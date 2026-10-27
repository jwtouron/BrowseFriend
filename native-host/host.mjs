import { createChatGPT, ChatGPTError } from "../vendor/sign-in-with-chatgpt-devkit/packages/local/dist/index.js";
import { APP_ID, APP_NAME, appDataDirectory } from "./constants.mjs";
import { createCredentialEncryption } from "./credential-encryption.mjs";
import { createMessageDecoder, encodeMessage } from "./protocol.mjs";

const allowedMethods = new Set(["auth.status", "auth.signIn", "auth.signOut", "auth.cancel"]);

function publicSession(session) {
  let state = "signed_out";
  if (session.status === "connecting") state = "signing_in";
  if (session.status === "connected") state = session.sharing ? "signed_in" : "plan_disabled";

  return {
    state,
    profile: session.identity ? {
      ...(session.identity.name ? { name: session.identity.name } : {}),
      ...(session.identity.email ? { email: session.identity.email } : {}),
    } : null,
    planUsageEnabled: session.sharing,
    ...(session.error ? { error: session.error } : {}),
  };
}

function publicError(error) {
  if (error instanceof ChatGPTError) return error.toJSON();
  return {
    code: "native_host_error",
    message: error instanceof Error ? error.message : "The BrowseFriend companion failed.",
    retryable: true,
  };
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
    send({ event: "auth.changed", payload: publicSession(session) });
  });

  let queue = Promise.resolve();

  const handle = async (request) => {
    if (!request || typeof request !== "object" || typeof request.id !== "string" ||
        typeof request.method !== "string" || !allowedMethods.has(request.method)) {
      send({
        id: typeof request?.id === "string" ? request.id : null,
        ok: false,
        error: { code: "invalid_request", message: "Unsupported native request.", retryable: false },
      });
      return;
    }

    try {
      let session;
      if (request.method === "auth.status") session = await chatgpt.getSession();
      if (request.method === "auth.signIn") {
        const current = await chatgpt.getSession();
        session = await chatgpt.signIn({ reconsent: current.status === "connected" && !current.sharing });
      }
      if (request.method === "auth.cancel") {
        chatgpt.cancelSignIn();
        session = await chatgpt.getSession();
      }
      if (request.method === "auth.signOut") {
        try {
          await chatgpt.disconnect();
          session = await chatgpt.getSession();
        } catch (error) {
          session = await chatgpt.getSession();
          if (!(error instanceof ChatGPTError) || error.code !== "revocation_failed") throw error;
          send({ id: request.id, ok: true, result: publicSession(session), warning: error.toJSON() });
          return;
        }
      }

      send({ id: request.id, ok: true, result: publicSession(session) });
    } catch (error) {
      send({ id: request.id, ok: false, error: publicError(error) });
    }
  };

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
