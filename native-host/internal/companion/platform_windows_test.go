package companion

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func testPaths(t *testing.T) HostPaths {
	t.Helper()
	paths, err := Paths("windows", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	paths.RegistryKey = `Software\BrowseFriend\Tests\` + randomValue()
	t.Cleanup(func() {
		parent, err := registry.OpenKey(registry.CURRENT_USER, `Software\BrowseFriend\Tests`, registry.WRITE|registry.WOW64_32KEY)
		if err == nil {
			defer parent.Close()
			registry.DeleteKey(parent, paths.RegistryKey[strings.LastIndex(paths.RegistryKey, `\`)+1:])
		}
	})
	return paths
}
func TestWindowsPaths(t *testing.T) {
	paths, err := Paths("windows", `C:\Users\Test User`, `D:\Local ü`)
	if err != nil || paths.Data != `D:\Local ü\BrowseFriend\native-host` || paths.Binary != filepath.Join(paths.Data, "browsefriend-native-host.exe") || paths.Manifest != filepath.Join(paths.Data, "com.browsefriend.native_host.json") {
		t.Fatal(paths, err)
	}
	if paths.RegistryKey != `Software\Google\Chrome\NativeMessagingHosts\com.browsefriend.native_host` {
		t.Fatal(paths.RegistryKey)
	}
}
func TestWindowsPrivateDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private")
	if err := privateDirectory(path); err != nil {
		sd, detail := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		sid, _ := currentSID()
		if detail == nil {
			t.Logf("test directory descriptor: %s; current user: %s", sd.String(), sid.String())
		}
		t.Fatal(err, detail)
	}
}
func TestWindowsProtectedKeyPersistsAcrossProcesses(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "protected account ü")
	store := NewStore(directory)
	ctx := context.Background()
	if err := store.WithLock(ctx, func(a *Account) error {
		a.ClientID, a.HostID = "test-client", "synthetic-host"
		a.Credentials = &Credentials{Access: "synthetic-access", Refresh: "synthetic-refresh", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
		return store.Save(ctx, a)
	}); err != nil {
		t.Fatal(err)
	}
	first, err := store.Key(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Key(ctx, true)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatal("key changed", err)
	}
	protected, _ := os.ReadFile(filepath.Join(directory, "key.dpapi"))
	if bytes.Contains(protected, first) {
		t.Fatal("key stored as plaintext")
	}
	if output, err := helper(t, store, "read-protected").CombinedOutput(); err != nil {
		t.Fatalf("protected restart: %v %s", err, output)
	}
	accountPath := filepath.Join(directory, "account.enc")
	before, _ := os.ReadFile(accountPath)
	if bytes.Contains(before, []byte("synthetic-access")) {
		t.Fatal("plaintext account")
	}
	keyPath := filepath.Join(directory, "key.dpapi")
	if err := atomicFile(keyPath, bytes.NewReader([]byte("damaged-dpapi")), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Key(ctx, true); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal(err)
	}
	if err := store.WithLock(ctx, func(*Account) error { t.Fatal("damaged key accepted"); return nil }); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(accountPath)
	keyAfter, _ := os.ReadFile(keyPath)
	if !bytes.Equal(before, after) || string(keyAfter) != "damaged-dpapi" {
		t.Fatal("damaged storage overwritten")
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if err := store.WithLock(ctx, func(*Account) error { t.Fatal("missing key accepted"); return nil }); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal(err)
	}
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatal("missing key replaced")
	}
}
func TestWindowsRegistrationIsOwnedAndDryRunDoesNotWrite(t *testing.T) {
	paths := testPaths(t)
	source := filepath.Join(t.TempDir(), "source ü.exe")
	if err := os.WriteFile(source, []byte("synthetic-binary"), 0700); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Install(paths, source, true, &out); err != nil {
		t.Fatal(err)
	}
	if key, err := registry.OpenKey(registry.CURRENT_USER, paths.RegistryKey, registry.READ|registry.WOW64_32KEY); err == nil {
		key.Close()
		t.Fatal("dry run wrote registry")
	}
	if err := Install(paths, source, false, &out); err != nil {
		t.Fatal(err)
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, paths.RegistryKey, registry.READ|registry.SET_VALUE|registry.WOW64_32KEY)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Close()
	value, _, err := key.GetStringValue("")
	if err != nil || value != paths.Manifest {
		t.Fatal(value, err)
	}
	if err := Uninstall(paths, true, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Binary); err != nil {
		t.Fatal("dry uninstall changed files", err)
	}
	key.SetStringValue("", `C:\another-installation.json`)
	if err := Install(paths, source, false, &out); publicError(err).Code != "registration_conflict" {
		t.Fatal(err)
	}
	if err := Uninstall(paths, false, &out); publicError(err).Code != "registration_conflict" {
		t.Fatal(err)
	}
	value, _, _ = key.GetStringValue("")
	if value != `C:\another-installation.json` {
		t.Fatal("foreign registration removed")
	}
	key.SetStringValue("", paths.Manifest)
	if err := Uninstall(paths, false, &out); err != nil {
		t.Fatal(err)
	}
	if _, _, err := key.GetStringValue(""); err != registry.ErrNotExist {
		t.Fatal("registration value remains", err)
	}
}
func TestWindowsInUseBinaryPreservesRegistration(t *testing.T) {
	paths := testPaths(t)
	source := filepath.Join(t.TempDir(), "source.exe")
	os.WriteFile(source, []byte("original"), 0700)
	if err := Install(paths, source, false, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	p, _ := windows.UTF16PtrFromString(paths.Binary)
	handle, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	before, _ := os.ReadFile(paths.Manifest)
	for _, operation := range []func() error{
		func() error { return Install(paths, source, false, &bytes.Buffer{}) },
		func() error { return Uninstall(paths, false, &bytes.Buffer{}) },
	} {
		if err := operation(); publicError(err).Code != "host_in_use" {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(paths.Manifest)
		if !bytes.Equal(before, after) || checkRegistration(paths) != nil {
			t.Fatal("busy operation changed registration")
		}
	}
}
func TestWindowsNativeSecurityEnforcement(t *testing.T) {
	if os.Getenv("BROWSEFRIEND_TEST_WINE") != "" {
		t.Skip("pending native Windows: Wine cannot validate Windows ACL/reparse security guarantees")
	}
	t.Run("unsafe account ACL", func(t *testing.T) {
		store := testStore(t)
		if err := store.WithLock(context.Background(), func(a *Account) error { return store.Save(context.Background(), a) }); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(store.Directory, "account.enc")
		sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
		if err != nil {
			t.Fatal(err)
		}
		acl, _, _ := sd.DACL()
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
			t.Fatal(err)
		}
		before, _ := os.ReadFile(path)
		if err := store.WithLock(context.Background(), func(*Account) error { t.Fatal("unsafe ACL accepted"); return nil }); publicError(err).Code != "storage_unsafe" {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("unsafe file replaced")
		}
	})
	t.Run("junction root", func(t *testing.T) {
		store := testStore(t)
		if err := store.WithLock(context.Background(), func(*Account) error { return nil }); err != nil {
			t.Fatal(err)
		}
		alias := filepath.Join(t.TempDir(), "junction")
		if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", alias, store.Directory).CombinedOutput(); err != nil {
			t.Fatalf("junction: %v %s", err, output)
		}
		if err := (&Store{Directory: alias, Key: store.Key}).WithLock(context.Background(), func(*Account) error { t.Fatal("junction accepted"); return nil }); publicError(err).Code != "storage_unsafe" {
			t.Fatal(err)
		}
	})
}
