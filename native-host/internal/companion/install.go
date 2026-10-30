package companion

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	hostcontract "browsefriend/shared"
)

type HostPaths struct{ Data, Manifest, Binary string }

func Paths(platform, home, config string) (HostPaths, error) {
	var data, manifest string
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
	default:
		return HostPaths{}, failure("unsupported_platform", "BrowseFriend supports macOS and Linux.", false)
	}
	return HostPaths{Data: data, Manifest: filepath.Join(manifest, hostcontract.Contract.HostName+".json"), Binary: filepath.Join(data, "browsefriend-native-host")}, nil
}
func SystemPaths() (HostPaths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return HostPaths{}, err
	}
	return Paths(runtime.GOOS, home, os.Getenv("XDG_CONFIG_HOME"))
}
func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return failure("storage_unsafe", "Use a private directory, not a symbolic link.", false)
	}
	return os.Chmod(path, 0700)
}
func atomicFile(path string, source io.Reader, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return failure("storage_unsafe", "Refusing to replace a non-regular file.", false)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".browsefriend-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err = temp.Chmod(mode); err == nil {
		_, err = io.Copy(temp, source)
	}
	if err == nil {
		err = temp.Sync()
	}
	closed := temp.Close()
	if err != nil {
		return err
	}
	if closed != nil {
		return closed
	}
	if err = os.Rename(temp.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func Install(paths HostPaths, source string, dry bool, out io.Writer) error {
	fmt.Fprintf(out, "BrowseFriend native companion\nBinary: %s\nChrome manifest: %s\n", paths.Binary, paths.Manifest)
	if dry {
		return nil
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
	return atomicFile(paths.Manifest, bytes.NewReader(append(data, '\n')), 0600)
}
func Uninstall(paths HostPaths, dry bool, out io.Writer) error {
	fmt.Fprintf(out, "Remove BrowseFriend registration: %s\nSaved account data is preserved.\n", paths.Manifest)
	if dry {
		return nil
	}
	data, err := os.ReadFile(paths.Manifest)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var manifest object
	if json.Unmarshal(data, &manifest) != nil || manifest["name"] != hostcontract.Contract.HostName || manifest["path"] != paths.Binary {
		return failure("registration_conflict", "The Chrome registration belongs to another installation. It has been preserved.", false)
	}
	if err := os.Remove(paths.Manifest); err != nil {
		return err
	}
	if err := os.Remove(paths.Binary); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
