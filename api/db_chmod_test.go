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

func TestDBCache(t *testing.T) {
	err := InitDB()
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}

	testPath := "/some/fake/path/to/folder"
	size := int64(102400)
	count := int64(12)

	err = SaveCachedDirSize(testPath, size, count)
	if err != nil {
		t.Fatalf("SaveCachedDirSize failed: %v", err)
	}

	cachedSize, cachedCount, ok := GetCachedDirSize(testPath)
	if !ok {
		t.Fatalf("Cache hit failed")
	}
	if cachedSize != size || cachedCount != count {
		t.Errorf("Cache mismatch: got %d size and %d count, expected %d size and %d count", cachedSize, cachedCount, size, count)
	}
}

func TestHandleChmod(t *testing.T) {
	tempFile, err := os.CreateTemp("", "zenman_chmod_test_*.txt")
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}
	defer os.Remove(tempFile.Name())
	tempFile.Close()

	reqBody := OpRequest{
		Op:      "chmod",
		Sources: []string{tempFile.Name()},
		Name:    "600",
	}

	bodyBytes, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/op", bytes.NewReader(bodyBytes))
	rr := httptest.NewRecorder()

	HandleFileOp(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Expected status code 200, got %d. Body: %s", rr.Code, rr.Body.String())
	}

	info, err := os.Stat(tempFile.Name())
	if err != nil {
		t.Fatalf("Failed to stat temp file: %v", err)
	}
	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("Expected permissions 0600, got %o", perm)
	}
}

func TestCalculateDirSizeRecursive(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "zenman_walk_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	subDir := filepath.Join(tempDir, "subdir")
	if err := os.Mkdir(subDir, 0755); err != nil {
		t.Fatalf("Failed to create subdir: %v", err)
	}

	fileA := filepath.Join(tempDir, "fileA.txt")
	os.WriteFile(fileA, []byte("123"), 0644) // 3 bytes

	fileB := filepath.Join(subDir, "fileB.txt")
	os.WriteFile(fileB, []byte("12345"), 0644) // 5 bytes

	size, count, err := CalculateDirSize(tempDir)
	if err != nil {
		t.Fatalf("CalculateDirSize failed: %v", err)
	}

	if size != 8 || count != 2 {
		t.Errorf("Expected root size 8 and count 2, got size %d and count %d", size, count)
	}

	subCachedSize, subCachedCount, ok := GetCachedDirSize(subDir)
	if !ok {
		t.Fatalf("Subdir cache hit failed")
	}
	if subCachedSize != 5 || subCachedCount != 1 {
		t.Errorf("Expected subdir size 5 and count 1, got size %d and count %d", subCachedSize, subCachedCount)
	}
}
