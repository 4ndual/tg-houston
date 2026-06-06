// User input dialogs for login codes and 2FA passwords, so secrets never pass
// through the agent chat transcript or shell history.
//
// Two transports, picked automatically:
// 1. In-app Houston modal — when running inside a Houston agent session the
//    engine exports HOUSTON_USER_PROMPT_URL + HOUSTON_ENGINE_TOKEN; we POST
//    and block until the user answers the dialog in the Houston window.
// 2. Native macOS dialog via osascript — standalone/terminal fallback.

const DIALOG_GIVE_UP_SECONDS = 100; // stay under typical 120s agent shell timeouts
const HOUSTON_WAIT_MS = 185_000; // engine blocks up to 180s; small margin

async function askHouston(
  url: string,
  token: string,
  message: string,
  opts: { hidden?: boolean; title?: string },
): Promise<string> {
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), HOUSTON_WAIT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: opts.title ?? "Telegram for Houston",
        message,
        hidden: opts.hidden ?? false,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(killer);
  }
  if (res.ok) {
    const body = (await res.json()) as { value?: string };
    if (!body.value) throw new Error("dialog_empty — the dialog was submitted without a value. Re-run the command.");
    return body.value;
  }
  let kind = "";
  try {
    const err = (await res.json()) as { error?: { details?: { kind?: string } } };
    kind = err.error?.details?.kind ?? "";
  } catch {}
  if (kind === "prompt_dismissed") {
    throw new Error("dialog_cancelled — the user cancelled the dialog. Ask for the value in chat instead, or retry.");
  }
  if (kind === "prompt_timeout") {
    throw new Error("dialog_timeout — no answer from the user. Re-run the command when the user is ready.");
  }
  throw new Error(`houston_prompt_failed — HTTP ${res.status}`);
}

function asScript(s: string): string {
  // AppleScript string literals use double quotes + backslash escapes;
  // JSON.stringify produces a compatible encoding for plain text.
  return JSON.stringify(s);
}

export async function askDialog(
  message: string,
  opts: { hidden?: boolean; title?: string } = {},
): Promise<string> {
  const houstonUrl = process.env.HOUSTON_USER_PROMPT_URL;
  const houstonToken = process.env.HOUSTON_ENGINE_TOKEN;
  if (houstonUrl && houstonToken) {
    try {
      return await askHouston(houstonUrl, houstonToken, message, opts);
    } catch (err: any) {
      // Deliberate user outcomes propagate; transport failures (engine
      // restarted, fetch abort, network refused) fall back to the OS dialog.
      const msg = String(err?.message ?? err);
      if (msg.startsWith("dialog_") ) throw err;
    }
  }
  const title = opts.title ?? "Telegram for Houston";
  const script =
    `display dialog ${asScript(message)} with title ${asScript(title)} ` +
    `default answer "" buttons {"Cancel", "OK"} default button "OK"` +
    `${opts.hidden ? " with hidden answer" : ""} giving up after ${DIALOG_GIVE_UP_SECONDS}`;

  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  // Bun.spawn has no reliable built-in timeout — kill manually as a backstop.
  const killer = setTimeout(() => proc.kill(), (DIALOG_GIVE_UP_SECONDS + 20) * 1000);
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  clearTimeout(killer);

  if (exit !== 0) {
    throw new Error("dialog_cancelled — the user cancelled the dialog. Ask for the value in chat instead, or retry.");
  }
  if (out.includes("gave up:true")) {
    throw new Error(`dialog_timeout — no input within ${DIALOG_GIVE_UP_SECONDS}s. Re-run the command when the user is ready.`);
  }
  const m = out.match(/text returned:(.*?)(?:, gave up:(?:true|false))?\s*$/s);
  const value = m?.[1]?.trim();
  if (!value) {
    throw new Error("dialog_empty — the dialog was submitted without a value. Re-run the command.");
  }
  return value;
}
