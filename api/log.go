package api

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// logMagic is the 4-byte sentinel at the start of every record: "ZMLG"
var logMagic = [4]byte{0x5A, 0x4D, 0x4C, 0x47}

// ActionType identifies the class of file operation logged.
type ActionType uint8

const (
	ActionCopy      ActionType = 1 // clipboard set — no file mutation, not reversible
	ActionPasteCopy ActionType = 2 // files duplicated to dest — reversible (delete copies)
	ActionPasteMove ActionType = 3 // files relocated to dest — reversible (move back)
	ActionDelete    ActionType = 4 // PERMANENT — SSD cannot recover, never reversible
	ActionRename    ActionType = 5 // file renamed in same directory — reversible
	ActionMkdir     ActionType = 6 // new empty directory created — reversible if still empty
)

// StatusType tracks the lifecycle of a log record.
type StatusType uint8

const (
	StatusDone     StatusType = 0
	StatusReverted StatusType = 1
)

var actionNames = map[ActionType]string{
	ActionCopy:      "copy",
	ActionPasteCopy: "paste-copy",
	ActionPasteMove: "paste-move",
	ActionDelete:    "delete",
	ActionRename:    "rename",
	ActionMkdir:     "mkdir",
}

// ActionRecord is the decoded, in-memory form of one log entry.
type ActionRecord struct {
	ID         int64      `json:"id"`
	Timestamp  time.Time  `json:"timestamp"`
	Action     ActionType `json:"action"`
	ActionStr  string     `json:"action_str"`
	Status     StatusType `json:"status"`
	StatusStr  string     `json:"status_str"`
	Sources    []string   `json:"sources"`
	Dest       string     `json:"dest"`
	Name       string     `json:"name"`
	Reversible bool       `json:"reversible"`
}

// ── Wire format constants ────────────────────────────────────────────────────
//
// Every record on disk (all fields big-endian):
//
//   Offset  Size  Field
//   0       4     magic [0x5A,0x4D,0x4C,0x47]
//   4       8     id        int64  (monotonic counter)
//   12      8     timestamp int64  (Unix nanoseconds)
//   20      1     action    ActionType
//   21      1     status    StatusType
//   22      4     recLen    uint32 (byte count of magic+header+body, NOT including CRC)
//   26      2     numSrc    uint16
//             sources[]:  [uint16 len][bytes] × numSrc
//             dest:       [uint16 len][bytes]
//             name:       [uint16 len][bytes]
//   end     4     crc32     IEEE checksum of all bytes before this field

const (
	logHeaderFixed = 4 + 8 + 8 + 1 + 1 + 4 // magic+id+ts+action+status+recLen = 26 bytes
	statusByteOff  = 4 + 8 + 8 + 1          // offset of status byte within a record = 21
)

// ── ActionLog ────────────────────────────────────────────────────────────────

// ActionLog is the process-wide append-only log store.
// Exactly one instance is created via GetLog().
type ActionLog struct {
	mu     sync.Mutex
	file   *os.File
	path   string
	index  map[string][]int64 // absolute path → slice of record file offsets
	nextID int64
}

var (
	globalLog     *ActionLog
	globalLogOnce sync.Once
)

// GetLog returns the singleton ActionLog, initialising it on first call.
// If the log cannot be opened, a no-op stub is returned so callers never crash.
func GetLog() *ActionLog {
	globalLogOnce.Do(func() {
		l, err := openActionLog()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[zen-man] action log unavailable: %v\n", err)
			globalLog = &ActionLog{index: make(map[string][]int64)}
			return
		}
		globalLog = l
	})
	return globalLog
}

// logDir returns ~/.local/share/zen-man (or $XDG_DATA_HOME/zen-man).
func logDir() string {
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "zen-man")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "/tmp/zen-man"
	}
	return filepath.Join(home, ".local", "share", "zen-man")
}

