package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bodgit/sevenzip"
	"github.com/google/uuid"
	"github.com/nwaples/rardecode"
)

// ExtractJob tracks extraction progress
type ExtractJob struct {
	ID          string    `json:"id"`
	Done        bool      `json:"done"`
	BytesDone   int64     `json:"bytes_done"`
	BytesTotal  int64     `json:"bytes_total"`
	Error       string    `json:"error,omitempty"`
	CompletedAt time.Time `json:"-"`
	cancel      context.CancelFunc
}

var (
	extractJobs sync.Map // job_id -> *ExtractJob
	extractSem  = make(chan struct{}, 3)
)

func init() {
	go startJobCleanupTicker()
}

func startJobCleanupTicker() {
	ticker := time.NewTicker(30 * time.Minute)
	for range ticker.C {
		now := time.Now()
		extractJobs.Range(func(key, value interface{}) bool {
			job := value.(*ExtractJob)
			if job.Done && now.Sub(job.CompletedAt) > 1*time.Hour {
				extractJobs.Delete(key)
			}
			return true
		})
	}
}

func validateDest(dest string) error {
	if !filepath.IsAbs(dest) {
		return fmt.Errorf("destination path must be absolute")
	}
	clean := filepath.Clean(dest)
	if strings.Contains(clean, "..") {
		return fmt.Errorf("path traversal detected in destination")
	}
	return nil
}

func safeDestPath(dest, entryName string) (string, error) {
	resolved := filepath.Join(dest, filepath.FromSlash(entryName))
	resolved = filepath.Clean(resolved)

	destClean := filepath.Clean(dest) + string(os.PathSeparator)
	if !strings.HasPrefix(resolved+string(os.PathSeparator), destClean) {
		return "", fmt.Errorf("zip slip detected: %s", entryName)
	}

	return resolved, nil
}

// HandleExtractArchive initiates extraction asynchronously
func HandleExtractArchive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Archive string   `json:"archive"`
		Nested  string   `json:"nested"`
		Sources []string `json:"sources"` // empty list means extract everything
		Dest    string   `json:"dest"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid request body: %v"}`, err), http.StatusBadRequest)
		return
	}

	resolvedArchive, err := ResolvePath(req.Archive)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid archive path: %v"}`, err), http.StatusBadRequest)
		return
	}

	resolvedDest, err := ResolvePath(req.Dest)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid destination path: %v"}`, err), http.StatusBadRequest)
		return
	}

	if err := validateDest(resolvedDest); err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "%v"}`, err), http.StatusForbidden)
		return
	}

	// 1. Get total bytes of selected entries
	cacheKey := BuildCacheKey(resolvedArchive, req.Nested)
	cache, ok := GetCache(cacheKey)
	if !ok {
		var err error
		cache, err = BuildManifest(resolvedArchive, req.Nested)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to read archive: %v"}`, err), http.StatusInternalServerError)
			return
		}
	}

	var totalBytes int64
	var matchedNodes []*VirtualNode

	cache.mu.RLock()
	// Filter entries
	for internalPath, node := range cache.Nodes {
		if node.IsDir {
			continue
		}
		match := false
		if len(req.Sources) == 0 {
			match = true
		} else {
			for _, src := range req.Sources {
				srcClean := cleanInternalPath(src)
				if internalPath == srcClean || strings.HasPrefix(internalPath, srcClean+"/") {
					match = true
					break
				}
			}
		}

		if match {
			totalBytes += node.Size
			matchedNodes = append(matchedNodes, node)
		}
	}
	cache.mu.RUnlock()

	if len(matchedNodes) == 0 {
		http.Error(w, `{"error": "No matching files to extract"}`, http.StatusBadRequest)
		return
	}

	// 2. Setup job
	jobID := uuid.New().String()
	ctx, cancel := context.WithCancel(context.Background())
	job := &ExtractJob{
		ID:         jobID,
		BytesTotal: totalBytes,
		cancel:     cancel,
	}

	extractJobs.Store(jobID, job)

	// 3. Launch goroutine
	go func() {
		defer func() {
			if r := recover(); r != nil {
				job.Error = fmt.Sprintf("Internal extraction panic: %v", r)
			}
			job.Done = true
			job.CompletedAt = time.Now()
			cancel()
		}()

		// Acquire semaphore
		select {
		case extractSem <- struct{}{}:
			defer func() { <-extractSem }()
		case <-ctx.Done():
			return
		}

		// Run extraction
		err := performExtract(ctx, resolvedArchive, req.Nested, resolvedDest, matchedNodes, job)
		if err != nil {
			job.Error = err.Error()
		}
	}()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"job_id": jobID,
	})
}

// HandleExtractStatus returns the progress of a running extract job
func HandleExtractStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	jobID := r.URL.Query().Get("job_id")
	if jobID == "" {
		http.Error(w, `{"error": "Missing job_id"}`, http.StatusBadRequest)
		return
	}

	val, ok := extractJobs.Load(jobID)
	if !ok {
		http.Error(w, `{"error": "Job not found"}`, http.StatusNotFound)
		return
	}

	job := val.(*ExtractJob)
	// Atomic read of done/progress
	json.NewEncoder(w).Encode(job)
}

