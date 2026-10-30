package main

import (
	"context"
	"fmt"
	"os"

	"browsefriend/nativehost/internal/companion"
)

func main() {
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
