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
	Name       string `json:"name"`
	IsDir      bool   `json:"is_dir"`
	Size       int64  `json:"size"`
	ModTime    int64  `json:"mod_time"` // Unix timestamp
	Mode       string `json:"mode"`
	RelPath    string `json:"rel_path,omitempty"`
	Depth      int    `json:"depth,omitempty"`
	FilesCount int64  `json:"files_count,omitempty"`
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
	relPath string
	depth   int
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

	isFlat := r.URL.Query().Get("flat") == "true"
	noFolders := r.URL.Query().Get("no_folders") == "true"

	var entries []sortableEntry

	if isFlat {
		limitWalk := 10000 // Hard safety limit for flat recursive traversals
		err = filepath.WalkDir(resolvedPath, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return nil // Skip files/folders with permission errors
			}
			if path == resolvedPath {
				return nil
			}
			if r.Context().Err() != nil {
				return r.Context().Err()
			}
			if noFolders && d.IsDir() {
				return nil
			}

			relPath, err := filepath.Rel(resolvedPath, path)
			if err != nil {
				return nil
			}

			var depth int
			if relPath == "." {
				depth = 0
			} else {
				depth = strings.Count(filepath.ToSlash(relPath), "/")
			}

			var size int64
			var modTime time.Time
			if sortBy == "size" || sortBy == "date" {
				if fi, err := d.Info(); err == nil {
					size = fi.Size()
					modTime = fi.ModTime()
				}
			}

			entries = append(entries, sortableEntry{
				DirEntry: d,
				size:     size,
				modTime:  modTime,
				relPath:  relPath,
				depth:    depth,
			})

			if len(entries) >= limitWalk {
				return filepath.SkipAll
			}
			return nil
		})
		if err != nil && err != r.Context().Err() {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to walk directory recursively: %v"}`, err), http.StatusInternalServerError)
			return
		}
	} else {
		// Read single directory entries
		rawEntries, err := os.ReadDir(resolvedPath)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to read directory: %v"}`, err), http.StatusInternalServerError)
			return
		}

		entries = make([]sortableEntry, len(rawEntries))
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
	}

	totalCount := len(entries)

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

		var filesCount int64 = 0
		if entry.IsDir() {
			dirPath := filepath.Join(resolvedPath, entry.Name())
			if cachedSize, cachedCount, ok := GetCachedDirSize(dirPath); ok {
				size = cachedSize
				filesCount = cachedCount
			}
		}

		fileEntries = append(fileEntries, FileEntry{
			Name:       entry.Name(),
			IsDir:      entry.IsDir(),
			Size:       size,
			ModTime:    modTime,
			Mode:       mode,
			RelPath:    entry.relPath,
			Depth:      entry.depth,
			FilesCount: filesCount,
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

// HandleDirSize calculates the total size and file count of a directory, caches it, and returns the result
func HandleDirSize(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	pathQuery := r.URL.Query().Get("path")
	resolvedPath, err := ResolvePath(pathQuery)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid path: %v"}`, err), http.StatusBadRequest)
		return
	}

	info, err := os.Stat(resolvedPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Path not found: %v"}`, err), http.StatusNotFound)
		return
	}
	if !info.IsDir() {
		http.Error(w, fmt.Sprintf(`{"error": "Path is not a directory"}`), http.StatusBadRequest)
		return
	}

	size, fileCount, err := CalculateDirSize(resolvedPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to calculate folder size: %v"}`, err), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "success",
		"path":        resolvedPath,
		"size":        size,
		"files_count": fileCount,
	})
}

// CalculateDirSize calculates the size and count of files inside a folder recursively, caching all sub-folders
func CalculateDirSize(dirPath string) (int64, int64, error) {
	root := filepath.Clean(dirPath)

	stats := make(map[string]DirSizeInfo)
	stats[root] = DirSizeInfo{}

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // Skip read/permission errors
		}
		if d.IsDir() {
			if _, exists := stats[path]; !exists {
				stats[path] = DirSizeInfo{}
			}
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return nil
		}
		fileSize := info.Size()

		curr := filepath.Dir(path)
		for {
			itemInfo := stats[curr]
			itemInfo.Size += fileSize
			itemInfo.FileCount++
			stats[curr] = itemInfo

			if curr == root {
				break
			}
			parent := filepath.Dir(curr)
			if parent == curr {
				break
			}
			curr = parent
		}
		return nil
	})

	if err != nil {
		return 0, 0, err
	}

	// Save all collected sub-folder statistics to the cache database in a batch transaction
	if err := SaveCachedDirSizesBatch(stats); err != nil {
		fmt.Fprintf(os.Stderr, "[zen-man] failed to batch cache dir sizes: %v\n", err)
	}

	rootInfo := stats[root]
	return rootInfo.Size, rootInfo.FileCount, nil
}
