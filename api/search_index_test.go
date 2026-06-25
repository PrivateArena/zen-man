package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseSearchQuery(t *testing.T) {
	tests := []struct {
		input    string
		expected ParsedQuery
	}{
		{
			input: "hello world ext:pdf in:\"/home/user/my space\" type:dir",
			expected: ParsedQuery{
				Words:      []string{"hello", "world"},
				Extensions: []string{"pdf"},
				Folders:    []string{"/home/user/my space"},
				TypeFilter: "dir",
			},
		},
		{
			input: "report ext:tar.gz type:file",
			expected: ParsedQuery{
				Words:      []string{"report"},
				Extensions: []string{"tar.gz"},
				Folders:    nil,
				TypeFilter: "file",
			},
		},
		{
			input: "just words",
			expected: ParsedQuery{
				Words:      []string{"just", "words"},
				Extensions: nil,
				Folders:    nil,
				TypeFilter: "any",
			},
		},
	}

	for i, tt := range tests {
		t.Run(fmt.Sprintf("Case_%d", i), func(t *testing.T) {
			got := ParseSearchQuery(tt.input)
			if len(got.Words) != len(tt.expected.Words) {
				t.Fatalf("expected words %v, got %v", tt.expected.Words, got.Words)
			}
			for j, w := range got.Words {
				if w != tt.expected.Words[j] {
					t.Errorf("word mismatch: expected %q, got %q", tt.expected.Words[j], w)
				}
			}

			if len(got.Extensions) != len(tt.expected.Extensions) {
				t.Fatalf("expected extensions %v, got %v", tt.expected.Extensions, got.Extensions)
			}
			for j, ext := range got.Extensions {
				if ext != tt.expected.Extensions[j] {
					t.Errorf("extension mismatch: expected %q, got %q", tt.expected.Extensions[j], ext)
				}
			}

			if len(got.Folders) != len(tt.expected.Folders) {
				t.Fatalf("expected folders %v, got %v", tt.expected.Folders, got.Folders)
			}
			for j, f := range got.Folders {
				if f != tt.expected.Folders[j] {
					t.Errorf("folder mismatch: expected %q, got %q", tt.expected.Folders[j], f)
				}
			}

			if got.TypeFilter != tt.expected.TypeFilter {
				t.Errorf("type filter mismatch: expected %q, got %q", tt.expected.TypeFilter, got.TypeFilter)
			}
		})
	}
}

func TestCompileExcludes(t *testing.T) {
	excludes := []string{
		"**/.git",
		"**/node_modules",
		"/tmp/test",
	}

	res := compileExcludes(excludes)
	if len(res) != 3 {
		t.Fatalf("Expected 3 compiled regexes, got %d", len(res))
	}

	tests := []struct {
		path     string
		expected bool
	}{
		{"/home/user/project/.git", true},
		{"/home/user/project/.git/config", true},
		{"/home/user/node_modules/express", true},
		{"/tmp/test/file.txt", true},
		{"/home/user/mygit/config", false},
	}

	for _, tt := range tests {
		matched := false
		for _, re := range res {
			if re.MatchString(tt.path) {
				matched = true
				break
			}
		}
		if matched != tt.expected {
			t.Errorf("Path %q match status: expected %v, got %v", tt.path, tt.expected, matched)
		}
	}
}

