package api

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// SearchEntry represents a match returned in a search request
type SearchEntry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mod_time"` // Unix timestamp
	Mode    string `json:"mode"`
	RelPath string `json:"rel_path"` // Relative path from search root
}

// SearchResponse is the JSON payload returned to the client
type SearchResponse struct {
	Entries      []SearchEntry `json:"entries"`
	TotalMatched int           `json:"total_matched"`
	Capped       bool          `json:"capped"`
}

// HandleSearch implements high-performance server-side FTS search
func HandleSearch(w http.ResponseWriter, r *http.Request) {
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

	searchQuery := r.URL.Query().Get("q")
	recursive := r.URL.Query().Get("recursive") == "true"

	// Split search query into lowercase tokens for multi-token FTS matching
	rawTokens := strings.Fields(strings.ToLower(searchQuery))
	var tokens []string
	for _, t := range rawTokens {
		trimmed := strings.TrimSpace(t)
		if trimmed != "" {
			tokens = append(tokens, trimmed)
		}
	}

	ctx := r.Context()
	var matches []SearchEntry
	limit := 500
	capped := false

	// Helper to check if name matches all query tokens
	matchesQuery := func(name string) bool {
		if len(tokens) == 0 {
			return true
		}
		lowerName := strings.ToLower(name)
		for _, token := range tokens {
			if !strings.Contains(lowerName, token) {
				return false
			}
		}
		return true
	}

	if recursive {
		// Recursive WalkDir with early context-based cancellation
		err = filepath.WalkDir(resolvedPath, func(path string, d fs.DirEntry, walkErr error) error {
			// Check if context has been canceled (client aborted request due to typing or closing modal)
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}

			if walkErr != nil {
				// Skip folders we can't access
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}

			// Don't match the search root directory itself
			if path == resolvedPath {
				return nil
			}

			name := d.Name()
			if matchesQuery(name) {
				if len(matches) >= limit {
					capped = true
					return filepath.SkipAll // Stop walking entirely
				}

				// Resolve relative path
				relPath, relErr := filepath.Rel(resolvedPath, path)
				if relErr != nil {
					relPath = name
				}

				var size int64 = 0
				var modTime int64 = 0
				var mode string = ""
				fileInfo, fileErr := d.Info()
				if fileErr == nil {
					size = fileInfo.Size()
					modTime = fileInfo.ModTime().Unix()
					mode = fileInfo.Mode().String()
				}

				matches = append(matches, SearchEntry{
					Name:    name,
					IsDir:   d.IsDir(),
					Size:    size,
					ModTime: modTime,
					Mode:    mode,
					RelPath: relPath,
				})
			}
			return nil
		})
		if err != nil && err != filepath.SkipAll && err != contextCanceled(ctx) {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to walk directory: %v"}`, err), http.StatusInternalServerError)
			return
		}
	} else {
		// Non-recursive flat directory scan (very fast, O(N))
		entries, err := os.ReadDir(resolvedPath)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to read directory: %v"}`, err), http.StatusInternalServerError)
			return
		}

		for _, entry := range entries {
			// Check context cancellation
			if ctxErr := ctx.Err(); ctxErr != nil {
				break
			}

			name := entry.Name()
			if matchesQuery(name) {
				if len(matches) >= limit {
					capped = true
					break
				}

				var size int64 = 0
				var modTime int64 = 0
				var mode string = ""
				fileInfo, fileErr := entry.Info()
				if fileErr == nil {
					size = fileInfo.Size()
					modTime = fileInfo.ModTime().Unix()
					mode = fileInfo.Mode().String()
				}

				matches = append(matches, SearchEntry{
					Name:    name,
					IsDir:   entry.IsDir(),
					Size:    size,
					ModTime: modTime,
					Mode:    mode,
					RelPath: name, // Flat search rel path is just the name
				})
			}
		}
	}

	response := SearchResponse{
		Entries:      matches,
		TotalMatched: len(matches),
		Capped:       capped,
	}

	json.NewEncoder(w).Encode(response)
}

// Helper to compare walk context cancel error
func contextCanceled(ctx interface{}) error {
	if c, ok := ctx.(interface{ Err() error }); ok {
		return c.Err()
	}
	return nil
}
