package api

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FileEntry represents a single file or directory item returned to the client
type FileEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mod_time"` // Unix timestamp
	Mode    string `json:"mode"`
}

// DirResponse represents the paginated directory contents payload
type DirResponse struct {
	Path        string      `json:"path"`
	Entries     []FileEntry `json:"entries"`
	Cursor      string      `json:"cursor"`
	HasMore     bool        `json:"has_more"`
	TotalCount  int         `json:"total_count"`
	LoadedSoFar int         `json:"loaded_so_far"`
}

// ResolvePath handles tilde extension and relative paths
func ResolvePath(pathStr string) (string, error) {
	if pathStr == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		return cwd, nil
	}

	if strings.HasPrefix(pathStr, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		pathStr = filepath.Join(home, pathStr[1:])
	}

	absPath, err := filepath.Abs(pathStr)
	if err != nil {
		return "", err
	}

	return filepath.Clean(absPath), nil
}

// Helper struct to cache file metadata for high-performance sorting
type sortableEntry struct {
	fs.DirEntry
	size    int64
	modTime time.Time
}

// HandleReadDirectory handles directory queries with cursor pagination
func HandleReadDirectory(w http.ResponseWriter, r *http.Request) {
	// Enable CORS for dev environments
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	pathQuery := r.URL.Query().Get("path")
	resolvedPath, err := ResolvePath(pathQuery)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid path: %v"}`, err), http.StatusBadRequest)
		return
	}

	// Validate path is a directory
	info, err := os.Stat(resolvedPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Path not found: %v"}`, err), http.StatusNotFound)
		return
	}
	if !info.IsDir() {
		http.Error(w, fmt.Sprintf(`{"error": "Path is not a directory"}`), http.StatusBadRequest)
		return
	}

	// Pagination params
	limitStr := r.URL.Query().Get("limit")
	limit := 200
	if l, err := strconv.Atoi(limitStr); err == nil && l > 0 {
		limit = l
	}

	cursorStr := r.URL.Query().Get("cursor")
	startIndex := 0
	if c, err := strconv.Atoi(cursorStr); err == nil && c >= 0 {
		startIndex = c
	}

	sortBy := r.URL.Query().Get("sort") // "name", "size", "date"
	if sortBy == "" {
		sortBy = "name"
	}
	sortOrder := r.URL.Query().Get("order") // "asc", "desc"
	if sortOrder == "" {
		sortOrder = "asc"
	}

	// Read directory entries
	rawEntries, err := os.ReadDir(resolvedPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to read directory: %v"}`, err), http.StatusInternalServerError)
		return
	}

	totalCount := len(rawEntries)

	// Wrap raw entries into our metadata-cached structures
	entries := make([]sortableEntry, len(rawEntries))
	for i, entry := range rawEntries {
		var size int64
		var modTime time.Time

		// Only hit disk stats if required by the sorting parameters
		if sortBy == "size" || sortBy == "date" {
			if fi, err := entry.Info(); err == nil {
				size = fi.Size()
				modTime = fi.ModTime()
			}
		}

		entries[i] = sortableEntry{
			DirEntry: entry,
			size:     size,
			modTime:  modTime,
		}
	}

	// Sort entries in memory using cached metadata (Blazing Fast)
	sortEntries(entries, sortBy, sortOrder)

	// Paginate
	hasMore := false
	endIndex := startIndex + limit
	if endIndex > totalCount {
		endIndex = totalCount
	} else if endIndex < totalCount {
		hasMore = true
	}

	pageEntries := entries[startIndex:endIndex]
	fileEntries := make([]FileEntry, 0, len(pageEntries))

	// Map sorted page slice down to target structure
	for _, entry := range pageEntries {
		var size int64 = entry.size
		var modTime int64 = entry.modTime.Unix()
		var mode string = "unknown"

		// If name sorting skipped stats collection, fetch it only for this paginated window
		if sortBy == "name" {
			if info, err := entry.Info(); err == nil {
				size = info.Size()
				modTime = info.ModTime().Unix()
				mode = info.Mode().String()
			}
		} else {
			if info, err := entry.Info(); err == nil {
				mode = info.Mode().String()
			}
		}

		fileEntries = append(fileEntries, FileEntry{
			Name:    entry.Name(),
			IsDir:   entry.IsDir(),
			Size:    size,
			ModTime: modTime,
			Mode:    mode,
		})
	}

	nextCursor := ""
	if hasMore {
		nextCursor = strconv.Itoa(endIndex)
	}

	response := DirResponse{
		Path:        resolvedPath,
		Entries:     fileEntries,
		Cursor:      nextCursor,
		HasMore:     hasMore,
		TotalCount:  totalCount,
		LoadedSoFar: endIndex,
	}

	json.NewEncoder(w).Encode(response)
}

// sortEntries sorts directories first, then items by the selected criteria using pre-cached values
func sortEntries(entries []sortableEntry, sortBy string, sortOrder string) {
	isAsc := sortOrder == "asc"

	sort.Slice(entries, func(i, j int) bool {
		// Dirs first always
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir() // true (is dir) comes first
		}

		switch sortBy {
		case "size":
			if isAsc {
				return entries[i].size < entries[j].size
			}
			return entries[i].size > entries[j].size

		case "date":
			if isAsc {
				return entries[i].modTime.Before(entries[j].modTime)
			}
			return entries[i].modTime.After(entries[j].modTime)

		default: // "name"
			nI, nJ := strings.ToLower(entries[i].Name()), strings.ToLower(entries[j].Name())
			if isAsc {
				return nI < nJ
			}
			return nI > nJ
		}
	})
}
