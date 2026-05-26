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
	entries, err := os.ReadDir(resolvedPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to read directory: %v"}`, err), http.StatusInternalServerError)
		return
	}

	totalCount := len(entries)

	// Sort entries (name sorting requires no syscall stats)
	sortEntries(entries, sortBy, sortOrder, resolvedPath)

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

	// Stat ONLY the page slice entries to optimize performance
	for _, entry := range pageEntries {
		var size int64 = 0
		var modTime int64 = 0
		var mode string = ""

		info, err := entry.Info()
		if err == nil {
			size = info.Size()
			modTime = info.ModTime().Unix()
			mode = info.Mode().String()
		} else {
			// Fallback if permission/access error on file
			mode = "unknown"
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

// sortEntries sorts directories first, then items by the selected criteria
func sortEntries(entries []fs.DirEntry, sortBy string, sortOrder string, baseDir string) {
	isAsc := sortOrder == "asc"

	sort.Slice(entries, func(i, j int) bool {
		// Dirs first always
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir() // true (is dir) comes first
		}

		var valI, valJ interface{}

		switch sortBy {
		case "size":
			infoI, errI := entries[i].Info()
			infoJ, errJ := entries[j].Info()
			var sI, sJ int64
			if errI == nil {
				sI = infoI.Size()
			}
			if errJ == nil {
				sJ = infoJ.Size()
			}
			valI, valJ = sI, sJ

		case "date":
			infoI, errI := entries[i].Info()
			infoJ, errJ := entries[j].Info()
			var tI, tJ time.Time
			if errI == nil {
				tI = infoI.ModTime()
			}
			if errJ == nil {
				tJ = infoJ.ModTime()
			}
			valI, valJ = tI, tJ

		default: // "name"
			valI, valJ = strings.ToLower(entries[i].Name()), strings.ToLower(entries[j].Name())
		}

		// Perform actual comparison
		if sortBy == "date" {
			tI, tJ := valI.(time.Time), valJ.(time.Time)
			if isAsc {
				return tI.Before(tJ)
			}
			return tI.After(tJ)
		} else if sortBy == "size" {
			sI, sJ := valI.(int64), valJ.(int64)
			if isAsc {
				return sI < sJ
			}
			return sI > sJ
		} else {
			nI, nJ := valI.(string), valJ.(string)
			if isAsc {
				return nI < nJ
			}
			return nI > nJ
		}
	})
}
