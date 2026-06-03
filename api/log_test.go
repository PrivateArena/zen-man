package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// newTestLog creates an ActionLog backed by a temp file.
// Caller must invoke cleanup() when done.
func newTestLog(t *testing.T) (*ActionLog, func()) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "action.log")

	f, err := os.OpenFile(logPath, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		t.Fatalf("open test log: %v", err)
	}

	al := &ActionLog{
		file:  f,
		path:  logPath,
		index: make(map[string][]int64),
	}
	return al, func() { f.Close() }
}

// ── encode / decode round-trip ────────────────────────────────────────────────

func TestEncodeDecodeRoundTrip(t *testing.T) {
	sources := []string{"/home/user/foo.txt", "/home/user/bar/baz.png"}
	dest := "/tmp/dest"
	name := "renamed.txt"

	raw, err := encodeRecord(42, ActionPasteCopy, StatusDone, sources, dest, name)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if !verifyCRC(raw) {
		t.Fatal("CRC check failed on freshly encoded record")
	}

	rec, _, err := readRecord(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("readRecord: %v", err)
	}

	if rec.ID != 42 {
		t.Errorf("ID: want 42, got %d", rec.ID)
	}
	if rec.Action != ActionPasteCopy {
		t.Errorf("Action: want %d, got %d", ActionPasteCopy, rec.Action)
	}
	if rec.ActionStr != "paste-copy" {
		t.Errorf("ActionStr: want paste-copy, got %q", rec.ActionStr)
	}
	if rec.Status != StatusDone {
		t.Errorf("Status: want done, got %d", rec.Status)
	}
	if len(rec.Sources) != 2 {
		t.Fatalf("Sources count: want 2, got %d", len(rec.Sources))
	}
	if rec.Sources[0] != sources[0] || rec.Sources[1] != sources[1] {
		t.Errorf("Sources mismatch: got %v", rec.Sources)
	}
	if rec.Dest != dest {
		t.Errorf("Dest: want %q, got %q", dest, rec.Dest)
	}
	if rec.Name != name {
		t.Errorf("Name: want %q, got %q", name, rec.Name)
	}
	if !rec.Reversible {
		t.Error("paste-copy should be reversible")
	}
	if rec.Timestamp.IsZero() {
		t.Error("Timestamp should not be zero")
	}
}

func TestCRCCorruptionDetection(t *testing.T) {
	raw, err := encodeRecord(1, ActionDelete, StatusDone, []string{"/a/b"}, "", "")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	// Flip a byte in the middle of the payload
	raw[15] ^= 0xFF

	if verifyCRC(raw) {
		t.Error("CRC should fail after corruption — data loss risk!")
	}
}

func TestEmptySourcesAndStrings(t *testing.T) {
	raw, err := encodeRecord(99, ActionMkdir, StatusDone, []string{}, "/tmp/newdir", "mydir")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !verifyCRC(raw) {
		t.Fatal("CRC failed for empty-sources record")
	}
	rec, _, err := readRecord(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rec.Sources) != 0 {
		t.Errorf("want 0 sources, got %d", len(rec.Sources))
	}
	if rec.Dest != "/tmp/newdir" {
		t.Errorf("Dest mismatch: %q", rec.Dest)
	}
}

// ── Append + Query ────────────────────────────────────────────────────────────

func TestAppendAndQueryRecent(t *testing.T) {
	al, cleanup := newTestLog(t)
	defer cleanup()

	ops := []struct {
		action  ActionType
		sources []string
		dest    string
		name    string
	}{
		{ActionPasteCopy, []string{"/src/a.txt"}, "/dst", ""},
		{ActionRename, []string{"/home/user/old.go"}, "", "new.go"},
		{ActionDelete, []string{"/home/user/gone.bin"}, "", ""},
		{ActionMkdir, []string{}, "/projects", "myproject"},
	}

	ids := make([]int64, len(ops))
	for i, op := range ops {
		id, err := al.Append(op.action, op.sources, op.dest, op.name)
		if err != nil {
			t.Fatalf("Append op %d: %v", i, err)
		}
		ids[i] = id
	}

	records, err := al.QueryRecent(10)
	if err != nil {
		t.Fatalf("QueryRecent: %v", err)
	}
	if len(records) != len(ops) {
		t.Fatalf("QueryRecent: want %d, got %d", len(ops), len(records))
	}

	// Newest-first order: last appended appears at index 0
	if records[0].Action != ActionMkdir {
		t.Errorf("newest record should be mkdir, got %s", records[0].ActionStr)
	}
	if records[3].Action != ActionPasteCopy {
		t.Errorf("oldest record should be paste-copy, got %s", records[3].ActionStr)
	}
}

