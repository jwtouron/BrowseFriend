//go:build darwin || linux

package companion

import (
	"os"
	"path/filepath"
	"syscall"
)

func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		return failure("storage_unsafe", "Credential storage must be a private directory.", false)
	}
	return os.Chmod(path, 0700)
}
func privateFile(path string, flags int) (*os.File, error) {
	fd, err := syscall.Open(path, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		f.Close()
		return nil, failure("storage_unsafe", "Credential storage must be a private, owner-only file.", false)
	}
	return f, nil
}

func secureFile(f *os.File, mode os.FileMode) error { return f.Chmod(mode) }
func privateTemp(directory string) (*os.File, error) {
	return os.CreateTemp(directory, ".browsefriend-*")
}
func replaceFile(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(to))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func removeBinary(path string) error { return os.Remove(path) }
