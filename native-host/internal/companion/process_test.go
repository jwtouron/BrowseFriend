package companion

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
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
	store := &Store{Directory: os.Getenv("BROWSEFRIEND_TEST_DIRECTORY"), Key: func(context.Context, bool) ([]byte, error) { return bytes.Repeat([]byte{7}, 32), nil }}
	if mode == "read-protected" {
		store = NewStore(store.Directory)
	}
	switch mode {
	case "read", "read-protected":
		if err := store.WithLock(context.Background(), func(a *Account) error {
			if a.ClientID != "test-client" || a.HostID == "" {
				t.Fatal("account missing")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	case "hold":
		if err := store.WithLock(context.Background(), func(*Account) error {
			os.Stdout.WriteString("locked\n")
			var b [1]byte
			_, err := os.Stdin.Read(b[:])
			return err
		}); err != nil {
			t.Fatal(err)
		}
	case "models":
		c := NewConnection(store, nil)
		c.issuer = os.Getenv("BROWSEFRIEND_TEST_ISSUER")
		c.api = c.issuer + "/v1"
		pool := x509.NewCertPool()
		data, err := os.ReadFile(os.Getenv("BROWSEFRIEND_TEST_CA"))
		if err != nil {
			t.Fatal(err)
		}
		if !pool.AppendCertsFromPEM(data) {
			t.Fatal("invalid test certificate")
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		c.HTTP = &http.Client{Transport: transport}
		if _, err := c.Models(context.Background()); err != nil {
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
func TestPersistenceAndLockAcrossProcesses(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	if output, err := helper(t, f.c.Store, "read").CombinedOutput(); err != nil {
		t.Fatalf("restart: %v %s", err, output)
	}
	cmd := helper(t, f.c.Store, "hold")
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
	line, err := bufio.NewReader(output).ReadString('\n')
	if err != nil || line != "locked\n" {
		t.Fatal(line, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := f.c.Store.WithLock(ctx, func(*Account) error { t.Fatal("process lock bypassed"); return nil }); err != context.DeadlineExceeded {
		t.Fatal(err)
	}
	input.Write([]byte{1})
	input.Close()
	io.Copy(io.Discard, output)
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := f.c.Store.WithLock(context.Background(), func(*Account) error { return nil }); err != nil {
		t.Fatal(err)
	}
}
func TestRefreshSerializedAcrossProcesses(t *testing.T) {
	f := newFixture(t)
	f.login(t)
	if err := f.c.Store.WithLock(context.Background(), func(a *Account) error {
		a.Credentials.ExpiresAt = time.Now().Add(-time.Hour).UnixMilli()
		return f.c.Store.Save(context.Background(), a)
	}); err != nil {
		t.Fatal(err)
	}
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	extra := []string{"BROWSEFRIEND_TEST_ISSUER=" + f.server.URL, "BROWSEFRIEND_TEST_CA=" + ca}
	first, second := helper(t, f.c.Store, "models", extra...), helper(t, f.c.Store, "models", extra...)
	var one, two bytes.Buffer
	first.Stdout = &one
	first.Stderr = &one
	second.Stdout = &two
	second.Stderr = &two
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	if err := first.Wait(); err != nil {
		t.Fatal(err, one.String())
	}
	if err := second.Wait(); err != nil {
		t.Fatal(err, two.String())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 1 || f.apiCalls != 2 {
		t.Fatal("refresh grant replayed", f.refreshes, f.apiCalls)
	}
}
func TestOSKeyLinuxSecretService(t *testing.T) {
	if runtime.GOOS != "linux" || os.Getenv("BROWSEFRIEND_TEST_SECRET_SERVICE") != "1" {
		t.Skip("requires isolated D-Bus/Secret Service session")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	key := platformKey(t.TempDir())
	first, err := key(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := key(ctx, false)
	if err != nil || !bytes.Equal(first, second) {
		t.Fatal("key did not persist", err)
	}
	third, err := key(ctx, true)
	if err != nil || !bytes.Equal(first, third) {
		t.Fatal("key overwritten", err)
	}
	cmd := exec.CommandContext(ctx, "/usr/bin/secret-tool", "clear", "application", "browsefriend", "key", "native-host-credentials")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	if _, err := key(ctx, false); err == nil {
		t.Fatal("missing key accepted")
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
