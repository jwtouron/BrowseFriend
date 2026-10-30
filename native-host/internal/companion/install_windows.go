package companion

import (
	"errors"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func configHome() (string, error) { return windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0) }
func checkRegistration(paths HostPaths) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, paths.RegistryKey, registry.QUERY_VALUE|registry.WOW64_32KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer key.Close()
	value, _, err := key.GetStringValue("")
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil || !samePath(value, paths.Manifest) {
		return registrationConflict()
	}
	return nil
}
func registerHost(paths HostPaths) error {
	if err := checkRegistration(paths); err != nil {
		return err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, paths.RegistryKey, registry.SET_VALUE|registry.WOW64_32KEY)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue("", paths.Manifest)
}
func unregisterHost(paths HostPaths) error {
	if err := checkRegistration(paths); err != nil {
		return err
	}
	// Use the same registry view used for registration.
	const access = registry.QUERY_VALUE | registry.SET_VALUE | registry.WOW64_32KEY
	key, err := registry.OpenKey(registry.CURRENT_USER, paths.RegistryKey, access)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer key.Close()
	// Remove only our value. Other values/subkeys belong to their creators.
	if err = key.DeleteValue(""); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}
