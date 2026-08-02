package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// IndexConfig represents the search manager configuration
type IndexConfig struct {
	SchemaVersion  int        `json:"schema_version"`
	Roots          []string   `json:"roots"`
	Excludes       []string   `json:"excludes"`
	AutoIndex      bool       `json:"auto_index"`
	IndexOnStartup bool       `json:"index_on_startup"`
	MaxDepth       int        `json:"max_depth"`
	FollowSymlinks bool       `json:"follow_symlinks"`
	WorkerCount    int        `json:"worker_count"`
	IndexState     IndexState `json:"index_state"`
}

type IndexState struct {
	LastIndexedUnix int64 `json:"last_indexed_unix"`
	TotalFiles      int64 `json:"total_files"`
	IsDirty         bool  `json:"is_dirty"`
}

// ParsedQuery represents a query parsed from plain text DSL
type ParsedQuery struct {
	Words      []string
	Extensions []string
	Folders    []string
	TypeFilter string // "file", "dir", "any"
}

// Package-level precompiled regexes to avoid allocations
var (
	queryFilterRe = regexp.MustCompile(`(\bext|\bin|\btype):(?:"([^"]+)"|(\S+))`)
	wordRe        = regexp.MustCompile(`"[^"]+"|\S+`)
)

// Global IndexManager
var (
	GlobalIndexManager *IndexManager
	indexManagerOnce   sync.Once
	ConfigPathOverride string
)

type IndexManager struct {
	Mutex         sync.RWMutex
	Config        IndexConfig
	configPath    string
	RebuildCancel func()
	IsRebuilding  bool
	CurrentTotal  int64
	ProgressCount int64
	LastErr       error
}

// GetIndexManager returns or initializes the singleton IndexManager
func GetIndexManager() *IndexManager {
	indexManagerOnce.Do(func() {
		home, err := os.UserHomeDir()
		var configDir string
		if err != nil {
			configDir = "."
		} else {
			configDir = filepath.Join(home, ".config", "zen-man")
		}
		os.MkdirAll(configDir, 0755)
		cPath := ConfigPathOverride
		if cPath == "" {
			cPath = filepath.Join(configDir, "search-config.json")
		} else {
			os.Remove(cPath)
		}

		im := &IndexManager{
			configPath: cPath,
		}
		im.LoadConfig()
		GlobalIndexManager = im
	})
	return GlobalIndexManager
}

// LoadConfig loads search-config.json
func (im *IndexManager) LoadConfig() {
	im.Mutex.Lock()
	defer im.Mutex.Unlock()

	// Default config
	im.Config = IndexConfig{
		SchemaVersion:  1,
		Roots:          []string{},
		Excludes:       []string{"/proc", "/sys", "/dev", "**/.git", "**/node_modules", "**/__pycache__"},
		AutoIndex:      false,
		IndexOnStartup: false,
		MaxDepth:       0,
		FollowSymlinks: false,
		WorkerCount:    2,
		IndexState: IndexState{
			LastIndexedUnix: 0,
			TotalFiles:      0,
			IsDirty:         true,
		},
	}

	data, err := os.ReadFile(im.configPath)
	if err == nil {
		var loaded IndexConfig
		if err := json.Unmarshal(data, &loaded); err == nil {
			im.Config = loaded
		}
	}
}

