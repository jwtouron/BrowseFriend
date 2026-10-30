package companion

import (
	"io"
	"os"
	"path/filepath"
)

func atomicFile(path string, source io.Reader, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return failure("storage_unsafe", "Refusing to replace a non-regular file.", false)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	temp, err := privateTemp(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err = secureFile(temp, mode); err == nil {
		_, err = io.Copy(temp, source)
	}
	if err == nil {
		err = temp.Sync()
	}
	closed := temp.Close()
	if err != nil {
		return err
	}
	if closed != nil {
		return closed
	}
	return replaceFile(temp.Name(), path)
}
