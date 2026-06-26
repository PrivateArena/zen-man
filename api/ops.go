package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// OpRequest defines the payload schema for file operations
type OpRequest struct {
	Op      string   `json:"op"`
	Sources []string `json:"sources"`
	Dest    string   `json:"dest"`
	Name    string   `json:"name"`
	Merge   bool     `json:"merge"`
}

// ClipboardState represents internal clipboard contents
type ClipboardState struct {
	Op      string   // "copy" or "cut"
	Sources []string // absolute file paths
}

var (
	clipboardMutex   sync.Mutex
	currentClipboard ClipboardState
)

// HandleFileOp routes file operations like opening, renaming, deleting, copying, moving
func HandleFileOp(w http.ResponseWriter, r *http.Request) {
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

	var req OpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid request body: %v"}`, err), http.StatusBadRequest)
		return
	}

	// VFS Read-Only Guard check
	isInsideArchive := func(p string) bool {
		norm := filepath.ToSlash(p)
		for _, ext := range []string{".zip/", ".rar/", ".7z/"} {
			if strings.Contains(norm, ext) {
				return true
			}
		}
		return false
	}

	for _, src := range req.Sources {
		if isInsideArchive(src) {
			http.Error(w, `{"error": "vfs_readonly", "message": "Write operations not supported inside archives"}`, http.StatusMethodNotAllowed)
			return
		}
	}
	if isInsideArchive(req.Dest) {
		http.Error(w, `{"error": "vfs_readonly", "message": "Write operations not supported inside archives"}`, http.StatusMethodNotAllowed)
		return
	}

	switch req.Op {
	case "open":
		handleOpen(w, req.Sources)
	case "copy":
		handleClipboardSet(w, "copy", req.Sources)
	case "cut":
		handleClipboardSet(w, "cut", req.Sources)
	case "copy_inside":
		resolved, err := resolveInsideSources(req.Sources)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "%v"}`, err), http.StatusBadRequest)
			return
		}
		handleClipboardSet(w, "copy", resolved)
	case "cut_inside":
		resolved, err := resolveInsideSources(req.Sources)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "%v"}`, err), http.StatusBadRequest)
			return
		}
		handleClipboardSet(w, "cut", resolved)
	case "clear":
		handleClearClipboard(w)
	case "paste":
		handlePaste(w, req)
	case "delete":
		handleDelete(w, req.Sources)
	case "rename":
		handleRename(w, req.Sources, req.Name)
	case "mkdir":
		handleMkdir(w, req.Dest, req.Name)
	case "chmod":
		handleChmod(w, req.Sources, req.Name)
	default:
		http.Error(w, fmt.Sprintf(`{"error": "Unsupported operation: %s"}`, req.Op), http.StatusBadRequest)
	}
}

func handleOpen(w http.ResponseWriter, sources []string) {
	if len(sources) == 0 {
		http.Error(w, `{"error": "No files specified to open"}`, http.StatusBadRequest)
		return
	}

	var lastErr error
	for _, source := range sources {
		err := openWithDefaultApp(source)
		if err != nil {
			lastErr = err
		}
	}

	if lastErr != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to open file: %v"}`, lastErr), http.StatusInternalServerError)
		return
	}

	w.Write([]byte(`{"status": "success"}`))
}

