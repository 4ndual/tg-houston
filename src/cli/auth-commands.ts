import type { Client } from "tdl";
import { createTelegramClient } from "../tdlib/client";
import {
  getRawAuthState,
  mapAuthState,
  mapAuthError,
  submitAndWaitNextState,
  type AuthState,
} from "../tdlib/stepauth";

// Conversational, one-shot auth commands. Each invocation advances the TDLib
// auth state machine and exits; the binlog carries the handshake to the next
// invocation. Designed so an agent can drive login in chat:
//   tg auth-status → tg login --phone +57... → tg login --code 12345
//   → (if 2FA) tg login --password ...

function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) return args[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

function codeSentTo(rawState: any): string {
  const t = rawState?.code_info?.type?._ ?? "";
  if (t.includes("TelegramMessage")) return "telegram_app";
  if (t.includes("Sms")) return "sms";
  if (t.includes("Call")) return "phone_call";
  if (t.includes("Fragment")) return "fragment";
  return t ? t.replace("authenticationCodeType", "").toLowerCase() : "unknown";
}

async function userLine(client: Client): Promise<string> {
  const me: any = await client.invoke({ _: "getMe" });
  const name = [me.first_name, me.last_name].filter(Boolean).join(" ");
  const username =
    me.usernames?.editable_username || me.usernames?.active_usernames?.[0] || "";
  return `user: ${name}${username ? ` (@${username})` : ""} id=${me.id}`;
}

function describeState(state: AuthState, rawState: any): string[] {
  const lines = [`auth_state: ${state}`];
  if (state === "wait_code") {
    lines.push(`code_sent_to: ${codeSentTo(rawState)}`);
    lines.push(
      "note: ask the user to paste the code HERE in this chat. The user must NEVER type or forward the code inside Telegram itself — Telegram invalidates codes sent through Telegram messages.",
    );
  }
  if (state === "wait_password") {
    const hint = rawState?.password_hint;
    lines.push(`password_hint: ${hint || "(none)"}`);
    lines.push("next: tg login --password <2FA password>");
  }
  if (state === "wait_phone") {
    lines.push("next: tg login --phone <+countrycode_number>");
  }
  if (state === "wait_registration" || state === "wait_email" || state === "wait_email_code") {
    lines.push(
      "note: unsupported state — finish registering this account in the official Telegram app first, then retry here.",
    );
  }
  return lines;
}

async function withOwnClient(fn: (client: Client) => Promise<string>): Promise<string> {
  const client = createTelegramClient();
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      // After logOut TDLib may already be closed — binlog is flushed either way.
    }
  }
}

export async function authStatus(_args: string[]): Promise<string> {
  return withOwnClient(async (client) => {
    const raw = await getRawAuthState(client);
    const state = mapAuthState(raw);
    const lines = describeState(state, raw);
    if (state === "ready") lines.push(await userLine(client));
    return lines.join("\n");
  });
}

export async function login(args: string[]): Promise<string> {
  const ask = args.includes("--ask");
  let phone = flagValue(args, "--phone");
  let code = flagValue(args, "--code");
  let password = flagValue(args, "--password");
  const given = [phone, code, password].filter((v) => v !== undefined);
  if (ask ? given.length !== 0 : given.length !== 1) {
    throw new Error(
      "Usage: tg login --ask   (native dialog for whichever step is next — preferred)\n" +
        "   or: tg login --phone <+number> | --code <code> | --password <2FA password>   (exactly one)",
    );
  }

  return withOwnClient(async (client) => {
    const raw = await getRawAuthState(client);
    const state = mapAuthState(raw);

    if (state === "ready") {
      return [`auth_state: ready`, "note: already logged in", await userLine(client)].join("\n");
    }

    if (ask) {
      // Pop a native macOS dialog for whichever credential the state machine
      // needs next — codes and 2FA passwords never enter the chat transcript.
      const { askDialog } = await import("./native-prompt");
      if (state === "wait_phone") {
        phone = await askDialog("Enter your phone number with country code (e.g. +573001234567):");
      } else if (state === "wait_code") {
        code = await askDialog(
          "Enter the Telegram login code (just sent to your Telegram app).\n\nDo NOT type it inside Telegram itself — that invalidates it.",
        );
      } else if (state === "wait_password") {
        const hint = raw?.password_hint ? ` (hint: ${raw.password_hint})` : "";
        password = await askDialog(`Enter your Telegram two-step verification password${hint}:`, {
          hidden: true,
        });
      } else {
        throw new Error(`wrong_state — auth_state: ${state}; nothing to ask for`);
      }
    }

    let request: any;
    if (phone !== undefined) {
      if (state !== "wait_phone" && state !== "wait_code") {
        throw new Error(`wrong_state — auth_state: ${state}; expected wait_phone (or wait_code to resend)`);
      }
      request = { _: "setAuthenticationPhoneNumber", phone_number: phone };
    } else if (code !== undefined) {
      if (state !== "wait_code") {
        throw new Error(`wrong_state — auth_state: ${state}; expected wait_code`);
      }
      request = { _: "checkAuthenticationCode", code };
    } else {
      if (state !== "wait_password") {
        throw new Error(`wrong_state — auth_state: ${state}; expected wait_password`);
      }
      request = { _: "checkAuthenticationPassword", password };
    }

    const nextRaw = await submitAndWaitNextState(client, request);
    const nextState = mapAuthState(nextRaw);
    const lines = describeState(nextState, nextRaw);
    if (nextState === "ready") lines.push(await userLine(client));
    return lines.join("\n");
  });
}

export async function logout(args: string[]): Promise<string> {
  if (!args.includes("--yes")) {
    throw new Error(
      "logout signs this Telegram session out and wipes the local tg-houston session data. Re-run with: tg logout --yes",
    );
  }
  return withOwnClient(async (client) => {
    const raw = await getRawAuthState(client);
    if (mapAuthState(raw) !== "ready") {
      return `auth_state: ${mapAuthState(raw)}\nnote: not logged in — nothing to do`;
    }
    try {
      await client.invoke({ _: "logOut" });
    } catch (err) {
      throw mapAuthError(err);
    }
    return "status: logged_out";
  });
}
