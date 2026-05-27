package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type CustomAction struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Icon       string `json:"icon"`
	Command    string `json:"command"`
	Role       string `json:"role"` // "files" | "dirs" | "both" | "background"
	Patterns   string `json:"patterns"`
	ShowOutput bool   `json:"show_output"`
}

type Config struct {
	Bookmarks     []string                    `json:"bookmarks"`
	Workspaces    map[string]WorkspaceSession `json:"workspaces"`
	CustomActions []CustomAction              `json:"custom_actions"`
}

type WorkspaceSession struct {
	LeftTabs    []TabState `json:"left_tabs"`
	LeftActive  string     `json:"left_active"`
	RightTabs   []TabState `json:"right_tabs"`
	RightActive string     `json:"right_active"`
	Split       bool       `json:"split"`
}

type TabState struct {
	Id    string `json:"id"`
	Path  string `json:"path"`
	Name  string `json:"name"`
	Group string `json:"group"`
	Color string `json:"color"`
}

type MountInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

var (
	configMutex sync.Mutex
)

func getConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	configDir := filepath.Join(home, ".config", "zen-man")
	_ = os.MkdirAll(configDir, 0755)
	return filepath.Join(configDir, "config.json"), nil
}

func loadConfig() (Config, error) {
	path, err := getConfigPath()
	if err != nil {
		return Config{}, err
	}

	configMutex.Lock()
	defer configMutex.Unlock()

	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{
				Bookmarks:     []string{},
				Workspaces:    make(map[string]WorkspaceSession),
				CustomActions: []CustomAction{},
			}, nil
		}
		return Config{}, err
	}
	defer file.Close()

	var cfg Config
	err = json.NewDecoder(file).Decode(&cfg)
	if err != nil {
		// If decoding fails, return fresh config to prevent bricking
		return Config{
			Bookmarks:     []string{},
			Workspaces:    make(map[string]WorkspaceSession),
			CustomActions: []CustomAction{},
		}, nil
	}

	if cfg.Workspaces == nil {
		cfg.Workspaces = make(map[string]WorkspaceSession)
	}
	return cfg, nil
}

func saveConfig(cfg Config) error {
	path, err := getConfigPath()
	if err != nil {
		return err
	}

	configMutex.Lock()
	defer configMutex.Unlock()

	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(cfg)
}

func HandlePlaces(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method == http.MethodGet {
		cfg, err := loadConfig()
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "%v"}`, err), http.StatusInternalServerError)
			return
		}

		mounts := getMountedDrives()

		response := map[string]interface{}{
			"bookmarks": cfg.Bookmarks,
			"mounts":    mounts,
		}
		json.NewEncoder(w).Encode(response)
		return
	}

	if r.Method == http.MethodPost {
		var req struct {
			Action string `json:"action"` // "add" or "remove"
			Path   string `json:"path"`
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

		if req.Action == "add" {
			exists := false
			for _, b := range cfg.Bookmarks {
				if b == req.Path {
					exists = true
					break
				}
			}
			if !exists {
				cfg.Bookmarks = append(cfg.Bookmarks, req.Path)
				_ = saveConfig(cfg)
			}
		} else if req.Action == "remove" {
			newBookmarks := make([]string, 0, len(cfg.Bookmarks))
			for _, b := range cfg.Bookmarks {
				if b != req.Path {
					newBookmarks = append(newBookmarks, b)
				}
			}
			cfg.Bookmarks = newBookmarks
			_ = saveConfig(cfg)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "bookmarks": cfg.Bookmarks})
		return
	}

	http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
}

func HandleWorkspaces(w http.ResponseWriter, r *http.Request) {
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
		names := []string{}
		for k := range cfg.Workspaces {
			names = append(names, k)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"workspaces": names,
		})
		return
	}

	if r.Method == http.MethodPost {
		var req struct {
			Action  string           `json:"action"` // "save" or "restore" or "delete"
			Name    string           `json:"name"`
			Session WorkspaceSession `json:"session"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, fmt.Sprintf(`{"error": "Invalid request: %v"}`, err), http.StatusBadRequest)
			return
		}

		if req.Name == "" {
			http.Error(w, `{"error": "Workspace name required"}`, http.StatusBadRequest)
			return
		}

		if req.Action == "save" {
			cfg.Workspaces[req.Name] = req.Session
			if err := saveConfig(cfg); err != nil {
				http.Error(w, fmt.Sprintf(`{"error": "Save failed: %v"}`, err), http.StatusInternalServerError)
				return
			}
			w.Write([]byte(`{"status": "success"}`))
			return
		} else if req.Action == "restore" {
			session, ok := cfg.Workspaces[req.Name]
			if !ok {
				http.Error(w, `{"error": "Workspace not found"}`, http.StatusNotFound)
				return
			}
			json.NewEncoder(w).Encode(map[string]interface{}{
				"status":  "success",
				"session": session,
			})
			return
		} else if req.Action == "delete" {
			delete(cfg.Workspaces, req.Name)
			_ = saveConfig(cfg)
			w.Write([]byte(`{"status": "success"}`))
			return
		}
	}

	http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
}

func getMountedDrives() []MountInfo {
	mounts := []MountInfo{}

	if runtime.GOOS != "linux" {
		return mounts
	}

	// 1. Check /media
	entries, err := os.ReadDir("/media")
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
				path := filepath.Join("/media", entry.Name())
				subentries, suberr := os.ReadDir(path)
				if suberr == nil && len(subentries) > 0 {
					for _, subentry := range subentries {
						if subentry.IsDir() && !strings.HasPrefix(subentry.Name(), ".") {
							mounts = append(mounts, MountInfo{
								Name: subentry.Name(),
								Path: filepath.Join(path, subentry.Name()),
							})
						}
					}
				} else {
					mounts = append(mounts, MountInfo{
						Name: entry.Name(),
						Path: path,
					})
				}
			}
		}
	}

	// 2. Check /run/media
	runMediaEntries, err := os.ReadDir("/run/media")
	if err == nil {
		for _, entry := range runMediaEntries {
			if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
				usernamePath := filepath.Join("/run/media", entry.Name())
				subentries, suberr := os.ReadDir(usernamePath)
				if suberr == nil {
					for _, subentry := range subentries {
						if subentry.IsDir() && !strings.HasPrefix(subentry.Name(), ".") {
							mounts = append(mounts, MountInfo{
								Name: subentry.Name(),
								Path: filepath.Join(usernamePath, subentry.Name()),
							})
						}
					}
				}
			}
		}
	}

	return mounts
}
