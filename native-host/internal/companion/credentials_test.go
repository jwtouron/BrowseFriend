package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func reconnect(f *fixture) *Connection {
	c := NewConnection(NewStore(f.c.Store.Directory), nil)
	c.issuer, c.api, c.HTTP, c.OpenBrowser = f.c.issuer, f.c.api, f.c.HTTP, f.c.OpenBrowser
	return c
}

func savedCredentials(t *testing.T, s *Store) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.Directory, credentialFile))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestPersistentCredentialsArePrivateAndBoundToRegistration(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	if runtime.GOOS != "windows" {
		for path, mode := range map[string]os.FileMode{f.c.Store.Directory: 0700, filepath.Join(f.c.Store.Directory, credentialFile): 0600} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != mode {
				t.Fatal("unexpected credential permissions", err)
			}
		}
	}
	var record credentialRecord
	if err := json.Unmarshal(savedCredentials(t, f.c.Store), &record); err != nil {
		t.Fatal(err)
	}
	if record.Version != 1 || record.Revision == "" || record.Account.Credentials == nil || record.Account.Subject == "" {
		t.Fatal("incomplete saved login")
	}
	fresh := reconnect(f)
	status, err := fresh.Status(context.Background())
	if err != nil || status.State != "signed_in" {
		t.Fatal("login not restored", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.apiCalls != 0 || f.refreshes != 0 {
		t.Fatal("status unexpectedly requested model or OAuth data")
	}
}

func TestCorruptAndUnsupportedCredentialsRequireExplicitReset(t *testing.T) {
	for _, mode := range []string{"malformed", "unsupported", "unknown-field", "oversized", "registration", "missing-token"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			f.login(t)
			registration, err := os.ReadFile(filepath.Join(f.c.Store.Directory, "registration.json"))
			if err != nil {
				t.Fatal(err)
			}
			data := savedCredentials(t, f.c.Store)
			var record credentialRecord
			json.Unmarshal(data, &record)
			switch mode {
			case "malformed":
				data = []byte("not JSON")
			case "unsupported":
				record.Version = 99
				data, _ = json.Marshal(record)
			case "unknown-field":
				data = append([]byte(`{"unknown":true,`), data[1:]...)
			case "oversized":
				data = []byte(strings.Repeat("x", maxCredentialBytes+1))
			case "registration":
				record.Account.Subject = "different"
				data, _ = json.Marshal(record)
			case "missing-token":
				record.Account.Credentials.Access = ""
				data, _ = json.Marshal(record)
			}
			if err := os.WriteFile(filepath.Join(f.c.Store.Directory, credentialFile), data, 0600); err != nil {
				t.Fatal(err)
			}
			_, err = reconnect(f).Status(context.Background())
			want := "credentials_invalid"
			if mode == "unsupported" {
				want = "credentials_version_unsupported"
			}
			if publicError(err).Code != want {
				t.Fatal("incorrect recovery classification", err)
			}
			if !bytes.Equal(savedCredentials(t, f.c.Store), data) {
				t.Fatal("damaged record overwritten automatically")
			}
			if _, err := f.c.ResetLogin(context.Background()); err != nil {
				t.Fatal(err)
			}
			status, err := reconnect(f).Status(context.Background())
			if err != nil || status.State != "signed_out" {
				t.Fatal("reset did not clear login", err)
			}
			after, _ := os.ReadFile(filepath.Join(f.c.Store.Directory, "registration.json"))
			if !bytes.Equal(registration, after) {
				t.Fatal("reset changed registration")
			}
			if bytes.Contains(savedCredentials(t, f.c.Store), []byte("synthetic-refresh")) {
				t.Fatal("reset retained credentials")
			}
			f.login(t)
		})
	}
}