func handleClipboardSet(w http.ResponseWriter, op string, sources []string) {
	if len(sources) == 0 {
		http.Error(w, `{"error": "No files selected"}`, http.StatusBadRequest)
		return
	}

	clipboardMutex.Lock()
	currentClipboard = ClipboardState{
		Op:      op,
		Sources: sources,
	}
	clipboardMutex.Unlock()

	// Sync to system clipboard
	writeToSystemClipboard(sources)

	// Log clipboard set (ActionCopy covers both "copy" and "cut" clipboard intent)
	GetLog().Append(ActionCopy, sources, "", "")

	// Build items info to return to frontend
	var items []map[string]interface{}
	for _, src := range sources {
		name := filepath.Base(src)
		isDir := false
		var size int64 = 0
		if fi, err := os.Stat(src); err == nil {
			isDir = fi.IsDir()
			size = fi.Size()
		}
		items = append(items, map[string]interface{}{
			"name":  name,
			"path":  src,
			"isDir": isDir,
			"size":  size,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "success",
		"op":     op,
		"items":  items,
	})
}

func resolveInsideSources(sources []string) ([]string, error) {
	if len(sources) == 0 {
		return nil, fmt.Errorf("no source folder specified")
	}
	var resolved []string
	for _, src := range sources {
		stat, err := os.Stat(src)
		if err != nil {
			return nil, fmt.Errorf("failed to access folder: %w", err)
		}
		if !stat.IsDir() {
			return nil, fmt.Errorf("source is not a directory")
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return nil, fmt.Errorf("failed to read folder contents: %w", err)
		}
		for _, entry := range entries {
			resolved = append(resolved, filepath.Join(src, entry.Name()))
		}
	}
	if len(resolved) == 0 {
		return nil, fmt.Errorf("folder is empty, nothing to copy/cut")
	}
	return resolved, nil
}

func handleClearClipboard(w http.ResponseWriter) {
	clipboardMutex.Lock()
	currentClipboard = ClipboardState{}
	clipboardMutex.Unlock()

	writeToSystemClipboard([]string{})

	w.Write([]byte(`{"status": "success"}`))
}

func handlePaste(w http.ResponseWriter, req OpRequest) {
	if req.Dest == "" {
		http.Error(w, `{"error": "Destination folder not specified"}`, http.StatusBadRequest)
		return
	}

	var paths []string
	var isURIList bool
	var err error
	if len(req.Sources) > 0 {
		paths = req.Sources
		isURIList = true
	} else {
		paths, isURIList, err = readFromSystemClipboard()
	}

	clipboardMutex.Lock()
	if len(currentClipboard.Sources) > 0 && !isURIList {
		paths = currentClipboard.Sources
	} else if err != nil || len(paths) == 0 {
		paths = currentClipboard.Sources
	}
	clipboardMutex.Unlock()

	if len(paths) == 0 {
		http.Error(w, `{"error": "Clipboard is empty"}`, http.StatusBadRequest)
		return
	}

	// Check for directory conflicts if merge is not confirmed
	var conflicts []string
	if !req.Merge {
		for _, src := range paths {
			name := filepath.Base(src)
			dst := filepath.Join(req.Dest, name)
			if src == dst || (isSourceDir(src) && isSubdir(src, dst)) {
				continue
			}
			srcInfo, err := os.Stat(src)
			if err == nil && srcInfo.IsDir() {
				dstInfo, err := os.Stat(dst)
				if err == nil && dstInfo.IsDir() {
					conflicts = append(conflicts, name)
				}
			}
		}
	}

	if len(conflicts) > 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "conflict",
			"conflicts": conflicts,
		})
		return
	}

	operation := "copy"
	clipboardMutex.Lock()
	if len(paths) == len(currentClipboard.Sources) {
		match := true
		for i, p := range paths {
			if currentClipboard.Sources[i] != p {
				match = false
				break
			}
		}
		if match {
			operation = currentClipboard.Op
		}
	}
	clipboardMutex.Unlock()

	var lastErr error
	var pastedEntries []FileEntry

	// Optimization: Skip tracking details array on high volume loads to save disk syscall iterations
	trackEntries := len(paths) <= 100

	for _, src := range paths {
		name := filepath.Base(src)
		dst := filepath.Join(req.Dest, name)

		if src == dst || (isSourceDir(src) && isSubdir(src, dst)) {
			continue
		}

		if operation == "cut" {
			err = moveItem(src, dst)
			if err != nil {
				lastErr = err
			}
		} else {
			err = copyItem(src, dst)
			if err != nil {
				lastErr = err
			}
		}

		if lastErr == nil && trackEntries {
			info, err := os.Stat(dst)
			if err == nil {
				pastedEntries = append(pastedEntries, FileEntry{
					Name:    info.Name(),
					IsDir:   info.IsDir(),
					Size:    info.Size(),
					ModTime: info.ModTime().Unix(),
					Mode:    info.Mode().String(),
				})
			}
		}
	}

	if operation == "cut" && lastErr == nil {
		clipboardMutex.Lock()
		currentClipboard = ClipboardState{}
		clipboardMutex.Unlock()
		writeToSystemClipboard([]string{})
	}

	if lastErr != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Paste operation encountered errors: %v"}`, lastErr), http.StatusInternalServerError)
		return
	}

	logAction := ActionPasteCopy
	if operation == "cut" {
		logAction = ActionPasteMove
	}
	GetLog().Append(logAction, paths, req.Dest, "")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          "success",
		"operation":       operation,
		"sources":         paths,
		"entries":         pastedEntries,
		"reload_required": !trackEntries, // Tells UI to just clear view cache and reload directory contents safely
	})
}