func TestQueryPath(t *testing.T) {
	al, cleanup := newTestLog(t)
	defer cleanup()

	targetFile := "/home/user/document.pdf"
	otherFile := "/home/user/photo.jpg"

	al.Append(ActionPasteCopy, []string{targetFile}, "/backup", "")
	al.Append(ActionDelete, []string{otherFile}, "", "")
	al.Append(ActionRename, []string{targetFile}, "", "document_v2.pdf")

	records, err := al.QueryPath(targetFile, 50)
	if err != nil {
		t.Fatalf("QueryPath: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("QueryPath: want 2 records for target, got %d", len(records))
	}

	// Newest first
	if records[0].Action != ActionRename {
		t.Errorf("newest record for target should be rename, got %s", records[0].ActionStr)
	}
}

func TestQueryPathDest(t *testing.T) {
	al, cleanup := newTestLog(t)
	defer cleanup()

	// After paste-copy, the dest path should also be indexed
	src := "/home/user/file.txt"
	dest := "/backup"
	al.Append(ActionPasteCopy, []string{src}, dest, "")

	dstPath := filepath.Join(dest, filepath.Base(src)) // /backup/file.txt
	records, err := al.QueryPath(dstPath, 10)
	if err != nil {
		t.Fatalf("QueryPath dest: %v", err)
	}
	if len(records) == 0 {
		t.Error("dest path should be indexed for paste-copy operations")
	}
}

func TestGetByID(t *testing.T) {
	al, cleanup := newTestLog(t)
	defer cleanup()

	id, _ := al.Append(ActionRename, []string{"/a/b.txt"}, "", "c.txt")
	al.Append(ActionDelete, []string{"/x/y"}, "", "")

	rec, offset, err := al.GetByID(id)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if rec.ID != id {
		t.Errorf("ID mismatch: want %d, got %d", id, rec.ID)
	}
	if offset < 0 {
		t.Error("offset should be non-negative")
	}
}

func TestMarkReverted(t *testing.T) {
	al, cleanup := newTestLog(t)
	defer cleanup()

	id, _ := al.Append(ActionRename, []string{"/a/old.txt"}, "", "new.txt")

	_, offset, err := al.GetByID(id)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}

	if err := al.MarkReverted(offset); err != nil {
		t.Fatalf("MarkReverted: %v", err)
	}

	// Re-read and verify status byte was updated
	rec, err := al.readAt(offset)
	if err != nil {
		t.Fatalf("readAt after mark: %v", err)
	}
	if rec.Status != StatusReverted {
		t.Errorf("status should be reverted, got %d", rec.Status)
	}
}

// ── Revert operations ─────────────────────────────────────────────────────────

