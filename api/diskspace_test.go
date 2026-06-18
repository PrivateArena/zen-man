package api

import (
	"os"
	"testing"
)

func TestGetDiskSpace(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Failed to get current working directory: %v", err)
	}

	info, err := GetDiskSpace(cwd)
	if err != nil {
		t.Fatalf("GetDiskSpace failed: %v", err)
	}

	if info.Total == 0 {
		t.Errorf("Expected non-zero Total disk space, got 0")
	}

	if info.Free > info.Total {
		t.Errorf("Free space (%d) cannot be greater than Total space (%d)", info.Free, info.Total)
	}
}
