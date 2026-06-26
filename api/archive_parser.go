package api

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bodgit/sevenzip"
	"github.com/nwaples/rardecode"
)

// DetectFormat returns the format type based on file extension
func DetectFormat(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".zip":
		return "zip"
	case ".rar":
		return "rar"
	case ".7z":
		return "7z"
	default:
		return ""
	}
}

func cleanInternalPath(p string) string {
	p = filepath.ToSlash(p)
	p = strings.Trim(p, "/")
	return p
}

func parseZip(ra io.ReaderAt, size int64, nodes map[string]*VirtualNode) error {
	r, err := zip.NewReader(ra, size)
	if err != nil {
		return err
	}
	for _, f := range r.File {
		cleanPath := cleanInternalPath(f.Name)
		if cleanPath == "" || cleanPath == "." {
			continue
		}
		isDir := f.FileInfo().IsDir()
		nodes[cleanPath] = &VirtualNode{
			Name:         filepath.Base(cleanPath),
			IsDir:        isDir,
			Size:         int64(f.UncompressedSize64),
			ModTime:      f.Modified,
			InternalPath: cleanPath,
		}
	}
	return nil
}

func parseRar(r io.Reader, nodes map[string]*VirtualNode) error {
	rr, err := rardecode.NewReader(r, "")
	if err != nil {
		return err
	}
	for {
		header, err := rr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		cleanPath := cleanInternalPath(header.Name)
		if cleanPath == "" || cleanPath == "." {
			continue
		}
		nodes[cleanPath] = &VirtualNode{
			Name:         filepath.Base(cleanPath),
			IsDir:        header.IsDir,
			Size:         header.UnPackedSize,
			ModTime:      header.ModificationTime,
			InternalPath: cleanPath,
		}
	}
	return nil
}

func parse7z(ra io.ReaderAt, size int64, nodes map[string]*VirtualNode) error {
	r, err := sevenzip.NewReader(ra, size)
	if err != nil {
		return err
	}
	for _, f := range r.File {
		cleanPath := cleanInternalPath(f.Name)
		if cleanPath == "" || cleanPath == "." {
			continue
		}
		isDir := f.FileInfo().IsDir()
		nodes[cleanPath] = &VirtualNode{
			Name:         filepath.Base(cleanPath),
			IsDir:        isDir,
			Size:         int64(f.UncompressedSize),
			ModTime:      f.Modified,
			InternalPath: cleanPath,
		}
	}
	return nil
}

func synthesizeDirectories(nodes map[string]*VirtualNode) {
	for {
		added := false
		for path, node := range nodes {
			parts := strings.Split(path, "/")
			if len(parts) > 1 {
				parentPath := strings.Join(parts[:len(parts)-1], "/")
				if _, exists := nodes[parentPath]; !exists {
					nodes[parentPath] = &VirtualNode{
						Name:         parts[len(parts)-2],
						IsDir:        true,
						Size:         0,
						ModTime:      node.ModTime,
						InternalPath: parentPath,
					}
					added = true
				}
			}
		}
		if !added {
			break
		}
	}

	for path := range nodes {
		parts := strings.Split(path, "/")
		if len(parts) > 1 {
			parentPath := strings.Join(parts[:len(parts)-1], "/")
			if parent, exists := nodes[parentPath]; exists {
				found := false
				for _, child := range parent.Children {
					if child == path {
						found = true
						break
					}
				}
				if !found {
					parent.Children = append(parent.Children, path)
				}
			}
		}
	}
}

func extractFileToMemory(hostPath, nestedPath string) ([]byte, error) {
	hostCacheKey := BuildCacheKey(hostPath, "")
	cache, ok := GetCache(hostCacheKey)
	var err error
	if !ok {
		cache, err = BuildManifest(hostPath, "")
		if err != nil {
			return nil, err
		}
	}

	f, err := OpenAndVerify(hostPath, cache.HostMtime)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	nestedPath = cleanInternalPath(nestedPath)
	node, exists := cache.Nodes[nestedPath]
	if !exists || node.IsDir {
		return nil, fmt.Errorf("file not found in archive: %s", nestedPath)
	}

	format := DetectFormat(hostPath)
	switch format {
	case "zip":
		fi, err := f.Stat()
		if err != nil {
			return nil, err
		}
		zr, err := zip.NewReader(f, fi.Size())
		if err != nil {
			return nil, err
		}
		for _, zf := range zr.File {
			if cleanInternalPath(zf.Name) == nestedPath {
				rc, err := zf.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}
		}
	case "rar":
		rr, err := rardecode.NewReader(f, "")
		if err != nil {
			return nil, err
		}
		for {
			header, err := rr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			if cleanInternalPath(header.Name) == nestedPath {
				return io.ReadAll(rr)
			}
		}
	case "7z":
		fi, err := f.Stat()
		if err != nil {
			return nil, err
		}
		sz, err := sevenzip.NewReader(f, fi.Size())
		if err != nil {
			return nil, err
		}
		for _, sf := range sz.File {
			if cleanInternalPath(sf.Name) == nestedPath {
				rc, err := sf.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}
		}
	}

	return nil, fmt.Errorf("file %s not found in archive", nestedPath)
}

// BuildManifest parses and builds the manifest cache for the archive
func BuildManifest(hostPath, nestedPath string) (*ArchiveCache, error) {
	cacheKey := BuildCacheKey(hostPath, nestedPath)

	if nestedPath == "" {
		f, err := os.Open(hostPath)
		if err != nil {
			return nil, err
		}
		defer f.Close()

		fi, err := f.Stat()
		if err != nil {
			return nil, err
		}

		nodes := make(map[string]*VirtualNode)
		format := DetectFormat(hostPath)

		switch format {
		case "zip":
			if err := parseZip(f, fi.Size(), nodes); err != nil {
				return nil, err
			}
		case "rar":
			if err := parseRar(f, nodes); err != nil {
				return nil, err
			}
		case "7z":
			if err := parse7z(f, fi.Size(), nodes); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("unsupported archive format: %s", format)
		}

		synthesizeDirectories(nodes)

		cache := &ArchiveCache{
			Nodes:      nodes,
			HostMtime:  fi.ModTime(),
			LastAccess: time.Now(),
		}
		PutCache(cacheKey, cache)
		return cache, nil
	}

	// Nested archive path
	buf, err := extractFileToMemory(hostPath, nestedPath)
	if err != nil {
		return nil, err
	}

	nodes := make(map[string]*VirtualNode)
	format := DetectFormat(nestedPath)
	reader := bytes.NewReader(buf)
	size := int64(len(buf))

	switch format {
	case "zip":
		if err := parseZip(reader, size, nodes); err != nil {
			return nil, err
		}
	case "rar":
		if err := parseRar(reader, nodes); err != nil {
			return nil, err
		}
	case "7z":
		if err := parse7z(reader, size, nodes); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported nested archive format: %s", format)
	}

	synthesizeDirectories(nodes)

	hostCacheKey := BuildCacheKey(hostPath, "")
	hostCache, ok := GetCache(hostCacheKey)
	var hostMtime time.Time
	if ok {
		hostMtime = hostCache.HostMtime
	} else {
		if fi, err := os.Stat(hostPath); err == nil {
			hostMtime = fi.ModTime()
		}
	}

	cache := &ArchiveCache{
		Nodes:      nodes,
		HostMtime:  hostMtime,
		LastAccess: time.Now(),
	}
	PutCache(cacheKey, cache)
	return cache, nil
}
