//go:build darwin || linux

package companion

import (
	"runtime"
	"testing"
)

func testPaths(t *testing.T) HostPaths {
	t.Helper()
	paths, err := Paths(runtime.GOOS, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	return paths
}