func TestRevertPasteCopy(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	// Create a source file and simulate a paste-copy by placing it in dst
	srcFile := filepath.Join(srcDir, "hello.txt")
	dstFile := filepath.Join(dstDir, "hello.txt")
	if err := os.WriteFile(srcFile, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dstFile, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	rec := ActionRecord{
		Action:  ActionPasteCopy,
		Sources: []string{srcFile},
		Dest:    dstDir,
	}

	if err := RevertRecord(rec); err != nil {
		t.Fatalf("RevertRecord paste-copy: %v", err)
	}

	if _, err := os.Stat(dstFile); !os.IsNotExist(err) {
		t.Error("dst file should have been removed by paste-copy revert")
	}
	// Original source must be untouched
	if _, err := os.Stat(srcFile); err != nil {
		t.Error("source file should still exist")
	}
}

func TestRevertPasteMove(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()

	originalSrc := filepath.Join(srcDir, "moved.txt")
	movedDst := filepath.Join(dstDir, "moved.txt")

	// Simulate: file was moved from src to dst
	if err := os.WriteFile(movedDst, []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}

	rec := ActionRecord{
		Action:  ActionPasteMove,
		Sources: []string{originalSrc},
		Dest:    dstDir,
	}

	if err := RevertRecord(rec); err != nil {
		t.Fatalf("RevertRecord paste-move: %v", err)
	}

	if _, err := os.Stat(movedDst); !os.IsNotExist(err) {
		t.Error("moved file should be gone from dst after revert")
	}
	if _, err := os.Stat(originalSrc); err != nil {
		t.Error("file should be back at original location")
	}
}

func TestRevertRename(t *testing.T) {
	dir := t.TempDir()
	originalPath := filepath.Join(dir, "original.txt")
	renamedPath := filepath.Join(dir, "renamed.txt")

	// Simulate: original.txt was renamed → renamed.txt
	if err := os.WriteFile(renamedPath, []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}

	rec := ActionRecord{
		Action:  ActionRename,
		Sources: []string{originalPath},
		Name:    "renamed.txt",
	}

	if err := RevertRecord(rec); err != nil {
		t.Fatalf("RevertRecord rename: %v", err)
	}

	if _, err := os.Stat(renamedPath); !os.IsNotExist(err) {
		t.Error("renamed file should be gone")
	}
	if _, err := os.Stat(originalPath); err != nil {
		t.Error("original filename should be restored")
	}
}

func TestRevertBatchRename(t *testing.T) {
	dir := t.TempDir()
	orig1 := filepath.Join(dir, "orig1.txt")
	orig2 := filepath.Join(dir, "orig2.txt")
	ren1 := filepath.Join(dir, "ren1.txt")
	ren2 := filepath.Join(dir, "ren2.txt")

	// Simulate: orig1.txt and orig2.txt were renamed → ren1.txt and ren2.txt
	if err := os.WriteFile(ren1, []byte("data1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ren2, []byte("data2"), 0644); err != nil {
		t.Fatal(err)
	}

	rec := ActionRecord{
		Action:  ActionRename,
		Sources: []string{orig1, orig2},
		Name:    `["ren1.txt","ren2.txt"]`,
	}

	if err := RevertRecord(rec); err != nil {
		t.Fatalf("RevertRecord batch rename: %v", err)
	}

	if _, err := os.Stat(ren1); !os.IsNotExist(err) {
		t.Error("ren1 should be gone")
	}
	if _, err := os.Stat(ren2); !os.IsNotExist(err) {
		t.Error("ren2 should be gone")
	}
	if _, err := os.Stat(orig1); err != nil {
		t.Error("orig1 should be restored")
	}
	if _, err := os.Stat(orig2); err != nil {
		t.Error("orig2 should be restored")
	}
}

func TestRevertMkdirEmpty(t *testing.T) {
	parent := t.TempDir()
	newDir := filepath.Join(parent, "emptydir")
	if err := os.Mkdir(newDir, 0755); err != nil {
		t.Fatal(err)
	}

	rec := ActionRecord{
		Action: ActionMkdir,
		Dest:   parent,
		Name:   "emptydir",
	}

	if err := RevertRecord(rec); err != nil {
		t.Fatalf("RevertRecord mkdir: %v", err)
	}
	if _, err := os.Stat(newDir); !os.IsNotExist(err) {
		t.Error("empty dir should have been removed")
	}
}

func TestRevertMkdirNonEmpty(t *testing.T) {
	parent := t.TempDir()
	newDir := filepath.Join(parent, "populated")
	if err := os.Mkdir(newDir, 0755); err != nil {
		t.Fatal(err)
	}
	// Put a file inside — revert must refuse
	os.WriteFile(filepath.Join(newDir, "child.txt"), []byte("x"), 0644)

	rec := ActionRecord{
		Action: ActionMkdir,
		Dest:   parent,
		Name:   "populated",
	}

	if err := RevertRecord(rec); err == nil {
		t.Error("should refuse to remove non-empty directory")
	}
}

func TestRevertDeleteBlocked(t *testing.T) {
	rec := ActionRecord{
		Action:  ActionDelete,
		Sources: []string{"/lost/forever.txt"},
	}
	if err := RevertRecord(rec); err == nil {
		t.Error("delete revert must always return an error")
	}
}

// ── Persistence: survive reopen ───────────────────────────────────────────────

func TestPersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "action.log")

	writeLog := func() int64 {
		f, _ := os.OpenFile(logPath, os.O_RDWR|os.O_CREATE, 0644)
		al := &ActionLog{file: f, path: logPath, index: make(map[string][]int64)}
		id, err := al.Append(ActionRename, []string{"/tmp/x.txt"}, "", "y.txt")
		if err != nil {
			t.Fatalf("Append: %v", err)
		}
		f.Close()
		return id
	}

	id := writeLog()

	// Reopen and rebuild index
	f, _ := os.OpenFile(logPath, os.O_RDWR, 0644)
	al := &ActionLog{file: f, path: logPath, index: make(map[string][]int64)}
	defer f.Close()
	if err := al.rebuildIndex(); err != nil {
		t.Fatalf("rebuildIndex: %v", err)
	}

	rec, _, err := al.GetByID(id)
	if err != nil {
		t.Fatalf("GetByID after reopen: %v", err)
	}
	if rec.Action != ActionRename {
		t.Errorf("wrong action after reopen: %s", rec.ActionStr)
	}
}

