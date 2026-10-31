package companion

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	keyring "github.com/zalando/go-keyring"
)

type fakeSecrets struct {
	get func(context.Context) (string, error)
	set func(context.Context, string) error
}

func (f fakeSecrets) GetWithContext(ctx context.Context, _, _ string) (string, error) {
	return f.get(ctx)
}
func (f fakeSecrets) SetWithContext(ctx context.Context, _, _, value string) error {
	return f.set(ctx, value)
}

func TestKeyringClassification(t *testing.T) {
	valid := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	for _, tc := range []struct {
		name, value string
		getErr      error
		create      bool
		success     bool
		writes      int
	}{
		{"existing", valid, nil, true, true, 0},
		{"missing read", "", keyring.ErrNotFound, false, false, 0},
		{"missing create", "", keyring.ErrNotFound, true, true, 1},
		{"locked", "", errors.New("synthetic locked store"), true, false, 0},
		{"malformed", "not-base64", nil, true, false, 0},
		{"short", "c2hvcnQ=", nil, true, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writes := 0
			vault := fakeSecrets{
				get: func(context.Context) (string, error) { return tc.value, tc.getErr },
				set: func(_ context.Context, value string) error {
					writes++
					data, err := base64.StdEncoding.DecodeString(value)
					if err != nil || len(data) != 32 {
						t.Fatal("invalid generated key")
					}
					return nil
				},
			}
			key, err := keyringProvider(vault, "synthetic")(context.Background(), tc.create)
			if (err == nil) != tc.success || writes != tc.writes || (tc.success && len(key) != 32) {
				t.Fatal("incorrect key classification", err, writes)
			}
		})
	}
}

func TestKeyLookupCancellationDoesNotCreateOrLeaveWork(t *testing.T) {
	var active atomic.Int32
	vault := fakeSecrets{
		get: func(ctx context.Context) (string, error) {
			active.Add(1)
			defer active.Add(-1)
			<-ctx.Done()
			return "", ctx.Err()
		},
		set: func(context.Context, string) error { t.Error("cancelled lookup created key"); return nil },
	}
	provider := keyringProvider(vault, "synthetic")
	for range 5 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
		_, err := provider(ctx, true)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) || active.Load() != 0 {
			t.Fatal(err, active.Load())
		}
	}
}

func TestKeyCreationKeepsLockButCancellationPreventsAccountWrite(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	vault := fakeSecrets{
		get: func(context.Context) (string, error) { return "", keyring.ErrNotFound },
		set: func(commit context.Context, _ string) error {
			close(started)
			<-release
			return commit.Err()
		},
	}
	store := &Store{Directory: filepath.Join(t.TempDir(), "account"), Key: keyringProvider(vault, "synthetic")}
	done := make(chan error, 1)
	go func() { done <- store.WithLock(ctx, func(tx *AccountTransaction) error { return tx.Save(ctx) }) }()
	<-started
	cancel()
	wait, stop := context.WithTimeout(context.Background(), 10*time.Millisecond)
	err := store.WithLock(wait, func(*AccountTransaction) error { t.Error("key creation lost lock"); return nil })
	stop()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.Directory, "account.enc")); !os.IsNotExist(err) {
		t.Fatal("cancelled account was saved", err)
	}
}

func TestKeyringOSPersistenceAndFailurePreservation(t *testing.T) {
	if runtime.GOOS != "windows" && os.Getenv("BROWSEFRIEND_TEST_MAC_KEYCHAIN") != "1" && os.Getenv("BROWSEFRIEND_TEST_SECRET_SERVICE") != "1" {
		t.Skip("opt-in OS-keyring test with unique synthetic entries")
	}
	service := "com.browsefriend.test." + randomValue()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err := keyring.DeleteWithContext(cleanup, service, keyAccount); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			t.Error(err)
		}
	})
	// Seed the old raw encoding on macOS, using a unique synthetic service only.
	if runtime.GOOS == "darwin" {
		encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
		if err := exec.CommandContext(ctx, "/usr/bin/security", "add-generic-password", "-s", service, "-a", keyAccount, "-w", encoded).Run(); err != nil {
			t.Fatal(err)
		}
	}
	store := &Store{Directory: filepath.Join(t.TempDir(), "account"), Key: keyringProvider(systemKeyring{}, service)}
	if err := store.WithLock(ctx, func(tx *AccountTransaction) error {
		tx.Account.ClientID, tx.Account.HostID = "test-client", "synthetic-host"
		tx.Account.Credentials = &Credentials{Access: "synthetic-access", Refresh: "synthetic-refresh", ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
		return tx.Save(ctx)
	}); err != nil {
		t.Fatal(err)
	}
	if output, err := helper(t, store, "read-protected", "BROWSEFRIEND_TEST_KEY_SERVICE="+service).CombinedOutput(); err != nil {
		t.Fatalf("keyring restart: %v %s", err, output)
	}
	path := filepath.Join(store.Directory, "account.enc")
	before, _ := os.ReadFile(path)
	if bytes.Contains(before, []byte("synthetic-access")) {
		t.Fatal("plaintext account")
	}
	if err := keyring.SetWithContext(ctx, service, keyAccount, "damaged-synthetic-key"); err != nil {
		t.Fatal(err)
	}
	for _, remove := range []bool{false, true} {
		if remove {
			if err := keyring.DeleteWithContext(ctx, service, keyAccount); err != nil {
				t.Fatal(err)
			}
		}
		if err := store.WithLock(ctx, func(*AccountTransaction) error { t.Error("invalid key accepted"); return nil }); publicError(err).Code != "storage_encryption_unavailable" {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("key failure changed account")
		}
	}
	if _, err := keyring.GetWithContext(ctx, service, keyAccount); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatal("missing key replaced", err)
	}
}