// openActionLog opens (or creates) the log file and rebuilds the in-memory index.
func openActionLog() (*ActionLog, error) {
	dir := logDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create log dir: %w", err)
	}

	logPath := filepath.Join(dir, "action.log")
	// O_RDWR so we can do in-place status updates; O_APPEND for safe concurrent appends
	f, err := os.OpenFile(logPath, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}

	al := &ActionLog{
		file:  f,
		path:  logPath,
		index: make(map[string][]int64),
	}

	if err := al.rebuildIndex(); err != nil {
		// Partial rebuild is acceptable — we log the warning and continue
		fmt.Fprintf(os.Stderr, "[zen-man] log index rebuilt with warnings: %v\n", err)
	}

	return al, nil
}

// rebuildIndex scans the log file from the beginning, re-creating the
// in-memory path→offset index.  Corrupt records (CRC mismatch, truncated
// data) are silently skipped.
func (al *ActionLog) rebuildIndex() error {
	if _, err := al.file.Seek(0, io.SeekStart); err != nil {
		return err
	}

	var maxID int64
	var lastErr error

	for {
		offset, err := al.file.Seek(0, io.SeekCurrent)
		if err != nil {
			lastErr = err
			break
		}

		rec, raw, err := readRecord(al.file)
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			lastErr = err
			// Try to recover by skipping 1 byte and continuing
			if _, seekErr := al.file.Seek(offset+1, io.SeekStart); seekErr != nil {
				break
			}
			continue
		}
		if !verifyCRC(raw) {
			continue
		}

		al.indexRecord(rec, offset)

		if rec.ID > maxID {
			maxID = rec.ID
		}
	}

	al.nextID = maxID + 1
	return lastErr
}

// indexRecord adds a decoded record's paths to the in-memory index.
// Must be called with or without the lock depending on context (caller manages).
func (al *ActionLog) indexRecord(rec ActionRecord, offset int64) {
	for _, src := range rec.Sources {
		al.index[src] = append(al.index[src], offset)
	}
	if rec.Dest != "" {
		for _, src := range rec.Sources {
			dst := filepath.Join(rec.Dest, filepath.Base(src))
			al.index[dst] = append(al.index[dst], offset)
		}
		// Also index mkdir targets: Dest/Name
		if rec.Action == ActionMkdir && rec.Name != "" {
			mdir := filepath.Join(rec.Dest, rec.Name)
			al.index[mdir] = append(al.index[mdir], offset)
		}
	}
}

// Append writes a new action record to the log.  Returns the assigned ID.
// It is safe to call from multiple goroutines.
func (al *ActionLog) Append(action ActionType, sources []string, dest, name string) (int64, error) {
	if al.file == nil {
		return 0, fmt.Errorf("log not initialised")
	}

	al.mu.Lock()
	defer al.mu.Unlock()

	id := al.nextID
	al.nextID++

	raw, err := encodeRecord(id, action, StatusDone, sources, dest, name)
	if err != nil {
		return 0, err
	}

	// Seek to end before writing (required when not opened with O_APPEND
	// and we also do in-place writes for status updates)
	offset, err := al.file.Seek(0, io.SeekEnd)
	if err != nil {
		return 0, err
	}

	if _, err := al.file.Write(raw); err != nil {
		return 0, err
	}

	// Update index with decoded record (re-decode to reuse indexRecord)
	al.indexRecord(ActionRecord{
		ID:      id,
		Action:  action,
		Sources: sources,
		Dest:    dest,
		Name:    name,
	}, offset)

	return id, nil
}

// QueryPath returns the N most-recent records that reference absPath,
// newest first.
func (al *ActionLog) QueryPath(absPath string, limit int) ([]ActionRecord, error) {
	al.mu.Lock()
	offsets := make([]int64, len(al.index[absPath]))
	copy(offsets, al.index[absPath])
	al.mu.Unlock()

	var records []ActionRecord
	for i := len(offsets) - 1; i >= 0 && len(records) < limit; i-- {
		rec, err := al.readAt(offsets[i])
		if err != nil {
			continue
		}
		records = append(records, rec)
	}
	return records, nil
}

