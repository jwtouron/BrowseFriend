package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gofrs/flock"
)

type Credentials struct {
	Access            string
	Refresh           string
	ExpiresAt         int64
	EarliestRefreshAt any
}
type Rotation struct {
	Credentials Credentials
	Scopes      []string
	IDToken     string
	ReceivedAt  int64
}

// Registration contains public identifiers, never credentials or display profiles.
type Registration struct {
	HostID   string `json:"hostId"`
	ClientID string `json:"clientId"`
	Subject  string `json:"subject"`
}

// Account exists only in the Store's owning process. Only Registration is serializable to disk.
type Account struct {
	Registration
	Identity    object
	Scopes      []string
	Credentials *Credentials
	IDToken     string
	Pending     *Rotation
}

type Store struct {
	Directory string
	once      sync.Once
	gate      chan struct{}
	account   *Account
}

func DefaultDirectory() (string, error) {
	paths, err := SystemPaths()
	return paths.Data, err
}
func NewStore(directory string) *Store { return &Store{Directory: directory} }

// WithLock serializes access to this process's account, including refresh rotation.
// Mutations remain in memory even if the callback returns an error after receiving a successor.
func (s *Store) WithLock(ctx context.Context, op func(*Account) error) error {
	s.once.Do(func() { s.gate = make(chan struct{}, 1) })
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case s.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.gate }()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.account == nil {
		var registration Registration
		if err := s.withRegistration(ctx, func(r *Registration) error { registration = *r; return nil }); err != nil {
			return err
		}
		s.account = &Account{Registration: registration}
	}
	return op(s.account)
}

// UpdateRegistration must run inside WithLock. It reloads only the public metadata so independent
// companion processes cannot overwrite a different registration. Authentication is never shared.
func (s *Store) UpdateRegistration(ctx context.Context, a *Account, op func(*Registration) error) error {
	var updated Registration
	if err := s.withRegistration(ctx, func(r *Registration) error {
		if err := op(r); err != nil {
			return err
		}
		updated = *r
		return nil
	}); err != nil {
		return err
	}
	a.Registration = updated
	return nil
}

func (s *Store) withRegistration(ctx context.Context, op func(*Registration) error) (err error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := privateDirectory(s.Directory); err != nil {
		return err
	}
	lock, err := acquireRegistrationLock(ctx, filepath.Join(s.Directory, "registration.lock"), 45*time.Second)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lock.Close()) }()
	r, err := s.readRegistration()
	if err != nil {
		return err
	}
	before := r
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := op(&r); err != nil {
		return err
	}
	if !validRegistration(r) {
		return failure("registration_invalid", "The ChatGPT registration is invalid.", false)
	}
	if before == r {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return atomicFile(filepath.Join(s.Directory, "registration.json"), bytes.NewReader(data), 0600)
}

func validRegistration(r Registration) bool {
	return len(r.HostID) <= 200 && len(r.Subject) <= 4096 &&
		(r.ClientID == "" || (r.HostID != "" && clientIDPattern.MatchString(r.ClientID) && r.ClientID != "dynamic_agent_client")) &&
		(r.Subject == "" || r.ClientID != "")
}

func (s *Store) readRegistration() (Registration, error) {
	var r Registration
	f, err := privateFile(filepath.Join(s.Directory, "registration.json"), os.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 16*1024+1))
	if err != nil {
		return r, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if len(data) > 16*1024 || decoder.Decode(&r) != nil || !validRegistration(r) || decoder.Decode(new(any)) != io.EOF {
		return Registration{}, failure("registration_invalid", "The saved ChatGPT registration is invalid.", false)
	}
	return r, nil
}

func acquireRegistrationLock(ctx context.Context, path string, timeout time.Duration) (*flock.Flock, error) {
	checked, err := privateFile(path, os.O_CREATE|os.O_RDWR)
	if err != nil {
		return nil, err
	}
	defer checked.Close()
	info, err := checked.Stat()
	if err != nil {
		return nil, err
	}
	// Never share a Flock object: an already-held object's TryLock succeeds again.
	lock := flock.New(path, flock.SetFlag(os.O_RDWR), flock.SetPermissions(0600))
	wait, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	locked, err := lock.TryLockContext(wait, 25*time.Millisecond)
	if !locked || err != nil {
		lock.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, failure("storage_busy", "Another process is updating the registration. Try again shortly.", true)
		}
		return nil, err
	}
	if err := validateLockIdentity(info, lock); err != nil {
		return nil, errors.Join(err, lock.Close())
	}
	return lock, nil
}

func validateLockIdentity(checked os.FileInfo, lock *flock.Flock) error {
	info, err := lock.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(checked, info) {
		return failure("storage_unsafe", "The registration lock file changed. The registration has been preserved.", false)
	}
	return nil
}
