package companion

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestOSKeyMacKeychain(t *testing.T) {
	if os.Getenv("BROWSEFRIEND_TEST_MAC_KEYCHAIN") != "1" {
		t.Skip("requires explicit disposable-Keychain integration test")
	}
	keychain := filepath.Join(t.TempDir(), "fixture.keychain-db")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := func(args ...string) {
		t.Helper()
		if output, err := exec.CommandContext(ctx, "/usr/bin/security", args...).CombinedOutput(); err != nil {
			t.Fatalf("keychain setup: %v %s", err, output)
		}
	}
	command("create-keychain", "-p", "browsefriend-synthetic-fixture", keychain)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if output, err := exec.CommandContext(cleanup, "/usr/bin/security", "delete-keychain", keychain).CombinedOutput(); err != nil {
			t.Errorf("keychain cleanup: %v %s", err, output)
		}
	})
	command("unlock-keychain", "-p", "browsefriend-synthetic-fixture", keychain)
	// A unique service and explicit keychain keep the real account completely separate.
	location := keyring{keychain: keychain, service: "com.browsefriend.test." + randomValue()}
	if _, err := location.key(ctx, false); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal("missing key accepted", err)
	}
	store := &Store{Directory: filepath.Join(t.TempDir(), "account"), Key: location.key}
	if err := store.WithLock(ctx, func(a *Account) error {
		a.ClientID, a.HostID = "synthetic-client", "synthetic-host"
		a.Credentials = &Credentials{Access: "synthetic-access", Refresh: "synthetic-refresh", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
		return store.Save(ctx, a)
	}); err != nil {
		t.Fatal(err)
	}
	first, err := location.key(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := location.key(ctx, true)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatal("key changed", err)
	}
	reopened := &Store{Directory: store.Directory, Key: location.key}
	if err := reopened.WithLock(ctx, func(a *Account) error {
		if a.Credentials == nil || a.Credentials.Access != "synthetic-access" {
			t.Fatal("account not recovered")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(store.Directory, "account.enc")
	before, _ := os.ReadFile(path)
	command("add-generic-password", "-U", "-a", "local-encryption-key", "-s", location.service, "-w", "invalid-synthetic-key", keychain)
	if _, err := location.key(ctx, true); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal("damaged key accepted", err)
	}
	if err := reopened.WithLock(ctx, func(*Account) error { t.Fatal("damaged key used"); return nil }); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("account overwritten after key failure")
	}
	command("delete-generic-password", "-a", "local-encryption-key", "-s", location.service, keychain)
	if _, err := location.key(ctx, false); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal("deleted key accepted", err)
	}
}
