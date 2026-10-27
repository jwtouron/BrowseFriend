import { toPublicSession } from "./session.mjs";

export const ALLOWED_AUTH_METHODS = new Set([
  "auth.status",
  "auth.signIn",
  "auth.signOut",
  "auth.cancel",
]);

function invalidRequest(request) {
  return !request || typeof request !== "object" || typeof request.id !== "string" ||
    typeof request.method !== "string" || !ALLOWED_AUTH_METHODS.has(request.method);
}

export function createAuthHandler({
  chatgpt,
  send,
  serializeError,
  isRevocationFailure,
}) {
  return async (request) => {
    if (invalidRequest(request)) {
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
        session = await chatgpt.signIn({
          reconsent: current.status === "connected" && !current.sharing,
        });
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
          if (!isRevocationFailure(error)) throw error;
          send({
            id: request.id,
            ok: true,
            result: toPublicSession(session),
            warning: serializeError(error),
          });
          return;
        }
      }

      send({ id: request.id, ok: true, result: toPublicSession(session) });
    } catch (error) {
      send({ id: request.id, ok: false, error: serializeError(error) });
    }
  };
}
