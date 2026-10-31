package companion

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestAccountOperationReusesKeyAndKeepsCommittedCheckpoint(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.WithLock(ctx, func(tx *AccountTransaction) error { return tx.Save(ctx) }); err != nil {
		t.Fatal(err)
	}
	key := s.Key
	lookups := 0
	s.Key = func(ctx context.Context, create bool) ([]byte, error) {
		lookups++
		if create {
			t.Error("existing account requested key creation")
		}
		return key(ctx, create)
	}
	later := errors.New("synthetic later verification failure")
	var finished *AccountTransaction
	err := s.WithLock(ctx, func(tx *AccountTransaction) error {
		finished = tx
		tx.Account.HostID = "first-checkpoint"
		if err := tx.Save(ctx); err != nil {
			return err
		}
		tx.Account.HostID = "successor-checkpoint"
		if err := tx.Save(ctx); err != nil {
			return err
		}
		return later
	})
	if err != later || lookups != 1 {
		t.Fatal(err, lookups)
	}
	if err := finished.Save(ctx); err == nil {
		t.Fatal("save escaped its account lock")
	}
	if err := s.WithLock(ctx, func(tx *AccountTransaction) error {
		if tx.Account.HostID != "successor-checkpoint" {
			t.Fatal("committed checkpoint rolled back")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAccountOperationsExcludeOtherGoroutinesAndStores(t *testing.T) {
	for _, separate := range []bool{false, true} {
		t.Run(map[bool]string{false: "shared Store", true: "separate Store"}[separate], func(t *testing.T) {
			s := testStore(t)
			other := s
			if separate {
				other = &Store{Directory: s.Directory, Key: s.Key}
			}
			entered, release := make(chan struct{}), make(chan struct{})
			done := make(chan error, 1)
			go func() {
				done <- s.WithLock(context.Background(), func(*AccountTransaction) error {
					close(entered)
					<-release
					return errors.New("synthetic callback failure")
				})
			}()
			<-entered
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
			err := other.WithLock(ctx, func(*AccountTransaction) error { t.Error("account operation overlapped"); return nil })
			cancel()
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			close(release)
			if err := <-done; err == nil {
				t.Fatal("callback error lost")
			}
			if err := other.WithLock(context.Background(), func(*AccountTransaction) error { return nil }); err != nil {
				t.Fatal("lock retained after callback failure", err)
			}
		})
	}
}

func TestAccountLockTimeoutClassificationAndIdentity(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "account")
	if err := privateDirectory(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "account.lock")
	first, err := acquireAccountLock(context.Background(), path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := acquireAccountLock(context.Background(), path, 5*time.Millisecond); publicError(err).Code != "storage_busy" {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if _, err := acquireAccountLock(ctx, path, time.Second); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	other, err := privateFile(filepath.Join(dir, "different.lock"), os.O_CREATE|os.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	info, err := other.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLockIdentity(info, first); publicError(err).Code != "storage_unsafe" {
		t.Fatal("different lock accepted", err)
	}
}

func TestUnsafeLockFilePreservesTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows has ACL/reparse enforcement cases")
	}
	s := testStore(t)
	if err := privateDirectory(s.Directory); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "outside")
	before := []byte("synthetic outside file")
	if err := os.WriteFile(target, before, 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Directory, "account.lock")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := s.WithLock(context.Background(), func(*AccountTransaction) error { t.Error("symlink lock accepted"); return nil }); err == nil {
		t.Fatal("unsafe lock accepted")
	}
	after, _ := os.ReadFile(target)
	if !bytes.Equal(before, after) {
		t.Fatal("outside file changed")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := s.WithLock(context.Background(), func(*AccountTransaction) error { t.Error("shared lock accepted"); return nil }); publicError(err).Code != "storage_unsafe" {
		t.Fatal(err)
	}
}

func TestCancelledSaveKeepsPreviousAccount(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.WithLock(ctx, func(tx *AccountTransaction) error { tx.Account.HostID = "before"; return tx.Save(ctx) }); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Directory, "account.enc")
	before, _ := os.ReadFile(path)
	if err := s.WithLock(ctx, func(tx *AccountTransaction) error {
		tx.Account.HostID = "after"
		stopped, cancel := context.WithCancel(ctx)
		cancel()
		return tx.Save(stopped)
	}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("cancelled save changed account")
	}
}
