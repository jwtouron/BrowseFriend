import assert from "node:assert/strict";
import test from "node:test";
import { createTestCredentialEncryption } from "../native-host/credential-encryption.mjs";

test("credential encryption round-trips without storing plaintext", async () => {
  const encryption = createTestCredentialEncryption(Buffer.alloc(32, 7));
  const plaintext = JSON.stringify({ accessToken: "secret-token", email: "person@example.com" });
  const ciphertext = await encryption.encrypt(plaintext);

  assert.equal(Buffer.from(ciphertext).includes(Buffer.from("secret-token")), false);
  assert.equal(await encryption.decrypt(ciphertext), plaintext);
});

test("credential encryption rejects a modified payload", async () => {
  const encryption = createTestCredentialEncryption(Buffer.alloc(32, 9));
  const ciphertext = Buffer.from(await encryption.encrypt("sensitive"));
  ciphertext[ciphertext.length - 1] ^= 1;

  await assert.rejects(() => encryption.decrypt(ciphertext));
});
