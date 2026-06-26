package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/bodgit/sevenzip"
	"github.com/nwaples/rardecode"
)

// HandleListArchiveDir handles directory querying within archive manifest caches
func HandleListArchiveDir(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	archivePath := r.URL.Query().Get("archive")
	nestedPath := r.URL.Query().Get("nested")
	internalDir := r.URL.Query().Get("path")

	if archivePath == "" {
		http.Error(w, `{"error": "Missing archive parameter"}`, http.StatusBadRequest)
		return
	}

	resolvedArchive, err := ResolvePath(archivePath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid archive path: %v"}`, err), http.StatusBadRequest)
		return
	}

	cacheKey := BuildCacheKey(resolvedArchive, nestedPath)
	cache, ok := GetCache(cacheKey)
	if !ok {
		var err error
		cache, err = BuildManifest(resolvedArchive, nestedPath)
		if err != nil {
			if strings.Contains(err.Error(), "encrypted") || strings.Contains(err.Error(), "password") {
				http.Error(w, fmt.Sprintf(`{"error": "archive_encrypted", "message": "%v"}`, err), http.StatusUnprocessableEntity)
				return
			}
			http.Error(w, fmt.Sprintf(`{"error": "Failed to read archive manifest: %v"}`, err), http.StatusInternalServerError)
			return
		}
	} else {
		fi, err := os.Stat(resolvedArchive)
		if err != nil {
			InvalidateCache(cacheKey)
			http.Error(w, `{"error": "Archive file not found"}`, http.StatusNotFound)
			return
		}
		if !fi.ModTime().Equal(cache.HostMtime) {
			InvalidateCache(cacheKey)
			http.Error(w, `{"error": "archive_modified"}`, http.StatusConflict)
			return
		}
	}

	internalDir = cleanInternalPath(internalDir)

	var entries []FileEntry
	if internalDir == "" {
		cache.mu.RLock()
		for path, node := range cache.Nodes {
			if !strings.Contains(path, "/") {
				entries = append(entries, node.ToFileEntry())
			}
		}
		cache.mu.RUnlock()
	} else {
		cache.mu.RLock()
		node, exists := cache.Nodes[internalDir]
		if !exists {
			cache.mu.RUnlock()
			http.Error(w, `{"error": "Directory not found inside archive"}`, http.StatusNotFound)
			return
		}
		if !node.IsDir {
			cache.mu.RUnlock()
			http.Error(w, `{"error": "Path inside archive is not a directory"}`, http.StatusBadRequest)
			return
		}
		for _, childPath := range node.Children {
			if childNode, exists := cache.Nodes[childPath]; exists {
				entries = append(entries, childNode.ToFileEntry())
			}
		}
		cache.mu.RUnlock()
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	response := map[string]interface{}{
		"archive": resolvedArchive,
		"nested":  nestedPath,
		"path":    internalDir,
		"entries": entries,
	}

	json.NewEncoder(w).Encode(response)
}

// HandleStreamArchiveFile streams a file out of the archive
func HandleStreamArchiveFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	archivePath := r.URL.Query().Get("archive")
	nestedPath := r.URL.Query().Get("nested")
	internalFilePath := r.URL.Query().Get("path")

	if archivePath == "" || internalFilePath == "" {
		http.Error(w, `{"error": "Missing parameters"}`, http.StatusBadRequest)
		return
	}

	resolvedArchive, err := ResolvePath(archivePath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid archive path: %v"}`, err), http.StatusBadRequest)
		return
	}

	cacheKey := BuildCacheKey(resolvedArchive, nestedPath)
	cache, ok := GetCache(cacheKey)
	if !ok {
		var err error
		cache, err = BuildManifest(resolvedArchive, nestedPath)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to read archive: %v"}`, err), http.StatusInternalServerError)
			return
		}
	}

	internalFilePath = cleanInternalPath(internalFilePath)
	cache.mu.RLock()
	node, exists := cache.Nodes[internalFilePath]
	if !exists || node.IsDir {
		cache.mu.RUnlock()
		http.Error(w, `{"error": "File not found inside archive"}`, http.StatusNotFound)
		return
	}
	cache.mu.RUnlock()

	if nestedPath == "" {
		f, err := OpenAndVerify(resolvedArchive, cache.HostMtime)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "%v"}`, err), http.StatusConflict)
			return
		}
		defer f.Close()

		format := DetectFormat(resolvedArchive)
		switch format {
		case "zip":
			fi, err := f.Stat()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			zr, err := zip.NewReader(f, fi.Size())
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for _, zf := range zr.File {
				if cleanInternalPath(zf.Name) == internalFilePath {
					rc, err := zf.Open()
					if err != nil {
						http.Error(w, err.Error(), http.StatusInternalServerError)
						return
					}
					defer rc.Close()
					w.Header().Set("Content-Length", fmt.Sprintf("%d", zf.UncompressedSize64))
					io.Copy(w, rc)
					return
				}
			}
		case "rar":
			rr, err := rardecode.NewReader(f, "")
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for {
				header, err := rr.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				if cleanInternalPath(header.Name) == internalFilePath {
					w.Header().Set("Content-Length", fmt.Sprintf("%d", header.UnPackedSize))
					ctx := r.Context()
					buf := make([]byte, 32*1024)
					for {
						select {
						case <-ctx.Done():
							return
						default:
						}
						n, readErr := rr.Read(buf)
						if n > 0 {
							if _, writeErr := w.Write(buf[:n]); writeErr != nil {
								return
							}
						}
						if readErr == io.EOF {
							return
						}
						if readErr != nil {
							return
						}
					}
				}
			}
		case "7z":
			fi, err := f.Stat()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			sz, err := sevenzip.NewReader(f, fi.Size())
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for _, sf := range sz.File {
				if cleanInternalPath(sf.Name) == internalFilePath {
					rc, err := sf.Open()
					if err != nil {
						http.Error(w, err.Error(), http.StatusInternalServerError)
						return
					}
					defer rc.Close()
					w.Header().Set("Content-Length", fmt.Sprintf("%d", sf.UncompressedSize))
					io.Copy(w, rc)
					return
				}
			}
		}
	} else {
		buf, err := extractFileToMemory(resolvedArchive, nestedPath)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to read nested archive: %v"}`, err), http.StatusInternalServerError)
			return
		}
		reader := bytes.NewReader(buf)
		size := int64(len(buf))

		format := DetectFormat(nestedPath)
		switch format {
		case "zip":
			zr, err := zip.NewReader(reader, size)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for _, zf := range zr.File {
				if cleanInternalPath(zf.Name) == internalFilePath {
					rc, err := zf.Open()
					if err != nil {
						http.Error(w, err.Error(), http.StatusInternalServerError)
						return
					}
					defer rc.Close()
					w.Header().Set("Content-Length", fmt.Sprintf("%d", zf.UncompressedSize64))
					io.Copy(w, rc)
					return
				}
			}
		case "rar":
			rr, err := rardecode.NewReader(reader, "")
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for {
				header, err := rr.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				if cleanInternalPath(header.Name) == internalFilePath {
					w.Header().Set("Content-Length", fmt.Sprintf("%d", header.UnPackedSize))
					io.Copy(w, rr)
					return
				}
			}
		case "7z":
			sz, err := sevenzip.NewReader(reader, size)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for _, sf := range sz.File {
				if cleanInternalPath(sf.Name) == internalFilePath {
					rc, err := sf.Open()
					if err != nil {
						http.Error(w, err.Error(), http.StatusInternalServerError)
						return
					}
					defer rc.Close()
					w.Header().Set("Content-Length", fmt.Sprintf("%d", sf.UncompressedSize))
					io.Copy(w, rc)
					return
				}
			}
		}
	}

	http.Error(w, `{"error": "File not found inside archive"}`, http.StatusNotFound)
}

