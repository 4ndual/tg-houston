import type { Client } from "tdl";

// Stepwise (non-interactive) TDLib authentication.
//
// Each CLI invocation is a one-shot process: TDLib persists the partial auth
// handshake in its binlog, so `login --phone` in one process leaves the next
// process starting directly in authorizationStateWaitCode. tdl auto-answers
// authorizationStateWaitTdlibParameters on client creation; everything else
// is driven manually here via invoke() — client.login() is never used.

export type AuthState =
  | "ready"
  | "wait_phone"
  | "wait_code"
  | "wait_password"
  | "wait_registration"
  | "wait_email"
  | "wait_email_code"
  | "wait_other_device"
  | "initializing"
  | "logging_out"
  | "closing"
  | "closed"
  | "unknown";

const STATE_MAP: Record<string, AuthState> = {
  authorizationStateReady: "ready",
  authorizationStateWaitPhoneNumber: "wait_phone",
  authorizationStateWaitCode: "wait_code",
  authorizationStateWaitPassword: "wait_password",
  authorizationStateWaitRegistration: "wait_registration",
  authorizationStateWaitEmailAddress: "wait_email",
  authorizationStateWaitEmailCode: "wait_email_code",
  authorizationStateWaitOtherDeviceConfirmation: "wait_other_device",
  authorizationStateWaitTdlibParameters: "initializing",
  authorizationStateLoggingOut: "logging_out",
  authorizationStateClosing: "closing",
  authorizationStateClosed: "closed",
};

export function mapAuthState(raw: any): AuthState {
  return STATE_MAP[raw?._] ?? "unknown";
}

/** Current TDLib authorization state object (raw), waiting out the init phase if needed. */
export async function getRawAuthState(client: Client, timeoutMs = 10000): Promise<any> {
  let state: any = await client.invoke({ _: "getAuthorizationState" });
  if (mapAuthState(state) !== "initializing") return state;
  // Rare race: parameters not answered yet — wait for the next auth update.
  return await new Promise((resolve) => {
    const timeout = setTimeout(async () => {
      client.off("update", handler);
      resolve(await client.invoke({ _: "getAuthorizationState" }));
    }, timeoutMs);
    const handler = (update: any) => {
      if (
        update._ === "updateAuthorizationState" &&
        mapAuthState(update.authorization_state) !== "initializing"
      ) {
        client.off("update", handler);
        clearTimeout(timeout);
        resolve(update.authorization_state);
      }
    };
    client.on("update", handler);
  });
}

/**
 * Submit an auth request and resolve with the NEXT raw authorization state.
 * Subscribes before invoking so the transition can't be missed; falls back to
 * one getAuthorizationState poll if no update arrives in time.
 */
export async function submitAndWaitNextState(
  client: Client,
  request: any,
  timeoutMs = 15000,
): Promise<any> {
  let resolved = false;
  const next = new Promise<any>((resolve) => {
    const timeout = setTimeout(async () => {
      if (resolved) return;
      client.off("update", handler);
      resolve(await client.invoke({ _: "getAuthorizationState" }));
    }, timeoutMs);
    const handler = (update: any) => {
      if (update._ === "updateAuthorizationState") {
        resolved = true;
        client.off("update", handler);
        clearTimeout(timeout);
        resolve(update.authorization_state);
      }
    };
    client.on("update", handler);
  });

  try {
    await client.invoke(request);
  } catch (err) {
    throw mapAuthError(err);
  }
  return await next;
}

/** Map TDLib auth errors to one-line, agent-relayable messages. */
export function mapAuthError(e: any): Error {
  const msg: string = e?.message || String(e);
  const code: number | undefined = e?.code;

  if (msg.includes("PHONE_NUMBER_INVALID"))
    return new Error("phone_number_invalid — include the country code, e.g. +573001234567");
  if (msg.includes("PHONE_NUMBER_BANNED"))
    return new Error("phone_number_banned — this number is blocked by Telegram");
  if (msg.includes("PHONE_CODE_INVALID") || msg.includes("PHONE_CODE_EMPTY"))
    return new Error(
      "code_invalid — re-check the code. Never send or forward the code through Telegram itself; that invalidates it",
    );
  if (msg.includes("PHONE_CODE_EXPIRED"))
    return new Error("code_expired — request a new code with: tg login --phone <+number>");
  if (msg.includes("PASSWORD_HASH_INVALID"))
    return new Error("password_invalid — wrong two-step verification (2FA) password");
  const flood = msg.match(/retry after (\d+)/i);
  if (code === 429 || flood)
    return new Error(
      `flood_wait — Telegram rate limit${flood ? `, retry after ${flood[1]} seconds` : ""}. Do not retry immediately`,
    );
  return new Error(`${msg}${code != null ? ` (code ${code})` : ""}`);
}
