package api

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type fileIndexEntry struct {
	Path      string
	NameLower string
	NameOrig  string
	Ext       string
	Parent    string
	Size      int64
	Mtime     int64
	IsDir     int
	IsSymlink int
}

// RebuildIndex starts the background indexing process
func (im *IndexManager) RebuildIndex() error {
	im.Mutex.Lock()

	// If already rebuilding, cancel the previous build
	if im.IsRebuilding && im.RebuildCancel != nil {
		im.RebuildCancel()
		im.Mutex.Unlock()
		// Wait a bit to ensure it exits
		time.Sleep(100 * time.Millisecond)
		im.Mutex.Lock()
	}

	ctx, cancel := context.WithCancel(context.Background())
	im.RebuildCancel = cancel
	im.IsRebuilding = true
	im.CurrentTotal = 0
	im.ProgressCount = 0
	im.LastErr = nil
	im.Mutex.Unlock()

	go func() {
		defer func() {
			im.Mutex.Lock()
			im.IsRebuilding = false
			im.Mutex.Unlock()
		}()

		err := im.runRebuild(ctx)
		im.Mutex.Lock()
		im.LastErr = err
		if err == nil {
			im.Config.IndexState.LastIndexedUnix = time.Now().Unix()
			im.Config.IndexState.TotalFiles = im.ProgressCount
			im.Config.IndexState.IsDirty = false
			im.SaveConfig()
		} else if err != context.Canceled {
			im.Config.IndexState.IsDirty = true
			im.SaveConfig()
		}
		im.Mutex.Unlock()
	}()

	return nil
}

// CancelRebuild cancels any running indexing job
func (im *IndexManager) CancelRebuild() {
	im.Mutex.Lock()
	defer im.Mutex.Unlock()
	if im.RebuildCancel != nil {
		im.RebuildCancel()
	}
}

