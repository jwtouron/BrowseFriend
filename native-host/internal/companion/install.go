package companion

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	hostcontract "browsefriend/shared"
)

type HostPaths struct{ Data, Manifest, Binary, RegistryKey string }

func Paths(platform, home, config string) (HostPaths, error) {
	var data, manifest, registryKey string
	binary := "browsefriend-native-host"
	switch platform {
	case "darwin":
		data = filepath.Join(home, "Library", "Application Support", "BrowseFriend", "native-host")
		manifest = filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
	case "linux":
		if config == "" {
			config = filepath.Join(home, ".config")
		}
		data = filepath.Join(config, "browsefriend", "native-host")
		manifest = filepath.Join(config, "google-chrome", "NativeMessagingHosts")
	case "windows":
		if config == "" {
			config = filepath.Join(home, "AppData", "Local")
		}
		data = filepath.Join(config, "BrowseFriend", "native-host")
		manifest = data
		binary += ".exe"
		registryKey = `Software\Google\Chrome\NativeMessagingHosts\` + hostcontract.Contract.HostName
	default:
		return HostPaths{}, failure("unsupported_platform", "BrowseFriend supports macOS, Linux, and Windows.", false)
	}
	return HostPaths{Data: data, Manifest: filepath.Join(manifest, hostcontract.Contract.HostName+".json"), Binary: filepath.Join(data, binary), RegistryKey: registryKey}, nil
}
func SystemPaths() (HostPaths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return HostPaths{}, err
	}
	config, err := configHome()
	if err != nil {
		return HostPaths{}, err
	}
	return Paths(runtime.GOOS, home, config)
}
func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return a == b
}
func registrationConflict() error {
	return failure("registration_conflict", "The Chrome registration belongs to another installation. It has been preserved.", false)
}
func Install(paths HostPaths, source string, dry bool, out io.Writer) error {
	fmt.Fprintf(out, "BrowseFriend native companion\nBinary: %s\nChrome manifest: %s\n", paths.Binary, paths.Manifest)
	if paths.RegistryKey != "" {
		fmt.Fprintf(out, "Registry: HKCU\\%s\n", paths.RegistryKey)
	}
	if dry {
		return nil
	}
	if err := checkRegistration(paths); err != nil {
		return err
	}
	if err := privateDirectory(paths.Data); err != nil {
		return err
	}
	if err := privateDirectory(filepath.Dir(paths.Manifest)); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return failure("install_failed", "The companion binary is not a regular file.", false)
	}
	if err := atomicFile(paths.Binary, input, 0700); err != nil {
		return err
	}
	manifest := object{"name": hostcontract.Contract.HostName, "description": "BrowseFriend secure ChatGPT sign-in companion", "path": paths.Binary, "type": "stdio", "allowed_origins": []string{hostcontract.Contract.ExtensionOrigin}}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	if err = atomicFile(paths.Manifest, bytes.NewReader(append(data, '\n')), 0600); err != nil {
		return err
	}
	return registerHost(paths)
}
func Uninstall(paths HostPaths, dry bool, out io.Writer) error {
	fmt.Fprintf(out, "Remove BrowseFriend registration: %s\nSaved login credentials will be removed; non-secret registration data is preserved.\n", paths.Manifest)
	if dry {
		return nil
	}
	if err := checkRegistration(paths); err != nil {
		return err
	}
	if _, err := os.Stat(paths.Data); os.IsNotExist(err) {
		return unregisterHost(paths)
	}
	store := NewStore(paths.Data)
	return store.withDiskLock(context.Background(), func() error { return uninstallLocked(paths, store) })
}
func uninstallLocked(paths HostPaths, store *Store) error {
	if err := store.validateCredentialFile(); err != nil {
		return err
	}
	data, err := os.ReadFile(paths.Manifest)
	if os.IsNotExist(err) {
		if err := store.removeCredentials(); err != nil {
			return err
		}
		return unregisterHost(paths)
	}
	if err != nil {
		return err
	}
	var manifest object
	if json.Unmarshal(data, &manifest) != nil || manifest["name"] != hostcontract.Contract.HostName || !samePath(text(manifest["path"]), paths.Binary) {
		return registrationConflict()
	}
	if err := removeBinary(paths.Binary); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := store.removeCredentials(); err != nil {
		return err
	}
	if err := unregisterHost(paths); err != nil {
		return err
	}
	return os.Remove(paths.Manifest)
}