// SaveConfig saves search-config.json
func (im *IndexManager) SaveConfig() error {
	// Assumes caller holds write lock if appropriate, or uses local locking
	data, err := json.MarshalIndent(im.Config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(im.configPath, data, 0644)
}

// InitSearchTables creates the needed database tables
func InitSearchTables() error {
	if db == nil {
		return errors.New("database not initialized")
	}

	// Schema version table
	_, err := db.Exec(`
	CREATE TABLE IF NOT EXISTS schema_meta (
		key   TEXT PRIMARY KEY,
		value TEXT
	);`)
	if err != nil {
		return fmt.Errorf("failed to create schema_meta: %w", err)
	}

	_, err = db.Exec(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('search_schema_version', '1');`)
	if err != nil {
		return fmt.Errorf("failed to initialize schema_version: %w", err)
	}

	// Live files table
	_, err = db.Exec(`
	CREATE TABLE IF NOT EXISTS files (
		id         INTEGER PRIMARY KEY,
		path       TEXT NOT NULL,
		name       TEXT NOT NULL,
		name_orig  TEXT NOT NULL,
		ext        TEXT NOT NULL,
		parent     TEXT NOT NULL,
		size       INTEGER NOT NULL,
		mtime      INTEGER NOT NULL,
		is_dir     INTEGER NOT NULL,
		is_symlink INTEGER NOT NULL
	);`)
	if err != nil {
		return fmt.Errorf("failed to create files table: %w", err)
	}

	// Indexing
	indexes := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path   ON files(path);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_name   ON files(name);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_ext    ON files(ext);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_parent ON files(parent);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_mtime  ON files(mtime);`,
	}
	for _, idx := range indexes {
		if _, err := db.Exec(idx); err != nil {
			return fmt.Errorf("failed to create index: %w", err)
		}
	}

	// Create FTS5 virtual table using trigram tokenizer for arbitrary substring search
	_, err = db.Exec(`
	CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
		name,
		tokenize='trigram'
	);`)
	if err != nil {
		return fmt.Errorf("failed to create files_fts table: %w", err)
	}

	return runSearchMigrations()
}

func runSearchMigrations() error {
	var val string
	err := db.QueryRow("SELECT value FROM schema_meta WHERE key='search_schema_version'").Scan(&val)
	if err != nil {
		return err
	}
	version, _ := strconv.Atoi(val)

	migrations := []struct {
		version int
		sql     string
	}{
		{1, "-- Initial version"},
	}

	for _, m := range migrations {
		if version < m.version {
			if _, err := db.Exec(m.sql); err != nil {
				return fmt.Errorf("migration to v%d failed: %w", m.version, err)
			}
			_, err = db.Exec("UPDATE schema_meta SET value=? WHERE key='search_schema_version'", strconv.Itoa(m.version))
			if err != nil {
				return err
			}
		}
	}

	return nil
}

// ParseSearchQuery parses filters like ext:pdf in:"/home/user/my folder" type:dir
func ParseSearchQuery(q string) ParsedQuery {
	var pq ParsedQuery
	pq.TypeFilter = "any"

	// Match key:value filters using package-level compiled regex
	matches := queryFilterRe.FindAllStringSubmatch(q, -1)

	// Keep track of matched indices to remove them from words
	removedParts := []string{}

	for _, match := range matches {
		fullMatch := match[0]
		key := match[1]
		val := match[2]
		if val == "" {
			val = match[3]
		}
		val = strings.TrimSpace(val)

		removedParts = append(removedParts, fullMatch)

		switch key {
		case "ext":
			pq.Extensions = append(pq.Extensions, strings.ToLower(val))
		case "in":
			pq.Folders = append(pq.Folders, val)
		case "type":
			lowerVal := strings.ToLower(val)
			if lowerVal == "dir" || lowerVal == "directory" || lowerVal == "folder" {
				pq.TypeFilter = "dir"
			} else if lowerVal == "file" {
				pq.TypeFilter = "file"
			}
		}
	}

	// Remove the filter tokens from the query to extract plain words
	cleanQ := q
	for _, part := range removedParts {
		cleanQ = strings.Replace(cleanQ, part, "", 1)
	}

	// Split by space, handle potential quotes in words using package-level compiled regex
	words := wordRe.FindAllString(cleanQ, -1)
	for _, w := range words {
		w = strings.Trim(w, `"`)
		w = strings.TrimSpace(w)
		if w != "" {
			pq.Words = append(pq.Words, strings.ToLower(w))
		}
	}

	return pq
}

// ExecuteSearch runs a query against the SQLite B-Tree index and FTS5 trigram virtual table
func ExecuteSearch(pq ParsedQuery, limit, offset int) ([]SearchEntry, int, error) {
	if db == nil {
		return nil, 0, errors.New("database not initialized")
	}

	var conditions []string
	var args []interface{}

	// Word queries - utilize FTS5 trigram virtual table for high-performance substring search
	if len(pq.Words) > 0 {
		var ftsParts []string
		for _, word := range pq.Words {
			// Escape double quotes inside FTS search tokens
			escaped := strings.ReplaceAll(word, `"`, `""`)
			ftsParts = append(ftsParts, `"`+escaped+`"`)
		}
		matchStr := strings.Join(ftsParts, " AND ")
		conditions = append(conditions, "id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)")
		args = append(args, matchStr)
	}

	// Extension queries
	if len(pq.Extensions) > 0 {
		var extConds []string
		for _, ext := range pq.Extensions {
			extConds = append(extConds, "ext = ?")
			args = append(args, ext)
		}
		conditions = append(conditions, "("+strings.Join(extConds, " OR ")+")")
	}

	// Folder (in:) queries - prefix matches (descendants)
	if len(pq.Folders) > 0 {
		var folderConds []string
		for _, f := range pq.Folders {
			// Convert path to clean absolute representation
			absF := filepath.Clean(f)
			escapedF := escapeLikePattern(absF)
			folderConds = append(folderConds, "(parent = ? OR parent LIKE ? ESCAPE '\\')")
			args = append(args, absF, escapedF+string(filepath.Separator)+"%")
		}
		conditions = append(conditions, "("+strings.Join(folderConds, " OR ")+")")
	}

	// Type filters
	if pq.TypeFilter == "dir" {
		conditions = append(conditions, "is_dir = 1")
	} else if pq.TypeFilter == "file" {
		conditions = append(conditions, "is_dir = 0")
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = "WHERE " + strings.Join(conditions, " AND ")
	}

	// First query the total matched count
	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM files %s", whereClause)
	var totalMatched int
	err := db.QueryRow(countQuery, args...).Scan(&totalMatched)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count search results: %w", err)
	}

	// Query actual page
	selectQuery := fmt.Sprintf(`
		SELECT name_orig, is_dir, size, mtime, path, parent 
		FROM files 
		%s 
		ORDER BY is_dir DESC, name ASC 
		LIMIT ? OFFSET ?`, whereClause)

	// Copy args to avoid race condition / slice aliasing bugs
	argsWithLimit := make([]interface{}, len(args), len(args)+2)
	copy(argsWithLimit, args)
	argsWithLimit = append(argsWithLimit, limit, offset)

	rows, err := db.Query(selectQuery, argsWithLimit...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query search results: %w", err)
	}
	defer rows.Close()

	var entries []SearchEntry
	for rows.Next() {
		var name, path, parent string
		var isDirVal, sizeVal, mtimeVal int64
		err := rows.Scan(&name, &isDirVal, &sizeVal, &mtimeVal, &path, &parent)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to scan search result row: %w", err)
		}

		entries = append(entries, SearchEntry{
			Name:    name,
			IsDir:   isDirVal == 1,
			Size:    sizeVal,
			ModTime: mtimeVal,
			Mode:    "",   // Not critical for global search
			RelPath: path, // For global search, RelPath stores the full absolute path
		})
	}

	if err = rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error during search results iteration: %w", err)
	}

	return entries, totalMatched, nil
}

func escapeLikePattern(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "%", "\\%")
	s = strings.ReplaceAll(s, "_", "\\_")
	return s
}
