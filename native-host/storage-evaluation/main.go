package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

func main() {
	backend := flag.String("backend", "file", "file, bolt, or an explicitly enabled candidate")
	iterations := flag.Int("iterations", 5, "fresh-open/read/write/close cycles")
	size := flag.Int("size", 4096, "synthetic access token size")
	flag.Parse()
	if *iterations < 1 || *iterations > 100 || *size < 1 || *size > 1024*1024 {
		fmt.Fprintln(os.Stderr, "invalid measurement bounds")
		os.Exit(2)
	}
	if err := measure(*backend, *iterations, *size); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func measure(backend string, iterations, size int) error {
	root, err := os.MkdirTemp("", "browsefriend-storage-evaluation-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(root)
	directory := filepath.Join(root, "account")
	key := func(ctx context.Context, _ bool) ([]byte, error) { return bytes.Repeat([]byte{0x42}, 32), ctx.Err() }
	store, err := newStore(backend, directory, key)
	if err != nil {
		return err
	}
	start := time.Now()
	var first, later time.Duration
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for i := 0; i <= iterations; i++ {
		before := time.Now()
		if err := store.WithLock(ctx, func(a *account, save saveAccount) error {
			if i > 0 && (a.Credentials == nil || len(a.Credentials.Access) != size) {
				return fmt.Errorf("measurement read failed")
			}
			a.ClientID, a.HostID = "synthetic-client", "synthetic-host"
			a.Credentials = syntheticCredentials(size)
			return save(ctx, a)
		}); err != nil {
			return err
		}
		if i == 0 {
			first = time.Since(before)
		} else {
			later += time.Since(before)
		}
	}
	var disk int64
	files := []string{}
	if err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			disk += info.Size()
			files = append(files, entry.Name())
		}
		return nil
	}); err != nil {
		return err
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	result := map[string]any{"backend": backend, "platform": runtime.GOOS + "/" + runtime.GOARCH, "iterations": iterations, "payload_bytes": size, "first_ms": float64(first.Microseconds()) / 1000, "cycle_ms": float64(later.Microseconds()) / float64(iterations) / 1000, "total_ms": float64(time.Since(start).Microseconds()) / 1000, "heap_alloc_bytes": memory.HeapAlloc, "heap_obtained_bytes": memory.HeapSys, "goroutines_after_close": runtime.NumGoroutine(), "disk_bytes": disk, "files": files}
	return json.NewEncoder(os.Stdout).Encode(result)
}
