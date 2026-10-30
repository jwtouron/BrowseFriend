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

func DefaultDirectory() (string, error) {
	paths, err := SystemPaths()
	return paths.Data, err
}
func NewStore(directory string) *Store {
	return &Store{Directory: directory, Key: platformKey(directory)}
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
func (s *Store) WithLock(ctx context.Context, op func(*Account) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := privateDirectory(s.Directory); err != nil {
		return err
	}
	lock, err := privateFile(filepath.Join(s.Directory, "account.lock"), os.O_CREATE|os.O_RDWR)
	if err != nil {
		return err
	}
	defer lock.Close()
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	for {
		locked, err := tryLock(lock)
		if err != nil {
			return err
		}
		if locked {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return failure("storage_busy", "Another process is updating the account. Try again shortly.", true)
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer unlockFile(lock)
	if err := ctx.Err(); err != nil {
		return err
	}
	a, err := s.read(ctx)
	if err != nil {
		return err
	}
	return op(a)
}
func (s *Store) read(ctx context.Context) (*Account, error) {
	f, err := privateFile(filepath.Join(s.Directory, "account.enc"), os.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return &Account{Version: 1}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() > 2*1024*1024 {
		return nil, failure("storage_invalid", "The account file is invalid.", false)
	}
	data := make([]byte, info.Size())
	if _, err := f.ReadAt(data, 0); err != nil {
		return nil, err
	}
	key, err := s.Key(ctx, false)
	if err != nil {
		return nil, err
	}
	plain, err := decrypt(key, data)
	if err != nil {
		return nil, failure("storage_decryption_failed", "Saved credentials could not be decrypted. The original file has been preserved.", false)
	}
	var a Account
	if json.Unmarshal(plain, &a) != nil || a.Version != 1 || a.ClientID == "dynamic_agent_client" ||
		(a.Credentials != nil && (a.Credentials.Access == "" || a.Credentials.ExpiresAt <= 0)) ||
		(a.Pending != nil && (a.Credentials == nil || a.Pending.Credentials.Refresh == "" || a.Pending.IDToken == "" || a.Pending.ReceivedAt <= 0 || a.Pending.ReceivedAt > time.Now().Add(5*time.Second).UnixMilli())) {
		return nil, failure("storage_invalid", "The saved account is invalid. The original file has been preserved.", false)
	}
	return &a, nil
}

// Save must only be called inside WithLock.
func (s *Store) Save(ctx context.Context, a *Account) error {
	key, err := s.Key(ctx, true)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(a)
	if err != nil {
		return err
	}
	data, err := encrypt(key, plain)
	if err != nil {
		return err
	}
	if len(data) > 2*1024*1024 {
		return failure("storage_too_large", "The account file is too large.", false)
	}
	return atomicFile(filepath.Join(s.Directory, "account.enc"), bytes.NewReader(data), 0600)
}
