package api

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// createTestZip generates a zip archive in memory and returns its bytes.
func createTestZip(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	for name, content := range files {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatalf("Failed to create zip entry %s: %v", name, err)
		}
		if _, err := f.Write([]byte(content)); err != nil {
			t.Fatalf("Failed to write content for %s: %v", name, err)
		}
	}

	if err := zw.Close(); err != nil {
		t.Fatalf("Failed to close zip writer: %v", err)
	}

	return buf.Bytes()
}

func TestArchiveVFS_ManifestAndEviction(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "archive-vfs-test")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create test zip files
	files := map[string]string{
		"file1.txt":      "hello world",
		"dir1/file2.txt": "hello nested",
		"dir1/dir2/f.go": "package main",
	}
	zipBytes := createTestZip(t, files)

	archivePath := filepath.Join(tmpDir, "test.zip")
	if err := os.WriteFile(archivePath, zipBytes, 0644); err != nil {
		t.Fatalf("Failed to write test zip: %v", err)
	}

	// Build manifest
	manifest, err := BuildManifest(archivePath, "")
	if err != nil {
		t.Fatalf("BuildManifest failed: %v", err)
	}

	// Verify entries exist
	expected := []string{"file1.txt", "dir1", "dir1/file2.txt", "dir1/dir2", "dir1/dir2/f.go"}
	for _, exp := range expected {
		if _, exists := manifest.Nodes[exp]; !exists {
			t.Errorf("Expected node %s to exist in manifest", exp)
		}
	}

	// Verify child links
	dir1 := manifest.Nodes["dir1"]
	if dir1 == nil || !dir1.IsDir {
		t.Fatalf("dir1 node is missing or is not directory")
	}
	if len(dir1.Children) != 2 {
		t.Errorf("Expected dir1 to have 2 children, got %d", len(dir1.Children))
	}

	// Verify GetCache / PutCache
	cacheKey := BuildCacheKey(archivePath, "")
	cached, ok := GetCache(cacheKey)
	if !ok || cached != manifest {
		t.Error("Failed to retrieve manifest from cache")
	}

	// Test cache invalidation on modified mtime
	// Change mtime of archive file
	err = os.Chtimes(archivePath, time.Now(), time.Now().Add(1*time.Hour))
	if err != nil {
		t.Fatalf("Failed to change mtime: %v", err)
	}

	_, err = OpenAndVerify(archivePath, manifest.HostMtime)
	if err == nil || err.Error() != "archive_modified" {
		t.Errorf("Expected OpenAndVerify to return archive_modified error, got %v", err)
	}
}

func TestArchiveVFS_NestedArchive(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "archive-vfs-nested")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Create inner zip
	innerFiles := map[string]string{
		"nested_file.txt": "inner data",
	}
	innerZipBytes := createTestZip(t, innerFiles)

	// Create outer zip containing the inner zip
	outerFiles := map[string]string{
		"outer_file.txt": "outer data",
		"inner.zip":      string(innerZipBytes),
	}
	outerZipBytes := createTestZip(t, outerFiles)

	outerPath := filepath.Join(tmpDir, "outer.zip")
	if err := os.WriteFile(outerPath, outerZipBytes, 0644); err != nil {
		t.Fatalf("Failed to write outer zip: %v", err)
	}

	// Build manifest for nested inner.zip
	manifest, err := BuildManifest(outerPath, "inner.zip")
	if err != nil {
		t.Fatalf("Failed to build nested manifest: %v", err)
	}

	if _, exists := manifest.Nodes["nested_file.txt"]; !exists {
		t.Error("nested_file.txt not found inside nested archive manifest")
	}

	node := manifest.Nodes["nested_file.txt"]
	if node.Size != int64(len("inner data")) {
		t.Errorf("Expected nested_file.txt size to be %d, got %d", len("inner data"), node.Size)
	}
}

func TestArchiveVFS_ZipSlip(t *testing.T) {
	destDir := "/safe/path"

	// Test safe path
	path, err := safeDestPath(destDir, "dir/file.txt")
	if err != nil {
		t.Fatalf("safeDestPath failed: %v", err)
	}
	expected := filepath.Clean("/safe/path/dir/file.txt")
	if path != expected {
		t.Errorf("Expected %s, got %s", expected, path)
	}

	// Test Zip Slip attempt
	_, err = safeDestPath(destDir, "../dangerous/file.txt")
	if err == nil {
		t.Error("Expected error for Zip Slip traversal path, got nil")
	} else if !strings.Contains(err.Error(), "zip slip") {
		t.Errorf("Expected zip slip error message, got: %v", err)
	}
}

func TestArchiveVFS_Extract(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "archive-vfs-extract")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	files := map[string]string{
		"file1.txt":      "hello world",
		"dir1/file2.txt": "hello nested",
	}
	zipBytes := createTestZip(t, files)

	archivePath := filepath.Join(tmpDir, "test.zip")
	if err := os.WriteFile(archivePath, zipBytes, 0644); err != nil {
		t.Fatalf("Failed to write test zip: %v", err)
	}

	manifest, err := BuildManifest(archivePath, "")
	if err != nil {
		t.Fatalf("BuildManifest failed: %v", err)
	}

	var nodes []*VirtualNode
	for _, n := range manifest.Nodes {
		nodes = append(nodes, n)
	}

	destExtract := filepath.Join(tmpDir, "extracted")
	job := &ExtractJob{
		ID:         "test_job",
		BytesTotal: 100,
	}

	ctx := context.Background()
	err = performExtract(ctx, archivePath, "", destExtract, nodes, job)
	if err != nil {
		t.Fatalf("performExtract failed: %v", err)
	}

	// Check extracted files
	f1Data, err := os.ReadFile(filepath.Join(destExtract, "file1.txt"))
	if err != nil {
		t.Fatalf("Failed to read extracted file1: %v", err)
	}
	if string(f1Data) != "hello world" {
		t.Errorf("Expected content 'hello world', got '%s'", string(f1Data))
	}

	f2Data, err := os.ReadFile(filepath.Join(destExtract, "dir1/file2.txt"))
	if err != nil {
		t.Fatalf("Failed to read extracted file2: %v", err)
	}
	if string(f2Data) != "hello nested" {
		t.Errorf("Expected content 'hello nested', got '%s'", string(f2Data))
	}
}