func TestResetBeforeFirstSignInDoesNotBlockRegistration(t *testing.T) {
	f := newFixture(t)
	if _, err := f.c.ResetLogin(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.login(t)
}

func TestCredentialSaveLimitPreservesPreviousLogin(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	before := savedCredentials(t, f.c.Store)
	err := f.c.Store.WithLock(context.Background(), func(a *Account) error {
		a.Credentials.Access = strings.Repeat("x", maxCredentialBytes)
		return f.c.Store.save(context.Background(), a)
	})
	if publicError(err).Code != "credentials_too_large" || !bytes.Equal(before, savedCredentials(t, f.c.Store)) {
		t.Fatal("oversized save damaged existing login", err)
	}
	if s, err := reconnect(f).Status(context.Background()); err != nil || s.State != "signed_in" {
		t.Fatal(err)
	}
}

func TestIndependentStoresSerializeRefreshAndObserveLogout(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	expire(t, f)
	other := reconnect(f)
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for _, c := range []*Connection{f.c, other} {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := c.Models(context.Background()); errors <- err }()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	f.mu.Lock()
	refreshes, calls := f.refreshes, f.apiCalls
	f.mu.Unlock()
	if refreshes != 1 || calls != 2 {
		t.Fatal("refresh raced or stale credentials used")
	}
	if _, err := other.SignOut(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s, err := f.c.Status(context.Background()); err != nil || s.State != "signed_out" {
		t.Fatal("stale process resurrected login", err)
	}
}

func TestFailedRefreshSaveRecoversWithoutReplayAndRespectsNewerReset(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission fault; Windows ACL tests exercise storage refusal")
	}
	for _, reset := range []bool{false, true} {
		t.Run(map[bool]string{false: "retry", true: "newer-reset"}[reset], func(t *testing.T) {
			f := newFixture(t)
			f.login(t)
			expire(t, f)
			before := savedCredentials(t, f.c.Store)
			transport := f.c.HTTP.Transport
			f.c.HTTP.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
				response, err := transport.RoundTrip(r)
				if r.URL.Path == "/token" && err == nil {
					if err := os.Chmod(f.c.Store.Directory, 0500); err != nil {
						t.Error(err)
					}
				}
				return response, err
			})
			t.Cleanup(func() { os.Chmod(f.c.Store.Directory, 0700) })
			if _, err := f.c.Models(context.Background()); publicError(err).Code != "storage_unavailable" {
				t.Fatal("save failure not reported", err)
			}
			if f.c.Store.retry == nil || f.c.Store.retry.account.Pending == nil {
				t.Fatal("received successor lost")
			}
			if !bytes.Equal(before, savedCredentials(t, f.c.Store)) {
				t.Fatal("failed save damaged file")
			}
			os.Chmod(f.c.Store.Directory, 0700)
			f.c.HTTP.Transport = transport
			if reset {
				if _, err := reconnect(f).ResetLogin(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			_, err := f.c.Models(context.Background())
			if reset {
				if publicError(err).Code != "sign_in_required" {
					t.Fatal("reset was overwritten", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.refreshes != 1 {
				t.Fatal("refresh grant replayed")
			}
		})
	}
}

func TestMemoryOnlyEvaluationNeverReadsOrWritesProductionCredentials(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	before := savedCredentials(t, f.c.Store)
	production := f.c
	memory := NewConnection(NewMemoryStore(f.c.Store.Directory), nil)
	memory.issuer, memory.api, memory.HTTP, memory.OpenBrowser = production.issuer, production.api, production.HTTP, production.OpenBrowser
	if status, err := memory.Status(context.Background()); err != nil || status.State != "signed_out" {
		t.Fatal("evaluator read production credentials", err)
	}
	f.c = memory
	f.login(t)
	if _, err := memory.ResetLogin(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, savedCredentials(t, production.Store)) {
		t.Fatal("evaluator overwrote production credentials")
	}
}

func TestUnsafeCredentialFileCannotBeReadResetOrRemoved(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered by native Windows ACL/reparse fixtures")
	}
	for _, mode := range []string{"permissions", "symlink"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			f.login(t)
			path := filepath.Join(f.c.Store.Directory, credentialFile)
			before := savedCredentials(t, f.c.Store)
			if mode == "permissions" {
				os.Chmod(path, 0644)
			} else {
				target := filepath.Join(t.TempDir(), "outside")
				os.WriteFile(target, before, 0600)
				os.Remove(path)
				os.Symlink(target, path)
			}
			if _, err := f.c.Status(context.Background()); err == nil {
				t.Fatal("unsafe file read")
			}
			if _, err := f.c.ResetLogin(context.Background()); err == nil {
				t.Fatal("unsafe file reset")
			}
			if err := f.c.Store.withDiskLock(context.Background(), f.c.Store.removeCredentials); err == nil {
				t.Fatal("unsafe file removed")
			}
			if !bytes.Equal(before, savedCredentials(t, f.c.Store)) {
				t.Fatal("unsafe target changed")
			}
		})
	}
}

func TestResetCancelsActiveSignInAndReturnsOnlySanitizedState(t *testing.T) {
	f := newFixture(t)
	opened := make(chan struct{})
	f.c.OpenBrowser = func(ctx context.Context, _ string) error { close(opened); <-ctx.Done(); return ctx.Err() }
	replies := make(chan object, 10)
	h := NewHandler(f.c, func(value any) { replies <- value.(object) })
	defer h.Close()
	h.Dispatch(context.Background(), Request{ID: "login", Method: "auth.signIn"})
	<-opened
	h.Dispatch(context.Background(), Request{ID: "reset", Method: "auth.reset"})
	for {
		reply := <-replies
		if reply["id"] != "reset" {
			continue
		}
		if reply["ok"] != true {
			t.Fatal("reset failed")
		}
		data, _ := json.Marshal(reply)
		if bytes.Contains(data, []byte("Credentials")) || bytes.Contains(data, []byte("IDToken")) {
			t.Fatal("native reply exposed credentials")
		}
		break
	}
	if status, err := reconnect(f).Status(context.Background()); err != nil || status.State != "signed_out" {
		t.Fatal("sign-in outlived reset", err)
	}
}

func TestLogoutCanClearAnUncommittedOversizedRefreshSuccessor(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	err := f.c.Store.WithLock(context.Background(), func(a *Account) error {
		a.Pending = &Rotation{Credentials: Credentials{Access: strings.Repeat("x", maxCredentialBytes), Refresh: "synthetic-successor", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}, IDToken: "synthetic-pending-id", ReceivedAt: time.Now().UnixMilli()}
		return f.c.Store.checkpoint(context.Background(), a)
	})
	if publicError(err).Code != "credentials_too_large" {
		t.Fatal(err)
	}
	if s, err := f.c.SignOut(context.Background()); err != nil || s.State != "signed_out" {
		t.Fatal("logout was blocked by a failed checkpoint", err)
	}
	if s, err := reconnect(f).Status(context.Background()); err != nil || s.State != "signed_out" {
		t.Fatal("logout did not persist", err)
	}
}

func TestConcurrentResetWinsOverAnUnfinishedSignIn(t *testing.T) {
	f := newFixture(t)
	transport := f.c.HTTP.Transport
	f.c.HTTP.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(r)
		if err == nil && r.URL.Path == "/token" {
			if err := NewStore(f.c.Store.Directory).Reset(context.Background()); err != nil {
				t.Error(err)
			}
		}
		return response, err
	})
	if _, err := f.c.SignIn(context.Background(), false); publicError(err).Code != "connection_changed" {
		t.Fatal("sign-in ignored newer reset", err)
	}
	if s, err := reconnect(f).Status(context.Background()); err != nil || s.State != "signed_out" {
		t.Fatal("sign-in resurrected credentials", err)
	}
}
