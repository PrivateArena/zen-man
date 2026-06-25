package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// BenchmarkParseSearchQuery benchmarks query parser DSL filters
func BenchmarkParseSearchQuery(b *testing.B) {
	query := "hello world ext:pdf in:\"/home/user/my space\" type:dir"
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = ParseSearchQuery(query)
	}
}

// BenchmarkExecuteSearch benchmarks SQLite index lookup speeds with varying search terms
func BenchmarkExecuteSearch(b *testing.B) {
	DBPathOverride = filepath.Join(b.TempDir(), "zen-man-bench.db")
	ConfigPathOverride = filepath.Join(b.TempDir(), "search-config-bench.json")

	if db != nil {
		db.Close()
		db = nil
	}

	err := InitDB()
	if err != nil {
		b.Fatalf("Failed to init DB: %v", err)
	}

	tempDir, err := os.MkdirTemp("", "zenman_bench_search_*")
	if err != nil {
		b.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Populate the index table with 10,000 mock files
	tx, err := db.Begin()
	if err != nil {
		b.Fatalf("failed to start transaction: %v", err)
	}
	_, _ = tx.Exec("DELETE FROM files")
	stmt, err := tx.Prepare(`
		INSERT INTO files (path, name, name_orig, ext, parent, size, mtime, is_dir, is_symlink)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		b.Fatalf("failed to prepare statement: %v", err)
	}

	for i := 0; i < 10000; i++ {
		name := fmt.Sprintf("file_%d.txt", i)
		if i%10 == 0 {
			name = fmt.Sprintf("report_%d.pdf", i)
		}
		path := filepath.Join(tempDir, name)
		_, err = stmt.Exec(path, name, name, filepath.Ext(name), tempDir, int64(100*i), int64(1750000000+i), 0, 0)
		if err != nil {
			tx.Rollback()
			b.Fatalf("failed to insert: %v", err)
		}
	}
	stmt.Close()
	err = tx.Commit()
	if err != nil {
		b.Fatalf("failed to commit mock data: %v", err)
	}

	// Benchmark simple substring query matching 1,000 items
	pq := ParseSearchQuery("report")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _, _ = ExecuteSearch(pq, 100, 0)
	}
}

// BenchmarkIndexerThroughput benchmarks walker + batch insert speed
func BenchmarkIndexerThroughput(b *testing.B) {
	DBPathOverride = filepath.Join(b.TempDir(), "zen-man-bench.db")
	ConfigPathOverride = filepath.Join(b.TempDir(), "search-config-bench.json")

	if db != nil {
		db.Close()
		db = nil
	}

	err := InitDB()
	if err != nil {
		b.Fatalf("Failed to init DB: %v", err)
	}

	tempDir, err := os.MkdirTemp("", "zenman_bench_walk_*")
	if err != nil {
		b.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Generate 2,000 files physically
	for i := 0; i < 2000; i++ {
		subDir := filepath.Join(tempDir, fmt.Sprintf("dir_%d", i%10))
		os.MkdirAll(subDir, 0755)
		filePath := filepath.Join(subDir, fmt.Sprintf("file_%d.dat", i))
		_ = os.WriteFile(filePath, []byte("some content"), 0644)
	}

	im := GetIndexManager()
	im.Mutex.Lock()
	im.Config.Roots = []string{tempDir}
	im.Config.Excludes = nil
	im.Config.WorkerCount = 2
	im.Mutex.Unlock()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// Run rebuild index
		err = im.runRebuild(context.Background())
		if err != nil {
			b.Fatalf("Rebuild index benchmark failed: %v", err)
		}
	}
}
