package companion

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func protectKey(data []byte, protect bool) ([]byte, error) {
	input := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var output windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	} else {
		err = windows.CryptUnprotectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return bytes.Clone(unsafe.Slice(output.Data, output.Size)), nil
}
func platformKey(directory string) KeyProvider {
	return func(ctx context.Context, create bool) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		path := filepath.Join(directory, "key.dpapi")
		file, err := privateFile(path, os.O_RDONLY)
		if os.IsNotExist(err) && create {
			// Creation is serialized by the account lock. Never replace an unreadable key.
			key := make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				return nil, err
			}
			blob, err := protectKey(key, true)
			if err == nil {
				err = atomicFile(path, bytes.NewReader(blob), 0600)
			}
			if err == nil {
				return key, nil
			}
			return nil, failure("storage_encryption_unavailable", "Windows could not protect the credential key. Saved credentials have been preserved.", true)
		}
		if err != nil {
			return nil, failure("storage_encryption_unavailable", "The Windows credential key is missing or unavailable. Saved credentials have been preserved.", true)
		}
		defer file.Close()
		blob, err := io.ReadAll(io.LimitReader(file, 65537))
		if err == nil && len(blob) > 0 && len(blob) <= 65536 {
			key, err := protectKey(blob, false)
			if err == nil && len(key) == 32 {
				return key, nil
			}
		}
		return nil, failure("storage_encryption_unavailable", "Windows could not decrypt the credential key. Saved credentials have been preserved.", true)
	}
}
