//go:build darwin || linux

package companion

import (
	"context"
	"os/exec"
	"runtime"
)

func openBrowser(ctx context.Context, u string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "/usr/bin/open"
	}
	if exec.CommandContext(ctx, command, u).Run() != nil {
		return failure("browser_unavailable", "The browser could not be opened. Check your default browser and try again.", false)
	}
	return nil
}
