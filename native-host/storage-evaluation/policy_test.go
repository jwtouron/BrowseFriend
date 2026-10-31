package main

import "testing"

func TestWindowsPolicyComparison(t *testing.T) {
	const user = "S-1-5-21-111-222-333-1001"
	private := []permissionEntry{{user, true, false, 0x1f01ff}, {"S-1-5-18", true, false, 0x1f01ff}}
	for _, tc := range []struct {
		name               string
		change             func(*permissions)
		strict, simplified bool
	}{
		{"protected owner and SYSTEM", func(*permissions) {}, true, true},
		{"safe inherited ACL", func(p *permissions) { p.protected = false }, false, true},
		{"owner read write delete without ACL administration", func(p *permissions) { p.entries[0].mask = 0x13019f }, false, true},
		{"owner read only", func(p *permissions) { p.entries[0].mask = 1 }, false, false},
		{"normal Administrators entry", func(p *permissions) {
			p.entries = append(p.entries, permissionEntry{"S-1-5-32-544", true, false, 0x1f01ff})
		}, false, true},
		{"restrictive deny entry", func(p *permissions) { p.entries = append(p.entries, permissionEntry{"S-1-1-0", false, true, 2}) }, false, true},
		{"Everyone read", func(p *permissions) { p.entries = append(p.entries, permissionEntry{"S-1-1-0", true, false, 1}) }, false, false},
		{"Users write", func(p *permissions) { p.entries = append(p.entries, permissionEntry{"S-1-5-32-545", true, false, 2}) }, false, false},
		{"different owner", func(p *permissions) { p.owner = "S-1-5-18" }, false, false},
		{"junction or linked file", func(p *permissions) { p.reparse = true }, false, false},
		{"null DACL", func(p *permissions) { p.hasACL = false }, false, false},
		{"empty DACL", func(p *permissions) { p.entries = nil }, false, false},
		{"conditional ACE", func(p *permissions) { p.entries = append(p.entries, permissionEntry{user, false, false, 1}) }, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := permissions{owner: user, user: user, protected: true, hasACL: true, entries: append([]permissionEntry(nil), private...)}
			tc.change(&p)
			if acceptsPermissions(p, true) != tc.strict || acceptsPermissions(p, false) != tc.simplified {
				t.Fatal("unexpected policy decision")
			}
		})
	}
}