func TestIndexRebuildAndSearch(t *testing.T) {
	DBPathOverride = filepath.Join(t.TempDir(), "zen-man-test.db")
	ConfigPathOverride = filepath.Join(t.TempDir(), "search-config-test.json")

	if db != nil {
		db.Close()
		db = nil
	}

	// Initialize database first
	err := InitDB()
	if err != nil {
		t.Fatalf("Failed to init DB: %v", err)
	}

	tempDir, err := os.MkdirTemp("", "zenman_search_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a dummy structure
	// tempDir/docs/report.pdf
	// tempDir/docs/notes.txt
	// tempDir/src/main.go
	// tempDir/src/node_modules/leftpad/index.js
	os.MkdirAll(filepath.Join(tempDir, "docs"), 0755)
	os.MkdirAll(filepath.Join(tempDir, "src"), 0755)
	os.MkdirAll(filepath.Join(tempDir, "src", "node_modules", "leftpad"), 0755)

	os.WriteFile(filepath.Join(tempDir, "docs", "report.pdf"), []byte("PDF content"), 0644)
	os.WriteFile(filepath.Join(tempDir, "docs", "notes.txt"), []byte("txt content"), 0644)
	os.WriteFile(filepath.Join(tempDir, "src", "main.go"), []byte("go content"), 0644)
	os.WriteFile(filepath.Join(tempDir, "src", "node_modules", "leftpad", "index.js"), []byte("js content"), 0644)

	im := GetIndexManager()
	im.Mutex.Lock()
	im.Config.Roots = []string{tempDir}
	im.Config.Excludes = []string{"**/node_modules"}
	im.Config.WorkerCount = 2
	im.Mutex.Unlock()

	err = im.runRebuild(context.Background())
	if err != nil {
		t.Fatalf("rebuild index failed: %v", err)
	}

	// Wait briefly
	time.Sleep(100 * time.Millisecond)

	// Search 1: general word search
	pq := ParseSearchQuery("report")
	entries, total, err := ExecuteSearch(pq, 10, 0)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if total != 1 {
		t.Errorf("Expected 1 match, got %d", total)
	}
	if len(entries) > 0 && entries[0].Name != "report.pdf" {
		t.Errorf("Expected report.pdf, got %s", entries[0].Name)
	}

	// Search 2: extension filter
	pq = ParseSearchQuery("ext:pdf")
	entries, total, err = ExecuteSearch(pq, 10, 0)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if total != 1 {
		t.Errorf("Expected 1 match, got %d", total)
	}

	// Search 3: excluded path node_modules check
	pq = ParseSearchQuery("index.js")
	entries, total, err = ExecuteSearch(pq, 10, 0)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if total != 0 {
		t.Errorf("Expected 0 matches for excluded path index.js, got %d", total)
	}

	// Search 4: folder prefix check
	pq = ParseSearchQuery(fmt.Sprintf("in:%s", filepath.Join(tempDir, "docs")))
	entries, total, err = ExecuteSearch(pq, 10, 0)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	// Expected docs/report.pdf and docs/notes.txt (plus the directory docs/ itself if it matches conditions, but docs doesn't fit since docs is a folder, wait, is docs inside tempDir? Yes, tempDir/docs is a directory inside tempDir)
	// Actually, does tempDir/docs get indexed? Yes, it's walked. Since it's a directory under tempDir, its parent is tempDir. Its path is tempDir/docs.
	// So in:tempDir/docs matches items whose parent is tempDir/docs or parent begins with tempDir/docs/.
	// These items are report.pdf and notes.txt. So exactly 2 items.
	if total != 2 {
		t.Errorf("Expected 2 matches for folder filter, got %d. Entries: %+v", total, entries)
	}
}

func TestFTS5Trigram(t *testing.T) {
	DBPathOverride = filepath.Join(t.TempDir(), "zen-man-test.db")
	if db != nil {
		db.Close()
		db = nil
	}

	err := InitDB()
	if err != nil {
		t.Fatalf("Failed to init DB: %v", err)
	}
	_, err = db.Exec("DROP TABLE IF EXISTS test_trigram_fts;")
	if err != nil {
		t.Fatalf("Failed to drop: %v", err)
	}
	_, err = db.Exec("CREATE VIRTUAL TABLE test_trigram_fts USING fts5(name, tokenize='trigram');")
	if err != nil {
		t.Fatalf("Failed to create FTS5 trigram table: %v", err)
	}
	_, err = db.Exec("INSERT INTO test_trigram_fts(name) VALUES ('report_sales.pdf'), ('notes_office.txt');")
	if err != nil {
		t.Fatalf("Failed to insert FTS5 trigram: %v", err)
	}
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM test_trigram_fts WHERE name MATCH 'sales'").Scan(&count)
	if err != nil {
		t.Fatalf("FTS5 trigram match query failed: %v", err)
	}
	if count != 1 {
		t.Errorf("Expected 1 match, got %d", count)
	}
}
