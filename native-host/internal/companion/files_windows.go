package companion

import (
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

const fileAllAccess = 0x1f01ff

func currentSID() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return user.User.Sid, nil
}
func privateDescriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	sid, err := currentSID()
	if err != nil {
		return nil, err
	}
	return windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)")
}
func unsafeStorage() error {
	return failure("storage_unsafe", "Credential storage must be private, owned by your Windows account, and free of reparse points.", false)
}
func validateHandle(handle windows.Handle, directory bool) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
		return unsafeStorage()
	}
	sid, err := currentSID()
	if err != nil {
		return err
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil || !owner.Equals(sid) {
		return unsafeStorage()
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return unsafeStorage()
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return unsafeStorage()
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return err
	}
	userAccess := false
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return unsafeStorage()
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !principal.Equals(sid) && !principal.Equals(system) {
			return unsafeStorage()
		}
		if principal.Equals(sid) && uint32(ace.Mask)&fileAllAccess == fileAllAccess {
			userAccess = true
		}
	}
	if !userAccess {
		return unsafeStorage()
	}
	return nil
}
func setPrivateACL(handle windows.Handle) error {
	sd, err := privateDescriptor()
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}
func privateDirectory(path string) error {
	if err := createPrivateDirectory(path); err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(p, windows.READ_CONTROL|windows.WRITE_DAC|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return unsafeStorage()
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	sid, sidErr := currentSID()
	if err != nil || sidErr != nil || owner == nil || !owner.Equals(sid) {
		return unsafeStorage()
	}
	if validateHandle(handle, true) == nil {
		return nil
	}
	if err := setPrivateACL(handle); err != nil {
		return err
	}
	return validateHandle(handle, true)
}
func createPrivateDirectory(path string) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sd, err := privateDescriptor()
	if err != nil {
		return err
	}
	attributes := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	err = windows.CreateDirectory(p, attributes)
	if errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		parent := filepath.Dir(path)
		if parent == path {
			return err
		}
		if err := createPrivateDirectory(parent); err != nil {
			return err
		}
		err = windows.CreateDirectory(p, attributes)
	}
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil
	}
	return err
}
func privateFile(path string, flags int) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	sd, err := privateDescriptor()
	if err != nil {
		return nil, err
	}
	attributes := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	access := uint32(windows.GENERIC_READ | windows.READ_CONTROL)
	if flags&os.O_RDWR != 0 {
		access |= windows.GENERIC_WRITE
	}
	disposition := uint32(windows.OPEN_EXISTING)
	if flags&os.O_CREATE != 0 {
		disposition = windows.OPEN_ALWAYS
	}
	handle, err := windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, attributes, disposition, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	if err := validateHandle(handle, false); err != nil {
		windows.CloseHandle(handle)
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}
func secureFile(f *os.File, _ os.FileMode) error {
	if validateHandle(windows.Handle(f.Fd()), false) == nil {
		return nil
	}
	if err := setPrivateACL(windows.Handle(f.Fd())); err != nil {
		return err
	}
	return validateHandle(windows.Handle(f.Fd()), false)
}
func privateTemp(directory string) (*os.File, error) {
	sd, err := privateDescriptor()
	if err != nil {
		return nil, err
	}
	attributes := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	for attempt := 0; attempt < 100; attempt++ {
		path := filepath.Join(directory, ".browsefriend-"+rand.Text())
		p, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return nil, err
		}
		handle, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.WRITE_DAC, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, attributes, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if errors.Is(err, windows.ERROR_FILE_EXISTS) || errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return os.NewFile(uintptr(handle), path), nil
	}
	return nil, failure("storage_busy", "Could not create a private temporary file.", true)
}
func tryLock(f *os.File) (bool, error) {
	err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}
func unlockFile(f *os.File) {
	windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &windows.Overlapped{})
}
func fileOperationError(err error) error {
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return failure("host_in_use", "Close BrowseFriend (or Chrome) and retry. Windows could not replace or remove the companion; check file permissions if the problem continues.", true)
	}
	return err
}
func replaceFile(from, to string) error {
	source, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return fileOperationError(windows.MoveFileEx(source, target, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH))
}
func removeBinary(path string) error { return fileOperationError(os.Remove(path)) }
