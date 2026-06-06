// Native macOS input dialog via osascript, so login codes and 2FA passwords
// never pass through the agent chat transcript or shell history.

const DIALOG_GIVE_UP_SECONDS = 100; // stay under typical 120s agent shell timeouts

function asScript(s: string): string {
  // AppleScript string literals use double quotes + backslash escapes;
  // JSON.stringify produces a compatible encoding for plain text.
  return JSON.stringify(s);
}

export async function askDialog(
  message: string,
  opts: { hidden?: boolean; title?: string } = {},
): Promise<string> {
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
