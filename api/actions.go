package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Generate a random UUID-like string
func generateUUID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func HandleActions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "%v"}`, err), http.StatusInternalServerError)
		return
	}

	if r.Method == http.MethodGet {
		if cfg.CustomActions == nil {
			cfg.CustomActions = []CustomAction{}
		}
		json.NewEncoder(w).Encode(cfg.CustomActions)
		return
	}

	if r.Method == http.MethodPost {
		var req struct {
			Action     string       `json:"action"` // "create", "update", "delete", "reorder"
			ActionData CustomAction `json:"action_data"`
			IDs        []string     `json:"ids"` // for "reorder"
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Invalid request: %v"}`, err), http.StatusBadRequest)
			return
		}

		if cfg.CustomActions == nil {
			cfg.CustomActions = []CustomAction{}
		}

		switch req.Action {
		case "create":
			req.ActionData.ID = generateUUID()
			cfg.CustomActions = append(cfg.CustomActions, req.ActionData)

		case "update":
			found := false
			for i, act := range cfg.CustomActions {
				if act.ID == req.ActionData.ID {
					cfg.CustomActions[i] = req.ActionData
					found = true
					break
				}
			}
			if !found {
				http.Error(w, `{"error": "Action not found"}`, http.StatusNotFound)
				return
			}

		case "delete":
			found := false
			newActions := make([]CustomAction, 0, len(cfg.CustomActions))
			for _, act := range cfg.CustomActions {
				if act.ID == req.ActionData.ID {
					found = true
				} else {
					newActions = append(newActions, act)
				}
			}
			if !found {
				http.Error(w, `{"error": "Action not found"}`, http.StatusNotFound)
				return
			}
			cfg.CustomActions = newActions

		case "reorder":
			ordered := make([]CustomAction, 0, len(cfg.CustomActions))
			actionMap := make(map[string]CustomAction)
			for _, act := range cfg.CustomActions {
				actionMap[act.ID] = act
			}
			for _, id := range req.IDs {
				if act, ok := actionMap[id]; ok {
					ordered = append(ordered, act)
				}
			}
			// Append any missing ones that weren't in the list
			for _, act := range cfg.CustomActions {
				found := false
				for _, id := range req.IDs {
					if act.ID == id {
						found = true
						break
					}
				}
				if !found {
					ordered = append(ordered, act)
				}
			}
			cfg.CustomActions = ordered

		default:
			http.Error(w, `{"error": "Unknown action"}`, http.StatusBadRequest)
			return
		}

		if err := saveConfig(cfg); err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to save: %v"}`, err), http.StatusInternalServerError)
			return
		}

		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "custom_actions": cfg.CustomActions})
		return
	}

	http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
}

func HandleActionExec(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		ID    string   `json:"id"`
		Paths []string `json:"paths"`
		Dir   string   `json:"dir"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid request: %v"}`, err), http.StatusBadRequest)
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "%v"}`, err), http.StatusInternalServerError)
		return
	}

	var targetAction *CustomAction
	for _, act := range cfg.CustomActions {
		if act.ID == req.ID {
			targetAction = &act
			break
		}
	}

	if targetAction == nil {
		http.Error(w, `{"error": "Custom action not found"}`, http.StatusNotFound)
		return
	}

	cmdStr := targetAction.Command
	var firstPath string
	if len(req.Paths) > 0 {
		firstPath = req.Paths[0]
	}

	var parentDir string
	if firstPath != "" {
		parentDir = filepath.Dir(firstPath)
	}

	var firstName string
	if firstPath != "" {
		firstName = filepath.Base(firstPath)
	}

	// build shell-safe representation or simpler string representation
	// Note: We wrap in quotes if we are outputting single variable expansions
	quotedPaths := []string{}
	for _, p := range req.Paths {
		quotedPaths = append(quotedPaths, fmt.Sprintf(`"%s"`, strings.ReplaceAll(p, `"`, `\"`)))
	}
	filesStr := strings.Join(quotedPaths, " ")

	quotedNames := []string{}
	for _, p := range req.Paths {
		quotedNames = append(quotedNames, fmt.Sprintf(`"%s"`, strings.ReplaceAll(filepath.Base(p), `"`, `\"`)))
	}
	namesStr := strings.Join(quotedNames, " ")

	// {target_dir}: smart directory — the folder itself if a dir was clicked,
	// the file's parent if a file was clicked, or the current pane dir on background.
	var targetDir string
	if firstPath != "" {
		if info, err := os.Stat(firstPath); err == nil && info.IsDir() {
			targetDir = firstPath
		} else {
			targetDir = parentDir
		}
	} else {
		targetDir = req.Dir
	}

	cmdStr = strings.ReplaceAll(cmdStr, "{dir}", req.Dir)
	cmdStr = strings.ReplaceAll(cmdStr, "{target_dir}", targetDir)
	cmdStr = strings.ReplaceAll(cmdStr, "{file}", firstPath)
	cmdStr = strings.ReplaceAll(cmdStr, "{files}", filesStr)
	cmdStr = strings.ReplaceAll(cmdStr, "{name}", firstName)
	cmdStr = strings.ReplaceAll(cmdStr, "{names}", namesStr)
	cmdStr = strings.ReplaceAll(cmdStr, "{parent}", parentDir)

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", cmdStr)
	} else {
		cmd = exec.Command("sh", "-c", cmdStr)
	}
	cmd.Dir = req.Dir

	if targetAction.ShowOutput {
		out, err := cmd.CombinedOutput()
		if err != nil {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"status": "error",
				"error":  err.Error(),
				"output": string(out),
			})
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success",
			"output": string(out),
		})
	} else {
		err := cmd.Start()
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Failed to start command: %v"}`, err), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success",
		})
	}
}
