package companion

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testInstallation(t *testing.T) HostPaths {
	t.Helper()
	paths := testPaths(t)
	source := filepath.Join(t.TempDir(), "synthetic-host")
	if err := os.WriteFile(source, []byte("synthetic-executable"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := Install(paths, source, false, io.Discard); err != nil {
		t.Fatal(err)
	}
	return paths
}

func TestUninstallInvalidatesUnfinishedFirstSignIn(t *testing.T) {
	f := newFixture(t)
	paths := testInstallation(t)
	f.c.Store = NewStore(paths.Data)
	transport := f.c.HTTP.Transport
	removed := false
	f.c.HTTP.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(r)
		if err == nil && r.URL.Path == "/token" {
			if err := Uninstall(paths, false, io.Discard); err != nil {
				t.Error(err)
			} else {
				removed = true
			}
		}
		return response, err
	})
	_, err := f.c.SignIn(context.Background(), false)
	if !removed {
		t.Fatal("uninstall did not run")
	}
	if _, fileErr := os.Stat(filepath.Join(paths.Data, credentialFile)); err == nil || !os.IsNotExist(fileErr) {
		t.Fatal("unfinished first sign-in survived uninstall")
	}
}

type crashReader struct{ emitted bool }

func (r *crashReader) Read(p []byte) (int, error) {
	if r.emitted {
		os.Exit(0)
	}
	r.emitted = true
	return copy(p, []byte(`{"refresh_token":"synthetic-crash-secret"}`)), nil
}
func TestLifecycleCrashWriterHelper(t *testing.T) {
	dir := os.Getenv("BROWSEFRIEND_TEST_CRASH_DIRECTORY")
	if dir == "" {
		return
	}
	store := NewStore(dir)
	if err := store.withDiskLock(context.Background(), func() error { return atomicFile(filepath.Join(dir, credentialFile), &crashReader{}, 0600) }); err != nil {
		t.Fatal(err)
	}
}
func TestUninstallRemovesCrashTemporaryCredentials(t *testing.T) {
	paths := testInstallation(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestLifecycleCrashWriterHelper$")
	cmd.Env = append(os.Environ(), "BROWSEFRIEND_TEST_CRASH_DIRECTORY="+paths.Data)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("helper failed: %v %s", err, output)
	}
	if err := Uninstall(paths, false, io.Discard); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(paths.Data)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".browsefriend-") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(paths.Data, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "synthetic-crash-secret") {
			t.Fatal("uninstall left crash credentials")
		}
	}
}

func TestExternalLogoutInvalidatesNativeContext(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	h := NewHandler(f.c, func(any) {})
	defer h.Close()
	f.c.Changed = h.AuthChanged
	h.actTask = &actConversation{id: "unfinished-task"}
	h.transcript = &transcriptContext{handle: "checkpoint", content: "synthetic"}
	other := reconnect(f)
	if _, err := other.SignOut(context.Background()); err != nil {
		t.Fatal(err)
	}
	status, err := f.c.Status(context.Background())
	if err != nil || status.State != "signed_out" {
		t.Fatal("logout not visible", err)
	}
	if h.actTask != nil || h.transcript != nil {
		t.Fatal("external logout retained native context")
	}
}

