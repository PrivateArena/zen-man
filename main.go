package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"zen-man/api"
)

//go:embed frontend/*
var embeddedFrontend embed.FS

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

// Dummy handler implementations for initial compilation

func handleProperties(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"name": "", "size": 0}`))
}
