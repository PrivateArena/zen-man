package api

import (
	"database/sql"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

var (
	db     *sql.DB
	dbOnce sync.Once
)

// InitDB initializes the SQLite database
func InitDB() error {
	var initErr error
	dbOnce.Do(func() {
		dir := logDir()
		if err := os.MkdirAll(dir, 0755); err != nil {
			initErr = fmt.Errorf("failed to create db dir: %w", err)
			return
		}

		dbPath := filepath.Join(dir, "zen-man.db")
		if flag.Lookup("test.v") != nil {
			dbPath = filepath.Join(os.TempDir(), "zen-man-test.db")
			os.Remove(dbPath)
			os.Remove(dbPath + "-wal")
			os.Remove(dbPath + "-shm")
		}
		d, err := sql.Open("sqlite", dbPath)
		if err != nil {
			initErr = fmt.Errorf("failed to open database: %w", err)
			return
		}

		d.SetMaxOpenConns(1)

		query := `
		CREATE TABLE IF NOT EXISTS folder_sizes (
			path TEXT PRIMARY KEY,
			size INTEGER,
			file_count INTEGER,
			updated_at INTEGER
		);`
		if _, err := d.Exec(query); err != nil {
			d.Close()
			initErr = fmt.Errorf("failed to create table: %w", err)
			return
		}

		db = d
		// Initialize search tables
		if err := InitSearchTables(); err != nil {
			d.Close()
			db = nil
			initErr = fmt.Errorf("failed to initialize search tables: %w", err)
			return
		}
	})
	return initErr
}

// GetCachedDirSize returns cached size, file count, and a boolean indicating cache hit
func GetCachedDirSize(path string) (int64, int64, bool) {
	if db == nil {
		if err := InitDB(); err != nil {
			return 0, 0, false
		}
	}

	var size, fileCount int64
	err := db.QueryRow("SELECT size, file_count FROM folder_sizes WHERE path = ?", path).Scan(&size, &fileCount)
	if err != nil {
		return 0, 0, false
	}
	return size, fileCount, true
}

// SaveCachedDirSize saves or updates the cached size and file count
func SaveCachedDirSize(path string, size int64, fileCount int64) error {
	if db == nil {
		if err := InitDB(); err != nil {
			return err
		}
	}

	_, err := db.Exec(
		"INSERT INTO folder_sizes (path, size, file_count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, file_count=excluded.file_count, updated_at=excluded.updated_at",
		path, size, fileCount, time.Now().Unix(),
	)
	return err
}

// DirSizeInfo holds size and file count info for folders
type DirSizeInfo struct {
	Size      int64
	FileCount int64
}

// SaveCachedDirSizesBatch writes directory statistics to the database in a single transaction
func SaveCachedDirSizesBatch(stats map[string]DirSizeInfo) error {
	if db == nil {
		if err := InitDB(); err != nil {
			return err
		}
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare("INSERT INTO folder_sizes (path, size, file_count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, file_count=excluded.file_count, updated_at=excluded.updated_at")
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	now := time.Now().Unix()
	for path, info := range stats {
		if _, err := stmt.Exec(path, info.Size, info.FileCount, now); err != nil {
			return fmt.Errorf("failed to execute: %w", err)
		}
	}

	return tx.Commit()
}
