package companion

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

type testRoundTripper func(*http.Request) (*http.Response, error)

func (fn testRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestLogoutRemovesLocalCredentialsAfterCancelledRevocation(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	transport := f.c.HTTP.Transport
	f.c.HTTP.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/revoke" {
			cancel()
			return nil, context.Canceled
		}
		return transport.RoundTrip(r)
	})
	s, err := f.c.SignOut(ctx)
	if publicError(err).Code != "revocation_failed" || s.State != "signed_out" {
		t.Fatal(s, err)
	}
	if err := f.c.Store.WithLock(context.Background(), func(a *Account) error {
		if a.Credentials != nil || a.Pending != nil || a.IDToken != "" {
			t.Fatal("local credentials retained")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

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
		return nil
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