func handleDelete(w http.ResponseWriter, sources []string) {
	var lastErr error
	var deleted []string
	for _, src := range sources {
		if err := os.RemoveAll(src); err != nil {
			lastErr = err
		} else {
			deleted = append(deleted, src)
		}
	}

	// Log only confirmed deletions — partial success is still logged
	if len(deleted) > 0 {
		GetLog().Append(ActionDelete, deleted, "", "")
	}

	if lastErr != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Delete failed: %v"}`, lastErr), http.StatusInternalServerError)
		return
	}

	w.Write([]byte(`{"status": "success"}`))
}

func handleRename(w http.ResponseWriter, sources []string, newName string) {
	if len(sources) == 0 || newName == "" {
		http.Error(w, `{"error": "Invalid rename arguments"}`, http.StatusBadRequest)
		return
	}

	if len(sources) == 1 {
		src := sources[0]
		dir := filepath.Dir(src)
		dst := filepath.Join(dir, newName)

		if src != dst {
			if err := os.Rename(src, dst); err != nil {
				http.Error(w, fmt.Sprintf(`{"error": "Rename failed: %v"}`, err), http.StatusInternalServerError)
				return
			}
			GetLog().Append(ActionRename, []string{src}, "", newName)
		}

		info, err := os.Stat(dst)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to stat renamed item: %v"}`, err), http.StatusInternalServerError)
			return
		}
		entry := FileEntry{
			Name:    info.Name(),
			IsDir:   info.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Unix(),
			Mode:    info.Mode().String(),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success",
			"entry":  entry,
		})
		return
	}

	// Batch rename path
	var parsedNames []string
	if err := json.Unmarshal([]byte(newName), &parsedNames); err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid JSON names array for batch rename: %v"}`, err), http.StatusBadRequest)
		return
	}

	if len(parsedNames) != len(sources) {
		http.Error(w, `{"error": "Mismatch between sources count and new names count"}`, http.StatusBadRequest)
		return
	}

	var renamedSources []string
	var renamedNewNames []string

	for i, src := range sources {
		name := parsedNames[i]
		if name == "" {
			continue // skip empty name renames
		}
		dir := filepath.Dir(src)
		dst := filepath.Join(dir, name)

		if src == dst {
			continue // skip renaming to itself
		}

		if err := os.Rename(src, dst); err != nil {
			if len(renamedSources) > 0 {
				serializedSuccess, _ := json.Marshal(renamedNewNames)
				GetLog().Append(ActionRename, renamedSources, "", string(serializedSuccess))
			}
			http.Error(w, fmt.Sprintf(`{"error": "Rename failed at %s -> %s: %v"}`, src, dst, err), http.StatusInternalServerError)
			return
		}

		// Update subsequent source paths in case a parent directory was renamed
		srcSlash := src + string(filepath.Separator)
		dstSlash := dst + string(filepath.Separator)
		for j := i + 1; j < len(sources); j++ {
			if strings.HasPrefix(sources[j], srcSlash) {
				sources[j] = dstSlash + strings.TrimPrefix(sources[j], srcSlash)
			}
		}

		renamedSources = append(renamedSources, src)
		renamedNewNames = append(renamedNewNames, name)
	}

	serializedResult, _ := json.Marshal(renamedNewNames)
	GetLog().Append(ActionRename, renamedSources, "", string(serializedResult))

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "success",
	})
}

