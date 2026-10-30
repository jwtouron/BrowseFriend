package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type packageFile struct {
	name string
	data []byte
	mode os.FileMode
}

func packageHost(root, binary, platform, arch string) (string, error) {
	if (platform != "darwin" && platform != "linux" && platform != "windows") || (arch != "amd64" && arch != "arm64") {
		return "", fmt.Errorf("unsupported package target: %s/%s", platform, arch)
	}
	files := []packageFile{}
	for _, input := range []struct {
		name, path string
		mode       os.FileMode
	}{
		{"browsefriend-native-host" + suffix(platform), binary, 0755},
		{"LICENSE", filepath.Join(root, "LICENSE"), 0644},
		{"NOTICE.md", filepath.Join(root, "NOTICE.md"), 0644},
		{"THIRD-PARTY-NOTICES.txt", filepath.Join(root, "build", "THIRD-PARTY-NOTICES.txt"), 0644},
	} {
		data, err := os.ReadFile(input.path)
		if err != nil {
			return "", err
		}
		files = append(files, packageFile{input.name, data, input.mode})
	}
	directory := filepath.Join(root, "build", "packages")
	if err := os.MkdirAll(directory, 0755); err != nil {
		return "", err
	}
	extension := ".tar.gz"
	if platform == "windows" {
		extension = ".zip"
	}
	path := filepath.Join(directory, "browsefriend-"+platform+"-"+arch+extension)
	file, err := os.CreateTemp(directory, ".package-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	digest := sha256.New()
	out := io.MultiWriter(file, digest)
	if platform == "windows" {
		err = writeZip(out, files)
	} else {
		err = writeTar(out, files)
	}
	if err == nil {
		err = file.Sync()
	}
	closed := file.Close()
	if err != nil {
		return "", err
	}
	if closed != nil {
		return "", closed
	}
	if err = os.Chmod(file.Name(), 0644); err != nil {
		return "", err
	}
	if err = os.Rename(file.Name(), path); err != nil {
		return "", err
	}
	checksum := fmt.Sprintf("%x  %s\n", digest.Sum(nil), filepath.Base(path))
	if err = os.WriteFile(path+".sha256", []byte(checksum), 0644); err != nil {
		return "", err
	}
	return path, nil
}

func writeTar(out io.Writer, files []packageFile) error {
	compressed := gzip.NewWriter(out)
	archive := tar.NewWriter(compressed)
	for _, file := range files {
		header := &tar.Header{Name: file.name, Mode: int64(file.mode.Perm()), Size: int64(len(file.data)), ModTime: time.Unix(0, 0), Typeflag: tar.TypeReg}
		if err := archive.WriteHeader(header); err != nil {
			return err
		}
		if _, err := archive.Write(file.data); err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return compressed.Close()
}

func writeZip(out io.Writer, files []packageFile) error {
	archive := zip.NewWriter(out)
	for _, file := range files {
		header := &zip.FileHeader{Name: file.name, Method: zip.Deflate}
		header.SetMode(file.mode)
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		entry, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		if _, err = entry.Write(file.data); err != nil {
			return err
		}
	}
	return archive.Close()
}
