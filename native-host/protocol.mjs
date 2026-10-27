import { endianness } from "node:os";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const littleEndian = endianness() === "LE";

function readLength(buffer) {
  return littleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
}

function writeLength(buffer, length) {
  if (littleEndian) buffer.writeUInt32LE(length, 0);
  else buffer.writeUInt32BE(length, 0);
}

export function encodeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");

  if (payload.length > MAX_MESSAGE_BYTES) {
    throw new Error("Native message exceeds the 1 MiB BrowseFriend limit.");
  }

  const header = Buffer.allocUnsafe(4);
  writeLength(header, payload.length);
  return Buffer.concat([header, payload]);
}

export function createMessageDecoder(onMessage, onError) {
  let buffered = Buffer.alloc(0);

  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);

    while (buffered.length >= 4) {
      const length = readLength(buffered);

      if (length > MAX_MESSAGE_BYTES) {
        buffered = Buffer.alloc(0);
        onError(new Error("Native message exceeds the 1 MiB BrowseFriend limit."));
        return;
      }

      if (buffered.length < length + 4) return;

      const payload = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);

      try {
        onMessage(JSON.parse(payload.toString("utf8")));
      } catch {
        onError(new Error("Native message is not valid JSON."));
      }
    }
  };
}
