package companion

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
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
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "BrowseFriend", "go-prototype"), nil
	case "linux":
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			base = filepath.Join(home, ".config")
		}
		return filepath.Join(base, "browsefriend", "go-prototype"), nil
	}
	return "", failure("unsupported_platform", "BrowseFriend supports macOS and Linux.", false)
}
func OSKey(ctx context.Context, create bool) ([]byte, error) {
	var read *exec.Cmd
	secretTool := "/usr/bin/secret-tool"
	if runtime.GOOS == "darwin" {
		read = exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-a", "local-encryption-key", "-s", "com.browsefriend.credentials.go-prototype", "-w")
	} else if runtime.GOOS == "linux" {
		if _, err := os.Stat(secretTool); err != nil {
			secretTool = "/usr/local/bin/secret-tool"
		}
		read = exec.CommandContext(ctx, secretTool, "lookup", "application", "browsefriend-go-prototype", "key", "credentials")
	} else {
		return nil, failure("storage_encryption_unavailable", "Secure credential storage is unavailable.", true)
	}
	data, err := read.Output()
	if err == nil && len(strings.TrimSpace(string(data))) > 0 {
		key, e := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if e == nil && len(key) == 32 {
			return key, nil
		}
		return nil, failure("storage_encryption_unavailable", "The prototype credential key is invalid. Saved credentials have been preserved.", true)
	}
	// Only a definite missing entry may create a key; never replace a denied/locked key.
	missing := false
	var exit *exec.ExitError
	if runtime.GOOS == "darwin" {
		missing = errors.As(err, &exit) && exit.ExitCode() == 44
	} else {
		missing = err == nil || (errors.As(err, &exit) && exit.ExitCode() == 1 && len(bytes.TrimSpace(exit.Stderr)) == 0)
	}
	if !create || !missing {
		return nil, failure("storage_encryption_unavailable", "Unlock your OS credential store and try again. Saved credentials have been preserved.", true)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	var write *exec.Cmd
	if runtime.GOOS == "darwin" {
		write = exec.CommandContext(ctx, "/usr/bin/security", "add-generic-password", "-a", "local-encryption-key", "-s", "com.browsefriend.credentials.go-prototype", "-w", encoded)
	} else {
		write = exec.CommandContext(ctx, secretTool, "store", "--label=BrowseFriend Go prototype credentials", "application", "browsefriend-go-prototype", "key", "credentials")
		write.Stdin = strings.NewReader(encoded)
	}
	if err := write.Run(); err != nil {
		return nil, failure("storage_encryption_unavailable", "Could not save the prototype credential key in the OS credential store.", true)
	}
	return key, nil
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
func privateFile(path string, flags int) (*os.File, error) {
	fd, err := syscall.Open(path, flags|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		f.Close()
		return nil, failure("storage_unsafe", "Credential storage must be a private, owner-only file.", false)
	}
	return f, nil
}
func (s *Store) WithLock(ctx context.Context, op func(*Account) error) error {
	if err := os.MkdirAll(s.Directory, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(s.Directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		return failure("storage_unsafe", "Credential storage must be a private directory.", false)
	}
	if err := os.Chmod(s.Directory, 0700); err != nil {
		return err
	}
	lock, err := privateFile(filepath.Join(s.Directory, "account.lock"), syscall.O_CREAT|syscall.O_RDWR)
	if err != nil {
		return err
	}
	defer lock.Close()
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return failure("storage_busy", "Another process is updating the prototype account. Try again shortly.", true)
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	a, err := s.read(ctx)
	if err != nil {
		return err
	}
	return op(a)
}
func (s *Store) read(ctx context.Context) (*Account, error) {
	f, err := privateFile(filepath.Join(s.Directory, "account.enc"), syscall.O_RDONLY)
	if errors.Is(err, os.ErrNotExist) {
		return &Account{Version: 1}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() > 2*1024*1024 {
		return nil, failure("storage_invalid", "The prototype account file is invalid.", false)
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
		return nil, failure("storage_decryption_failed", "Saved prototype credentials could not be decrypted. The original file has been preserved.", false)
	}
	var a Account
	if json.Unmarshal(plain, &a) != nil || a.Version != 1 || a.ClientID == "dynamic_agent_client" ||
		(a.Credentials != nil && (a.Credentials.Access == "" || a.Credentials.ExpiresAt <= 0)) ||
		(a.Pending != nil && (a.Credentials == nil || a.Pending.Credentials.Refresh == "" || a.Pending.IDToken == "" || a.Pending.ReceivedAt <= 0 || a.Pending.ReceivedAt > time.Now().Add(5*time.Second).UnixMilli())) {
		return nil, failure("storage_invalid", "The saved prototype account is invalid. The original file has been preserved.", false)
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
		return failure("storage_too_large", "The prototype account file is too large.", false)
	}
	f, err := os.CreateTemp(s.Directory, ".account-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), filepath.Join(s.Directory, "account.enc")); err != nil {
		return err
	}
	dir, err := os.Open(s.Directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
