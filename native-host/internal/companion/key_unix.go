//go:build darwin || linux

package companion

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func platformKey(_ string) KeyProvider { return osKey }

func osKey(ctx context.Context, create bool) ([]byte, error) {
	var read *exec.Cmd
	secretTool := "/usr/bin/secret-tool"
	if runtime.GOOS == "darwin" {
		read = exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-a", "local-encryption-key", "-s", "com.browsefriend.native-host.credentials", "-w")
	} else if runtime.GOOS == "linux" {
		if _, err := os.Stat(secretTool); err != nil {
			secretTool = "/usr/local/bin/secret-tool"
		}
		read = exec.CommandContext(ctx, secretTool, "lookup", "application", "browsefriend", "key", "native-host-credentials")
	} else {
		return nil, failure("storage_encryption_unavailable", "Secure credential storage is unavailable.", true)
	}
	data, err := read.Output()
	if err == nil && len(strings.TrimSpace(string(data))) > 0 {
		key, e := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if e == nil && len(key) == 32 {
			return key, nil
		}
		return nil, failure("storage_encryption_unavailable", "The credential key is invalid. Saved credentials have been preserved.", true)
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
		write = exec.CommandContext(ctx, "/usr/bin/security", "add-generic-password", "-a", "local-encryption-key", "-s", "com.browsefriend.native-host.credentials", "-w", encoded)
	} else {
		write = exec.CommandContext(ctx, secretTool, "store", "--label=BrowseFriend credentials", "application", "browsefriend", "key", "native-host-credentials")
		write.Stdin = strings.NewReader(encoded)
	}
	if err := write.Run(); err != nil {
		return nil, failure("storage_encryption_unavailable", "Could not save the credential key in the OS credential store.", true)
	}
	return key, nil
}
