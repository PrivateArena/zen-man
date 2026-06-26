package api

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// VirtualNode mirrors FileEntry for archive contents.
type VirtualNode struct {
	Name         string    `json:"name"`
	IsDir        bool      `json:"is_dir"`
	Size         int64     `json:"size"`
	ModTime      time.Time `json:"mod_time"`
	InternalPath string    `json:"internal_path"`
	Children     []string  `json:"children,omitempty"` // InternalPaths of children
}

// ToFileEntry converts a VirtualNode to the canonical FileEntry schema.
func (n *VirtualNode) ToFileEntry() FileEntry {
	return FileEntry{
		Name:    n.Name,
		IsDir:   n.IsDir,
		Size:    n.Size,
		ModTime: n.ModTime.Unix(),
		Mode:    "-r--r--r--", // read-only visual cue
		RelPath: n.InternalPath,
	}
}

// ArchiveCache keeps in-memory directory representation of an archive
type ArchiveCache struct {
	Nodes      map[string]*VirtualNode // key: InternalPath (canonical, clean slash path)
	HostMtime  time.Time
	LastAccess time.Time
	mu         sync.RWMutex
}

const (
	maxCacheEntries = 10
	cacheTTL        = 15 * time.Minute
	evictInterval   = 5 * time.Minute
)

var (
	manifestCache  sync.Map // key: composite path (e.g. hostPath or hostPath::nestedPath) -> *ArchiveCache
	manifestKeys   []string // LRU tracking list (oldest at index 0)
	manifestKeysMu sync.Mutex
	evictionDone   = make(chan struct{})
)

func init() {
	go startEvictionTicker(evictionDone)
}

// StopEviction stops the background eviction ticker (useful for testing or shutdown)
func StopEviction() {
	close(evictionDone)
}

func startEvictionTicker(done <-chan struct{}) {
	ticker := time.NewTicker(evictInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			evictStale()
		case <-done:
			return
		}
	}
}

func evictStale() {
	now := time.Now()
	manifestCache.Range(func(key, val interface{}) bool {
		cache := val.(*ArchiveCache)
		cache.mu.RLock()
		idle := now.Sub(cache.LastAccess)
		cache.mu.RUnlock()

		if idle > cacheTTL {
			manifestCache.Delete(key)
			removeKey(key.(string))
		}
		return true
	})
}

// GetCache retrieves an ArchiveCache from the global cache, updating its last access time
func GetCache(cacheKey string) (*ArchiveCache, bool) {
	val, ok := manifestCache.Load(cacheKey)
	if !ok {
		return nil, false
	}
	cache := val.(*ArchiveCache)
	cache.mu.Lock()
	cache.LastAccess = time.Now()
	cache.mu.Unlock()

	// Update LRU position
	manifestKeysMu.Lock()
	promoteKey(cacheKey)
	manifestKeysMu.Unlock()

	return cache, true
}

// PutCache adds an ArchiveCache to the global cache, enforcing the LRU cap
func PutCache(cacheKey string, cache *ArchiveCache) {
	manifestKeysMu.Lock()
	defer manifestKeysMu.Unlock()

	// If key already exists, promote it and update value
	if _, ok := manifestCache.Load(cacheKey); ok {
		promoteKey(cacheKey)
		manifestCache.Store(cacheKey, cache)
		return
	}

	// Enforce LRU cap
	if len(manifestKeys) >= maxCacheEntries {
		oldest := manifestKeys[0]
		manifestCache.Delete(oldest)
		manifestKeys = manifestKeys[1:]
	}

	manifestKeys = append(manifestKeys, cacheKey)
	manifestCache.Store(cacheKey, cache)
}

// InvalidateCache invalidates a specific cache entry
func InvalidateCache(cacheKey string) {
	manifestCache.Delete(cacheKey)
	manifestKeysMu.Lock()
	removeKey(cacheKey)
	manifestKeysMu.Unlock()
}

func promoteKey(key string) {
	for i, k := range manifestKeys {
		if k == key {
			manifestKeys = append(manifestKeys[:i], manifestKeys[i+1:]...)
			break
		}
	}
	manifestKeys = append(manifestKeys, key)
}

func removeKey(key string) {
	for i, k := range manifestKeys {
		if k == key {
			manifestKeys = append(manifestKeys[:i], manifestKeys[i+1:]...)
			return
		}
	}
}

// BuildCacheKey creates a canonical key for the cache based on host archive and optional nested path
func BuildCacheKey(hostPath, nestedPath string) string {
	cleanedHost := filepath.Clean(hostPath)
	if nestedPath == "" {
		return cleanedHost
	}
	// Normalize nested path separators to slashes
	cleanedNested := filepath.ToSlash(filepath.Clean(nestedPath))
	cleanedNested = strings.Trim(cleanedNested, "/")
	return cleanedHost + "::" + cleanedNested
}

// OpenAndVerify opens an archive file and verifies its modtime matches what we expect
func OpenAndVerify(hostPath string, cachedMtime time.Time) (*os.File, error) {
	f, err := os.Open(hostPath)
	if err != nil {
		return nil, err
	}

	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}

	if !fi.ModTime().Equal(cachedMtime) {
		f.Close()
		return nil, fmt.Errorf("archive_modified")
	}

	return f, nil
}