func handleMkdir(w http.ResponseWriter, dest string, name string) {
	if dest == "" || name == "" {
		http.Error(w, `{"error": "Invalid directory arguments"}`, http.StatusBadRequest)
		return
	}

	target := filepath.Join(dest, name)
	if err := os.Mkdir(target, 0755); err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to create directory: %v"}`, err), http.StatusInternalServerError)
		return
	}

	// Log: sources empty (no pre-existing file), dest = parent, name = new dir name
	GetLog().Append(ActionMkdir, []string{}, dest, name)

	info, err := os.Stat(target)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to stat new directory: %v"}`, err), http.StatusInternalServerError)
		return
	}
	entry := FileEntry{
		Name:    info.Name(),
		IsDir:   info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime().Unix(),
		Mode:    info.Mode().String(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "success",
		"entry":  entry,
	})
}

// OS integration helper functions
func openWithDefaultApp(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "linux":
		cmd = exec.Command("xdg-open", path)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		return fmt.Errorf("unsupported operating system: %s", runtime.GOOS)
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	// CRITICAL FIX: Spin off a lightweight background monitor thread to reap
	// the application resource cleanly upon exit, preventing system zombie leaks.
	go func() {
		_ = cmd.Wait()
	}()

	return nil
}

func writeToSystemClipboard(paths []string) {
	var uris []string
	for _, p := range paths {
		u := &url.URL{
			Scheme: "file",
			Path:   p,
		}
		uris = append(uris, u.String())
	}
	data := strings.Join(uris, "\n")

	// Try Wayland wl-copy
	if _, err := exec.LookPath("wl-copy"); err == nil {
		cmd := exec.Command("wl-copy", "-t", "text/uri-list")
		cmd.Stdin = strings.NewReader(data)
		_ = cmd.Run()
		return
	}

	// Try X11 xclip
	if _, err := exec.LookPath("xclip"); err == nil {
		cmd := exec.Command("xclip", "-i", "-selection", "clipboard", "-t", "text/uri-list")
		cmd.Stdin = strings.NewReader(data)
		_ = cmd.Run()
		return
	}
}

func readFromSystemClipboard() ([]string, bool, error) {
	// Try Wayland wl-paste
	if _, err := exec.LookPath("wl-paste"); err == nil {
		cmd := exec.Command("wl-paste", "-t", "text/uri-list")
		out, err := cmd.Output()
		if err == nil {
			return parseURIList(string(out)), true, nil
		}
		// Fallback to plain text
		cmdFallback := exec.Command("wl-paste")
		outFallback, errFallback := cmdFallback.Output()
		if errFallback == nil {
			return parsePlainPaths(string(outFallback)), false, nil
		}
	}

	// Try X11 xclip
	if _, err := exec.LookPath("xclip"); err == nil {
		cmd := exec.Command("xclip", "-o", "-selection", "clipboard", "-t", "text/uri-list")
		out, err := cmd.Output()
		if err == nil {
			return parseURIList(string(out)), true, nil
		}
		// Fallback to plain text
		cmdFallback := exec.Command("xclip", "-o", "-selection", "clipboard")
		outFallback, errFallback := cmdFallback.Output()
		if errFallback == nil {
			return parsePlainPaths(string(outFallback)), false, nil
		}
	}

	return nil, false, fmt.Errorf("no clipboard utility found")
}

func parseURIList(data string) []string {
	var paths []string
	lines := strings.Split(data, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "file://") {
			p := strings.TrimPrefix(line, "file://")
			if decoded, err := url.PathUnescape(p); err == nil {
				p = decoded
			}
			paths = append(paths, filepath.Clean(p))
		}
	}
	return paths
}

func parsePlainPaths(data string) []string {
	var paths []string
	lines := strings.Split(data, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if filepath.IsAbs(line) {
			if _, err := os.Stat(line); err == nil {
				paths = append(paths, filepath.Clean(line))
			}
		}
	}
	return paths
}

