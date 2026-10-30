//go:build darwin || linux

package companion

import "os"

func configHome() (string, error)       { return os.Getenv("XDG_CONFIG_HOME"), nil }
func checkRegistration(HostPaths) error { return nil }
func registerHost(HostPaths) error      { return nil }
func unregisterHost(HostPaths) error    { return nil }
