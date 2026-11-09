package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
)

const credentialFile = "credentials.json"
const maxCredentialBytes = 2 * 1024 * 1024

type credentialRecord struct {
	Version  int     `json:"version"`
	Revision string  `json:"revision"`
	Account  Account `json:"account"`
}

type credentialCheckpoint struct {
	account  Account
	revision string
}

func storageError(err error) error {
	if err == nil {
		return nil
	}
	var safe *Error
	if errors.As(err, &safe) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return failure("storage_unavailable", "Could not access saved login storage. Check permissions and available disk space, then retry. Existing saved data has been preserved.", true)
}

func invalidCredentials() error {
	return failure("credentials_invalid", "The saved login is damaged or does not match this registration. Open Settings to reset the saved login, then sign in again.", false)
}

func validAccount(a *Account) bool {
	if !validRegistration(a.Registration) || len(a.Generation) > 200 {
		return false
	}
	if a.Credentials == nil {
		return a.Pending == nil && a.IDToken == "" && len(a.Scopes) == 0 && len(a.Identity) == 0
	}
	if a.Subject == "" || a.ClientID == "" || a.HostID == "" || a.Credentials.Access == "" || a.Credentials.ExpiresAt <= 0 || a.IDToken == "" {
		return false
	}
	if p := a.Pending; p != nil {
		if p.Credentials.Access == "" || p.Credentials.Refresh == "" || p.Credentials.ExpiresAt <= 0 || p.IDToken == "" || p.ReceivedAt <= 0 || p.ReceivedAt > time.Now().Add(5*time.Second).UnixMilli() {
			return false
		}
	}
	return true
}

func (s *Store) readCredentials(r Registration) (*Account, string, error) {
	f, err := privateFile(filepath.Join(s.Directory, credentialFile), os.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return &Account{Registration: r, Generation: s.lifecycle.Generation}, "", nil
	}
	if err != nil {
		return nil, "", storageError(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxCredentialBytes+1))
	if err != nil {
		return nil, "", storageError(err)
	}
	if len(data) > maxCredentialBytes {
		return nil, "", invalidCredentials()
	}
	var version struct {
		Version int `json:"version"`
	}
	if json.Unmarshal(data, &version) != nil {
		return nil, "", invalidCredentials()
	}
	if version.Version != 1 {
		return nil, "", failure("credentials_version_unsupported", "This saved login format is unsupported. Open Settings to reset the saved login, then sign in again.", false)
	}
	var record credentialRecord
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&record) != nil || d.Decode(new(any)) != io.EOF || record.Revision == "" || len(record.Revision) > 200 || (record.Account.Credentials != nil && record.Account.Registration != r) || !validAccount(&record.Account) {
		return nil, "", invalidCredentials()
	}
	if record.Account.Generation != s.lifecycle.Generation {
		return &Account{Registration: r, Generation: s.lifecycle.Generation}, record.Revision, nil
	}
	record.Account.Registration = r
	return &record.Account, record.Revision, nil
}

