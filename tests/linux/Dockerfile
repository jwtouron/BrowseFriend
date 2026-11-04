FROM golang:1.27.3-bookworm
WORKDIR /work
COPY go.mod go.sum ./
COPY shared ./shared
COPY native-host ./native-host
RUN CGO_ENABLED=0 go build -o /tmp/browsefriend-native-host ./native-host/cmd/browsefriend-native-host
ENV BROWSEFRIEND_TEST_BINARY=/tmp/browsefriend-native-host
CMD ["sh", "-ec", "go test -race ./...; go vet ./...; /tmp/browsefriend-native-host install --dry-run; /tmp/browsefriend-native-host install; /tmp/browsefriend-native-host uninstall"]
