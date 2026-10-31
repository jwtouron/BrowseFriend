package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"

	keyring "github.com/zalando/go-keyring"
)

var errKeyUnavailable = errors.New("evaluation encryption key unavailable")

type secretStore interface {
	Get(string, string) (string, error)
	Set(string, string, string) error
	Delete(string, string) error
}
type systemKeyring struct{}

func (systemKeyring) Get(s, u string) (string, error) { return keyring.Get(s, u) }
func (systemKeyring) Set(s, u, p string) error        { return keyring.Set(s, u, p) }
func (systemKeyring) Delete(s, u string) error        { return keyring.Delete(s, u) }

// This adapter never treats access failures or malformed keys as missing entries.
// The library has no context API; checks here cannot interrupt a blocked OS call.
func keyringProvider(vault secretStore, service string) keyProvider {
	return func(ctx context.Context, create bool) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		value, err := vault.Get(service, "account-encryption-key")
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err == nil {
			key, decode := base64.StdEncoding.DecodeString(value)
			if decode != nil || len(key) != 32 {
				return nil, errKeyUnavailable
			}
			return key, nil
		}
		if !create || !errors.Is(err, keyring.ErrNotFound) {
			return nil, errKeyUnavailable
		}
		key := make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		if err = vault.Set(service, "account-encryption-key", base64.StdEncoding.EncodeToString(key)); err != nil {
			return nil, errKeyUnavailable
		}
		return key, nil
	}
}
