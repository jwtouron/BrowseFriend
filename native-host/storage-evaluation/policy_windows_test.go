package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func inspectWindowsPath(path string) (permissions, error) {
	p := permissions{}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return p, err
	}
	p.user = user.User.Sid.String()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return p, err
	}
	h, err := windows.CreateFile(name, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return p, err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &info); err != nil {
		return p, err
	}
	p.reparse = info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return p, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return p, err
	}
	if owner != nil {
		p.owner = owner.String()
	}
	control, _, err := sd.Control()
	if err != nil {
		return p, err
	}
	p.protected = control&windows.SE_DACL_PROTECTED != 0
	acl, _, err := sd.DACL()
	if err != nil {
		return p, err
	}
	p.hasACL = acl != nil
	if acl != nil {
		for i := uint32(0); i < uint32(acl.AceCount); i++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err = windows.GetAce(acl, i, &ace); err != nil {
				return p, err
			}
			entry := permissionEntry{mask: uint32(ace.Mask), allow: ace.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE, deny: ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE}
			if entry.allow || entry.deny {
				entry.principal = (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
			}
			p.entries = append(p.entries, entry)
		}
	}
	return p, nil
}

func TestNativeWindowsPermissions(t *testing.T) {
	if os.Getenv("BROWSEFRIEND_TEST_WINE") != "" {
		t.Skip("Wine does not establish native Windows ACL/reparse behavior")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	for _, tc := range []struct {
		name, acl      string
		strict, simple bool
	}{
		{"protected", "D:P(A;;FA;;;" + sid + ")(A;;FA;;;SY)", true, true},
		{"inherited", "D:AI(A;ID;FA;;;" + sid + ")(A;ID;FA;;;SY)(A;ID;FA;;;BA)", false, true},
		{"shared", "D:P(A;;FA;;;" + sid + ")(A;;FA;;;SY)(A;;FR;;;WD)", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := t.TempDir()
			parentSD, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
			if err != nil {
				t.Fatal(err)
			}
			parentACL, _, err := parentSD.DACL()
			if err != nil {
				t.Fatal(err)
			}
			if err := windows.SetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, parentACL, nil); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(parent, "synthetic.enc")
			if err := os.WriteFile(path, []byte("synthetic ciphertext"), 0600); err != nil {
				t.Fatal(err)
			}
			sd, err := windows.SecurityDescriptorFromString(tc.acl)
			if err != nil {
				t.Fatal(err)
			}
			acl, _, err := sd.DACL()
			if err != nil {
				t.Fatal(err)
			}
			flags := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION | windows.OWNER_SECURITY_INFORMATION)
			if tc.name == "inherited" {
				flags = windows.DACL_SECURITY_INFORMATION | windows.UNPROTECTED_DACL_SECURITY_INFORMATION | windows.OWNER_SECURITY_INFORMATION
			}
			if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, flags, user.User.Sid, nil, acl, nil); err != nil {
				t.Fatal(err)
			}
			p, err := inspectWindowsPath(path)
			if err != nil {
				t.Fatal(err)
			}
			if acceptsPermissions(p, true) != tc.strict || acceptsPermissions(p, false) != tc.simple {
				t.Fatalf("unexpected real ACL decisions: protected=%v", p.protected)
			}
		})
	}
	t.Run("junction", func(t *testing.T) {
		root := t.TempDir()
		target, alias := filepath.Join(root, "target"), filepath.Join(root, "alias")
		if err := os.Mkdir(target, 0700); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", alias, target).CombinedOutput(); err != nil {
			t.Fatalf("junction fixture: %v %s", err, out)
		}
		p, err := inspectWindowsPath(alias)
		if err != nil {
			t.Fatal(err)
		}
		if !p.reparse || acceptsPermissions(p, false) {
			t.Fatal("junction accepted")
		}
	})
}
