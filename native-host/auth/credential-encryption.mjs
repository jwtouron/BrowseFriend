import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;
const MACOS_SECURITY = "/usr/bin/security";
const LINUX_SECRET_TOOL_PATHS = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"];
const SERVICE = "com.browsefriend.credentials";
const ACCOUNT = "local-encryption-key";

async function executableAt(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSecretTool() {
  if (process.env.BROWSEFRIEND_SECRET_TOOL && await executableAt(process.env.BROWSEFRIEND_SECRET_TOOL)) {
    return process.env.BROWSEFRIEND_SECRET_TOOL;
  }

  for (const path of LINUX_SECRET_TOOL_PATHS) {
    if (await executableAt(path)) return path;
  }

  return null;
}

function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];

    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `Credential command exited with ${code}.`));
    });
    child.stdin.end(input);
  });
}

function decodeKey(value) {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error("The BrowseFriend credential key is invalid.");
  return key;
}

function createAesProvider(loadKey) {
  return {
    id: "browsefriend-os-key-v1",
    async isAvailable() {
      try {
        await loadKey({ create: false, availabilityOnly: true });
        return true;
      } catch {
        return false;
      }
    },
    async encrypt(plaintext) {
      const key = await loadKey({ create: true, availabilityOnly: false });
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, tag, encrypted]);
    },
    async decrypt(ciphertext) {
      const payload = Buffer.from(ciphertext);
      const minimumLength = 1 + IV_BYTES + TAG_BYTES;
      if (payload.length < minimumLength || payload[0] !== FORMAT_VERSION) {
        throw new Error("The BrowseFriend credential payload is invalid.");
      }
      const key = await loadKey({ create: false, availabilityOnly: false });
      const iv = payload.subarray(1, 1 + IV_BYTES);
      const tag = payload.subarray(1 + IV_BYTES, minimumLength);
      const encrypted = payload.subarray(minimumLength);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    },
  };
}

async function createMacKeyLoader() {
  if (!await executableAt(MACOS_SECURITY)) throw new Error("macOS Keychain is unavailable.");

  return async ({ create, availabilityOnly }) => {
    if (availabilityOnly) return Buffer.alloc(KEY_BYTES);

    try {
      const { stdout } = await execFileAsync(MACOS_SECURITY, [
        "find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w",
      ]);
      return decodeKey(stdout);
    } catch (error) {
      if (!create) throw error;
    }

    const encoded = randomBytes(KEY_BYTES).toString("base64");
    await execFileAsync(MACOS_SECURITY, [
      "add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-U", "-w", encoded,
    ]);
    return decodeKey(encoded);
  };
}

async function createLinuxKeyLoader() {
  const secretTool = await findSecretTool();
  if (!secretTool) throw new Error("Install secret-tool and unlock a Secret Service keyring.");

  return async ({ create, availabilityOnly }) => {
    if (availabilityOnly) return Buffer.alloc(KEY_BYTES);

    try {
      const { stdout } = await execFileAsync(secretTool, [
        "lookup", "application", "browsefriend", "key", "credentials",
      ]);
      if (stdout.trim()) return decodeKey(stdout);
    } catch (error) {
      if (!create) throw error;
    }

    if (!create) throw new Error("The BrowseFriend credential key was not found.");

    const encoded = randomBytes(KEY_BYTES).toString("base64");
    await runWithInput(secretTool, [
      "store", "--label=BrowseFriend credentials",
      "application", "browsefriend", "key", "credentials",
    ], encoded);
    return decodeKey(encoded);
  };
}

export async function createCredentialEncryption(platform = process.platform) {
  if (platform === "darwin") return createAesProvider(await createMacKeyLoader());
  if (platform === "linux") return createAesProvider(await createLinuxKeyLoader());
  throw new Error("BrowseFriend secure storage currently supports macOS and Linux.");
}

export function createTestCredentialEncryption(key = randomBytes(KEY_BYTES)) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error("Test credential keys must contain exactly 32 bytes.");
  }
  return createAesProvider(async () => key);
}
