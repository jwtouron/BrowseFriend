package companion

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	hostcontract "browsefriend/shared"
)

func TestInstallUninstall(t *testing.T) {
	paths := testPaths(t)
	var err error
	source := filepath.Join(t.TempDir(), "host")
	if err := os.WriteFile(source, []byte("synthetic-executable"), 0700); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Install(paths, source, true, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Data); !os.IsNotExist(err) {
		t.Fatal("dry run wrote files")
	}
	for i := 0; i < 2; i++ {
		if err := Install(paths, source, false, &out); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(paths.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	var manifest object
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["path"] != paths.Binary || manifest["name"] != hostcontract.Contract.HostName {
		t.Fatal(manifest)
	}
	origins := manifest["allowed_origins"].([]any)
	if len(origins) != 1 || origins[0] != hostcontract.Contract.ExtensionOrigin {
		t.Fatal(origins)
	}
	for path, mode := range map[string]os.FileMode{paths.Binary: 0700, paths.Manifest: 0600} {
		info, err := os.Stat(path)
		if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != mode) {
			t.Fatal(path, err)
		}
	}
	account := filepath.Join(paths.Data, "account.enc")
	os.WriteFile(account, []byte("encrypted-synthetic-backup"), 0600)
	if err := Uninstall(paths, false, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(account); err != nil {
		t.Fatal("account removed", err)
	}
	if _, err := os.Stat(paths.Manifest); !os.IsNotExist(err) {
		t.Fatal("manifest remains")
	}
	if err := Uninstall(paths, false, &out); err != nil {
		t.Fatal(err)
	}
}
func TestInstallationFailurePreservesRegistration(t *testing.T) {
	paths := testPaths(t)
	source := filepath.Join(t.TempDir(), "host")
	os.WriteFile(source, []byte("binary"), 0700)
	if err := Install(paths, source, false, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(paths.Manifest)
	if err := Install(paths, source+"-missing", false, &bytes.Buffer{}); err == nil {
		t.Fatal("missing source accepted")
	}
	after, _ := os.ReadFile(paths.Manifest)
	if !bytes.Equal(before, after) {
		t.Fatal("registration changed")
	}
	var m object
	json.Unmarshal(before, &m)
	m["path"] = "/another/installation"
	changed, _ := json.Marshal(m)
	os.WriteFile(paths.Manifest, changed, 0600)
	if err := Uninstall(paths, false, &bytes.Buffer{}); publicError(err).Code != "registration_conflict" {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Binary); err != nil {
		t.Fatal("other registration caused binary removal")
	}
	if runtime.GOOS == "windows" {
		return
	} // Windows reparse-point checks have native-only tests.
	os.Remove(paths.Binary)
	os.Symlink(source, paths.Binary)
	if err := Install(paths, source, false, &bytes.Buffer{}); publicError(err).Code != "storage_unsafe" {
		t.Fatal(err)
	}
}
func TestPlatformPaths(t *testing.T) {
	mac, _ := Paths("darwin", "/Users/tester", "")
	linux, _ := Paths("linux", "/home/tester", "/custom")
	if mac.Data != filepath.Join("/Users/tester", "Library", "Application Support", "BrowseFriend", "native-host") {
		t.Fatal(mac)
	}
	if linux.Data != filepath.Join("/custom", "browsefriend", "native-host") || linux.Manifest != filepath.Join("/custom", "google-chrome", "NativeMessagingHosts", "com.browsefriend.native_host.json") {
		t.Fatal(linux)
	}
	if _, err := Paths("unsupported", "test", ""); err == nil {
		t.Fatal("unsupported platform accepted")
	}
}