func (im *IndexManager) runRebuild(ctx context.Context) error {
	if db == nil {
		return fmt.Errorf("database not initialized")
	}

	// 1. Create shadow tables
	_, err := db.Exec(`DROP TABLE IF EXISTS files_shadow;`)
	if err != nil {
		return fmt.Errorf("failed to drop old shadow table: %w", err)
	}

	_, err = db.Exec(`
	CREATE TABLE files_shadow (
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
		return fmt.Errorf("failed to create shadow table: %w", err)
	}

	_, err = db.Exec(`DROP TABLE IF EXISTS files_fts_shadow;`)
	if err != nil {
		db.Exec(`DROP TABLE IF EXISTS files_shadow;`)
		return fmt.Errorf("failed to drop old fts shadow table: %w", err)
	}

	_, err = db.Exec(`
	CREATE VIRTUAL TABLE files_fts_shadow USING fts5(
		name,
		tokenize='trigram'
	);`)
	if err != nil {
		db.Exec(`DROP TABLE IF EXISTS files_shadow;`)
		return fmt.Errorf("failed to create fts shadow table: %w", err)
	}

	// Compile glob exclusions to regexes
	im.Mutex.RLock()
	excludes := im.Config.Excludes
	roots := im.Config.Roots
	workers := im.Config.WorkerCount
	followSymlinks := im.Config.FollowSymlinks
	maxDepth := im.Config.MaxDepth
	im.Mutex.RUnlock()

	if workers <= 0 {
		workers = defaultWorkerCount()
	}

	excludeRegexes := compileExcludes(excludes)

	entryCh := make(chan fileIndexEntry, 4096)
	errCh := make(chan error, 1)

	// Writer goroutine (single SQLite writer)
	var writerWg sync.WaitGroup
	writerWg.Add(1)
	go func() {
		defer writerWg.Done()
		im.writer(ctx, entryCh, errCh)
	}()

	// Spawn Walkers (semaphore-bounded)
	var walkerWg sync.WaitGroup
	sem := make(chan struct{}, workers)

	for _, root := range roots {
		walkerWg.Add(1)
		go func(r string) {
			defer walkerWg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			// Per-root timeout of 30 seconds to prevent offline mounts hanging
			rootCtx, rootCancel := context.WithTimeout(ctx, 30*time.Second)
			defer rootCancel()

			im.walkRoot(rootCtx, r, maxDepth, followSymlinks, excludeRegexes, entryCh)
		}(root)
	}

	// Wait for walkers, then close channel
	walkerWg.Wait()
	close(entryCh)

	// Wait for writer to finish
	writerWg.Wait()

	select {
	case writeErr := <-errCh:
		if writeErr != nil {
			db.Exec(`DROP TABLE IF EXISTS files_shadow;`)
			db.Exec(`DROP TABLE IF EXISTS files_fts_shadow;`)
			return writeErr
		}
	default:
	}

	if ctx.Err() != nil {
		db.Exec(`DROP TABLE IF EXISTS files_shadow;`)
		db.Exec(`DROP TABLE IF EXISTS files_fts_shadow;`)
		return ctx.Err()
	}

	// Recreate indexes on shadow table before swap
	shadowIndexes := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_files_shadow_path   ON files_shadow(path);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_shadow_name   ON files_shadow(name);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_shadow_ext    ON files_shadow(ext);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_shadow_parent ON files_shadow(parent);`,
		`CREATE        INDEX IF NOT EXISTS idx_files_shadow_mtime  ON files_shadow(mtime);`,
	}
	for _, idx := range shadowIndexes {
		if _, err := db.Exec(idx); err != nil {
			db.Exec(`DROP TABLE IF EXISTS files_shadow;`)
			db.Exec(`DROP TABLE IF EXISTS files_fts_shadow;`)
			return fmt.Errorf("failed to index shadow table: %w", err)
		}
	}

	// Populate the FTS5 shadow table from the files_shadow table
	_, err = db.Exec(`INSERT INTO files_fts_shadow(rowid, name) SELECT id, name FROM files_shadow;`)
	if err != nil {
		db.Exec(`DROP TABLE IF EXISTS files_shadow;`)
		db.Exec(`DROP TABLE IF EXISTS files_fts_shadow;`)
		return fmt.Errorf("failed to populate fts shadow table: %w", err)
	}

	// Atomic table swap
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec(`DROP TABLE IF EXISTS files;`)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`DROP TABLE IF EXISTS files_fts;`)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`ALTER TABLE files_shadow RENAME TO files;`)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`ALTER TABLE files_fts_shadow RENAME TO files_fts;`)
	if err != nil {
		return err
	}

	err = tx.Commit()
	if err != nil {
		return fmt.Errorf("failed to commit swap transaction: %w", err)
	}

	// Run checkpoint to flush WAL changes
	db.Exec("PRAGMA wal_checkpoint(PASSIVE);")

	return nil
}

