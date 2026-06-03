package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandleReadDirectoryFlat(t *testing.T) {
	// 1. Create a temporary directory structure
	tempDir, err := os.MkdirTemp("", "zenman_flat_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create subdirectories and files
	// root/file1.txt
	// root/sub1/file2.txt
	// root/sub1/sub2/file3.txt
	err = os.WriteFile(filepath.Join(tempDir, "file1.txt"), []byte(""), 0644)
	if err != nil {
		t.Fatalf("failed to create file1: %v", err)
	}

	sub1 := filepath.Join(tempDir, "sub1")
	err = os.Mkdir(sub1, 0755)
	if err != nil {
		t.Fatalf("failed to create sub1: %v", err)
	}
	err = os.WriteFile(filepath.Join(sub1, "file2.txt"), []byte(""), 0644)
	if err != nil {
		t.Fatalf("failed to create file2: %v", err)
	}

	sub2 := filepath.Join(sub1, "sub2")
	err = os.Mkdir(sub2, 0755)
	if err != nil {
		t.Fatalf("failed to create sub2: %v", err)
	}
	err = os.WriteFile(filepath.Join(sub2, "file3.txt"), []byte(""), 0644)
	if err != nil {
		t.Fatalf("failed to create file3: %v", err)
	}

	// 2. Test recursive walk (mixed)
	req, err := http.NewRequest("GET", fmt.Sprintf("/api/dir?path=%s&flat=true", tempDir), nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}
	rr := httptest.NewRecorder()
	handler := http.HandlerFunc(HandleReadDirectory)
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", rr.Code, rr.Body.String())
	}

	var resp DirResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	// Mixed flat view should include the 3 files plus sub1 and sub1/sub2 directories
	// Total expected: 5 items (file1.txt, sub1, sub1/file2.txt, sub1/sub2, sub1/sub2/file3.txt)
	if len(resp.Entries) != 5 {
		t.Errorf("Expected 5 entries, got %d. Entries: %+v", len(resp.Entries), resp.Entries)
	}

	// Verify rel_path is set
	hasRelPaths := true
	for _, entry := range resp.Entries {
		if entry.RelPath == "" {
			hasRelPaths = false
		}
	}
	if !hasRelPaths {
		t.Errorf("Expected rel_path to be populated for all flat items, got empty: %+v", resp.Entries)
	}

	// 3. Test recursive walk (no folders)
	req2, err := http.NewRequest("GET", fmt.Sprintf("/api/dir?path=%s&flat=true&no_folders=true", tempDir), nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}
	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req2)

	var resp2 DirResponse
	if err := json.NewDecoder(rr2.Body).Decode(&resp2); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	// Mixed No Folders should filter out folders: only file1.txt, sub1/file2.txt, sub1/sub2/file3.txt
	// Total expected: 3 items
	if len(resp2.Entries) != 3 {
		t.Errorf("Expected 3 entries, got %d", len(resp2.Entries))
	}
	for _, entry := range resp2.Entries {
		if entry.IsDir {
			t.Errorf("Expected no directory entries in no_folders mode, but got: %s", entry.Name)
		}
	}
}
