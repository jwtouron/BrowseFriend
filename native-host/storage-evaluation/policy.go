package main

// A small, conservative policy experiment, not a general Windows ACL interpreter.
// Inheritance and Administrators are allowed; unrecognized allow/conditional ACEs
// remain failures. Deny entries cannot broaden access and may be retained.
type permissionEntry struct {
	principal string
	allow     bool
	deny      bool
	mask      uint32
}
type permissions struct {
	owner, user       string
	protected, hasACL bool
	reparse           bool
	entries           []permissionEntry
}

func acceptsPermissions(p permissions, strict bool) bool {
	if p.owner != p.user || p.reparse || !p.hasACL || len(p.entries) == 0 || (strict && !p.protected) {
		return false
	}
	userAccess := false
	required := uint32(0x10003) // delete + read/write data; OS still enforces deny ACEs.
	if strict {
		required = 0x1f01ff
	}
	for _, entry := range p.entries {
		if entry.deny && !strict {
			continue
		}
		if !entry.allow {
			return false
		}
		if entry.principal != p.user && entry.principal != "S-1-5-18" && (strict || entry.principal != "S-1-5-32-544") {
			return false
		}
		if entry.principal == p.user && entry.mask&required == required {
			userAccess = true
		}
	}
	return userAccess
}
