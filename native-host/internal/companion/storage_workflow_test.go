package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestOnlyRegistrationPersists(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	path := filepath.Join(f.c.Store.Directory, "registration.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]string
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved) != 3 || saved["clientId"] != "test-client" || saved["hostId"] == "" || saved["subject"] == "" {
		t.Fatal("incomplete registration")
	}
	for _, forbidden := range []string{"synthetic-access", "synthetic-refresh", "test@example.invalid", "id_token", "Credentials", "Pending"} {
		if bytes.Contains(data, []byte(forbidden)) {
			t.Fatal("session information persisted")
		}
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0600 {
			t.Fatal("registration is not private")
		}
	}
	// Legacy files must be ignored, without importing, deleting, or interpreting their contents.
	legacy := filepath.Join(f.c.Store.Directory, "account.enc")
	marker := []byte("synthetic legacy credentials must never be loaded")
	if err := os.WriteFile(legacy, marker, 0600); err != nil {
		t.Fatal(err)
	}
	fresh := NewConnection(NewStore(f.c.Store.Directory), nil)
	status, err := fresh.Status(context.Background())
	if err != nil || status.State != "signed_out" || status.Profile != nil {
		t.Fatal(status, err)
	}
	if _, err := fresh.Models(context.Background()); publicError(err).Code != "sign_in_required" {
		t.Fatal(err)
	}
	if err := fresh.Store.WithLock(context.Background(), func(a *Account) error {
		if a.ClientID != saved["clientId"] || a.HostID != saved["hostId"] || a.Subject != saved["subject"] || a.Credentials != nil || a.Identity != nil || a.Pending != nil || a.IDToken != "" || len(a.Scopes) != 0 {
			t.Fatal("session crossed store lifetime")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(legacy)
	if err != nil || !bytes.Equal(after, marker) {
		t.Fatal("legacy data was changed", err)
	}
	// A returning sign-in must reuse registration, not restore previous authentication.
	opener := f.c.OpenBrowser
	fresh.issuer, fresh.api, fresh.HTTP, fresh.OpenBrowser = f.c.issuer, f.c.api, f.c.HTTP, opener
	f.c = fresh
	f.login(t)
	again, _ := os.ReadFile(path)
	if !bytes.Equal(data, again) {
		t.Fatal("returning sign-in changed registration")
	}
}

func TestAccountMemorySerializesAndCancellationReleasesWaiters(t *testing.T) {
	s := testStore(t)
	started, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- s.WithLock(context.Background(), func(a *Account) error {
			a.IDToken = "synthetic-in-memory"
			close(started)
			<-release
			return errors.New("synthetic later error")
		})
	}()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	if err := s.WithLock(ctx, func(*Account) error { t.Error("overlapping account operations"); return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	// Independent processes/stores share registration, not login or refresh locks.
	other := NewStore(s.Directory)
	if err := other.WithLock(context.Background(), func(a *Account) error {
		if a.IDToken != "" {
			t.Fatal("memory shared across stores")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err == nil {
		t.Fatal("callback error lost")
	}
	if err := s.WithLock(context.Background(), func(a *Account) error {
		if a.IDToken != "synthetic-in-memory" {
			t.Fatal("memory checkpoint rolled back")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestRegistrationValidationAndCancelledWrite(t *testing.T) {
	for _, invalid := range []string{`{"hostId":"h","clientId":"dynamic_agent_client","subject":""}`, `{"hostId":"h","clientId":"client","subject":"","accessToken":"synthetic"}`, `{"hostId":"h"} {}`, "not-json"} {
		t.Run(invalid, func(t *testing.T) {
			s := testStore(t)
			if err := privateDirectory(s.Directory); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(s.Directory, "registration.json")
			if err := atomicFile(path, bytes.NewBufferString(invalid), 0600); err != nil {
				t.Fatal(err)
			}
			if err := s.WithLock(context.Background(), func(*Account) error { t.Error("invalid registration accepted"); return nil }); publicError(err).Code != "registration_invalid" {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(path)
			if string(after) != invalid {
				t.Fatal("invalid file overwritten")
			}
		})
	}
	s := testStore(t)
	if err := s.withRegistration(context.Background(), func(r *Registration) error { r.HostID = "before"; return nil }); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	err := s.withRegistration(ctx, func(r *Registration) error { r.HostID = "after"; cancel(); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := NewStore(s.Directory).WithLock(context.Background(), func(a *Account) error {
		if a.HostID != "before" {
			t.Fatal("cancelled metadata written")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestRegistrationLockTimeoutAndIdentity(t *testing.T) {
	s := testStore(t)
	if err := privateDirectory(s.Directory); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Directory, "registration.lock")
	first, err := acquireRegistrationLock(context.Background(), path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := acquireRegistrationLock(context.Background(), path, 5*time.Millisecond); publicError(err).Code != "storage_busy" {
		t.Fatal(err)
	}
	other, err := privateFile(filepath.Join(s.Directory, "other.lock"), os.O_CREATE|os.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	info, err := other.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLockIdentity(info, first); publicError(err).Code != "storage_unsafe" {
		t.Fatal(err)
	}
}

func TestUnsafeRegistrationPathsPreserveTargets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows ACL/reparse fixtures cover this")
	}
	for _, name := range []string{"registration.json", "registration.lock"} {
		t.Run(name, func(t *testing.T) {
			s := testStore(t)
			if err := privateDirectory(s.Directory); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(t.TempDir(), "outside")
			before := []byte("synthetic outside data")
			if err := os.WriteFile(target, before, 0600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(s.Directory, name)
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
			if err := s.WithLock(context.Background(), func(*Account) error { t.Error("symlink accepted"); return nil }); err == nil {
				t.Fatal("unsafe path accepted")
			}
			after, _ := os.ReadFile(target)
			if !bytes.Equal(after, before) {
				t.Fatal("outside target modified")
			}
		})
	}
}