// ── Concurrency ───────────────────────────────────────────────────────────────

func TestConcurrentAppend(t *testing.T) {
	al, cleanup := newTestLog(t)
	defer cleanup()

	const workers = 20
	const perWorker = 50

	var wg sync.WaitGroup
	errs := make(chan error, workers*perWorker)

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				_, err := al.Append(ActionDelete,
					[]string{filepath.Join("/tmp", "concurrent", time.Now().String())},
					"", "")
				if err != nil {
					errs <- err
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Errorf("concurrent append error: %v", err)
	}

	records, err := al.QueryRecent(workers * perWorker)
	if err != nil {
		t.Fatalf("QueryRecent: %v", err)
	}
	if len(records) != workers*perWorker {
		t.Errorf("want %d records, got %d", workers*perWorker, len(records))
	}

	// All IDs must be unique
	seen := make(map[int64]bool, len(records))
	for _, r := range records {
		if seen[r.ID] {
			t.Errorf("duplicate ID: %d", r.ID)
		}
		seen[r.ID] = true
	}
}

// ── HTTP handler tests ────────────────────────────────────────────────────────

func TestHandleLogRecent(t *testing.T) {
	// Override the global singleton for this test
	orig := globalLog
	globalLog = nil
	globalLogOnce = *new(sync.Once)
	defer func() {
		globalLog = orig
	}()

	// Point log dir to temp
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	req := httptest.NewRequest(http.MethodGet, "/api/log?limit=10", nil)
	rr := httptest.NewRecorder()
	HandleLog(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("HandleLog status: want 200, got %d — %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Records []ActionRecord `json:"records"`
		Count   int            `json:"count"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	// Empty log is fine
	if resp.Records == nil {
		t.Error("records field should be an array, not null")
	}
}

func TestHandleLogRevertUnknownID(t *testing.T) {
	orig := globalLog
	globalLog = nil
	globalLogOnce = *new(sync.Once)
	defer func() { globalLog = orig }()

	t.Setenv("XDG_DATA_HOME", t.TempDir())

	body, _ := json.Marshal(map[string]int64{"id": 9999})
	req := httptest.NewRequest(http.MethodPost, "/api/log/revert", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	HandleLogRevert(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("want 404 for unknown id, got %d", rr.Code)
	}
}

func TestHandleLogMethodNotAllowed(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/log", nil)
	rr := httptest.NewRecorder()
	HandleLog(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("want 405, got %d", rr.Code)
	}
}

// ── Write performance benchmark ───────────────────────────────────────────────

func BenchmarkAppend(b *testing.B) {
	dir := b.TempDir()
	f, _ := os.OpenFile(filepath.Join(dir, "bench.log"), os.O_RDWR|os.O_CREATE, 0644)
	al := &ActionLog{file: f, path: filepath.Join(dir, "bench.log"), index: make(map[string][]int64)}
	defer f.Close()

	sources := []string{"/home/user/documents/very-important-file.pdf"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		al.Append(ActionPasteCopy, sources, "/backup/documents", "")
	}
}
