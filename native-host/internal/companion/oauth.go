package companion

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
)

const issuer = "https://auth.openai.com"
const resource = "https://api.openai.com/v1"
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const sharing = "chatgpt.tokens.use.direct"

type discovery struct {
	Issuer        string
	Authorization string
	Token         string
	Revocation    string
	JWKS          string
}
type Connection struct {
	Store       *Store
	HTTP        *http.Client
	OpenBrowser func(context.Context, string) error
	Changed     func(Session)
	mu          sync.Mutex
	signing     bool
	discovery   *discovery
	issuer      string
	api         string
}

func NewConnection(store *Store, changed func(Session)) *Connection {
	return &Connection{Store: store, HTTP: newHTTPClient(), OpenBrowser: openBrowser, Changed: changed, issuer: issuer, api: resource}
}
func randomValue() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("secure randomness unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func hostID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("secure randomness unavailable")
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("urn:uuid:%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func openBrowser(ctx context.Context, u string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "/usr/bin/open"
	}
	if exec.CommandContext(ctx, command, u).Run() != nil {
		return failure("browser_unavailable", "The browser could not be opened. Check your default browser and try again.", false)
	}
	return nil
}
func session(a *Account) Session {
	s := Session{State: "signed_out"}
	if a.Identity != nil {
		s.Profile = object{}
		for _, field := range []string{"name", "email"} {
			if value, ok := a.Identity[field].(string); ok && value != "" {
				s.Profile[field] = value
			}
		}
	}
	if a.Credentials != nil {
		s.State = "plan_disabled"
		if has(a.Scopes, sharing) {
			s.State = "signed_in"
			s.PlanUsageEnabled = true
		}
	}
	if a.Pending != nil {
		s.Error = identityUnavailable()
	}
	return s
}
func (c *Connection) emit(s Session) {
	if c.Changed != nil {
		c.Changed(s)
	}
}
func (c *Connection) Status(ctx context.Context) (Session, error) {
	c.mu.Lock()
	signing := c.signing
	c.mu.Unlock()
	if signing {
		return Session{State: "signing_in"}, nil
	}
	var result Session
	err := c.Store.WithLock(ctx, func(a *Account) error { result = session(a); return nil })
	return result, err
}
func (c *Connection) discover(ctx context.Context) (*discovery, error) {
	c.mu.Lock()
	cached := c.discovery
	c.mu.Unlock()
	if cached != nil {
		return cached, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := request(ctx, c.HTTP, "GET", c.issuer+"/.well-known/openid-configuration", "", "", nil)
	if err != nil {
		return nil, err
	}
	body, err := decodeJSON(res)
	if err != nil {
		return nil, err
	}
	d := &discovery{Issuer: text(body["issuer"]), Authorization: text(body["authorization_endpoint"]), Token: text(body["token_endpoint"]), JWKS: text(body["jwks_uri"]), Revocation: text(body["revocation_endpoint"])}
	if d.Issuer != c.issuer {
		return nil, failure("discovery_failed", "ChatGPT sign-in configuration could not be verified.", true)
	}
	for _, s := range []string{d.Authorization, d.Token, d.JWKS, d.Revocation} {
		if s == "" && d.Revocation == s {
			continue
		}
		u, e := url.Parse(s)
		if e != nil || u.Scheme+"://"+u.Host != c.issuer || u.User != nil || u.Fragment != "" {
			return nil, failure("discovery_failed", "ChatGPT sign-in configuration could not be verified.", true)
		}
	}
	if d.Authorization == "" || d.Token == "" || d.JWKS == "" {
		return nil, failure("discovery_failed", "ChatGPT sign-in configuration could not be verified.", true)
	}
	c.mu.Lock()
	c.discovery = d
	c.mu.Unlock()
	return d, nil
}
func identityUnavailable() *Error {
	return failure("identity_verification_unavailable", "ChatGPT identity verification is temporarily unavailable. Your connection has been preserved. Try again shortly.", true)
}
func (c *Connection) verify(ctx context.Context, token, clientID, nonce string, at time.Time) (string, object, error) {
	d, err := c.discover(ctx)
	if err != nil {
		return "", nil, identityUnavailable()
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := request(ctx, c.HTTP, "GET", d.JWKS, "", "", nil)
	if err != nil {
		return "", nil, identityUnavailable()
	}
	body, err := decodeJSON(res)
	if err != nil {
		return "", nil, identityUnavailable()
	}
	data, _ := json.Marshal(body)
	var keys jose.JSONWebKeySet
	if json.Unmarshal(data, &keys) != nil || len(keys.Keys) == 0 {
		return "", nil, identityUnavailable()
	}
	publicKeys := []crypto.PublicKey{}
	for _, key := range keys.Keys {
		if key.Valid() && key.IsPublic() && (key.Use == "" || key.Use == "sig") && (key.Algorithm == "" || key.Algorithm == "RS256") {
			publicKeys = append(publicKeys, key.Key)
		}
	}
	if len(publicKeys) == 0 {
		return "", nil, identityUnavailable()
	}
	verifier := oidc.NewVerifier(c.issuer, &oidc.StaticKeySet{PublicKeys: publicKeys}, &oidc.Config{ClientID: clientID, SupportedSigningAlgs: []string{"RS256"}, Now: func() time.Time { return at }})
	verified, err := verifier.Verify(ctx, token)
	bad := failure("invalid_id_token", "The ChatGPT identity could not be verified. Please sign in again.", false)
	if err != nil || verified.Subject == "" {
		return "", nil, bad
	}
	var claims struct {
		Name  string
		Email string
		Azp   string
		Iat   float64
	}
	if verified.Claims(&claims) != nil || claims.Iat <= 0 || claims.Iat > float64(at.Add(5*time.Second).Unix()) ||
		(nonce != "" && verified.Nonce != nonce) || (claims.Azp != "" && claims.Azp != clientID) || (len(verified.Audience) > 1 && claims.Azp != clientID) {
		return "", nil, bad
	}
	identity := object{}
	if claims.Name != "" {
		identity["name"] = claims.Name
	}
	if claims.Email != "" {
		identity["email"] = claims.Email
	}
	return verified.Subject, identity, nil
}
func (c *Connection) token(ctx context.Context, form url.Values) (object, error) {
	d, err := c.discover(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := request(ctx, c.HTTP, "POST", d.Token, "application/x-www-form-urlencoded", "", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	return decodeJSON(res)
}
func tokenFields(body object, previousScopes []string, refresh bool) (*Credentials, []string, error) {
	scope, ok := body["scope"].(string)
	if !ok && refresh {
		scope = strings.Join(previousScopes, " ")
		ok = true
	}
	bad := failure("invalid_token_response", "ChatGPT returned incomplete credentials. Please sign in again.", false)
	if !ok {
		return nil, nil, bad
	}
	granted := strings.Fields(scope)
	access := text(body["access_token"])
	if access == "" {
		if has(granted, sharing) || has(granted, "offline_access") || refresh {
			return nil, nil, bad
		}
		return nil, granted, nil
	}
	seconds, ok := body["expires_in"].(float64)
	if !ok || seconds <= 0 || seconds > 365*24*3600 || !strings.EqualFold(text(body["token_type"]), "bearer") ||
		((refresh || has(granted, "offline_access")) && text(body["refresh_token"]) == "") {
		return nil, nil, bad
	}
	return &Credentials{Access: access, Refresh: text(body["refresh_token"]), ExpiresAt: time.Now().Add(time.Duration(seconds * float64(time.Second))).UnixMilli(), EarliestRefreshAt: body["earliest_refresh_at"]}, granted, nil
}

var clientIDPattern = regexp.MustCompile("^[a-zA-Z0-9_-]{1,200}$")

func (c *Connection) SignIn(ctx context.Context, reconsent bool) (resultSession Session, resultError error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	c.mu.Lock()
	c.signing = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.signing = false
		c.mu.Unlock()
		if resultError != nil {
			recovery, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer stop()
			if saved, err := c.Status(recovery); err == nil {
				c.emit(saved)
			}
		}
	}()
	c.emit(Session{State: "signing_in"})
	var previous Account
	err := c.Store.WithLock(ctx, func(a *Account) error {
		if a.HostID == "" {
			a.HostID = hostID()
		}
		if err := c.Store.Save(ctx, a); err != nil {
			return err
		}
		previous = *a
		return nil
	})
	if err != nil {
		return Session{}, err
	}
	d, err := c.discover(ctx)
	if err != nil {
		return Session{}, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return Session{}, failure("callback_port_unavailable", "The sign-in port is unavailable. Try again.", true)
	}
	state, nonce, verifier := randomValue(), randomValue(), randomValue()
	redirect := "http://" + listener.Addr().String() + "/auth/callback"
	type callback struct {
		Code, ClientID string
		Error          error
	}
	result := make(chan callback, 1)
	var once sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		if r.Method != "GET" || r.Host != listener.Addr().String() || r.URL.Path != "/auth/callback" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if len(q["state"]) != 1 || subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(state)) != 1 {
			http.Error(w, "Invalid sign-in state.", 400)
			return
		}
		value := callback{Code: q.Get("code"), ClientID: q.Get("client_id")}
		if value.ClientID == "" {
			value.ClientID = previous.ClientID
		}
		if q.Get("error") != "" {
			value.Error = apiError(object{"error": q.Get("error")}, 0, "")
		} else if value.Code == "" || len(q["code"]) != 1 || len(q["client_id"]) > 1 || !clientIDPattern.MatchString(value.ClientID) || value.ClientID == "dynamic_agent_client" || (previous.ClientID != "" && value.ClientID != previous.ClientID) {
			value.Error = failure("registration_incomplete", "ChatGPT did not complete app registration. Please try signing in again.", false)
		}
		once.Do(func() { result <- value })
		http.Redirect(w, r, "/auth/complete", http.StatusSeeOther)
	})
	mux.HandleFunc("/auth/complete", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>BrowseFriend</title><h1>Return to BrowseFriend</h1><p>The app will finish checking your connection. You can close this tab.</p></html>")
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second}
	go server.Serve(listener)
	defer server.Close()
	challenge := sha256.Sum256([]byte(verifier))
	id := previous.ClientID
	if id == "" {
		id = "dynamic_agent_client"
	}
	params := url.Values{"client_id": {id}, "response_type": {"code"}, "redirect_uri": {redirect}, "scope": {scopes}, "resource": {resource}, "state": {state}, "nonce": {nonce}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "ext_agent_host_id": {previous.HostID}}
	if previous.ClientID == "" {
		params.Set("agent_name_hint", "BrowseFriend")
	}
	// Match the existing host: no retained tokens in opener URLs/process arguments.
	if email := text(previous.Identity["email"]); email != "" {
		params.Set("login_hint", email)
	}
	if reconsent {
		params.Set("prompt", "consent")
	}
	if err = c.OpenBrowser(ctx, d.Authorization+"?"+params.Encode()); err != nil {
		return Session{}, err
	}
	var cb callback
	select {
	case cb = <-result:
	case <-ctx.Done():
		return Session{}, ctx.Err()
	}
	if cb.Error != nil {
		return Session{}, cb.Error
	}
	err = c.Store.WithLock(ctx, func(a *Account) error {
		if a.ClientID != "" && a.ClientID != cb.ClientID {
			return failure("connection_changed", "The account changed during sign-in.", true)
		}
		a.ClientID = cb.ClientID
		return c.Store.Save(ctx, a)
	})
	if err != nil {
		return Session{}, err
	}
	body, err := c.token(ctx, url.Values{"grant_type": {"authorization_code"}, "client_id": {cb.ClientID}, "code": {cb.Code}, "code_verifier": {verifier}, "redirect_uri": {redirect}, "resource": {resource}})
	if err != nil {
		return Session{}, err
	}
	subject, identity, err := c.verify(ctx, text(body["id_token"]), cb.ClientID, nonce, time.Now())
	if err != nil {
		return Session{}, err
	}
	if previous.Subject != "" && subject != previous.Subject {
		return Session{}, failure("account_mismatch", "This sign-in returned a different ChatGPT account. Choose the original account.", false)
	}
	creds, granted, err := tokenFields(body, nil, false)
	if err != nil {
		return Session{}, err
	}
	var s Session
	err = c.Store.WithLock(ctx, func(a *Account) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		a.Subject = subject
		a.Identity = identity
		a.Credentials = creds
		a.Scopes = granted
		a.IDToken = text(body["id_token"])
		a.Pending = nil
		if err := c.Store.Save(ctx, a); err != nil {
			return err
		}
		s = session(a)
		return nil
	})
	if err == nil {
		c.emit(s)
	}
	return s, err
}
func refreshTime(v any) time.Time {
	switch n := v.(type) {
	case float64:
		if n < 1e12 {
			n *= 1000
		}
		return time.UnixMilli(int64(n))
	case string:
		if t, e := time.Parse(time.RFC3339, n); e == nil {
			return t
		}
		if f, e := strconv.ParseFloat(n, 64); e == nil {
			return refreshTime(f)
		}
	}
	return time.Time{}
}
func (c *Connection) credentials(ctx context.Context) (string, error) {
	c.mu.Lock()
	signing := c.signing
	c.mu.Unlock()
	if signing {
		return "", failure("connection_busy", "Sign-in is already in progress.", true)
	}
	var token string
	err := c.Store.WithLock(ctx, func(a *Account) error {
		if a.Credentials == nil {
			return failure("sign_in_required", "Connect a ChatGPT account before sending a message.", false)
		}
		if a.Pending != nil || a.Credentials.ExpiresAt < time.Now().Add(time.Minute).UnixMilli() {
			if a.Pending == nil && time.Now().Before(refreshTime(a.Credentials.EarliestRefreshAt)) {
				if a.Credentials.ExpiresAt <= time.Now().UnixMilli() {
					return failure("refresh_not_ready", "Your ChatGPT connection cannot refresh yet. Try again shortly.", true)
				}
			} else {
				// Once rotation starts, finish saving its successor even if the caller stops.
				renewal, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
				defer cancel()
				if err := c.refresh(renewal, a); err != nil {
					if has([]string{"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_id_token", "invalid_token_response", "account_mismatch"}, publicError(err).Code) {
						a.Credentials = nil
						a.Pending = nil
						a.IDToken = ""
						a.Scopes = nil
						if saveErr := c.Store.Save(renewal, a); saveErr != nil {
							return saveErr
						}
						c.emit(session(a))
					}
					return err
				}
			}
		}
		if a.Credentials.ExpiresAt <= time.Now().UnixMilli() {
			return failure("refresh_not_ready", "Your ChatGPT connection was recovered. Retry to renew it.", true)
		}
		if !has(a.Scopes, sharing) {
			return failure("sharing_not_enabled", "Enable ChatGPT plan usage to continue.", false)
		}
		token = a.Credentials.Access
		return nil
	})
	return token, err
}
func (c *Connection) refresh(ctx context.Context, a *Account) error {
	pending := a.Pending
	if pending == nil {
		if a.Credentials.Refresh == "" {
			return failure("invalid_grant", "Sign in again to renew this connection.", false)
		}
		body, err := c.token(ctx, url.Values{"grant_type": {"refresh_token"}, "client_id": {a.ClientID}, "refresh_token": {a.Credentials.Refresh}, "resource": {resource}})
		if err != nil {
			return err
		}
		next, granted, err := tokenFields(body, a.Scopes, true)
		if err != nil {
			return err
		}
		if v, exists := body["id_token"]; exists && text(v) == "" {
			return failure("invalid_id_token", "ChatGPT returned an invalid refreshed identity.", false)
		}
		if id := text(body["id_token"]); id != "" {
			pending = &Rotation{Credentials: *next, Scopes: granted, IDToken: id, ReceivedAt: time.Now().UnixMilli()}
			a.Pending = pending
			if err := c.Store.Save(ctx, a); err != nil {
				return err
			}
		} else {
			a.Credentials = next
			a.Scopes = granted
			return c.Store.Save(ctx, a)
		}
	}
	subject, identity, err := c.verify(ctx, pending.IDToken, a.ClientID, "", time.UnixMilli(pending.ReceivedAt))
	if err != nil {
		return err
	}
	if subject != a.Subject {
		return failure("account_mismatch", "The refreshed ChatGPT identity does not match this account.", false)
	}
	a.Credentials = &pending.Credentials
	a.Scopes = pending.Scopes
	a.Identity = identity
	a.IDToken = pending.IDToken
	a.Pending = nil
	return c.Store.Save(ctx, a)
}
func (c *Connection) SignOut(ctx context.Context) (Session, error) {
	var s Session
	var warning error
	err := c.Store.WithLock(ctx, func(a *Account) error {
		token := ""
		if a.Credentials != nil {
			token = a.Credentials.Refresh
		}
		if a.Pending != nil {
			token = a.Pending.Credentials.Refresh
		}
		if token != "" {
			d, e := c.discover(ctx)
			revoked := false
			if e == nil && d.Revocation != "" {
				for attempt := 0; attempt < 2; attempt++ {
					revoke, cancel := context.WithTimeout(ctx, 10*time.Second)
					res, e := request(revoke, c.HTTP, "POST", d.Revocation, "application/x-www-form-urlencoded", "", strings.NewReader(url.Values{"token": {token}, "token_type_hint": {"refresh_token"}, "client_id": {a.ClientID}}.Encode()))
					status := 0
					if e == nil {
						status = res.StatusCode
						res.Body.Close()
					}
					cancel()
					if status == 200 {
						revoked = true
						break
					}
					if status > 0 && status < 500 {
						break
					}
					if attempt == 0 {
						select {
						case <-time.After(300 * time.Millisecond):
						case <-ctx.Done():
						}
					}
				}
			}
			if !revoked {
				warning = failure("revocation_failed", "Local credentials were removed, but remote disconnection could not be confirmed. Disconnect the app in ChatGPT Settings.", true)
			}
		}
		a.Credentials = nil
		a.Pending = nil
		a.IDToken = ""
		a.Scopes = nil
		if err := c.Store.Save(ctx, a); err != nil {
			return err
		}
		s = session(a)
		return nil
	})
	if err != nil {
		return s, err
	}
	c.emit(s)
	return s, warning
}