func TestExternalLoginRejectsPreviousActContinuation(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	replies := make(chan object, 20)
	h := NewHandler(f.c, func(value any) { replies <- value.(object) })
	defer h.Close()
	f.c.Changed = h.AuthChanged
	p := contextParams()
	o, valid := options(p, false)
	if !valid {
		t.Fatal("invalid fixture")
	}
	task, err := h.prepareAct(Request{ID: "task", Method: "model.stream", Params: p}, &o)
	if err != nil {
		t.Fatal(err)
	}
	task.pending = object{"callId": "one", "name": "page_click", "arguments": `{"ref":"e1"}`}
	other := reconnect(f)
	if _, err := other.SignOut(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := other.SignIn(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	h.Dispatch(context.Background(), Request{ID: "task", Method: "model.stream", Params: continueParams("one")})
	for {
		reply := <-replies
		if reply["id"] == "task" {
			if reply["ok"] == true {
				t.Fatal("external login reused previous Act context")
			}
			break
		}
	}
}

func TestPendingRefreshOwnsAccountUntilRecovered(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission fault")
	}
	f := newFixture(t)
	f.login(t)
	expire(t, f)
	transport := f.c.HTTP.Transport
	f.c.HTTP.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(r)
		if r.URL.Path == "/token" && err == nil {
			if err := os.Chmod(f.c.Store.Directory, 0500); err != nil {
				t.Error(err)
			}
		}
		return response, err
	})
	t.Cleanup(func() { os.Chmod(f.c.Store.Directory, 0700) })
	if _, err := f.c.Models(context.Background()); publicError(err).Code != "storage_unavailable" {
		t.Fatal("fault not injected", err)
	}
	os.Chmod(f.c.Store.Directory, 0700)
	f.c.HTTP.Transport = transport
	other := reconnect(f)
	defer other.Close()
	wait, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
	defer cancel()
	if _, err := other.Models(wait); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("other process could replay spent grant", err)
	}
	f.mu.Lock()
	refreshes := f.refreshes
	f.mu.Unlock()
	if refreshes != 1 {
		t.Fatal("spent grant replayed")
	}
	if _, err := f.c.Models(context.Background()); err != nil {
		t.Fatal("successor not recovered", err)
	}
	if _, err := other.Models(context.Background()); err != nil {
		t.Fatal("lock not released", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 1 {
		t.Fatal("recovery repeated refresh")
	}
}

func TestAuthenticationCleanupSweepsAbandonedFiles(t *testing.T) {
	for _, operation := range []string{"logout", "reset", "startup"} {
		t.Run(operation, func(t *testing.T) {
			f := newFixture(t)
			f.login(t)
			path := filepath.Join(f.c.Store.Directory, ".browsefriend-abandoned")
			file, err := privateFile(path, os.O_CREATE|os.O_WRONLY)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.Write([]byte("synthetic-crash-secret")); err != nil {
				t.Fatal(err)
			}
			file.Close()
			switch operation {
			case "logout":
				_, err = f.c.SignOut(context.Background())
			case "reset":
				_, err = f.c.ResetLogin(context.Background())
			default:
				_, err = f.c.Status(context.Background())
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("abandoned credentials retained", err)
			}
		})
	}
}

func TestReinstallCannotCommitPreviousSignIn(t *testing.T) {
	f := newFixture(t)
	paths := testInstallation(t)
	f.c.Store = NewStore(paths.Data)
	defer f.c.Close()
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("synthetic-host"), 0700); err != nil {
		t.Fatal(err)
	}
	transport := f.c.HTTP.Transport
	changed := false
	f.c.HTTP.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		response, err := transport.RoundTrip(r)
		if r.URL.Path == "/token" && err == nil && !changed {
			changed = true
			if err := Uninstall(paths, false, io.Discard); err != nil {
				t.Error(err)
			}
			if _, err := f.c.ResetLogin(context.Background()); publicError(err).Code != "companion_unavailable" {
				t.Error("reset reenabled uninstalled host", err)
			}
			if err := Install(paths, source, false, io.Discard); err != nil {
				t.Error(err)
			}
		}
		return response, err
	})
	if _, err := f.c.SignIn(context.Background(), false); publicError(err).Code != "connection_changed" {
		t.Fatal("old sign-in survived reinstall", err)
	}
	f.c.HTTP.Transport = transport
	f.login(t)
}

func TestCompletedRequestsRejectExternalLoginEvenAfterStatusObservedIt(t *testing.T) {
	for _, path := range []string{"/v1/responses", "/v1/models"} {
		t.Run(path, func(t *testing.T) {
			f := newFixture(t)
			f.login(t)
			other := reconnect(f)
			defer other.Close()
			transport := f.c.HTTP.Transport
			f.c.HTTP.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
				response, err := transport.RoundTrip(r)
				if r.URL.Path == path && err == nil {
					if _, err := other.SignOut(context.Background()); err != nil {
						t.Error(err)
					}
					if _, err := other.SignIn(context.Background(), false); err != nil {
						t.Error(err)
					}
					if _, err := f.c.Status(context.Background()); err != nil {
						t.Error(err)
					}
				}
				return response, err
			})
			var err error
			if path == "/v1/responses" {
				_, err = f.c.Stream(context.Background(), ModelOptions{Model: "model-1"}, func(string) {})
			} else {
				_, err = f.c.Models(context.Background())
			}
			if publicError(err).Code != "connection_changed" {
				t.Fatal("old request accepted after external login", err)
			}
		})
	}
}
