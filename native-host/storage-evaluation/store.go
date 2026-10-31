// This module measures storage alternatives. It is never linked into the companion.
package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"browsefriend/native-host/internal/companion"
	bolt "go.etcd.io/bbolt"
)

type account = companion.Account
type keyProvider = companion.KeyProvider

func syntheticCredentials(size int) *companion.Credentials {
	return &companion.Credentials{Access: strings.Repeat("s", size), Refresh: "synthetic-refresh", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
}

type saveAccount func(context.Context, *account) error
type accountStore interface {
	WithLock(context.Context, func(*account, saveAccount) error) error
}

type record interface {
	get() ([]byte, error)
	put(context.Context, []byte) error
	close() error
}
type recordOpener func(context.Context, string, keyProvider) (record, error)

var openers = map[string]recordOpener{"bolt": openBolt}

func newStore(name, directory string, key keyProvider) (accountStore, error) {
	if name == "file" {
		store := companion.NewStore(directory)
		store.Key = key
		return &fileStore{store: store}, nil
	}
	open, ok := openers[name]
	if !ok {
		return nil, errors.New("unknown evaluation backend")
	}
	return &databaseStore{directory: directory, key: key, open: open, lease: make(chan struct{}, 1)}, nil
}

type fileStore struct{ store *companion.Store }

func (s *fileStore) WithLock(ctx context.Context, op func(*account, saveAccount) error) error {
	return s.store.WithLock(ctx, func(tx *companion.AccountTransaction) error {
		return op(tx.Account, func(ctx context.Context, a *account) error {
			if tx.Account != a {
				return errors.New("save requires the locked account")
			}
			return tx.Save(ctx)
		})
	})
}

// One open/close interval serializes the account operation across processes.
// Each put commits separately: a pending refresh must survive a later error.
type databaseStore struct {
	directory string
	key       keyProvider
	open      recordOpener
	lease     chan struct{}
}

func (s *databaseStore) WithLock(ctx context.Context, op func(*account, saveAccount) error) (err error) {
	wait := time.NewTimer(45 * time.Second)
	defer wait.Stop()
	select {
	case s.lease <- struct{}{}:
		defer func() { <-s.lease }()
	case <-ctx.Done():
		return ctx.Err()
	case <-wait.C:
		return errors.New("evaluation account operation busy")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = os.MkdirAll(s.directory, 0700); err != nil {
		return err
	}
	r, err := s.open(ctx, s.directory, s.key)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, r.close()) }()
	if err = ctx.Err(); err != nil {
		return err
	}
	data, err := r.get()
	if err != nil {
		return err
	}
	a := &account{Version: 1}
	if len(data) != 0 {
		if len(data) > 2*1024*1024 || json.Unmarshal(data, a) != nil || a.Version != 1 {
			return errors.New("invalid evaluation account")
		}
	}
	return op(a, func(ctx context.Context, a *account) error { return saveRecord(ctx, r, a) })
}

func saveRecord(ctx context.Context, r record, a *account) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if len(data) > 2*1024*1024 {
		return errors.New("evaluation account too large")
	}
	return r.put(ctx, data)
}

type boltRecord struct {
	db  *bolt.DB
	key keyProvider
	ctx context.Context
}

func openBolt(ctx context.Context, directory string, key keyProvider) (record, error) {
	// Short, bounded attempts let context cancellation interrupt lock contention.
	deadline := time.Now().Add(45 * time.Second)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if time.Now().After(deadline) {
			return nil, errors.New("evaluation database lock timed out")
		}
		db, err := bolt.Open(filepath.Join(directory, "account.db"), 0600, &bolt.Options{Timeout: 25 * time.Millisecond})
		if errors.Is(err, bolt.ErrTimeout) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return &boltRecord{db: db, key: key, ctx: ctx}, nil
	}
}

func (r *boltRecord) get() ([]byte, error) {
	var encrypted []byte
	err := r.db.View(func(tx *bolt.Tx) error {
		if b := tx.Bucket([]byte("account")); b != nil {
			encrypted = append([]byte(nil), b.Get([]byte("current"))...)
		}
		return nil
	})
	if err != nil || len(encrypted) == 0 {
		return nil, err
	}
	key, err := r.key(r.ctx, false)
	if err != nil {
		return nil, err
	}
	return openEnvelope(key, encrypted)
}

func (r *boltRecord) put(ctx context.Context, plain []byte) error {
	key, err := r.key(ctx, true)
	if err != nil {
		return err
	}
	encrypted, err := sealEnvelope(key, plain)
	if err != nil {
		return err
	}
	return r.db.Update(func(tx *bolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists([]byte("account"))
		if err != nil {
			return err
		}
		return b.Put([]byte("current"), encrypted)
	})
}
func (r *boltRecord) close() error { return r.db.Close() }

// The reference uses the production AES-GCM envelope, with Go's standard crypto.
func sealEnvelope(key, plain []byte) ([]byte, error) {
	gcm, err := envelopeCipher(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(append([]byte{1}, nonce...), gcm.Seal(nil, nonce, plain, nil)...), nil
}
func openEnvelope(key, data []byte) ([]byte, error) {
	gcm, err := envelopeCipher(key)
	if err != nil {
		return nil, err
	}
	if len(data) < 1+gcm.NonceSize()+gcm.Overhead() || data[0] != 1 {
		return nil, errors.New("invalid envelope")
	}
	return gcm.Open(nil, data[1:1+gcm.NonceSize()], data[1+gcm.NonceSize():], nil)
}
func envelopeCipher(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
