package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// OpRequest defines the payload schema for file operations
type OpRequest struct {
	Op      string   `json:"op"`
	Sources []string `json:"sources"`
	Dest    string   `json:"dest"`
	Name    string   `json:"name"`
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

	switch req.Op {
	case "open":
		handleOpen(w, req.Sources)
	case "copy":
		handleClipboardSet(w, "copy", req.Sources)
	case "cut":
		handleClipboardSet(w, "cut", req.Sources)
	case "paste":
		handlePaste(w, req)
	case "delete":
		handleDelete(w, req.Sources)
	case "rename":
		handleRename(w, req.Sources, req.Name)
	case "mkdir":
		handleMkdir(w, req.Dest, req.Name)
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

	w.Write([]byte(`{"status": "success"}`))
}

func handlePaste(w http.ResponseWriter, req OpRequest) {
	if req.Dest == "" {
		http.Error(w, `{"error": "Destination folder not specified"}`, http.StatusBadRequest)
		return
	}

	// 1. Try to read from system clipboard
	paths, err := readFromSystemClipboard()
	
	// Fall back to internal state if system clipboard is empty or fails
	clipboardMutex.Lock()
	if err != nil || len(paths) == 0 {
		paths = currentClipboard.Sources
	}
	
	if len(paths) == 0 {
		clipboardMutex.Unlock()
		http.Error(w, `{"error": "Clipboard is empty"}`, http.StatusBadRequest)
		return
	}

	// Check if this matches internal sources to determine operation
	operation := "copy"
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
	for _, src := range paths {
		name := filepath.Base(src)
		dst := filepath.Join(req.Dest, name)

		// Don't copy/move into itself
		if src == dst {
			continue
		}

		if operation == "cut" {
			err := moveItem(src, dst)
			if err != nil {
				lastErr = err
			}
		} else {
			err := copyItem(src, dst)
			if err != nil {
				lastErr = err
			}
		}
	}

	// Clear internal clipboard on successful cut move
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

	w.Write([]byte(`{"status": "success"}`))
}

func handleDelete(w http.ResponseWriter, sources []string) {
	var lastErr error
	for _, src := range sources {
		err := os.RemoveAll(src)
		if err != nil {
			lastErr = err
		}
	}

	if lastErr != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Delete failed: %v"}`, lastErr), http.StatusInternalServerError)
		return
	}

	w.Write([]byte(`{"status": "success"}`))
}

func handleRename(w http.ResponseWriter, sources []string, newName string) {
	if len(sources) != 1 || newName == "" {
		http.Error(w, `{"error": "Invalid rename arguments"}`, http.StatusBadRequest)
		return
	}
	src := sources[0]
	dir := filepath.Dir(src)
	dst := filepath.Join(dir, newName)

	if err := os.Rename(src, dst); err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Rename failed: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Write([]byte(`{"status": "success"}`))
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

	w.Write([]byte(`{"status": "success"}`))
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
	return cmd.Start()
}

func writeToSystemClipboard(paths []string) {
	var uris []string
	for _, p := range paths {
		uris = append(uris, "file://"+p)
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

func readFromSystemClipboard() ([]string, error) {
	// Try Wayland wl-paste
	if _, err := exec.LookPath("wl-paste"); err == nil {
		cmd := exec.Command("wl-paste", "-t", "text/uri-list")
		out, err := cmd.Output()
		if err == nil {
			return parseURIList(string(out)), nil
		}
		// Fallback to plain text
		cmdFallback := exec.Command("wl-paste")
		outFallback, errFallback := cmdFallback.Output()
		if errFallback == nil {
			return parsePlainPaths(string(outFallback)), nil
		}
	}

	// Try X11 xclip
	if _, err := exec.LookPath("xclip"); err == nil {
		cmd := exec.Command("xclip", "-o", "-selection", "clipboard", "-t", "text/uri-list")
		out, err := cmd.Output()
		if err == nil {
			return parseURIList(string(out)), nil
		}
		// Fallback to plain text
		cmdFallback := exec.Command("xclip", "-o", "-selection", "clipboard")
		outFallback, errFallback := cmdFallback.Output()
		if errFallback == nil {
			return parsePlainPaths(string(outFallback)), nil
		}
	}

	return nil, fmt.Errorf("no clipboard utility found")
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
	err := os.Rename(src, dst)
	if err == nil {
		return nil
	}

	// Cross-device fallback
	err = copyItem(src, dst)
	if err != nil {
		return err
	}
	return os.RemoveAll(src)
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
