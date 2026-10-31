package companion

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
type Account struct {
	Version     int
	HostID      string
	ClientID    string
	Subject     string
	Identity    object
	Scopes      []string
	Credentials *Credentials
	IDToken     string
	Pending     *Rotation
}
type KeyProvider func(context.Context, bool) ([]byte, error)
type Store struct {
	Directory string
	Key       KeyProvider
}

// AccountTransaction owns the account and key for one WithLock callback.
// Each Save commits independently; a later callback error does not roll it back.
type AccountTransaction struct {
	Account *Account
	store   *Store
	key     []byte
}

func DefaultDirectory() (string, error) {
	paths, err := SystemPaths()
	return paths.Data, err
}
func NewStore(directory string) *Store {
	return &Store{Directory: directory, Key: keyringProvider(systemKeyring{}, keyService)}
}
func encrypt(key, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(append([]byte{1}, nonce...), gcm.Seal(nil, nonce, plain, nil)...), nil
}
func decrypt(key, data []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < 1+gcm.NonceSize()+gcm.Overhead() || data[0] != 1 {
		return nil, errors.New("invalid ciphertext")
	}
	return gcm.Open(nil, data[1:1+gcm.NonceSize()], data[1+gcm.NonceSize():], nil)
}
func (s *Store) WithLock(ctx context.Context, op func(*AccountTransaction) error) (err error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := privateDirectory(s.Directory); err != nil {
		return err
	}
	lock, err := acquireAccountLock(ctx, filepath.Join(s.Directory, "account.lock"), 45*time.Second)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := lock.Close(); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	tx := &AccountTransaction{store: s}
	defer func() { tx.store, tx.key = nil, nil }()
	if err := tx.read(ctx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return op(tx)
}

func acquireAccountLock(ctx context.Context, path string, timeout time.Duration) (*flock.Flock, error) {
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
			return nil, failure("storage_busy", "Another process is updating the account. Try again shortly.", true)
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
		return failure("storage_unsafe", "The account lock file changed. Saved credentials have been preserved.", false)
	}
	return nil
}

func (tx *AccountTransaction) read(ctx context.Context) error {
	f, err := privateFile(filepath.Join(tx.store.Directory, "account.enc"), os.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		tx.Account = &Account{Version: 1}
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() > 2*1024*1024 {
		return failure("storage_invalid", "The account file is invalid.", false)
	}
	data := make([]byte, info.Size())
	if _, err := f.ReadAt(data, 0); err != nil {
		return err
	}
	tx.key, err = tx.store.Key(ctx, false)
	if err != nil {
		return err
	}
	plain, err := decrypt(tx.key, data)
	if err != nil {
		return failure("storage_decryption_failed", "Saved credentials could not be decrypted. The original file has been preserved.", false)
	}
	var a Account
	if json.Unmarshal(plain, &a) != nil || a.Version != 1 || a.ClientID == "dynamic_agent_client" ||
		(a.Credentials != nil && (a.Credentials.Access == "" || a.Credentials.ExpiresAt <= 0)) ||
		(a.Pending != nil && (a.Credentials == nil || a.Pending.Credentials.Refresh == "" || a.Pending.IDToken == "" || a.Pending.ReceivedAt <= 0 || a.Pending.ReceivedAt > time.Now().Add(5*time.Second).UnixMilli())) {
		return failure("storage_invalid", "The saved account is invalid. The original file has been preserved.", false)
	}
	tx.Account = &a
	return nil
}

func (tx *AccountTransaction) Save(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if tx.store == nil {
		return errors.New("save requires an active account operation")
	}
	if tx.key == nil {
		key, err := tx.store.Key(ctx, true)
		if err != nil {
			return err
		}
		tx.key = key
	}
	plain, err := json.Marshal(tx.Account)
	if err != nil {
		return err
	}
	data, err := encrypt(tx.key, plain)
	if err != nil {
		return err
	}
	if len(data) > 2*1024*1024 {
		return failure("storage_too_large", "The account file is too large.", false)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return atomicFile(filepath.Join(tx.store.Directory, "account.enc"), bytes.NewReader(data), 0600)
}