// QueryRecent returns the N most-recent records across all paths, newest first.
func (al *ActionLog) QueryRecent(limit int) ([]ActionRecord, error) {
	if al.file == nil {
		return nil, nil
	}

	al.mu.Lock()
	defer al.mu.Unlock()

	if _, err := al.file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}

	var all []ActionRecord
	for {
		rec, raw, err := readRecord(al.file)
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil || !verifyCRC(raw) {
			continue
		}
		all = append(all, rec)
	}

	start := len(all) - limit
	if start < 0 {
		start = 0
	}
	result := make([]ActionRecord, len(all)-start)
	copy(result, all[start:])
	// Reverse: newest first
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result, nil
}

// GetByID scans for a record with the given ID and returns it along with
// its file offset (needed by MarkReverted).
func (al *ActionLog) GetByID(id int64) (ActionRecord, int64, error) {
	if al.file == nil {
		return ActionRecord{}, 0, fmt.Errorf("log not initialised")
	}

	al.mu.Lock()
	defer al.mu.Unlock()

	if _, err := al.file.Seek(0, io.SeekStart); err != nil {
		return ActionRecord{}, 0, err
	}

	for {
		offset, _ := al.file.Seek(0, io.SeekCurrent)
		rec, raw, err := readRecord(al.file)
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil || !verifyCRC(raw) {
			continue
		}
		if rec.ID == id {
			return rec, offset, nil
		}
	}
	return ActionRecord{}, 0, fmt.Errorf("record %d not found", id)
}

// MarkReverted performs an in-place update: it flips the status byte to
// StatusReverted and rewrites the trailing CRC so the record remains valid.
// This is the only mutation ever applied to existing log bytes.
func (al *ActionLog) MarkReverted(offset int64) error {
	if al.file == nil {
		return fmt.Errorf("log not initialised")
	}

	al.mu.Lock()
	defer al.mu.Unlock()

	// 1. Read the full record to know its total size
	if _, err := al.file.Seek(offset, io.SeekStart); err != nil {
		return fmt.Errorf("seek to record: %w", err)
	}
	_, raw, err := readRecord(al.file)
	if err != nil {
		return fmt.Errorf("read record for revert: %w", err)
	}

	// 2. Flip status byte in the raw buffer
	raw[statusByteOff] = byte(StatusReverted)

	// 3. Recompute CRC over all bytes except the last 4
	newCRC := crc32.ChecksumIEEE(raw[:len(raw)-4])
	binary.BigEndian.PutUint32(raw[len(raw)-4:], newCRC)

	// 4. Write back the modified status byte and updated CRC in two targeted writes
	statusPos := offset + int64(statusByteOff)
	if _, err := al.file.WriteAt([]byte{byte(StatusReverted)}, statusPos); err != nil {
		return fmt.Errorf("write status byte: %w", err)
	}
	crcPos := offset + int64(len(raw)-4)
	if _, err := al.file.WriteAt(raw[len(raw)-4:], crcPos); err != nil {
		return fmt.Errorf("write updated CRC: %w", err)
	}
	return nil
}

// readAt reads and decodes the record at a given file offset.
// Caller must hold mu or guarantee no concurrent writers.
func (al *ActionLog) readAt(offset int64) (ActionRecord, error) {
	if _, err := al.file.Seek(offset, io.SeekStart); err != nil {
		return ActionRecord{}, err
	}
	rec, raw, err := readRecord(al.file)
	if err != nil {
		return ActionRecord{}, err
	}
	if !verifyCRC(raw) {
		return ActionRecord{}, fmt.Errorf("CRC mismatch at offset %d", offset)
	}
	return rec, nil
}

// ── Binary codec ─────────────────────────────────────────────────────────────