// save must run under WithLock. It never rolls back an earlier checkpoint.
func (s *Store) save(ctx context.Context, a *Account) error {
	if s.active != a {
		return errors.New("credential save requires an active account operation")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !validAccount(a) {
		return invalidCredentials()
	}
	if s.sessionOnly {
		return nil
	}
	// Validate the existing file's permissions even when replacing a damaged record.
	if err := s.validateCredentialFile(); err != nil {
		return err
	}
	record := credentialRecord{Version: 1, Revision: randomValue(), Account: *a}
	data, err := json.Marshal(record)
	if err != nil || len(data) > maxCredentialBytes {
		return failure("credentials_too_large", "The saved login exceeds its storage limit. Existing saved data has been preserved.", false)
	}
	if err := atomicFile(filepath.Join(s.Directory, credentialFile), bytes.NewReader(data), 0600); err != nil {
		// Replacement can succeed before directory synchronization reports an error.
		if _, revision, readErr := s.readCredentials(a.Registration); readErr == nil && revision == record.Revision {
			s.revision = revision
		}
		return storageError(err)
	}
	s.revision = record.Revision
	s.retry = nil
	return nil
}

// checkpoint retains a received refresh successor (or a local logout) when storage fails.
// Until it commits or a newer durable operation supersedes it, WithLock blocks other work.
func (s *Store) checkpoint(ctx context.Context, a *Account) error {
	if err := s.save(ctx, a); err != nil {
		if !s.sessionOnly {
			// Clone mutable maps/slices, without logging any serialized credentials.
			data, encodeErr := json.Marshal(a)
			var copy Account
			if encodeErr == nil && json.Unmarshal(data, &copy) == nil {
				s.retry = &credentialCheckpoint{account: copy, revision: s.revision}
			}
		}
		return err
	}
	return nil
}

func (s *Store) validateCredentialFile() error {
	f, err := privateFile(filepath.Join(s.Directory, credentialFile), os.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return storageError(err)
	}
	return storageError(f.Close())
}

// Reset bypasses damaged credential parsing but keeps all ownership/path checks.
func (s *Store) Reset(ctx context.Context) error {
	return s.withDiskLock(ctx, func() error {
		if s.lifecycle.Disabled {
			return failure("companion_unavailable", "The companion has been uninstalled. Install it again before signing in.", false)
		}
		r, err := s.readRegistration()
		if err != nil {
			return storageError(err)
		}
		a := &Account{Registration: r}
		s.active = a
		defer func() { s.active = nil }()
		return s.clearLogin(ctx, a, false)
	})
}

// removeCredentials runs under the account lock during explicit uninstall.
func (s *Store) removeCredentials() error {
	return s.clearLogin(context.Background(), nil, true)
}

// clearLogin is the common invalidation/cleanup path for revoked grants, logout, reset and uninstall.
func (s *Store) clearLogin(ctx context.Context, a *Account, remove bool) error {
	if err := s.validateCredentialFile(); err != nil {
		return err
	}
	if s.sessionOnly {
		*a = Account{Registration: a.Registration, Generation: randomValue()}
		s.account = a
		return nil
	}
	state := authLifecycle{Generation: randomValue(), Disabled: remove}
	if err := s.writeLifecycle(ctx, state); err != nil {
		return err
	}
	if remove {
		s.retry = nil
		if err := os.Remove(filepath.Join(s.Directory, credentialFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return storageError(err)
		}
		return storageError(syncDirectory(s.Directory))
	}
	*a = Account{Registration: a.Registration, Generation: state.Generation}
	return s.checkpoint(ctx, a)
}

type authLifecycle struct {
	Generation string `json:"generation"`
	Disabled   bool   `json:"disabled"`
}

func (s *Store) readLifecycle() error {
	f, err := privateFile(filepath.Join(s.Directory, "auth-state.json"), os.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		s.lifecycle = authLifecycle{}
		return nil
	}
	if err != nil {
		return storageError(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return storageError(err)
	}
	var state authLifecycle
	if len(data) > 4096 || json.Unmarshal(data, &state) != nil || len(state.Generation) > 200 {
		return failure("storage_unsafe", "The native authentication state is invalid. Existing data has been preserved.", false)
	}
	s.lifecycle = state
	return nil
}
func (s *Store) writeLifecycle(ctx context.Context, state authLifecycle) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return storageError(err)
	}
	if err := atomicFile(filepath.Join(s.Directory, "auth-state.json"), bytes.NewReader(data), 0600); err != nil {
		return storageError(err)
	}
	s.lifecycle = state
	return nil
}

func (s *Store) activate(ctx context.Context, a *Account) error {
	if s.sessionOnly {
		a.Generation = randomValue()
		return s.save(ctx, a)
	}
	state := authLifecycle{Generation: randomValue()}
	if err := s.writeLifecycle(ctx, state); err != nil {
		return err
	}
	a.Generation = state.Generation
	return s.checkpoint(ctx, a)
}
