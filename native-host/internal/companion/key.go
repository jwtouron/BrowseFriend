package companion

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	keyring "github.com/zalando/go-keyring"
)

const keyringTimeout = 20 * time.Second
const keyService = "com.browsefriend.native-host.credentials"
const keyAccount = "local-encryption-key"

type secretStore interface {
	GetWithContext(context.Context, string, string) (string, error)
	SetWithContext(context.Context, string, string, string) error
}
type systemKeyring struct{}

func (systemKeyring) GetWithContext(ctx context.Context, service, account string) (string, error) {
	return keyring.GetWithContext(ctx, service, account)
}
func (systemKeyring) SetWithContext(ctx context.Context, service, account, value string) error {
	return keyring.SetWithContext(ctx, service, account, value)
}

// Creation must run under the account lock. Never replace an unavailable key.
func keyringProvider(vault secretStore, service string) KeyProvider {
	return func(ctx context.Context, create bool) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		lookup, cancel := context.WithTimeout(ctx, keyringTimeout)
		value, err := vault.GetWithContext(lookup, service, keyAccount)
		cancel()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err == nil {
			key, decode := base64.StdEncoding.DecodeString(value)
			if decode == nil && len(key) == 32 {
				return key, nil
			}
			return nil, failure("storage_encryption_unavailable", "The credential key is invalid. Saved credentials have been preserved.", true)
		}
		if !create || !errors.Is(err, keyring.ErrNotFound) {
			return nil, failure("storage_encryption_unavailable", "Unlock your OS credential store and try again. Saved credentials have been preserved.", true)
		}
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		// Once creation starts, keep the lock until its actual outcome is known.
		commit, stop := context.WithTimeout(context.WithoutCancel(ctx), keyringTimeout)
		defer stop()
		if err := vault.SetWithContext(commit, service, keyAccount, base64.StdEncoding.EncodeToString(key)); err != nil {
			return nil, failure("storage_encryption_unavailable", "Could not save the credential key in the OS credential store. Saved credentials have been preserved.", true)
		}
		return key, nil
	}
}
