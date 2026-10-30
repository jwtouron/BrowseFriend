package main

import (
	"context"
	"fmt"
	"os"

	"browsefriend/native-host/internal/companion"
	hostcontract "browsefriend/shared"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] != hostcontract.Contract.ExtensionOrigin {
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
	client := companion.NewConnection(&companion.Store{Directory: dir, Key: companion.OSKey}, func(s companion.Session) { _ = writer.Send(map[string]any{"event": "auth.changed", "payload": s}) })
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