func encodeRecord(id int64, action ActionType, status StatusType, sources []string, dest, name string) ([]byte, error) {
	// Pre-calculate variable body size
	bodySize := 2 // numSrc uint16
	for _, s := range sources {
		if len(s) > 65535 {
			return nil, fmt.Errorf("source path exceeds max length: %d bytes", len(s))
		}
		bodySize += 2 + len(s)
	}
	if len(dest) > 65535 {
		return nil, fmt.Errorf("dest path exceeds max length: %d bytes", len(dest))
	}
	if len(name) > 65535 {
		return nil, fmt.Errorf("name exceeds max length: %d bytes", len(name))
	}
	bodySize += 2 + len(dest)
	bodySize += 2 + len(name)

	recLen := uint32(logHeaderFixed + bodySize) // excludes trailing CRC
	totalSize := int(recLen) + 4               // +4 bytes for CRC

	buf := make([]byte, totalSize)
	p := 0

	copy(buf[p:], logMagic[:])
	p += 4

	binary.BigEndian.PutUint64(buf[p:], uint64(id))
	p += 8

	binary.BigEndian.PutUint64(buf[p:], uint64(time.Now().UnixNano()))
	p += 8

	buf[p] = byte(action)
	p++
	buf[p] = byte(status)
	p++

	binary.BigEndian.PutUint32(buf[p:], recLen)
	p += 4

	if len(sources) > 65535 {
		return nil, fmt.Errorf("too many sources: %d", len(sources))
	}
	binary.BigEndian.PutUint16(buf[p:], uint16(len(sources)))
	p += 2

	for _, s := range sources {
		binary.BigEndian.PutUint16(buf[p:], uint16(len(s)))
		p += 2
		copy(buf[p:], s)
		p += len(s)
	}

	binary.BigEndian.PutUint16(buf[p:], uint16(len(dest)))
	p += 2
	copy(buf[p:], dest)
	p += len(dest)

	binary.BigEndian.PutUint16(buf[p:], uint16(len(name)))
	p += 2
	copy(buf[p:], name)
	p += len(name)

	checksum := crc32.ChecksumIEEE(buf[:p])
	binary.BigEndian.PutUint32(buf[p:], checksum)

	return buf, nil
}

// readRecord decodes one record from r.  Returns the decoded ActionRecord,
// the complete raw bytes (including CRC), and any error.
func readRecord(r io.Reader) (ActionRecord, []byte, error) {
	// Read magic
	magic := make([]byte, 4)
	if _, err := io.ReadFull(r, magic); err != nil {
		return ActionRecord{}, nil, err
	}
	if magic[0] != logMagic[0] || magic[1] != logMagic[1] ||
		magic[2] != logMagic[2] || magic[3] != logMagic[3] {
		return ActionRecord{}, nil, fmt.Errorf("bad magic %x", magic)
	}

	// Fixed-size portion after magic: id(8)+ts(8)+action(1)+status(1)+recLen(4) = 22 bytes
	fixedRest := make([]byte, 22)
	if _, err := io.ReadFull(r, fixedRest); err != nil {
		return ActionRecord{}, nil, err
	}

	id := int64(binary.BigEndian.Uint64(fixedRest[0:8]))
	tsNano := int64(binary.BigEndian.Uint64(fixedRest[8:16]))
	action := ActionType(fixedRest[16])
	status := StatusType(fixedRest[17])
	recLen := binary.BigEndian.Uint32(fixedRest[18:22])

	bodyLen := int(recLen) - logHeaderFixed
	if bodyLen < 2 || bodyLen > 10*1024*1024 {
		return ActionRecord{}, nil, fmt.Errorf("implausible recLen %d (bodyLen %d)", recLen, bodyLen)
	}

	body := make([]byte, bodyLen)
	if _, err := io.ReadFull(r, body); err != nil {
		return ActionRecord{}, nil, err
	}

	crcBuf := make([]byte, 4)
	if _, err := io.ReadFull(r, crcBuf); err != nil {
		return ActionRecord{}, nil, err
	}

	// Assemble raw blob for CRC verification
	raw := make([]byte, 4+22+bodyLen+4)
	copy(raw[0:], magic)
	copy(raw[4:], fixedRest)
	copy(raw[26:], body)
	copy(raw[26+bodyLen:], crcBuf)

	// Decode body
	p := 0
	if p+2 > len(body) {
		return ActionRecord{}, raw, fmt.Errorf("body too short for numSrc")
	}
	numSrc := int(binary.BigEndian.Uint16(body[p:]))
	p += 2

	sources := make([]string, 0, numSrc)
	for i := 0; i < numSrc; i++ {
		if p+2 > len(body) {
			return ActionRecord{}, raw, fmt.Errorf("body truncated in source %d", i)
		}
		sLen := int(binary.BigEndian.Uint16(body[p:]))
		p += 2
		if p+sLen > len(body) {
			return ActionRecord{}, raw, fmt.Errorf("source %d data truncated", i)
		}
		sources = append(sources, string(body[p:p+sLen]))
		p += sLen
	}

	if p+2 > len(body) {
		return ActionRecord{}, raw, fmt.Errorf("body truncated before dest")
	}
	destLen := int(binary.BigEndian.Uint16(body[p:]))
	p += 2
	if p+destLen > len(body) {
		return ActionRecord{}, raw, fmt.Errorf("dest data truncated")
	}
	dest := string(body[p : p+destLen])
	p += destLen

	if p+2 > len(body) {
		return ActionRecord{}, raw, fmt.Errorf("body truncated before name")
	}
	nameLen := int(binary.BigEndian.Uint16(body[p:]))
	p += 2
	if p+nameLen > len(body) {
		return ActionRecord{}, raw, fmt.Errorf("name data truncated")
	}
	name := string(body[p : p+nameLen])

	statusStr := "done"
	if status == StatusReverted {
		statusStr = "reverted"
	}

	rec := ActionRecord{
		ID:         id,
		Timestamp:  time.Unix(0, tsNano),
		Action:     action,
		ActionStr:  actionNames[action],
		Status:     status,
		StatusStr:  statusStr,
		Sources:    sources,
		Dest:       dest,
		Name:       name,
		Reversible: isReversible(action),
	}

	return rec, raw, nil
}

