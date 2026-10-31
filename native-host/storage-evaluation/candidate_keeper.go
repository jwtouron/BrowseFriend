//go:build candidate_keeper

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	keeper "github.com/agberohq/keeper"
)

func init() { openers["keeper"] = openKeeper }

type keeperRecord struct{ store *keeper.Keeper }

func openKeeper(ctx context.Context, directory string, key keyProvider) (record, error) {
	path := filepath.Join(directory, "account.db")
	_, exists := os.Stat(path)
	secret, err := key(ctx, os.IsNotExist(exists))
	if err != nil {
		return nil, err
	}
	s, err := keeper.New(keeper.Config{DBPath: path, EnableAudit: false})
	if err != nil {
		return nil, err
	}
	if err = s.Unlock(secret); err == nil {
		err = s.EnsureBucket("vault://browsefriend/account")
	}
	if err != nil {
		s.Close()
		return nil, err
	}
	return &keeperRecord{store: s}, nil
}
func (r *keeperRecord) get() ([]byte, error) {
	data, err := r.store.Get("vault://browsefriend/account")
	if errors.Is(err, keeper.ErrKeyNotFound) {
		return nil, nil
	}
	return data, err
}
func (r *keeperRecord) put(_ context.Context, data []byte) error {
	return r.store.Set("vault://browsefriend/account", data)
}
func (r *keeperRecord) close() error { return r.store.Close() }
