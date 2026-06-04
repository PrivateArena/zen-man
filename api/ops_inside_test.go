package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandleFileOpInside(t *testing.T) {
	// Create a temporary directory structure
	tempDir, err := os.MkdirTemp("", "zenman_inside_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	folderA := filepath.Join(tempDir, "FolderA")
	if err := os.Mkdir(folderA, 0755); err != nil {
		t.Fatalf("Failed to create FolderA: %v", err)
	}

	file1 := filepath.Join(folderA, "file1.txt")
	if err := os.WriteFile(file1, []byte("hello"), 0644); err != nil {
		t.Fatalf("Failed to write file1.txt: %v", err)
	}

	file2 := filepath.Join(folderA, "file2.txt")
	if err := os.WriteFile(file2, []byte("world"), 0644); err != nil {
		t.Fatalf("Failed to write file2.txt: %v", err)
	}

	// 1. Test copy_inside on FolderA
	reqBody := OpRequest{
		Op:      "copy_inside",
		Sources: []string{folderA},
	}
	bodyBytes, _ := json.Marshal(reqBody)
	req, err := http.NewRequest("POST", "/api/op", bytes.NewReader(bodyBytes))
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}

	rr := httptest.NewRecorder()
	handler := http.HandlerFunc(HandleFileOp)
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Expected status code 200, got %d. Body: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Status string                   `json:"status"`
		Op     string                   `json:"op"`
		Items  []map[string]interface{} `json:"items"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if resp.Status != "success" {
		t.Errorf("Expected status success, got %s", resp.Status)
	}
	if resp.Op != "copy" {
		t.Errorf("Expected op copy, got %s", resp.Op)
	}
	if len(resp.Items) != 2 {
		t.Errorf("Expected 2 items in clipboard response, got %d", len(resp.Items))
	}

	// Verify clipboard items metadata
	hasFile1 := false
	hasFile2 := false
	for _, item := range resp.Items {
		name := item["name"].(string)
		if name == "file1.txt" {
			hasFile1 = true
		} else if name == "file2.txt" {
			hasFile2 = true
		}
	}
	if !hasFile1 || !hasFile2 {
		t.Errorf("Clipboard items metadata missing file1 or file2: %+v", resp.Items)
	}

	// 2. Test copy_inside on an empty folder (should return error)
	folderEmpty := filepath.Join(tempDir, "EmptyFolder")
	if err := os.Mkdir(folderEmpty, 0755); err != nil {
		t.Fatalf("Failed to create EmptyFolder: %v", err)
	}

	reqBodyEmpty := OpRequest{
		Op:      "copy_inside",
		Sources: []string{folderEmpty},
	}
	bodyBytesEmpty, _ := json.Marshal(reqBodyEmpty)
	reqEmpty, _ := http.NewRequest("POST", "/api/op", bytes.NewReader(bodyBytesEmpty))
	rrEmpty := httptest.NewRecorder()
	handler.ServeHTTP(rrEmpty, reqEmpty)

	if rrEmpty.Code != http.StatusBadRequest {
		t.Errorf("Expected status code 400 for empty folder copy inside, got %d", rrEmpty.Code)
	}
}

func TestIsSubdir(t *testing.T) {
	tests := []struct {
		parent string
		child  string
		want   bool
	}{
		{"/a/b", "/a/b", true},
		{"/a/b", "/a/b/c", true},
		{"/a/b", "/a/bc", false},
		{"/a/b", "/a/b/../b", true},
		{"/a/b", "/a/b/../b/c", true},
	}

	for _, tt := range tests {
		got := isSubdir(tt.parent, tt.child)
		if got != tt.want {
			t.Errorf("isSubdir(%q, %q) = %v; want %v", tt.parent, tt.child, got, tt.want)
		}
	}
}