func verifyCRC(raw []byte) bool {
	if len(raw) < 4 {
		return false
	}
	data := raw[:len(raw)-4]
	stored := binary.BigEndian.Uint32(raw[len(raw)-4:])
	return crc32.ChecksumIEEE(data) == stored
}

func isReversible(a ActionType) bool {
	return a == ActionPasteCopy || a == ActionPasteMove || a == ActionRename || a == ActionMkdir
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

// HandleLog serves GET /api/log
// Query params:
//
//	path=<encoded>  — filter records by this absolute path (optional)
//	limit=N         — max records to return (default 50, max 500)
func HandleLog(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	limit := 50
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 {
		if l > 500 {
			l = 500
		}
		limit = l
	}

	al := GetLog()
	var records []ActionRecord
	var err error

	if path := r.URL.Query().Get("path"); path != "" {
		resolved, resErr := ResolvePath(path)
		if resErr != nil {
			http.Error(w, fmt.Sprintf(`{"error":"invalid path: %v"}`, resErr), http.StatusBadRequest)
			return
		}
		records, err = al.QueryPath(resolved, limit)
	} else {
		records, err = al.QueryRecent(limit)
	}

	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), http.StatusInternalServerError)
		return
	}
	if records == nil {
		records = []ActionRecord{}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"records": records,
		"count":   len(records),
	})
}

// HandleLogRevert serves POST /api/log/revert
// Body: {"id": <record_id>}
func HandleLogRevert(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"invalid request: %v"}`, err), http.StatusBadRequest)
		return
	}

	al := GetLog()
	rec, offset, err := al.GetByID(body.ID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), http.StatusNotFound)
		return
	}

	if rec.Status == StatusReverted {
		http.Error(w, `{"error":"already reverted"}`, http.StatusConflict)
		return
	}

	if !rec.Reversible {
		http.Error(w, fmt.Sprintf(`{"error":"action '%s' cannot be reverted"}`, rec.ActionStr), http.StatusUnprocessableEntity)
		return
	}

	if err := RevertRecord(rec); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"revert failed: %v"}`, err), http.StatusInternalServerError)
		return
	}

	if err := al.MarkReverted(offset); err != nil {
		// Filesystem was already reverted — just log the metadata update failure
		fmt.Fprintf(os.Stderr, "[zen-man] could not mark record %d as reverted: %v\n", body.ID, err)
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "reverted",
		"record_id": body.ID,
		"action":    rec.ActionStr,
	})
}
