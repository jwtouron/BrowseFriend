module browsefriend

go 1.25.0

require (
	github.com/coreos/go-oidc/v3 v3.21.0
	github.com/go-jose/go-jose/v4 v4.1.4
	github.com/gofrs/flock v0.13.1
	github.com/zalando/go-keyring v0.2.8
	golang.org/x/sys v0.47.0
)

require (
	github.com/danieljoos/wincred v1.2.3 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	golang.org/x/oauth2 v0.36.0 // indirect
)

replace github.com/zalando/go-keyring => github.com/jwtouron/go-keyring v0.2.9-0.20261031003251-fce83d213507
