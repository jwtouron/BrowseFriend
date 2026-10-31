FROM golang:1.27.3-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends dbus-x11 gnome-keyring && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY go.mod go.sum ./
COPY shared ./shared
COPY native-host ./native-host
RUN CGO_ENABLED=0 go build -o /tmp/browsefriend-native-host ./native-host/cmd/browsefriend-native-host
ENV BROWSEFRIEND_TEST_SECRET_SERVICE=1
ENV BROWSEFRIEND_TEST_BINARY=/tmp/browsefriend-native-host
CMD ["dbus-run-session", "--", "sh", "-ec", "printf 'synthetic-keyring-password' | gnome-keyring-daemon --unlock --components=secrets; go test -race ./...; /tmp/browsefriend-native-host install --dry-run; /tmp/browsefriend-native-host install; /tmp/browsefriend-native-host uninstall"]