func (im *IndexManager) walkRoot(ctx context.Context, root string, maxDepth int, followSymlinks bool, excludes []*regexp.Regexp, entryCh chan<- fileIndexEntry) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return
	}

	// Recursion tracking depth
	rootDepth := strings.Count(absRoot, string(filepath.Separator))

	filepath.WalkDir(absRoot, func(path string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		if err != nil {
			// Skip directory read errors
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		// Exclude check
		relPath := path
		if strings.HasPrefix(path, absRoot) {
			relPath = path[len(absRoot):]
		}
		// Standardize to forward slashes for cross-platform exclude regexes
		stdPath := strings.ReplaceAll(path, "\\", "/")
		stdRelPath := strings.ReplaceAll(relPath, "\\", "/")

		for _, re := range excludes {
			if re.MatchString(stdPath) || re.MatchString(stdRelPath) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}

		// Max depth check
		if maxDepth > 0 {
			currDepth := strings.Count(path, string(filepath.Separator)) - rootDepth
			if currDepth > maxDepth {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}

		info, err := d.Info()
		if err != nil {
			return nil
		}

		// Symlink check
		isSymlink := 0
		if d.Type()&fs.ModeSymlink != 0 {
			isSymlink = 1
			if !followSymlinks {
				// Record symlink but do not descend
			}
		}

		// Build entry
		ext := strings.ToLower(filepath.Ext(d.Name()))
		if len(ext) > 0 && ext[0] == '.' {
			ext = ext[1:]
		}

		parent := filepath.Dir(path)
		name := d.Name()

		entryCh <- fileIndexEntry{
			Path:      path,
			NameLower: strings.ToLower(name),
			NameOrig:  name,
			Ext:       ext,
			Parent:    parent,
			Size:      info.Size(),
			Mtime:     info.ModTime().Unix(),
			IsDir:     boolToInt(d.IsDir()),
			IsSymlink: isSymlink,
		}

		return nil
	})
}

func (im *IndexManager) writer(ctx context.Context, entryCh <-chan fileIndexEntry, errCh chan<- error) {
	batch := make([]fileIndexEntry, 0, 1000)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()

		stmt, err := tx.Prepare(`
			INSERT OR REPLACE INTO files_shadow (path, name, name_orig, ext, parent, size, mtime, is_dir, is_symlink)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		defer stmt.Close()

		for _, entry := range batch {
			_, err = stmt.Exec(
				entry.Path,
				entry.NameLower,
				entry.NameOrig,
				entry.Ext,
				entry.Parent,
				entry.Size,
				entry.Mtime,
				entry.IsDir,
				entry.IsSymlink,
			)
			if err != nil {
				return err
			}
		}

		err = tx.Commit()
		if err == nil {
			im.Mutex.Lock()
			im.ProgressCount += int64(len(batch))
			im.Mutex.Unlock()
		}
		return err
	}

	for entry := range entryCh {
		if ctx.Err() != nil {
			errCh <- ctx.Err()
			return
		}
		batch = append(batch, entry)
		if len(batch) >= 1000 {
			if err := flush(); err != nil {
				errCh <- err
				return
			}
			batch = batch[:0]
		}
	}

	if err := flush(); err != nil {
		errCh <- err
		return
	}

	errCh <- nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func compileExcludes(excludes []string) []*regexp.Regexp {
	var regexes []*regexp.Regexp
	for _, pattern := range excludes {
		p := strings.ReplaceAll(pattern, "\\", "/")
		escaped := ""
		i := 0
		for i < len(p) {
			if i < len(p)-1 && p[i:i+2] == "**" {
				escaped += ".*"
				i += 2
			} else if p[i] == '*' {
				escaped += "[^/]*"
				i++
			} else if p[i] == '?' {
				escaped += "."
				i++
			} else if strings.ContainsRune(".+()|{}^$[]", rune(p[i])) {
				escaped += "\\" + string(p[i])
				i++
			} else {
				escaped += string(p[i])
				i++
			}
		}
		if !strings.HasPrefix(escaped, "^") {
			escaped = "(^|/)" + escaped
		}
		if !strings.HasSuffix(escaped, "$") {
			escaped = escaped + "($|/)"
		}
		if re, err := regexp.Compile(escaped); err == nil {
			regexes = append(regexes, re)
		}
	}
	return regexes
}

func defaultWorkerCount() int {
	if runtime.GOOS != "linux" {
		return 2
	}
	// On Linux, try detecting rotational block devices
	// Walk /sys/block and if all queue/rotational are 0, use 4 workers (SSD/NVMe). Otherwise 1 or 2.
	files, err := os.ReadDir("/sys/block")
	if err != nil {
		return 2
	}

	ssdCount := 0
	hddCount := 0
	for _, f := range files {
		name := f.Name()
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") {
			continue
		}
		rotPath := filepath.Join("/sys/block", name, "queue/rotational")
		data, err := os.ReadFile(rotPath)
		if err == nil {
			val := strings.TrimSpace(string(data))
			if val == "0" {
				ssdCount++
			} else if val == "1" {
				hddCount++
			}
		}
	}

	if hddCount > 0 {
		return 1 // HDD present, stay safe
	}
	if ssdCount > 0 {
		return 4 // pure SSD
	}
	return 2
}

// GetMountedRotationalHeuristic check helper
func isRotationalDev(path string) bool {
	var stat syscall.Stat_t
	err := syscall.Stat(path, &stat)
	if err != nil {
		return false
	}
	major := (stat.Dev >> 8) & 0xfff
	minor := stat.Dev & 0xff
	rotPath := fmt.Sprintf("/sys/dev/block/%d:%d/queue/rotational", major, minor)
	data, err := os.ReadFile(rotPath)
	if err == nil {
		return strings.TrimSpace(string(data)) == "1"
	}
	return false
}
