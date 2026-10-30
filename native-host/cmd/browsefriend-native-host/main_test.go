package main

import (
	hostcontract "browsefriend/shared"
	"testing"
)

func TestNativeArguments(t *testing.T) {
	origin := hostcontract.Contract.ExtensionOrigin
	for _, platform := range []string{"darwin", "linux", "windows"} {
		for _, item := range []struct {
			args  []string
			valid bool
		}{
			{nil, true}, {[]string{origin}, true},
			{[]string{origin, "--parent-window=0"}, platform == "windows"},
			{[]string{origin, "--parent-window=123456"}, platform == "windows"},
			{[]string{origin, "--parent-window="}, false},
			{[]string{origin, "--parent-window=-1"}, false},
			{[]string{origin, "--parent-window=+1"}, false},
			{[]string{origin, "--parent-window=18446744073709551616"}, false},
			{[]string{origin, "--parent-window=0", "extra"}, false},
			{[]string{origin, "unexpected"}, false},
			{[]string{"chrome-extension://wrong/"}, false},
		} {
			if got := nativeArguments(item.args, platform); got != item.valid {
				t.Fatalf("%s %v: got %v", platform, item.args, got)
			}
		}
	}
}
