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

// Account is private to the native runtime; only Session may cross the browser boundary.
type Account struct {
	Registration
	Identity    object
	Scopes      []string
	Credentials *Credentials
	IDToken     string
	Pending     *Rotation
}

type Store struct {
	Directory   string
	once        sync.Once
	gate        chan struct{}
	sessionOnly bool
	account     *Account
	active      *Account
	revision    string
	retry       *credentialCheckpoint
}

func DefaultDirectory() (string, error) {
	paths, err := SystemPaths()
	return paths.Data, err
}
func NewStore(directory string) *Store { return &Store{Directory: directory} }

// NewMemoryStore shares registration identifiers but never reads or writes credentials.
// Live evaluations use this to keep their independent logins out of production storage.
func NewMemoryStore(directory string) *Store {
	return &Store{Directory: directory, sessionOnly: true}
}

// withDiskLock owns both registration and credentials, including network refresh rotation.
func (s *Store) withDiskLock(ctx context.Context, op func() error) (err error) {
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
	if err := privateDirectory(s.Directory); err != nil {
		return storageError(err)
	}
	lock, err := acquireRegistrationLock(ctx, filepath.Join(s.Directory, "registration.lock"), 45*time.Second)
	if err != nil {
		return storageError(err)
	}
	defer func() { err = errors.Join(err, storageError(lock.Close())) }()
	return op()
}

// WithLock reloads the latest durable account before each operation. Writes are explicit:
// a checkpoint committed inside a callback survives a subsequent callback error.
func (s *Store) WithLock(ctx context.Context, op func(*Account) error) error {
	return s.withAccount(ctx, true, op)
}

func (s *Store) withAccount(ctx context.Context, commitPending bool, op func(*Account) error) error {
	return s.withDiskLock(ctx, func() error {
		r, err := s.readRegistration()
		if err != nil {
			return storageError(err)
		}
		var a *Account
		if s.sessionOnly {
			if s.account == nil || s.account.Registration != r {
				s.account = &Account{Registration: r}
			}
			a = s.account
		} else {
			a, s.revision, err = s.readCredentials(r)
			if err != nil {
				return err
			}
		}
		s.active = a
		defer func() { s.active = nil }()
		if pending := s.retry; pending != nil {
			// A newer logout, reset, or another process's refresh always wins.
			if pending.revision != s.revision || pending.account.Registration != r {
				s.retry = nil
			} else {
				*a = pending.account
				if commitPending {
					if err := s.checkpoint(ctx, a); err != nil {
						return err
					}
				}
			}
		}
		return op(a)
	})
}

// UpdateRegistration runs inside WithLock, under its already-held interprocess lock.
func (s *Store) UpdateRegistration(ctx context.Context, a *Account, op func(*Registration) error) error {
	if s.active != a {
		return errors.New("registration update requires an active account operation")
	}
	r := a.Registration
	if err := op(&r); err != nil {
		return err
	}
	if err := s.writeRegistration(ctx, a.Registration, r); err != nil {
		return err
	}
	a.Registration = r
	return nil
}

func (s *Store) withRegistration(ctx context.Context, op func(*Registration) error) error {
	return s.withDiskLock(ctx, func() error {
		r, err := s.readRegistration()
		if err != nil {
			return storageError(err)
		}
		before := r
		if err := op(&r); err != nil {
			return err
		}
		return s.writeRegistration(ctx, before, r)
	})
}

func (s *Store) writeRegistration(ctx context.Context, before, r Registration) error {
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
		return storageError(err)
	}
	return storageError(atomicFile(filepath.Join(s.Directory, "registration.json"), bytes.NewReader(data), 0600))
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
			return nil, failure("storage_busy", "Another process is updating the saved login. Try again shortly.", true)
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
