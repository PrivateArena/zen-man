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

func TestHandlePasteInside(t *testing.T) {
	// Create a temporary directory structure
	tempDir, err := os.MkdirTemp("", "zenman_paste_inside_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	folderA := filepath.Join(tempDir, "FolderA")
	if err := os.Mkdir(folderA, 0755); err != nil {
		t.Fatalf("Failed to create FolderA: %v", err)
	}
	file1 := filepath.Join(folderA, "file1.txt")
	os.WriteFile(file1, []byte("hello"), 0644)

	folderB := filepath.Join(tempDir, "FolderB")
	if err := os.Mkdir(folderB, 0755); err != nil {
		t.Fatalf("Failed to create FolderB: %v", err)
	}

	// 1. Cut Inside FolderA
	reqBody := OpRequest{
		Op:      "cut_inside",
		Sources: []string{folderA},
	}
	bodyBytes, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/op", bytes.NewReader(bodyBytes))
	rr := httptest.NewRecorder()
	HandleFileOp(rr, req)

	// 2. Paste to FolderB
	reqPaste := OpRequest{
		Op:   "paste",
		Dest: folderB,
	}
	pasteBytes, _ := json.Marshal(reqPaste)
	reqP, _ := http.NewRequest("POST", "/api/op", bytes.NewReader(pasteBytes))
	rrP := httptest.NewRecorder()
	HandleFileOp(rrP, reqP)

	if rrP.Code != http.StatusOK {
		t.Fatalf("Expected status code 200, got %d. Body: %s", rrP.Code, rrP.Body.String())
	}

	// Verify file was moved
	movedFile := filepath.Join(folderB, "file1.txt")
	if _, err := os.Stat(movedFile); os.IsNotExist(err) {
		t.Errorf("Expected file1.txt to be moved to %s, but it does not exist", folderB)
	}
	if _, err := os.Stat(file1); !os.IsNotExist(err) {
		t.Errorf("Expected file1.txt to be removed from %s, but it still exists", folderA)
	}
}

func TestParseURIListPercentDecoding(t *testing.T) {
	data := "file:///media/jang/exhdd/Kontakt/Evolution%20Rock%20Standard%201.3.0%20%5BOrange%20Tree%20Samples%5D/Samples/Evolution%20Rock%20Standard_0/Samples/Bridge_SwoopUp_rr2.flac\n"
	expected := "/media/jang/exhdd/Kontakt/Evolution Rock Standard 1.3.0 [Orange Tree Samples]/Samples/Evolution Rock Standard_0/Samples/Bridge_SwoopUp_rr2.flac"
	got := parseURIList(data)
	if len(got) != 1 {
		t.Fatalf("Expected 1 path, got %d", len(got))
	}
	if got[0] != filepath.Clean(expected) {
		t.Errorf("Expected %q, got %q", expected, got[0])
	}
}
