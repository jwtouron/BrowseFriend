package companion

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"sync"
)

const maxMessage = 1024 * 1024

type Writer struct {
	mu  sync.Mutex
	Out io.Writer
}

func (w *Writer) Send(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > maxMessage {
		return failure("message_too_large", "Native message exceeds the 1 MiB BrowseFriend limit.", false)
	}
	frame := make([]byte, 4+len(data))
	binary.NativeEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)
	w.mu.Lock()
	defer w.mu.Unlock()
	for len(frame) > 0 {
		n, err := w.Out.Write(frame)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}

// Run consumes Chrome framing. Invalid JSON does not consume subsequent frames.
func Run(ctx context.Context, in io.Reader, handler *Handler) error {
	defer handler.Close()
	var header [4]byte
	for {
		if _, err := io.ReadFull(in, header[:]); err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		size := binary.NativeEndian.Uint32(header[:])
		if size > maxMessage {
			return failure("message_too_large", "Native message exceeds the 1 MiB BrowseFriend limit.", false)
		}
		body := make([]byte, int(size))
		if _, err := io.ReadFull(in, body); err != nil {
			return err
		}
		var request Request
		if !json.Valid(body) {
			continue
		}
		if json.Unmarshal(body, &request) != nil {
			request = Request{}
		}
		handler.Dispatch(ctx, request)
	}
}
