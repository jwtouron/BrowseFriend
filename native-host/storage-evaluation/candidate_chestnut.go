//go:build candidate_chestnut

package main

import (
	"context"
	"os"
	"path/filepath"

	"github.com/jrapoport/chestnut"
	"github.com/jrapoport/chestnut/encryptor/aes"
	"github.com/jrapoport/chestnut/encryptor/crypto"
	chestbolt "github.com/jrapoport/chestnut/storage/bolt"
)

func init() { openers["chestnut"] = openChestnut }

type chestnutRecord struct{ store *chestnut.Chestnut }

func openChestnut(ctx context.Context, directory string, key keyProvider) (record, error) {
	path := filepath.Join(directory, "account.db")
	_, exists := os.Stat(path)
	secret, err := key(ctx, os.IsNotExist(exists))
	if err != nil {
		return nil, err
	}
	s := chestnut.NewChestnut(chestbolt.NewStore(path), chestnut.WithAES(crypto.Key256, aes.GCM, crypto.TextSecret(secret)))
	if err = s.Open(); err != nil {
		return nil, err
	}
	return &chestnutRecord{store: s}, nil
}
func (r *chestnutRecord) get() ([]byte, error) {
	ok, err := r.store.Has("account", []byte("current"))
	if err != nil || !ok {
		return nil, err
	}
	return r.store.Get("account", []byte("current"))
}
func (r *chestnutRecord) put(_ context.Context, data []byte) error {
	return r.store.Put("account", []byte("current"), data)
}
func (r *chestnutRecord) close() error { return r.store.Close() }