func performExtract(ctx context.Context, archivePath, nestedPath, destDir string, nodes []*VirtualNode, job *ExtractJob) error {
	if nestedPath == "" {
		f, err := os.Open(archivePath)
		if err != nil {
			return err
		}
		defer f.Close()

		fi, err := f.Stat()
		if err != nil {
			return err
		}

		format := DetectFormat(archivePath)
		switch format {
		case "zip":
			zr, err := zip.NewReader(f, fi.Size())
			if err != nil {
				return err
			}
			nodeMap := make(map[string]bool)
			for _, node := range nodes {
				nodeMap[node.InternalPath] = true
			}

			for _, zf := range zr.File {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				cleanPath := cleanInternalPath(zf.Name)
				if !nodeMap[cleanPath] {
					continue
				}

				err := extractZipFile(ctx, zf, destDir, job)
				if err != nil {
					return err
				}
			}
		case "rar":
			rr, err := rardecode.NewReader(f, "")
			if err != nil {
				return err
			}
			nodeMap := make(map[string]bool)
			for _, node := range nodes {
				nodeMap[node.InternalPath] = true
			}

			for {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				header, err := rr.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					return err
				}

				cleanPath := cleanInternalPath(header.Name)
				if !nodeMap[cleanPath] {
					continue
				}

				err = extractRarFile(ctx, rr, header, destDir, job)
				if err != nil {
					return err
				}
			}
		case "7z":
			sz, err := sevenzip.NewReader(f, fi.Size())
			if err != nil {
				return err
			}
			nodeMap := make(map[string]bool)
			for _, node := range nodes {
				nodeMap[node.InternalPath] = true
			}

			for _, sf := range sz.File {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				cleanPath := cleanInternalPath(sf.Name)
				if !nodeMap[cleanPath] {
					continue
				}

				err := extract7zFile(ctx, sf, destDir, job)
				if err != nil {
					return err
				}
			}
		}
	} else {
		// In-memory nested archive extraction
		buf, err := extractFileToMemory(archivePath, nestedPath)
		if err != nil {
			return err
		}
		reader := bytes.NewReader(buf)
		size := int64(len(buf))

		format := DetectFormat(nestedPath)
		switch format {
		case "zip":
			zr, err := zip.NewReader(reader, size)
			if err != nil {
				return err
			}
			nodeMap := make(map[string]bool)
			for _, node := range nodes {
				nodeMap[node.InternalPath] = true
			}

			for _, zf := range zr.File {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				cleanPath := cleanInternalPath(zf.Name)
				if !nodeMap[cleanPath] {
					continue
				}

				err := extractZipFile(ctx, zf, destDir, job)
				if err != nil {
					return err
				}
			}
		case "rar":
			rr, err := rardecode.NewReader(reader, "")
			if err != nil {
				return err
			}
			nodeMap := make(map[string]bool)
			for _, node := range nodes {
				nodeMap[node.InternalPath] = true
			}

			for {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				header, err := rr.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					return err
				}

				cleanPath := cleanInternalPath(header.Name)
				if !nodeMap[cleanPath] {
					continue
				}

				err = extractRarFile(ctx, rr, header, destDir, job)
				if err != nil {
					return err
				}
			}
		case "7z":
			sz, err := sevenzip.NewReader(reader, size)
			if err != nil {
				return err
			}
			nodeMap := make(map[string]bool)
			for _, node := range nodes {
				nodeMap[node.InternalPath] = true
			}

			for _, sf := range sz.File {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				cleanPath := cleanInternalPath(sf.Name)
				if !nodeMap[cleanPath] {
					continue
				}

				err := extract7zFile(ctx, sf, destDir, job)
				if err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func extractZipFile(ctx context.Context, zf *zip.File, destDir string, job *ExtractJob) error {
	cleanName := cleanInternalPath(zf.Name)
	outPath, err := safeDestPath(destDir, cleanName)
	if err != nil {
		return err
	}

	if zf.FileInfo().IsDir() {
		return os.MkdirAll(outPath, 0755)
	}

	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		return err
	}

	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	out, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, zf.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	buf := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		n, err := rc.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			atomic.AddInt64(&job.BytesDone, int64(n))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func extractRarFile(ctx context.Context, rr *rardecode.Reader, header *rardecode.FileHeader, destDir string, job *ExtractJob) error {
	cleanName := cleanInternalPath(header.Name)
	outPath, err := safeDestPath(destDir, cleanName)
	if err != nil {
		return err
	}

	if header.IsDir {
		return os.MkdirAll(outPath, 0755)
	}

	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		return err
	}

	out, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, header.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	buf := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		n, err := rr.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			atomic.AddInt64(&job.BytesDone, int64(n))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func extract7zFile(ctx context.Context, sf *sevenzip.File, destDir string, job *ExtractJob) error {
	cleanName := cleanInternalPath(sf.Name)
	outPath, err := safeDestPath(destDir, cleanName)
	if err != nil {
		return err
	}

	if sf.FileInfo().IsDir() {
		return os.MkdirAll(outPath, 0755)
	}

	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		return err
	}

	rc, err := sf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	out, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, sf.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	buf := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		n, err := rc.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			atomic.AddInt64(&job.BytesDone, int64(n))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	return nil
}
