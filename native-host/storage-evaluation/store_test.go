package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"browsefriend/native-host/internal/companion"
	bolt "go.etcd.io/bbolt"
)

func backends() []string {
	names := []string{"file"}
	for name := range openers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func testDirectory(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "account")
}
func fixedKey(ctx context.Context, _ bool) ([]byte, error) {
	return bytes.Repeat([]byte{0x42}, 32), ctx.Err()
}
func testStore(t *testing.T, name, dir string, key keyProvider) accountStore {
	t.Helper()
	s, err := newStore(name, dir, key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func seed(t *testing.T, s accountStore, size int) {
	t.Helper()
	if err := s.WithLock(context.Background(), func(a *account, save saveAccount) error {
		a.ClientID, a.HostID, a.Subject = "synthetic-client", "synthetic-host", "0"
		a.Credentials = syntheticCredentials(size)
		return save(context.Background(), a)
	}); err != nil {
		t.Fatal(err)
	}
}

func TestStorageContract(t *testing.T) {
	for _, name := range backends() {
		t.Run(name, func(t *testing.T) {
			for _, size := range []int{64, 128 * 1024} {
				t.Run(strconv.Itoa(size), func(t *testing.T) {
					dir := testDirectory(t)
					store := testStore(t, name, dir, fixedKey)
					seed(t, store, size)
					if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
						if a.Credentials == nil || len(a.Credentials.Access) != size || a.ClientID != "synthetic-client" {
							return errors.New("round trip failed")
						}
						return nil
					}); err != nil {
						t.Fatal(err)
					}
				})
			}
			t.Run("pending checkpoint survives verification error", func(t *testing.T) {
				dir := testDirectory(t)
				s := testStore(t, name, dir, fixedKey)
				seed(t, s, 64)
				verification := errors.New("simulated identity verifier unavailable")
				if err := s.WithLock(context.Background(), func(a *account, save saveAccount) error {
					a.Pending = &companion.Rotation{Credentials: *syntheticCredentials(123), IDToken: "synthetic-id", ReceivedAt: time.Now().UnixMilli()}
					if err := save(context.Background(), a); err != nil {
						return err
					}
					return verification
				}); !errors.Is(err, verification) {
					t.Fatal(err)
				}
				if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
					if a.Pending == nil || len(a.Pending.Credentials.Access) != 123 {
						return errors.New("pending successor lost")
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if err := s.WithLock(context.Background(), func(a *account, save saveAccount) error {
					if a.Pending == nil {
						return errors.New("pending successor lost")
					}
					a.Credentials, a.Pending = &a.Pending.Credentials, nil
					return save(context.Background(), a)
				}); err != nil {
					t.Fatal(err)
				}
			})
			t.Run("failed keys preserve account", func(t *testing.T) {
				dir := testDirectory(t)
				seed(t, testStore(t, name, dir, fixedKey), 64)
				for _, key := range []keyProvider{
					func(context.Context, bool) ([]byte, error) { return nil, errKeyUnavailable },
					func(context.Context, bool) ([]byte, error) { return bytes.Repeat([]byte{0x43}, 32), nil },
				} {
					if err := testStore(t, name, dir, key).WithLock(context.Background(), func(_ *account, _ saveAccount) error { t.Fatal("bad key accepted"); return nil }); err == nil {
						t.Fatal("bad key succeeded")
					}
				}
				if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
					if a.Credentials == nil || a.Credentials.Refresh != "synthetic-refresh" {
						return errors.New("account destroyed")
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			})
			t.Run("logout preserves registration", func(t *testing.T) {
				dir := testDirectory(t)
				s := testStore(t, name, dir, fixedKey)
				seed(t, s, 64)
				if err := s.WithLock(context.Background(), func(a *account, save saveAccount) error {
					a.Credentials, a.Pending, a.IDToken = nil, nil, ""
					return save(context.Background(), a)
				}); err != nil {
					t.Fatal(err)
				}
				if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
					if a.Credentials != nil || a.Pending != nil || a.ClientID == "" || a.HostID == "" {
						return errors.New("logout state invalid")
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			})
		})
	}
}

func TestEnvelopeAndStoredRecordTampering(t *testing.T) {
	for _, name := range []string{"file", "bolt"} {
		t.Run(name, func(t *testing.T) {
			dir := testDirectory(t)
			seed(t, testStore(t, name, dir, fixedKey), 4096)
			mutate := func(data []byte) []byte { data = bytes.Clone(data); data[len(data)-1] ^= 1; return data }
			var changed []byte
			if name == "file" {
				path := filepath.Join(dir, "account.enc")
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				changed = mutate(data)
				if err := os.WriteFile(path, changed, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				db, err := bolt.Open(filepath.Join(dir, "account.db"), 0600, nil)
				if err != nil {
					t.Fatal(err)
				}
				err = db.Update(func(tx *bolt.Tx) error {
					b := tx.Bucket([]byte("account"))
					changed = mutate(b.Get([]byte("current")))
					return b.Put([]byte("current"), changed)
				})
				db.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(_ *account, _ saveAccount) error { t.Fatal("modified record accepted"); return nil }); err == nil {
				t.Fatal("no integrity error")
			}
			if name == "file" {
				data, err := os.ReadFile(filepath.Join(dir, "account.enc"))
				if err != nil || !bytes.Equal(data, changed) {
					t.Fatal("damaged account overwritten")
				}
			}
		})
	}
}

func child(t *testing.T, name, dir, operation string) *exec.Cmd {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestEvaluationProcess$", "-test.timeout=30s")
	cmd.Env = append(os.Environ(), "BF_STORAGE_EVALUATION_HELPER=1", "BF_STORAGE_EVALUATION_BACKEND="+name, "BF_STORAGE_EVALUATION_DIRECTORY="+dir, "BF_STORAGE_EVALUATION_OPERATION="+operation)
	return cmd
}

func startHeldProcess(t *testing.T, name, dir, operation string) *exec.Cmd {
	t.Helper()
	cmd := child(t, name, dir, operation)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		ready <- scanner.Scan() && scanner.Text() == "evaluation-checkpoint-ready"
	}()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatalf("helper failed before checkpoint: %s", stderr.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("helper checkpoint timed out")
	}
	return cmd
}

func TestIndependentProcessesAndTermination(t *testing.T) {
	for _, name := range backends() {
		t.Run(name, func(t *testing.T) {
			dir := testDirectory(t)
			seed(t, testStore(t, name, dir, fixedKey), 64)
			if err := os.WriteFile(filepath.Join(dir, "evaluation.marker"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			commands := []*exec.Cmd{}
			outputs := []*bytes.Buffer{}
			for i := 0; i < 3; i++ {
				cmd := child(t, name, dir, "increment")
				var out bytes.Buffer
				cmd.Stdout, cmd.Stderr = &out, &out
				if err := cmd.Start(); err != nil {
					t.Fatal(err)
				}
				commands = append(commands, cmd)
				outputs = append(outputs, &out)
			}
			for i, cmd := range commands {
				if err := cmd.Wait(); err != nil {
					t.Fatalf("process contract: %v %s", err, outputs[i].String())
				}
			}
			if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
				if a.Subject != "3" {
					return errors.New("concurrent update lost")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			held := startHeldProcess(t, name, dir, "checkpoint")
			if err := held.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			held.Wait()
			if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
				if a.Pending == nil || a.Pending.IDToken != "synthetic-id" {
					return errors.New("terminated process lost committed checkpoint")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCancellationCapability(t *testing.T) {
	for _, name := range backends() {
		t.Run(name, func(t *testing.T) {
			dir := testDirectory(t)
			seed(t, testStore(t, name, dir, fixedKey), 64)
			if err := os.WriteFile(filepath.Join(dir, "evaluation.marker"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			startHeldProcess(t, name, dir, "hold")
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
			defer cancel()
			started := time.Now()
			err := testStore(t, name, dir, fixedKey).WithLock(ctx, func(_ *account, _ saveAccount) error { t.Fatal("entered contended operation"); return nil })
			elapsed := time.Since(started)
			if name == "keeper" {
				if elapsed < time.Second || err == nil {
					t.Fatal("expected pinned Keeper's non-cancellable open restriction", err, elapsed)
				}
				t.Logf("ADOPTION BLOCKER: 10ms cancellation took %v (Keeper open timeout)", elapsed)
			} else if !errors.Is(err, context.DeadlineExceeded) || elapsed > 500*time.Millisecond {
				t.Fatal("lock wait did not cancel promptly", err, elapsed)
			}
		})
	}
}

func TestEvaluationProcess(t *testing.T) {
	if os.Getenv("BF_STORAGE_EVALUATION_HELPER") != "1" {
		return
	}
	dir := os.Getenv("BF_STORAGE_EVALUATION_DIRECTORY")
	if _, err := os.Stat(filepath.Join(dir, "evaluation.marker")); err != nil {
		t.Fatal("helper requires synthetic evaluation directory")
	}
	s := testStore(t, os.Getenv("BF_STORAGE_EVALUATION_BACKEND"), dir, fixedKey)
	if err := s.WithLock(context.Background(), func(a *account, save saveAccount) error {
		switch os.Getenv("BF_STORAGE_EVALUATION_OPERATION") {
		case "increment":
			n, err := strconv.Atoi(a.Subject)
			if err != nil {
				return err
			}
			a.Subject = strconv.Itoa(n + 1)
			return save(context.Background(), a)
		case "checkpoint":
			a.Pending = &companion.Rotation{Credentials: *syntheticCredentials(123), IDToken: "synthetic-id", ReceivedAt: time.Now().UnixMilli()}
			if err := save(context.Background(), a); err != nil {
				return err
			}
		case "hold":
		default:
			return errors.New("unknown helper operation")
		}
		fmt.Println("evaluation-checkpoint-ready")
		time.Sleep(25 * time.Second)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestStoredPlaintextAbsent(t *testing.T) {
	for _, name := range backends() {
		t.Run(name, func(t *testing.T) {
			dir := testDirectory(t)
			seed(t, testStore(t, name, dir, fixedKey), 4096)
			if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
				if err != nil || entry.IsDir() {
					return err
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				if bytes.Contains(data, bytes.Repeat([]byte("s"), 256)) || bytes.Contains(data, []byte("synthetic-refresh")) {
					return errors.New("plaintext credential found")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestEnvelopeCompatibility(t *testing.T) {
	dir := testDirectory(t)
	seed(t, testStore(t, "file", dir, fixedKey), 64)
	data, err := os.ReadFile(filepath.Join(dir, "account.enc"))
	if err != nil {
		t.Fatal(err)
	}
	key, _ := fixedKey(context.Background(), false)
	plain, err := openEnvelope(key, data)
	if err != nil {
		t.Fatal(err)
	}
	var a account
	if json.Unmarshal(plain, &a) != nil || a.Credentials == nil {
		t.Fatal("reference envelope differs from production")
	}
	data, err = sealEnvelope(key, plain)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "account.enc"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err = testStore(t, "file", dir, fixedKey).WithLock(context.Background(), func(_ *account, _ saveAccount) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestOversizedSavePreservesAccount(t *testing.T) {
	for _, name := range backends() {
		t.Run(name, func(t *testing.T) {
			dir := testDirectory(t)
			s := testStore(t, name, dir, fixedKey)
			seed(t, s, 64)
			if err := s.WithLock(context.Background(), func(a *account, save saveAccount) error {
				a.Credentials = syntheticCredentials(3 * 1024 * 1024)
				return save(context.Background(), a)
			}); err == nil {
				t.Fatal("oversized record accepted")
			}
			if err := s.WithLock(context.Background(), func(a *account, save saveAccount) error {
				if a.Credentials == nil || len(a.Credentials.Access) != 64 {
					return errors.New("old account lost after failed save")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBoltUncommittedWriteRollsBack(t *testing.T) {
	dir := testDirectory(t)
	seed(t, testStore(t, "bolt", dir, fixedKey), 64)
	db, err := bolt.Open(filepath.Join(dir, "account.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := errors.New("simulated interrupted transaction")
	if err := db.Update(func(tx *bolt.Tx) error {
		if err := tx.Bucket([]byte("account")).Put([]byte("current"), []byte("incomplete ciphertext")); err != nil {
			return err
		}
		return interrupted
	}); !errors.Is(err, interrupted) {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := testStore(t, "bolt", dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
		if a.Credentials == nil || len(a.Credentials.Access) != 64 {
			return errors.New("uncommitted write replaced account")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCancelledCallerPreservesRefreshCheckpoint(t *testing.T) {
	for _, name := range backends() {
		t.Run(name, func(t *testing.T) {
			dir := testDirectory(t)
			s := testStore(t, name, dir, fixedKey)
			seed(t, s, 64)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if err := s.WithLock(ctx, func(a *account, save saveAccount) error {
				cancel()
				a.Pending = &companion.Rotation{Credentials: *syntheticCredentials(123), IDToken: "synthetic-id", ReceivedAt: time.Now().UnixMilli()}
				if err := save(context.WithoutCancel(ctx), a); err != nil {
					return err
				}
				return ctx.Err()
			}); !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
			if err := testStore(t, name, dir, fixedKey).WithLock(context.Background(), func(a *account, save saveAccount) error {
				if a.Pending == nil {
					return errors.New("cancellation lost successor")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
