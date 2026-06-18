package api

import (
	"encoding/json"
	"fmt"
	"net/http"
)

type DiskSpaceInfo struct {
	Free  uint64 `json:"free"`
	Total uint64 `json:"total"`
}

func HandleDiskSpace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, `{"error": "Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	pathQuery := r.URL.Query().Get("path")
	resolvedPath, err := ResolvePath(pathQuery)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Invalid path: %v"}`, err), http.StatusBadRequest)
		return
	}

	info, err := GetDiskSpace(resolvedPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error": "Failed to get disk space: %v"}`, err), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(info)
}