// File/Dir Copy Helpers
func copyFile(src, dst string) error {
	// If destination file already exists, skip it or handle as conflict
	if _, err := os.Stat(dst); err == nil {
		return nil // Avoid clobbering existing target data during a merge
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	if err != nil {
		return err
	}

	info, err := os.Stat(src)
	if err == nil {
		return os.Chmod(dst, info.Mode())
	}
	return nil
}

func copyDir(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}

	err = os.MkdirAll(dst, info.Mode())
	if err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			err = copyDir(srcPath, dstPath)
		} else {
			err = copyFile(srcPath, dstPath)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func moveItem(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	// Uniform Safety Guard: Prevent overwriting existing files blindly on both local and cross-device environments
	if !srcInfo.IsDir() {
		if dstInfo, err := os.Stat(dst); err == nil && !dstInfo.IsDir() {
			return fmt.Errorf("file already exists at destination: %s", dst)
		}
	}

	// 1. Try the instant OS rename first (works if dst directory or file doesn't exist)
	err = os.Rename(src, dst)
	if err == nil {
		return nil
	}

	// 2. If it failed because the destination directory already exists, merge them instantly
	if srcInfo.IsDir() {
		dstStat, dstErr := os.Stat(dst)
		if dstErr == nil && dstStat.IsDir() {
			return mergeDirViaRename(src, dst)
		}
	}

	// 3. True Cross-device fallback (different partitions/drives)
	if srcInfo.IsDir() {
		// CRITICAL FIX: Ensure target directory path shell is fully initialized on target partition first
		if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
			return err
		}

		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			subSrc := filepath.Join(src, entry.Name())
			subDst := filepath.Join(dst, entry.Name())
			if err := moveItem(subSrc, subDst); err != nil {
				return err
			}
		}

		// Only remove the source directory shell if it is now completely empty
		if remaining, err := os.ReadDir(src); err == nil && len(remaining) == 0 {
			return os.Remove(src)
		}
		return nil
	}

	// For standard file cross-device migration
	err = copyFile(src, dst)
	if err != nil {
		return err
	}
	return os.Remove(src)
}

// mergeDirViaRename loops through immediate assets and renames them individually.
// This preserves the instant "pointer-swap" speed for the 5,000 files inside.
func mergeDirViaRename(srcDir, dstDir string) error {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return err
	}

	// Channel to collect errors from goroutines
	errChan := make(chan error, len(entries))
	var wg sync.WaitGroup

	// Limit concurrency so we don't overwhelm OS file descriptors
	sem := make(chan struct{}, 64)

	for _, entry := range entries {
		wg.Add(1)
		go func(e os.DirEntry) {
			defer wg.Done()
			sem <- struct{}{}        // Acquire token
			defer func() { <-sem }() // Release token

			subSrc := filepath.Join(srcDir, e.Name())
			subDst := filepath.Join(dstDir, e.Name())

			if err := moveItem(subSrc, subDst); err != nil {
				errChan <- err
			}
		}(entry)
	}

	wg.Wait()
	close(errChan)

	// Check if any goroutine encountered an error
	if len(errChan) > 0 {
		return <-errChan
	}

	return os.Remove(srcDir)
}

func copyItem(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return copyDir(src, dst)
	}
	return copyFile(src, dst)
}

func isSourceDir(src string) bool {
	fi, err := os.Stat(src)
	return err == nil && fi.IsDir()
}

func isSubdir(parent, child string) bool {
	parent = filepath.Clean(parent)
	child = filepath.Clean(child)
	if parent == child {
		return true
	}
	parentWithSlash := parent + string(filepath.Separator)
	return strings.HasPrefix(child, parentWithSlash)
}

func handleChmod(w http.ResponseWriter, sources []string, modeStr string) {
	if len(sources) == 0 || modeStr == "" {
		http.Error(w, `{"error": "Invalid chmod arguments"}`, http.StatusBadRequest)
		return
	}

	modeNum, err := strconv.ParseUint(modeStr, 8, 32)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid permission mode: %v"}`, err), http.StatusBadRequest)
		return
	}

	mode := os.FileMode(modeNum)
	var lastErr error
	for _, src := range sources {
		if err := os.Chmod(src, mode); err != nil {
			lastErr = err
		}
	}

	if lastErr != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Chmod failed: %v"}`, lastErr), http.StatusInternalServerError)
		return
	}

	GetLog().Append(ActionChmod, sources, "", modeStr)

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status": "success"}`))
}
