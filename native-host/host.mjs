import { createChatGPT, ChatGPTError } from "../vendor/sign-in-with-chatgpt-devkit/packages/local/dist/index.js";
import { APP_ID, APP_NAME, appDataDirectory } from "./constants.mjs";
import { createAuthHandler } from "./auth/handler.mjs";
import { createCredentialEncryption } from "./auth/credential-encryption.mjs";
import { toPublicError, toPublicSession } from "./auth/session.mjs";
import { createMessageDecoder, encodeMessage } from "./messaging/protocol.mjs";
import { ALLOWED_MODEL_METHODS, createModelHandler } from "./model/handler.mjs";

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

  let authQueue = Promise.resolve();
  const handleAuth = createAuthHandler({
    chatgpt,
    send,
    serializeError: publicError,
    isRevocationFailure: (error) =>
      error instanceof ChatGPTError && error.code === "revocation_failed",
  });
  const handleModel = createModelHandler({ chatgpt, send, serializeError: publicError });

  const decode = createMessageDecoder(
    (request) => {
      if (request?.method === "auth.cancel") {
        void handleAuth(request);
        return;
      }
      if (request?.method === "model.cancel") {
        void handleModel(request);
        return;
      }
      if (typeof request?.method === "string" && request.method.startsWith("auth.")) {
        authQueue = authQueue.then(() => handleAuth(request)).catch((error) => {
          console.error("BrowseFriend native auth request failed.", publicError(error).code);
        });
        return;
      }
      if (ALLOWED_MODEL_METHODS.has(request?.method)) {
        void handleModel(request).catch((error) => {
          console.error("BrowseFriend native model request failed.", publicError(error).code);
        });
        return;
      }
      send({
        id: typeof request?.id === "string" ? request.id : null,
        ok: false,
        error: { code: "invalid_request", message: "Unsupported native request.", retryable: false },
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
