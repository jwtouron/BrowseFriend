package main

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"

	"browsefriend/native-host/internal/companion"
	hostcontract "browsefriend/shared"
)

func nativeArguments(args []string, platform string) bool {
	if len(args) == 0 {
		return true
	}
	if args[0] != hostcontract.Contract.ExtensionOrigin {
		return false
	}
	if len(args) == 1 {
		return true
	}
	if platform != "windows" || len(args) != 2 || !strings.HasPrefix(args[1], "--parent-window=") {
		return false
	}
	value := strings.TrimPrefix(args[1], "--parent-window=")
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	_, err := strconv.ParseUint(value, 10, 64)
	return err == nil
}

func main() {
	if !nativeArguments(os.Args[1:], runtime.GOOS) {
		paths, err := companion.SystemPaths()
		if err == nil {
			dry := false
			for _, arg := range os.Args[2:] {
				if arg == "--dry-run" {
					dry = true
				} else {
					err = fmt.Errorf("unknown option")
				}
			}
			if err == nil {
				switch os.Args[1] {
				case "install":
					var executable string
					executable, err = os.Executable()
					if err == nil {
						err = companion.Install(paths, executable, dry, os.Stdout)
					}
				case "uninstall":
					err = companion.Uninstall(paths, dry, os.Stdout)
				default:
					err = fmt.Errorf("use install or uninstall, optionally with --dry-run")
				}
			}
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	dir, err := companion.DefaultDirectory()
	if err != nil {
		fmt.Fprintln(os.Stderr, "BrowseFriend Go host: unsupported platform.")
		os.Exit(1)
	}
	writer := &companion.Writer{Out: os.Stdout}
	client := companion.NewConnection(companion.NewStore(dir), func(s companion.Session) { _ = writer.Send(map[string]any{"event": "auth.changed", "payload": s}) })
	handler := companion.NewHandler(client, func(v any) {
		if writer.Send(v) != nil {
			os.Exit(1)
		}
	})
	if companion.Run(context.Background(), os.Stdin, handler) != nil {
		fmt.Fprintln(os.Stderr, "BrowseFriend Go host: input closed or invalid native frame.")
		os.Exit(1)
	}
}
