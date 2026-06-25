package api

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// HandleIndexSearch executes an indexed search query
func HandleIndexSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	qStr := r.URL.Query().Get("q")
	limitStr := r.URL.Query().Get("limit")
	offsetStr := r.URL.Query().Get("offset")

	limit := 200
	if limitStr != "" {
		if val, err := strconv.Atoi(limitStr); err == nil && val > 0 {
			limit = val
		}
	}
	offset := 0
	if offsetStr != "" {
		if val, err := strconv.Atoi(offsetStr); err == nil && val >= 0 {
			offset = val
		}
	}

	im := GetIndexManager()
	im.Mutex.RLock()
	isDirty := im.Config.IndexState.IsDirty
	lastIndexed := im.Config.IndexState.LastIndexedUnix
	im.Mutex.RUnlock()

	// If there is no search query and no filters, return empty results
	pq := ParseSearchQuery(qStr)

	// If the index is empty/dirty and we have no records, we could fall back,
	// but here we execute search on SQLite db table 'files'.
	entries, totalMatched, err := ExecuteSearch(pq, limit, offset)
	if err != nil {
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	response := map[string]interface{}{
		"entries":           entries,
		"total_matched":     totalMatched,
		"capped":            totalMatched > limit+offset,
		"index_dirty":       isDirty,
		"last_indexed_unix": lastIndexed,
	}

	json.NewEncoder(w).Encode(response)
}

// HandleIndexRebuild starts the rebuild process
func HandleIndexRebuild(w http.ResponseWriter, r *http.Request) {
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

	im := GetIndexManager()
	err := im.RebuildIndex()
	if err != nil {
		http.Error(w, `{"error": "`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"started": true,
	})
}

// HandleIndexStatus returns status info about indexing
func HandleIndexStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	im := GetIndexManager()
	im.Mutex.RLock()
	defer im.Mutex.RUnlock()

	response := map[string]interface{}{
		"is_indexing":  im.IsRebuilding,
		"total_files":  im.Config.IndexState.TotalFiles,
		"last_indexed": im.Config.IndexState.LastIndexedUnix,
		"is_dirty":     im.Config.IndexState.IsDirty,
		"config": map[string]interface{}{
			"roots":           im.Config.Roots,
			"excludes":        im.Config.Excludes,
			"auto_index":      im.Config.AutoIndex,
			"worker_count":    im.Config.WorkerCount,
			"follow_symlinks": im.Config.FollowSymlinks,
		},
		"progress": map[string]interface{}{
			"indexed": im.ProgressCount,
		},
	}
	if im.LastErr != nil {
		response["error"] = im.LastErr.Error()
	}

	json.NewEncoder(w).Encode(response)
}

// HandleIndexConfig updates configurations
func HandleIndexConfig(w http.ResponseWriter, r *http.Request) {
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

	type ConfigInput struct {
		Roots          []string `json:"roots"`
		Excludes       []string `json:"excludes"`
		AutoIndex      bool     `json:"auto_index"`
		WorkerCount    int      `json:"worker_count"`
		FollowSymlinks bool     `json:"follow_symlinks"`
	}

	var input ConfigInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, `{"error": "Invalid JSON body"}`, http.StatusBadRequest)
		return
	}

	im := GetIndexManager()
	im.Mutex.Lock()
	im.Config.Roots = input.Roots
	im.Config.Excludes = input.Excludes
	im.Config.AutoIndex = input.AutoIndex
	im.Config.WorkerCount = input.WorkerCount
	im.Config.FollowSymlinks = input.FollowSymlinks
	err := im.SaveConfig()
	im.Mutex.Unlock()

	if err != nil {
		http.Error(w, `{"error": "Failed to save configuration: `+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"saved": true,
	})
}

// HandleIndexCancel cancels active rebuild task
func HandleIndexCancel(w http.ResponseWriter, r *http.Request) {
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

	im := GetIndexManager()
	im.CancelRebuild()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"cancelled": true,
	})
}
