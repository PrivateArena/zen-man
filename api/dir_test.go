package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHandleReadDirectoryPerformance(t *testing.T) {
	// 1. Create a temporary directory
	tempDir, err := os.MkdirTemp("", "zenman_perf_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// 2. Populate it with 10,000 mock files
	t.Log("Generating 10,000 test files in temp directory...")
	for i := 0; i < 10000; i++ {
		fileName := fmt.Sprintf("file_%05d.txt", i)
		filePath := filepath.Join(tempDir, fileName)
		err := os.WriteFile(filePath, []byte(""), 0644)
		if err != nil {
			t.Fatalf("Failed to create test file %d: %v", i, err)
		}
	}

	// 3. Measure directory read duration
	req, err := http.NewRequest("GET", fmt.Sprintf("/api/dir?path=%s&limit=200", tempDir), nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}

	rr := httptest.NewRecorder()
	handler := http.HandlerFunc(HandleReadDirectory)

	t.Log("Starting read operation benchmark...")
	start := time.Now()
	handler.ServeHTTP(rr, req)
	duration := time.Since(start)

	t.Logf("Directory read completed in: %v", duration)

	// 4. Verify performance and correctness
	if duration > 100*time.Millisecond {
		t.Errorf("Performance target missed: directory read took %v, expected < 100ms", duration)
	}

	if rr.Code != http.StatusOK {
		t.Errorf("Expected status code 200, got %d. Body: %s", rr.Code, rr.Body.String())
	}

	var resp DirResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if len(resp.Entries) != 200 {
		t.Errorf("Expected exactly 200 entries, got %d", len(resp.Entries))
	}

	if !resp.HasMore {
		t.Errorf("Expected has_more to be true")
	}

	if resp.TotalCount != 10000 {
		t.Errorf("Expected total count to be 10000, got %d", resp.TotalCount)
	}
}
