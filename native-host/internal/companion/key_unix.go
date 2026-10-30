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

type keyring struct{ keychain, service string }

func platformKey(_ string) KeyProvider {
	return keyring{service: "com.browsefriend.native-host.credentials"}.key
}

func (location keyring) key(ctx context.Context, create bool) ([]byte, error) {
	var read *exec.Cmd
	secretTool := "/usr/bin/secret-tool"
	if runtime.GOOS == "darwin" {
		args := []string{"find-generic-password", "-a", "local-encryption-key", "-s", location.service, "-w"}
		if location.keychain != "" {
			args = append(args, location.keychain)
		}
		read = exec.CommandContext(ctx, "/usr/bin/security", args...)
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
		args := []string{"add-generic-password", "-a", "local-encryption-key", "-s", location.service, "-w", encoded}
		if location.keychain != "" {
			args = append(args, location.keychain)
		}
		write = exec.CommandContext(ctx, "/usr/bin/security", args...)
	} else {
		write = exec.CommandContext(ctx, secretTool, "store", "--label=BrowseFriend credentials", "application", "browsefriend", "key", "native-host-credentials")
		write.Stdin = strings.NewReader(encoded)
	}
	if err := write.Run(); err != nil {
		return nil, failure("storage_encryption_unavailable", "Could not save the credential key in the OS credential store.", true)
	}
	return key, nil
}
