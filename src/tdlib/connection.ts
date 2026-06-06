import type { Client } from "tdl";
import { createTelegramClient } from "./client";

// tg-houston runs a single TDLib session: the historical "upload" slot is an
// alias for primary so media sends share the one authenticated login.
type Slot = "primary" | "upload";
const clients: Partial<Record<"primary", Client>> = {};

export async function getClient(_slot: Slot = "primary"): Promise<Client> {
  const existing = clients.primary;
  if (existing) return existing;

  const c = createTelegramClient();
  clients.primary = c;

  // Fail fast instead of tdl's interactive login() (which would hang one-shot
  // agent invocations on a readline prompt when the session isn't authenticated).
  const { getRawAuthState, mapAuthState } = await import("./stepauth");
  const state = mapAuthState(await getRawAuthState(c));
  if (state !== "ready") {
    throw new Error(
      `auth_state: ${state} — this tg-houston session is not authenticated. Run: tg auth-status, then tg login --phone <+number>`,
    );
  }

  await waitForConnection(c);

  if (process.env.TDLIB_VERBOSE) console.log("TDLib client connected");
  return c;
}

function waitForConnection(c: Client): Promise<void> {
  return new Promise((resolve) => {
    // Give it a short window — if already ready, resolve immediately
    const timeout = setTimeout(() => resolve(), 5000);

    const handler = (update: any) => {
      if (update._ === "updateConnectionState" && update.state._ === "connectionStateReady") {
        c.off("update", handler);
        clearTimeout(timeout);
        resolve();
      }
    };
    c.on("update", handler);
  });
}

export type SendResult = { ok: true; newMessageId?: number } | { ok: false; error: string };

/**
 * Wait for a message to be confirmed as sent by the server.
 * Resolves once updateMessageSendSucceeded or updateMessageSendFailed fires.
 * Returns the server-assigned message id on success, or the TDLib error message on failure.
 */
export function waitForMessageSend(
  c: Client,
  localMessageId: number,
  timeoutMs: number = 10000,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      c.off("update", handler);
      resolve({ ok: false, error: `timeout: no send confirmation in ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    const handler = (update: any) => {
      if (update._ === "updateMessageSendSucceeded" && update.old_message_id === localMessageId) {
        c.off("update", handler);
        clearTimeout(timeout);
        resolve({ ok: true, newMessageId: update.message?.id });
      }
      if (update._ === "updateMessageSendFailed" && update.old_message_id === localMessageId) {
        c.off("update", handler);
        clearTimeout(timeout);
        const err = update.error;
        const msg = err?.message ?? "unknown send error";
        const code = err?.code != null ? ` (code ${err.code})` : "";
        if (process.env.TDLIB_VERBOSE) console.error("Send failed:", err);
        resolve({ ok: false, error: `${msg}${code}` });
      }
    };
    c.on("update", handler);
  });
}

export async function closeClient(): Promise<void> {
  const c = clients.primary;
  if (!c) return;
  await c.close();
  delete clients.primary;
  if (process.env.TDLIB_VERBOSE) console.log("TDLib client closed");
}
