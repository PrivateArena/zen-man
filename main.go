package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"zen-man/api"
)

//go:embed frontend/*
var embeddedFrontend embed.FS

// canCreateSymlink is probed once at startup via a temporary os.Symlink call.
// On Windows this detects Developer Mode / admin privileges; on Linux/macOS
// it always succeeds.
var canCreateSymlink bool

func init() {
	canCreateSymlink = probeSymlinkSupport()
}

func probeSymlinkSupport() bool {
	tmpDir, err := os.MkdirTemp("", "zen-man-symlink-probe-*")
	if err != nil {
		return false
	}
	defer os.RemoveAll(tmpDir)

	target := filepath.Join(tmpDir, "target")
	link := filepath.Join(tmpDir, "link")

	// Create a zero-byte temp file
	if err := os.WriteFile(target, []byte{}, 0644); err != nil {
		return false
	}

	if err := os.Symlink(target, link); err != nil {
		return false
	}

	// Clean up is deferred via RemoveAll above
	return true
}

func openBrowser(url string) {
	var err error
	switch runtime.GOOS {
	case "linux":
		err = exec.Command("xdg-open", url).Start()
	case "windows":
		err = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		err = exec.Command("open", url).Start()
	}
	if err != nil {
		log.Printf("Failed to open browser: %v", err)
	}
}

func main() {
	devMode := flag.Bool("dev", false, "run in development mode (serves static files from local filesystem)")
	portFlag := flag.Int("port", 0, "port to run on (default: auto-assign free port)")
	flag.Parse()

	// Initialize SQLite Database
	if err := api.InitDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}

	var fileServer http.Handler

	if *devMode {
		fmt.Println("Running in DEVELOPMENT mode: serving from ./frontend")
		fileServer = http.FileServer(http.Dir("./frontend"))
	} else {
		// Serve from embedded FS
		subFS, err := fs.Sub(embeddedFrontend, "frontend")
		if err != nil {
			log.Fatalf("Failed to extract embedded frontend: %v", err)
		}
		fileServer = http.FileServer(http.FS(subFS))
	}

	mux := http.NewServeMux()

	// Static files
	mux.Handle("/", fileServer)

	// API Handlers (wrapped or bound in api subpackage)
	mux.HandleFunc("/api/dir", api.HandleReadDirectory)
	mux.HandleFunc("/api/dir/size", api.HandleDirSize)
	mux.HandleFunc("/api/op", api.HandleFileOp)
	mux.HandleFunc("/api/places", api.HandlePlaces)
	mux.HandleFunc("/api/workspaces", api.HandleWorkspaces)
	mux.HandleFunc("/api/actions", api.HandleActions)
	mux.HandleFunc("/api/action/exec", api.HandleActionExec)
	mux.HandleFunc("/api/search", api.HandleSearch)
	mux.HandleFunc("/api/props", handleProperties)
	mux.HandleFunc("/api/log", api.HandleLog)
	mux.HandleFunc("/api/log/revert", api.HandleLogRevert)
	mux.HandleFunc("/api/diskspace", api.HandleDiskSpace)
	mux.HandleFunc("/api/index/search", api.HandleIndexSearch)
	mux.HandleFunc("/api/index/rebuild", api.HandleIndexRebuild)
	mux.HandleFunc("/api/index/status", api.HandleIndexStatus)
	mux.HandleFunc("/api/index/config", api.HandleIndexConfig)
	mux.HandleFunc("/api/index/cancel", api.HandleIndexCancel)
	mux.HandleFunc("/api/archive/dir", api.HandleListArchiveDir)
	mux.HandleFunc("/api/archive/stream", api.HandleStreamArchiveFile)
	mux.HandleFunc("/api/archive/extract", api.HandleExtractArchive)
	mux.HandleFunc("/api/archive/extract/status", api.HandleExtractStatus)

	// Bind strictly to localhost loopback
	addr := fmt.Sprintf("127.0.0.1:%d", *portFlag)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("Failed to bind to %s: %v", addr, err)
	}

	assignedPort := listener.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://127.0.0.1:%d", assignedPort)
	fmt.Printf("Zen-Man File Manager listening on %s\n", url)

	//if !*devMode {
	//	openBrowser(url)
	//}

	if err := http.Serve(listener, mux); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}

func handleProperties(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"symlink_supported": canCreateSymlink,
		"platform":          runtime.GOOS,
	})
}
