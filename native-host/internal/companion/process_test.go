package companion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func productionBinary(t *testing.T) string {
	t.Helper()
	path := os.Getenv("BROWSEFRIEND_TEST_BINARY")
	if path == "" {
		t.Skip("run native build --test to exercise the compiled artifact")
	}
	return path
}
func TestProductionBinaryWireWithoutLanguageRuntime(t *testing.T) {
	checkProductionBinary(t, productionBinary(t))
}
func TestInstalledProductionBinary(t *testing.T) {
	source := productionBinary(t)
	paths := testPaths(t)
	t.Cleanup(func() {
		if err := Uninstall(paths, false, io.Discard); err != nil {
			t.Error(err)
		}
	})
	if err := Install(paths, source, false, io.Discard); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(paths.Data, "account.enc")
	if err := os.WriteFile(marker, []byte("synthetic-preserved-account"), 0600); err != nil {
		t.Fatal(err)
	}
	checkProductionBinary(t, paths.Binary)
	if err := Uninstall(paths, false, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.Binary); !os.IsNotExist(err) {
		t.Fatal("installed binary remains")
	}
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != "synthetic-preserved-account" {
		t.Fatal("account data changed", err)
	}
}
func checkProductionBinary(t *testing.T, path string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	args := []string{contract.ExtensionOrigin}
	if runtime.GOOS == "windows" {
		args = append(args, "--parent-window=0")
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), "PATH=")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { input.Close(); cmd.Process.Kill() }()
	body := []byte("not-json")
	header := make([]byte, 4)
	binary.NativeEndian.PutUint32(header, uint32(len(body)))
	input.Write(append(header, body...))
	var framed bytes.Buffer
	writer := Writer{Out: &framed}
	requestID := "artifact\n雪🧭"
	request := object{"id": requestID, "method": "auth.readTokens", "padding": ""}
	unpadded, _ := json.Marshal(request)
	// 266 has a literal 0x0A in its frame header, detecting Windows text-mode I/O.
	request["padding"] = strings.Repeat("x", 266-len(unpadded))
	if err := writer.Send(request); err != nil {
		t.Fatal(err)
	}
	data := framed.Bytes()
	input.Write(data[:2])
	input.Write(data[2:9])
	input.Write(data[9:])
	if _, err = io.ReadFull(output, header); err != nil {
		t.Fatal(err)
	}
	size := binary.NativeEndian.Uint32(header)
	if size > maxMessage {
		t.Fatal("invalid native framing")
	}
	payload := make([]byte, size)
	if _, err = io.ReadFull(output, payload); err != nil {
		t.Fatal(err)
	}
	var reply object
	if err = json.Unmarshal(payload, &reply); err != nil {
		t.Fatal(err)
	}
	if reply["id"] != requestID || reply["ok"] != false || reply["error"].(map[string]any)["code"] != "invalid_request" {
		t.Fatal(reply)
	}
	input.Close()
	if err = cmd.Wait(); err != nil || stderr.Len() != 0 {
		t.Fatal(err, stderr.String())
	}
}

// Helpers run only inside the Go test executable, never in the shipped binary.
func TestProcessHelper(t *testing.T) {
	mode := os.Getenv("BROWSEFRIEND_TEST_HELPER")
	if mode == "" {
		return
	}
	store := NewStore(os.Getenv("BROWSEFRIEND_TEST_DIRECTORY"))
	switch mode {
	case "read-registration":
		if err := store.WithLock(context.Background(), func(a *Account) error {
			if a.ClientID != "test-client" || a.HostID == "" || a.Subject == "" || a.Credentials != nil || a.IDToken != "" || a.Pending != nil || a.Identity != nil || len(a.Scopes) != 0 {
				t.Fatal("authentication crossed a process restart")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	case "hold-registration":
		if err := store.withRegistration(context.Background(), func(*Registration) error {
			os.Stdout.WriteString("locked\n")
			var b [1]byte
			_, err := os.Stdin.Read(b[:])
			return err
		}); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("unknown helper")
	}
}
func helper(t *testing.T, store *Store, mode string, extra ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessHelper$")
	cmd.Env = append(os.Environ(), "BROWSEFRIEND_TEST_HELPER="+mode, "BROWSEFRIEND_TEST_DIRECTORY="+store.Directory)
	cmd.Env = append(cmd.Env, extra...)
	return cmd
}
func TestProcessRestartKeepsRegistrationButNotAuthentication(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	if output, err := helper(t, f.c.Store, "read-registration").CombinedOutput(); err != nil {
		t.Fatalf("restart: %v %s", err, output)
	}
	cmd := helper(t, f.c.Store, "hold-registration")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { input.Close(); cmd.Process.Kill() })
	if line, err := bufio.NewReader(output).ReadString('\n'); err != nil || line != "locked\n" {
		t.Fatal(line, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := f.c.Store.withRegistration(ctx, func(*Registration) error { t.Error("process lock bypassed"); return nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	// A blocked registration writer does not lock existing process-local credentials.
	if s, err := f.c.Status(context.Background()); err != nil || s.State != "signed_in" {
		t.Fatal(s, err)
	}
	input.Write([]byte{1})
	input.Close()
	io.Copy(io.Discard, output)
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
}
func FuzzCompactedContext(f *testing.F) {
	for _, seed := range []string{"", "null", "[]", "[null]", "[1]", "[{\"type\":\"compaction\",\"encrypted_content\":\"opaque\"}]"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		items, ok := compacted(input)
		if ok && len(items) == 0 {
			t.Fatal("invalid canonical output accepted")
		}
	})
}
func FuzzSSE(f *testing.F) {
	f.Add("data: {}\n\n")
	f.Add("data: {\"type\":\"response.completed\"}\n\n")
	f.Fuzz(func(t *testing.T, input string) {
		if len(input) > 2*1024*1024 {
			return
		}
		consumeSSE(context.Background(), strings.NewReader(input), func(string) {}, "test")
	})
}
