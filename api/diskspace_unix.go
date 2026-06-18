//go:build !windows

package api

import "syscall"

func GetDiskSpace(path string) (DiskSpaceInfo, error) {
	var stat syscall.Statfs_t
	err := syscall.Statfs(path, &stat)
	if err != nil {
		return DiskSpaceInfo{}, err
	}
	return DiskSpaceInfo{
		Free:  stat.Bavail * uint64(stat.Bsize),
		Total: stat.Blocks * uint64(stat.Bsize),
	}, nil
}
