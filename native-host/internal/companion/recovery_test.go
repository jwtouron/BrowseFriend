package companion

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPublicSessionAndErrorsContainOnlyDisplayFields(t *testing.T) {
	s := session(&Account{Identity: object{"name": "Person", "email": "synthetic@example.invalid", "subject": "private-subject", "token": "private-token"}, Credentials: &Credentials{Access: "private-token"}, Scopes: []string{sharing}})
	data, _ := json.Marshal(s)
	if strings.Contains(string(data), "private") || s.State != "signed_in" || !s.PlanUsageEnabled {
		t.Fatal("private data in session")
	}
	errorData, _ := json.Marshal(publicError(errors.New("private-token")))
	if strings.Contains(string(errorData), "private") {
		t.Fatal("unsafe error")
	}
	if session(&Account{Credentials: &Credentials{Access: "synthetic"}}).State != "plan_disabled" {
		t.Fatal("missing consent ignored")
	}
}

func expire(t *testing.T, f *fixture) {
	t.Helper()
	if err := f.c.Store.WithLock(context.Background(), func(a *Account) error {
		a.Credentials.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
		return f.c.Store.Save(context.Background(), a)
	}); err != nil {
		t.Fatal(err)
	}
}
func TestRefreshRejectsInvalidIdentityAndRevokedGrants(t *testing.T) {
	for _, mode := range []string{"issuer", "audience", "expiry", "signature", "azp", "subject", "revoked"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			f.login(t)
			expire(t, f)
			f.mu.Lock()
			f.identityFailure = mode
			f.refreshFailure = mode == "revoked"
			f.mu.Unlock()
			_, err := f.c.Models(context.Background())
			want := "invalid_id_token"
			if mode == "subject" {
				want = "account_mismatch"
			}
			if mode == "revoked" {
				want = "invalid_grant"
			}
			if publicError(err).Code != want {
				t.Fatal(err)
			}
			if err := f.c.Store.WithLock(context.Background(), func(a *Account) error {
				if a.Credentials != nil || a.Pending != nil || a.IDToken != "" {
					t.Fatal("invalid grant retained")
				}
				if a.ClientID == "" || a.HostID == "" {
					t.Fatal("registration lost")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.apiCalls != 0 || f.refreshes != 1 {
				t.Fatal("invalid credential used or grant retried")
			}
		})
	}
}
func TestStopDuringRefreshPreservesSuccessor(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	expire(t, f)
	release := make(chan struct{})
	started := make(chan struct{})
	f.mu.Lock()
	f.refreshGate = release
	f.refreshStarted = started
	f.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := f.c.Models(ctx); done <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("refresh did not start")
	}
	cancel()
	close(release)
	if err := <-done; err != context.Canceled {
		t.Fatal(err)
	}
	if _, err := f.c.Models(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 1 || f.apiCalls != 1 {
		t.Fatal("stopped request reused refresh grant")
	}
}
func TestPendingRefreshRecoversInAnotherProcess(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	expire(t, f)
	f.mu.Lock()
	f.jwksDown = true
	f.mu.Unlock()
	if _, err := f.c.Models(context.Background()); publicError(err).Code != "identity_verification_unavailable" {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.jwksDown = false
	f.mu.Unlock()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := helper(t, f.c.Store, "models", "BROWSEFRIEND_TEST_ISSUER="+f.server.URL, "BROWSEFRIEND_TEST_CA="+ca)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 1 || f.apiCalls != 1 {
		t.Fatal("pending successor was not recovered")
	}
}
func TestStoreFailuresPreserveEncryptedAccount(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	path := filepath.Join(f.c.Store.Directory, "account.enc")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	unavailable := &Store{Directory: f.c.Store.Directory, Key: func(context.Context, bool) ([]byte, error) {
		return nil, failure("storage_encryption_unavailable", "Unlock your credential store.", true)
	}}
	if err := unavailable.WithLock(context.Background(), func(a *Account) error { return unavailable.Save(context.Background(), a) }); publicError(err).Code != "storage_encryption_unavailable" {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("failed storage replaced credentials")
	}
}
