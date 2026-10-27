import assert from "node:assert/strict";
import test from "node:test";
import { createTestCredentialEncryption } from "../../native-host/auth/credential-encryption.mjs";

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

test("credential encryption uses a fresh nonce for every payload", async () => {
  const encryption = createTestCredentialEncryption(Buffer.alloc(32, 4));
  const first = await encryption.encrypt("same plaintext");
  const second = await encryption.encrypt("same plaintext");

  assert.notDeepEqual(first, second);
  assert.equal(await encryption.decrypt(first), "same plaintext");
  assert.equal(await encryption.decrypt(second), "same plaintext");
});

test("credential encryption rejects unknown formats and incorrect keys", async () => {
  const encryption = createTestCredentialEncryption(Buffer.alloc(32, 1));
  const anotherEncryption = createTestCredentialEncryption(Buffer.alloc(32, 2));
  const ciphertext = await encryption.encrypt("sensitive");

  await assert.rejects(() => encryption.decrypt(Buffer.alloc(10)), /payload is invalid/);
  await assert.rejects(() => anotherEncryption.decrypt(ciphertext));
  assert.throws(() => createTestCredentialEncryption(Buffer.alloc(31)), /exactly 32 bytes/);
});
