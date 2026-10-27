import { createChatGPT, ChatGPTError } from "../vendor/sign-in-with-chatgpt-devkit/packages/local/dist/index.js";
import { APP_ID, APP_NAME, appDataDirectory } from "./constants.mjs";
import { createAuthHandler } from "./auth-handler.mjs";
import { createCredentialEncryption } from "./credential-encryption.mjs";
import { createMessageDecoder, encodeMessage } from "./protocol.mjs";
import { toPublicError, toPublicSession } from "./session.mjs";

function publicError(error) {
  if (error instanceof ChatGPTError) return toPublicError(error.toJSON());
  return toPublicError(null, {
    retryable: true,
  });
}

function send(message) {
  process.stdout.write(encodeMessage(message));
}

async function main() {
  const credentialEncryption = await createCredentialEncryption();
  const chatgpt = createChatGPT({
    appName: APP_NAME,
    appId: APP_ID,
    redirectPort: 0,
    storageDir: appDataDirectory(),
    credentialEncryption,
    sendHostId: true,
  });

  chatgpt.subscribe((session) => {
    send({ event: "auth.changed", payload: toPublicSession(session) });
  });

  let queue = Promise.resolve();
  const handle = createAuthHandler({
    chatgpt,
    send,
    serializeError: publicError,
    isRevocationFailure: (error) =>
      error instanceof ChatGPTError && error.code === "revocation_failed",
  });

  const decode = createMessageDecoder(
    (request) => {
      if (request?.method === "auth.cancel") {
        void handle(request);
        return;
      }
      queue = queue.then(() => handle(request)).catch((error) => {
        console.error("BrowseFriend native request failed.", publicError(error).code);
      });
    },
    (error) => console.error("BrowseFriend native protocol error.", error.message),
  );

  process.stdin.on("data", decode);
  process.stdin.on("error", (error) => console.error("BrowseFriend native input failed.", error.message));
}

main().catch((error) => {
  console.error("BrowseFriend native host could not start.", publicError(error).code);
  process.exitCode = 1;
});
