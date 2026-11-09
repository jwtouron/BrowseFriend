package companion

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

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
	for _, name := range []string{"registration.json", "registration.lock", credentialFile} {
		t.Run("unsafe ACL "+name, func(t *testing.T) {
			store := testStore(t)
			if err := store.WithLock(context.Background(), func(a *Account) error {
				return store.UpdateRegistration(context.Background(), a, func(r *Registration) error { r.HostID = "test-host"; return nil })
			}); err != nil {
				t.Fatal(err)
			}
			if name == credentialFile {
				if err := store.Reset(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(store.Directory, name)
			sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
			if err != nil {
				t.Fatal(err)
			}
			acl, _, _ := sd.DACL()
			if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			if err := NewStore(store.Directory).WithLock(context.Background(), func(*Account) error { t.Fatal("unsafe ACL accepted"); return nil }); publicError(err).Code != "storage_unsafe" {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("unsafe file replaced")
			}
		})
	}
	t.Run("junction root", func(t *testing.T) {
		store := testStore(t)
		if err := store.WithLock(context.Background(), func(*Account) error { return nil }); err != nil {
			t.Fatal(err)
		}
		alias := filepath.Join(t.TempDir(), "junction")
		if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", alias, store.Directory).CombinedOutput(); err != nil {
			t.Fatalf("junction: %v %s", err, output)
		}
		if err := NewStore(alias).WithLock(context.Background(), func(*Account) error { t.Fatal("junction accepted"); return nil }); publicError(err).Code != "storage_unsafe" {
			t.Fatal(err)
		}
	})
}
