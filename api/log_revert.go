package api

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RevertRecord undoes the filesystem effect of a completed action.
// Only ActionPasteCopy, ActionPasteMove, ActionRename, ActionMkdir, and
// ActionPasteLink can be reverted.  ActionDelete is permanent (SSD — no
// recovery path).
func RevertRecord(rec ActionRecord) error {
	switch rec.Action {
	case ActionPasteCopy:
		return revertPasteCopy(rec)
	case ActionPasteMove:
		return revertPasteMove(rec)
	case ActionRename:
		return revertRename(rec)
	case ActionMkdir:
		return revertMkdir(rec)
	case ActionPasteLink:
		return revertPasteLink(rec)
	case ActionDelete:
		return fmt.Errorf("delete is permanent on SSD — recovery requires a backup")
	default:
		return fmt.Errorf("action '%s' produces no filesystem change to revert", rec.ActionStr)
	}
}

// revertPasteLink removes only the symlink(s) at rec.Dest.
// os.Remove (NOT RemoveAll) is intentional — removes exactly the link,
// never the target.
func revertPasteLink(rec ActionRecord) error {
	if rec.Dest == "" {
		return fmt.Errorf("paste-link record has no dest")
	}
	for _, src := range rec.Sources {
		dstPath := filepath.Join(rec.Dest, filepath.Base(src))
		if _, err := os.Lstat(dstPath); os.IsNotExist(err) {
			continue // idempotent
		}
		if err := os.Remove(dstPath); err != nil {
			return fmt.Errorf("revert paste-link: %q: %w", dstPath, err)
		}
	}
	return nil
}

// revertPasteCopy removes the files/dirs that were copied into rec.Dest.
// Each source basename is deleted from Dest.  Fails fast on the first error
// to avoid partial reverts.
func revertPasteCopy(rec ActionRecord) error {
	if rec.Dest == "" {
		return fmt.Errorf("paste-copy record has no dest")
	}
	for _, src := range rec.Sources {
		dstPath := filepath.Join(rec.Dest, filepath.Base(src))

		// Verify the destination still exists before removing
		if _, err := os.Stat(dstPath); os.IsNotExist(err) {
			// Already gone — treat as success (idempotent)
			continue
		}

		if err := os.RemoveAll(dstPath); err != nil {
			return fmt.Errorf("revert paste-copy: remove %q: %w", dstPath, err)
		}
	}
	return nil
}

// revertPasteMove moves each file/dir back from Dest to its original Source
// location.  Uses os.Rename first; falls back to copy+delete for cross-device.
func revertPasteMove(rec ActionRecord) error {
	if rec.Dest == "" {
		return fmt.Errorf("paste-move record has no dest")
	}
	for _, src := range rec.Sources {
		dstPath := filepath.Join(rec.Dest, filepath.Base(src))

		if _, err := os.Stat(dstPath); os.IsNotExist(err) {
			return fmt.Errorf("revert paste-move: %q no longer exists at dest", dstPath)
		}

		// Ensure the original parent directory still exists
		srcDir := filepath.Dir(src)
		if err := os.MkdirAll(srcDir, 0755); err != nil {
			return fmt.Errorf("revert paste-move: recreate source dir %q: %w", srcDir, err)
		}

		if err := moveItem(dstPath, src); err != nil {
			return fmt.Errorf("revert paste-move: move %q → %q: %w", dstPath, src, err)
		}
	}
	return nil
}

// revertRename renames the file back from its new name to the original name.
// rec.Sources[0] is the original absolute path; rec.Name is the new name.
func revertRename(rec ActionRecord) error {
	if len(rec.Sources) == 0 || rec.Name == "" {
		return fmt.Errorf("rename record malformed: sources=%d name=%q", len(rec.Sources), rec.Name)
	}

	// If it's a batch rename, rec.Name is a JSON array of names
	if len(rec.Sources) > 1 || (strings.HasPrefix(rec.Name, "[") && strings.HasSuffix(rec.Name, "]")) {
		var parsedNames []string
		if err := json.Unmarshal([]byte(rec.Name), &parsedNames); err == nil && len(parsedNames) == len(rec.Sources) {
			// Revert each rename in the batch
			var lastErr error
			for i := len(rec.Sources) - 1; i >= 0; i-- { // revert in reverse order to handle dependencies cleanly
				originalPath := rec.Sources[i]
				dir := filepath.Dir(originalPath)
				currentPath := filepath.Join(dir, parsedNames[i])

				if _, err := os.Stat(currentPath); err == nil {
					if renameErr := os.Rename(currentPath, originalPath); renameErr != nil {
						lastErr = renameErr
					}
				}
			}
			return lastErr
		}
	}

	// Single rename fallback
	originalPath := rec.Sources[0]
	dir := filepath.Dir(originalPath)
	currentPath := filepath.Join(dir, rec.Name) // path after the rename was applied

	if _, err := os.Stat(currentPath); os.IsNotExist(err) {
		return fmt.Errorf("revert rename: %q not found at new location", currentPath)
	}

	if err := os.Rename(currentPath, originalPath); err != nil {
		return fmt.Errorf("revert rename: %q → %q: %w", currentPath, originalPath, err)
	}
	return nil
}

// revertMkdir removes a directory created by zen-man, but only if it is
// still empty.  A non-empty directory is not removed to prevent data loss.
func revertMkdir(rec ActionRecord) error {
	if rec.Dest == "" || rec.Name == "" {
		return fmt.Errorf("mkdir record malformed: dest=%q name=%q", rec.Dest, rec.Name)
	}

	target := filepath.Join(rec.Dest, rec.Name)

	entries, err := os.ReadDir(target)
	if os.IsNotExist(err) {
		return nil // already gone — idempotent success
	}
	if err != nil {
		return fmt.Errorf("revert mkdir: stat %q: %w", target, err)
	}
	if len(entries) > 0 {
		return fmt.Errorf("revert mkdir: %q is not empty (%d items) — will not remove", target, len(entries))
	}

	if err := os.Remove(target); err != nil {
		return fmt.Errorf("revert mkdir: remove %q: %w", target, err)
	}
	return nil
}
