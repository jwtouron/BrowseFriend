package companion

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	return &Store{Directory: filepath.Join(t.TempDir(), "account"), Key: func(context.Context, bool) ([]byte, error) { return bytes.Repeat([]byte{7}, 32), nil }}
}
func TestEncryptedStorage(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	err := s.WithLock(ctx, func(a *Account) error {
		a.ClientID = "client-test"
		a.Credentials = &Credentials{Access: "synthetic-secret", Refresh: "synthetic-renewal", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
		return s.Save(ctx, a)
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Directory, "account.enc")
	first, _ := os.ReadFile(path)
	if bytes.Contains(first, []byte("synthetic")) {
		t.Fatal("plaintext credentials")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("permissions")
	}
	err = s.WithLock(ctx, func(a *Account) error {
		if a.Credentials.Access != "synthetic-secret" {
			t.Fatal("lost credentials")
		}
		return s.Save(ctx, a)
	})
	if err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if bytes.Equal(first, second) {
		t.Fatal("nonce reused")
	}
	second[len(second)-1] ^= 1
	os.WriteFile(path, second, 0600)
	err = s.WithLock(ctx, func(a *Account) error { t.Fatal("damaged ciphertext accepted"); return nil })
	if publicError(err).Code != "storage_decryption_failed" {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(after, second) {
		t.Fatal("damaged file overwritten")
	}
}
func TestUnsafeStorageAndCancellation(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.WithLock(ctx, func(a *Account) error { return s.Save(ctx, a) }); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Directory, "account.enc")
	os.Chmod(path, 0644)
	if err := s.WithLock(ctx, func(*Account) error { return nil }); publicError(err).Code != "storage_unsafe" {
		t.Fatal(err)
	}
	os.Chmod(path, 0600)
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- s.WithLock(ctx, func(*Account) error { close(entered); <-release; return nil }) }()
	<-entered
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.WithLock(cancelCtx, func(*Account) error { return nil }); err != context.Canceled {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "symlink")
	os.Symlink(s.Directory, other)
	if err := (&Store{Directory: other, Key: s.Key}).WithLock(ctx, func(*Account) error { return nil }); publicError(err).Code != "storage_unsafe" {
		t.Fatal(err)
	}
}
func TestCipherRejectsUnknownFormatAndKey(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	value, err := encrypt(key, []byte("synthetic"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decrypt(bytes.Repeat([]byte{2}, 32), value); err == nil {
		t.Fatal("incorrect key accepted")
	}
	if _, err := decrypt(key, []byte{9}); err == nil {
		t.Fatal("incorrect format accepted")
	}
}

type fixture struct {
	mu        sync.Mutex
	c         *Connection
	server    *httptest.Server
	key       *rsa.PrivateKey
	nonce     string
	jwksDown  bool
	refreshes int
	apiCalls  int
	lastBody  object
	badNonce  bool
}

func (f *fixture) sign(claims object) string {
	header, _ := json.Marshal(object{"alg": "RS256", "typ": "JWT", "kid": "test-key"})
	body, _ := json.Marshal(claims)
	message := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	hash := sha256.Sum256([]byte(message))
	signature, _ := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, hash[:])
	return message + "." + base64.RawURLEncoding.EncodeToString(signature)
}
func newFixture(t *testing.T) *fixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{key: key}
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(object{"issuer": f.server.URL, "authorization_endpoint": f.server.URL + "/authorize", "token_endpoint": f.server.URL + "/token", "jwks_uri": f.server.URL + "/jwks", "revocation_endpoint": f.server.URL + "/revoke"})
		case "/jwks":
			if f.jwksDown {
				http.Error(w, "synthetic-unavailable", 503)
				return
			}
			json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "test-key", Use: "sig", Algorithm: "RS256"}}})
		case "/token":
			r.ParseForm()
			if r.Form.Get("resource") != resource {
				t.Error("missing resource")
			}
			if r.Form.Get("grant_type") == "refresh_token" {
				f.refreshes++
			}
			nonce := f.nonce
			if f.badNonce {
				nonce = "incorrect"
			}
			jwt := f.sign(object{"iss": f.server.URL, "aud": "test-client", "sub": "test-subject", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": nonce, "name": "Synthetic Person", "email": "test@example.invalid"})
			json.NewEncoder(w).Encode(object{"access_token": "synthetic-access", "refresh_token": "synthetic-refresh-next", "scope": scopes, "token_type": "Bearer", "expires_in": 3600, "id_token": jwt})
		case "/revoke":
			r.ParseForm()
			if r.Form.Get("token_type_hint") != "refresh_token" {
				t.Error("wrong revocation")
			}
			w.WriteHeader(200)
		case "/v1/models":
			f.apiCalls++
			if r.Header.Get("Authorization") != "Bearer synthetic-access" {
				t.Error("wrong bearer")
			}
			json.NewEncoder(w).Encode(object{"models": []object{{"slug": "model-1", "display_name": "Model One", "visibility": "list", "default_reasoning_level": "medium", "supported_reasoning_levels": []object{{"effort": "medium"}}}}})
		case "/v1/responses":
			f.apiCalls++
			json.NewDecoder(r.Body).Decode(&f.lastBody)
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\ndata: {\"type\":\"response.completed\"}\n\n")
		case "/v1/responses/compact":
			json.NewDecoder(r.Body).Decode(&f.lastBody)
			json.NewEncoder(w).Encode(object{"output": []object{{"type": "compaction", "encrypted_content": "opaque"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.server.Close)
	f.c = NewConnection(testStore(t), nil)
	f.c.issuer = f.server.URL
	f.c.api = f.server.URL + "/v1"
	f.c.HTTP = f.server.Client()
	f.c.HTTP.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	f.c.OpenBrowser = func(ctx context.Context, raw string) error {
		u, err := url.Parse(raw)
		if err != nil {
			return err
		}
		q := u.Query()
		f.mu.Lock()
		f.nonce = q.Get("nonce")
		f.mu.Unlock()
		if q.Get("client_id") != "dynamic_agent_client" && q.Get("client_id") != "test-client" {
			t.Error("wrong client")
		}
		if q.Get("code_challenge_method") != "S256" || q.Get("ext_agent_host_id") == "" {
			t.Error("missing PKCE or host identity")
		}
		if strings.Contains(raw, "synthetic-access") || q.Has("id_token_hint") {
			t.Error("credential in opener")
		}
		callback, _ := url.Parse(q.Get("redirect_uri"))
		params := url.Values{"state": {q.Get("state")}, "code": {"synthetic-code"}, "client_id": {"test-client"}}
		callback.RawQuery = params.Encode()
		res, err := f.c.HTTP.Get(callback.String())
		if err != nil {
			return err
		}
		res.Body.Close()
		if res.StatusCode != 303 {
			t.Errorf("callback status %d", res.StatusCode)
		}
		return nil
	}
	return f
}
func (f *fixture) login(t *testing.T) {
	t.Helper()
	s, err := f.c.SignIn(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != "signed_in" || s.Profile["email"] != "test@example.invalid" {
		t.Fatal(s)
	}
}
func TestOAuthAndModelHTTP(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	ctx := context.Background()
	models, err := f.c.Models(ctx)
	if err != nil || len(models) != 1 || models[0]["defaultReasoningEffort"] != "medium" {
		t.Fatal(models, err)
	}
	var delta string
	_, err = f.c.Stream(ctx, ModelOptions{Model: "model-1", Input: []object{{"role": "user", "content": "Hello"}}, Instructions: "Policy", Tools: contract.Tools, ReasoningEffort: "medium"}, func(s string) { delta += s })
	if err != nil || delta != "Hello" {
		t.Fatal(delta, err)
	}
	f.mu.Lock()
	if f.lastBody["store"] != false || f.lastBody["stream"] != true {
		t.Fatal(f.lastBody)
	}
	tools := f.lastBody["tools"].([]any)
	if tools[0].(map[string]any)["type"] != "namespace" {
		t.Fatal("tools not namespaced")
	}
	f.mu.Unlock()
	compacted, err := f.c.Compact(ctx, ModelOptions{Model: "model-1", Input: []object{{"role": "user", "content": "Earlier"}}})
	if err != nil || !strings.Contains(compacted, "opaque") {
		t.Fatal(compacted, err)
	}
	s, err := f.c.SignOut(ctx)
	if err != nil || s.State != "signed_out" {
		t.Fatal(s, err)
	}
	if err := f.c.Store.WithLock(ctx, func(a *Account) error {
		if a.Credentials != nil || a.IDToken != "" || a.Pending != nil {
			t.Fatal("logout retained tokens")
		}
		if a.ClientID != "test-client" || a.HostID == "" {
			t.Fatal("lost registration")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
func TestOAuthRejectsInvalidIdentity(t *testing.T) {
	f := newFixture(t)
	f.badNonce = true
	if _, err := f.c.SignIn(context.Background(), false); publicError(err).Code != "invalid_id_token" {
		t.Fatal(err)
	}
	if err := f.c.Store.WithLock(context.Background(), func(a *Account) error {
		if a.Credentials != nil {
			t.Fatal("invalid identity activated")
		}
		if a.ClientID != "test-client" {
			t.Fatal("registration not saved")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
func TestRefreshRecoveryAcrossRestart(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	ctx := context.Background()
	if err := f.c.Store.WithLock(ctx, func(a *Account) error {
		a.Credentials.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
		return f.c.Store.Save(ctx, a)
	}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.jwksDown = true
	f.mu.Unlock()
	if _, err := f.c.Models(ctx); publicError(err).Code != "identity_verification_unavailable" {
		t.Fatal(err)
	}
	if err := f.c.Store.WithLock(ctx, func(a *Account) error {
		if a.Pending == nil {
			t.Fatal("rotation checkpoint missing")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	restarted := NewConnection(f.c.Store, nil)
	restarted.issuer = f.c.issuer
	restarted.api = f.c.api
	restarted.HTTP = f.c.HTTP
	f.mu.Lock()
	f.jwksDown = false
	f.mu.Unlock()
	if _, err := restarted.Models(ctx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 1 || f.apiCalls != 1 {
		t.Fatal("refresh replay or invalid credentials used", f.refreshes, f.apiCalls)
	}
}
func TestOAuthCancellationAndCallbackState(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	f.c.OpenBrowser = func(_ context.Context, raw string) error {
		u, _ := url.Parse(raw)
		callback, _ := url.Parse(u.Query().Get("redirect_uri"))
		callback.RawQuery = "code=bad&client_id=bad&state=wrong"
		res, err := f.c.HTTP.Get(callback.String())
		if err != nil {
			return err
		}
		res.Body.Close()
		if res.StatusCode != 400 {
			t.Error("wrong state accepted")
		}
		cancel()
		return nil
	}
	if _, err := f.c.SignIn(ctx, false); err != context.Canceled {
		t.Fatal(err)
	}
}

func TestAuthCancelReturnsSettledState(t *testing.T) {
	f := newFixture(t)
	started := make(chan struct{})
	f.c.OpenBrowser = func(ctx context.Context, _ string) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	replies := make(chan object, 10)
	h := NewHandler(f.c, func(v any) { replies <- v.(map[string]any) })
	defer h.Close()
	h.Dispatch(context.Background(), Request{ID: "login", Method: "auth.signIn"})
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("sign-in did not start")
	}
	h.Dispatch(context.Background(), Request{ID: "queued-login", Method: "auth.signIn"})
	h.Dispatch(context.Background(), Request{ID: "cancel", Method: "auth.cancel"})
	for {
		select {
		case reply := <-replies:
			if reply["id"] == "cancel" {
				if reply["result"].(Session).State != "signed_out" {
					t.Fatal(reply)
				}
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("sign-in cancellation did not settle")
		}
	}
}
func TestSSECompletionAndErrors(t *testing.T) {
	for _, tc := range []struct{ data, code string }{
		{"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Partial\"}\n\n", "stream_interrupted"},
		{"data: {\"type\":\"response.incomplete\"}\n\n", "response_incomplete"},
		{"data: invalid\n\n", "invalid_stream"},
		{"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"synthetic-secret\"}}}\n\n", "subscription_sharing_usage_limit_exceeded"},
	} {
		_, err := consumeSSE(context.Background(), strings.NewReader(tc.data), func(string) {}, "req-test")
		if publicError(err).Code != tc.code {
			t.Fatal(tc.code, err)
		}
		encoded, _ := json.Marshal(publicError(err))
		if strings.Contains(string(encoded), "synthetic-secret") {
			t.Fatal("unsafe error")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := consumeSSE(ctx, strings.NewReader("data: {}\n\n"), func(string) {}, "")
	if err != context.Canceled {
		t.Fatal(err)
	}
	calls, err := consumeSSE(context.Background(), strings.NewReader("data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"page_click\",\"arguments\":\"{}\"}}\r\n\r\ndata: {\"type\":\"response.completed\"}\r\n\r\n"), func(string) {}, "")
	if err != nil || len(calls) != 1 || calls[0]["callId"] != "call-1" {
		t.Fatal(calls, err)
	}
}
func TestProtocolFrames(t *testing.T) {
	var b bytes.Buffer
	w := Writer{Out: &b}
	if err := w.Send(object{"id": "one", "ok": true}); err != nil {
		t.Fatal(err)
	}
	size := binary.NativeEndian.Uint32(b.Bytes()[:4])
	if int(size) != len(b.Bytes())-4 {
		t.Fatal("frame size")
	}
	if err := w.Send(object{"body": strings.Repeat("x", maxMessage)}); err == nil {
		t.Fatal("oversized output accepted")
	}
	header := make([]byte, 4)
	binary.NativeEndian.PutUint32(header, maxMessage+1)
	h := NewHandler(nil, func(any) {})
	if err := Run(context.Background(), bytes.NewReader(header), h); publicError(err).Code != "message_too_large" {
		t.Fatal(err)
	}
}
