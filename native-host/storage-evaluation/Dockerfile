FROM golang:1.27.3-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends dbus-x11 gnome-keyring && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY go.mod go.sum ./
COPY shared ./shared
COPY native-host ./native-host
WORKDIR /work/native-host/storage-evaluation
RUN go mod download
ENV BF_STORAGE_EVALUATION_KEYRING=1
CMD ["dbus-run-session", "--", "sh", "-ec", "printf 'synthetic-evaluation-password' | gnome-keyring-daemon --unlock --components=secrets; go test -race -tags candidate_keeper -v ./...; BF_STORAGE_EVALUATION_UNAVAILABLE_KEYRING=1 DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/browsefriend-no-such-bus go test -run '^TestUnavailableKeyringOS$' -v .; go run . -backend=file; go run . -backend=bolt; go run -tags candidate_keeper . -backend=keeper"]
