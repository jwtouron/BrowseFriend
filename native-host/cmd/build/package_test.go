package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func packageFixture(t *testing.T) (string, string, map[string][]byte) {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "build"), 0755); err != nil {
		t.Fatal(err)
	}
	contents := map[string][]byte{
		"LICENSE":                       []byte("MIT fixture license"),
		"NOTICE.md":                     []byte("Asset attribution stays separate."),
		"build/THIRD-PARTY-NOTICES.txt": []byte("Apache and BSD fixture notices"),
		"build/production":              []byte("production\x00binary\n雪"),
		"build/test-host.exe":           []byte("never package the test driver"),
		"build/account.enc":             []byte("never package account data"),
	}
	for name, data := range contents {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name)), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root, filepath.Join(root, "build", "production"), contents
}

func TestPackageArchivesContainOnlyProductionAndLicenses(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		t.Run(platform, func(t *testing.T) {
			root, binary, fixture := packageFixture(t)
			path, err := packageHost(root, binary, platform, "arm64")
			if err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			checksum, err := os.ReadFile(path + ".sha256")
			if err != nil || string(checksum) != fmt.Sprintf("%x  %s\n", sha256.Sum256(data), filepath.Base(path)) {
				t.Fatal("incorrect archive checksum", err)
			}
			actual := map[string][]byte{}
			modes := map[string]os.FileMode{}
			if platform == "windows" {
				reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range reader.File {
					in, err := entry.Open()
					if err != nil {
						t.Fatal(err)
					}
					actual[entry.Name], err = io.ReadAll(in)
					in.Close()
					if err != nil {
						t.Fatal(err)
					}
					modes[entry.Name] = entry.Mode()
				}
			} else {
				compressed, err := gzip.NewReader(bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				defer compressed.Close()
				reader := tar.NewReader(compressed)
				for {
					header, err := reader.Next()
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Fatal(err)
					}
					if header.Typeflag != tar.TypeReg {
						t.Fatal("unexpected archive entry type")
					}
					actual[header.Name], err = io.ReadAll(reader)
					if err != nil {
						t.Fatal(err)
					}
					modes[header.Name] = os.FileMode(header.Mode)
				}
			}
			expected := map[string][]byte{
				"browsefriend-native-host" + suffix(platform): fixture["build/production"],
				"LICENSE": fixture["LICENSE"], "NOTICE.md": fixture["NOTICE.md"],
				"THIRD-PARTY-NOTICES.txt": fixture["build/THIRD-PARTY-NOTICES.txt"],
			}
			if len(actual) != len(expected) {
				t.Fatal("unexpected packaged files", actual)
			}
			for name, content := range expected {
				if !bytes.Equal(actual[name], content) {
					t.Fatal("changed or missing packaged file", name)
				}
				mode := os.FileMode(0644)
				if strings.HasPrefix(name, "browsefriend-native-host") {
					mode = 0755
				}
				if modes[name].Perm() != mode {
					t.Fatal("incorrect archive permissions", name, modes[name])
				}
			}
			if _, err := packageHost(root, binary, platform, "arm64"); err != nil {
				t.Fatal("repeat packaging failed", err)
			}
			repeated, _ := os.ReadFile(path)
			if !bytes.Equal(data, repeated) {
				t.Fatal("package contains unstable metadata")
			}
		})
	}
}

func TestPackageRequiresAllNoticesAndSupportedTarget(t *testing.T) {
	root, binary, _ := packageFixture(t)
	if _, err := packageHost(root, binary, "unsupported", "amd64"); err == nil {
		t.Fatal("unsupported platform accepted")
	}
	if _, err := packageHost(root, binary, "windows", "386"); err == nil {
		t.Fatal("unsupported architecture accepted")
	}
	os.Remove(filepath.Join(root, "build", "THIRD-PARTY-NOTICES.txt"))
	if _, err := packageHost(root, binary, "linux", "amd64"); err == nil {
		t.Fatal("package without dependency licenses accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "build", "packages")); !os.IsNotExist(err) {
		t.Fatal("incomplete package left behind")
	}
}
