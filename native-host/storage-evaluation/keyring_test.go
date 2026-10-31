package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	keyring "github.com/zalando/go-keyring"
)

type fakeVault struct {
	value  string
	err    error
	writes int
	delay  time.Duration
	setErr error
}

func (v *fakeVault) Get(string, string) (string, error) { time.Sleep(v.delay); return v.value, v.err }
func (v *fakeVault) Set(_, _, value string) error {
	if v.setErr != nil {
		return v.setErr
	}
	v.value, v.err = value, nil
	v.writes++
	return nil
}
func (v *fakeVault) Delete(string, string) error { return nil }

func TestKeyringFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		name, value     string
		err             error
		create, success bool
		writes          int
	}{
		{"missing read", "", keyring.ErrNotFound, false, false, 0},
		{"missing create", "", keyring.ErrNotFound, true, true, 1},
		{"denied", "", errors.New("synthetic access denied"), true, false, 0},
		{"locked", "", errors.New("synthetic vault locked"), true, false, 0},
		{"malformed", "invalid base64", nil, true, false, 0},
		{"wrong length", "c2hvcnQ=", nil, true, false, 0},
		{"existing", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32)), nil, true, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := &fakeVault{value: tc.value, err: tc.err}
			key, err := keyringProvider(v, "synthetic-service")(context.Background(), tc.create)
			if (err == nil) != tc.success || v.writes != tc.writes || (tc.success && len(key) != 32) {
				t.Fatal("unsafe key handling")
			}
		})
	}
}

func TestKeyringCancellationLimitation(t *testing.T) {
	v := &fakeVault{err: keyring.ErrNotFound, delay: 60 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := keyringProvider(v, "synthetic-service")(ctx, true)
	if !errors.Is(err, context.DeadlineExceeded) || v.writes != 0 {
		t.Fatal("cancelled lookup created a key")
	}
	if time.Since(started) < v.delay {
		t.Fatal("expected synchronous upstream API limitation")
	}
	t.Log("Zalando's API cannot interrupt a blocked lookup; adapter prevents a later create")
}

func TestKeyringSaveFailure(t *testing.T) {
	v := &fakeVault{err: keyring.ErrNotFound, setErr: errors.New("synthetic save denied")}
	if _, err := keyringProvider(v, "synthetic-service")(context.Background(), true); !errors.Is(err, errKeyUnavailable) || v.writes != 0 {
		t.Fatal("save failure ignored")
	}
}

func TestKeyringOS(t *testing.T) {
	if os.Getenv("BF_STORAGE_EVALUATION_KEYRING") != "1" {
		t.Skip("opt-in OS keyring test using synthetic entries only")
	}
	service := "com.browsefriend.storage-evaluation." + strconv.FormatInt(time.Now().UnixNano(), 36)
	const user = "account-encryption-key"
	vault := systemKeyring{}
	t.Cleanup(func() {
		if err := vault.Delete(service, user); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			t.Error("synthetic key cleanup failed")
		}
	})
	key := keyringProvider(vault, service)
	ctx := context.Background()
	if _, err := key(ctx, false); !errors.Is(err, errKeyUnavailable) {
		t.Fatal("missing entry accepted")
	}
	first, err := key(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := key(ctx, false)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatal("key round trip failed")
	}
	for _, backend := range []string{"file", "bolt"} {
		s := testStore(t, backend, testDirectory(t), key)
		seed(t, s, 4096)
		if err := s.WithLock(ctx, func(a *account, save saveAccount) error {
			if a.Credentials == nil || a.Credentials.Refresh != "synthetic-refresh" {
				return errors.New("OS key did not recover account")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestKeyringProcess$", "-test.timeout=15s")
	cmd.Env = append(os.Environ(), "BF_STORAGE_EVALUATION_KEYRING_SERVICE="+service)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("keyring process persistence: %v %s", err, output)
	}
	if err := vault.Set(service, user, "damaged-synthetic-key"); err != nil {
		t.Fatal("synthetic corruption setup failed")
	}
	if _, err := key(ctx, true); !errors.Is(err, errKeyUnavailable) {
		t.Fatal("malformed key replaced")
	}
	if value, err := vault.Get(service, user); err != nil || value != "damaged-synthetic-key" {
		t.Fatal("corrupt entry changed")
	}
	if err := vault.Delete(service, user); err != nil {
		t.Fatal("synthetic key removal failed")
	}
	if _, err := vault.Get(service, user); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatal("upstream did not distinguish a missing entry")
	}
}

func TestKeyringProcess(t *testing.T) {
	service := os.Getenv("BF_STORAGE_EVALUATION_KEYRING_SERVICE")
	if service == "" {
		return
	}
	if !strings.HasPrefix(service, "com.browsefriend.storage-evaluation.") {
		t.Fatal("refusing non-evaluation service")
	}
	key, err := keyringProvider(systemKeyring{}, service)(context.Background(), false)
	if err != nil || len(key) != 32 {
		t.Fatal("synthetic key unavailable in fresh process")
	}
}

func TestUnavailableKeyringOS(t *testing.T) {
	if os.Getenv("BF_STORAGE_EVALUATION_UNAVAILABLE_KEYRING") != "1" {
		t.Skip("requires deliberately unavailable isolated Secret Service")
	}
	_, err := (systemKeyring{}).Get("com.browsefriend.storage-evaluation.unavailable", "synthetic")
	if err == nil || errors.Is(err, keyring.ErrNotFound) {
		t.Fatal("unavailable store reported as a missing entry")
	}
}
