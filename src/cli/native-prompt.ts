// User input dialogs for login codes and 2FA passwords, so secrets never pass
// through the agent chat transcript or shell history.
//
// One native dialog per OS, picked by process.platform:
//   darwin → osascript `display dialog` (hidden answer for secrets)
//   win32  → PowerShell WinForms form (UseSystemPasswordChar for secrets)
//   linux  → zenity --entry / --password (must be installed; most desktop
//            distros ship it — otherwise the CLI errors and the agent falls
//            back to asking in chat per SKILL.md)
//
// Secrets travel dialog → stdout → process memory → TDLib. They are never
// written to disk, argv, or the conversation.

const DIALOG_GIVE_UP_SECONDS = 100; // stay under typical 120s agent shell timeouts
const KILL_GRACE_SECONDS = 20;

export interface DialogOpts {
  hidden?: boolean;
  title?: string;
}

function cancelledError(): Error {
  return new Error(
    "dialog_cancelled — the user cancelled the dialog. Re-run when the user is ready, or fall back to chat per the skill instructions.",
  );
}

function timeoutError(): Error {
  return new Error(
    `dialog_timeout — no input within ${DIALOG_GIVE_UP_SECONDS}s. Re-run the command when the user is ready.`,
  );
}

function emptyError(): Error {
  return new Error("dialog_empty — the dialog was submitted without a value. Re-run the command.");
}

async function runPrompt(argv: string[]): Promise<{ out: string; exit: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  // Bun.spawn has no reliable built-in timeout — kill manually as a backstop.
  const killer = setTimeout(
    () => proc.kill(),
    (DIALOG_GIVE_UP_SECONDS + KILL_GRACE_SECONDS) * 1000,
  );
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  clearTimeout(killer);
  return { out, exit };
}

function asScript(s: string): string {
  // AppleScript string literals use double quotes + backslash escapes;
  // JSON.stringify produces a compatible encoding for plain text.
  return JSON.stringify(s);
}

async function askMac(message: string, opts: DialogOpts): Promise<string> {
  const title = opts.title ?? "Telegram for Houston";
  const script =
    `display dialog ${asScript(message)} with title ${asScript(title)} ` +
    `default answer "" buttons {"Cancel", "OK"} default button "OK"` +
    `${opts.hidden ? " with hidden answer" : ""} giving up after ${DIALOG_GIVE_UP_SECONDS}`;
  const { out, exit } = await runPrompt(["osascript", "-e", script]);
  if (exit !== 0) throw cancelledError();
  if (out.includes("gave up:true")) throw timeoutError();
  const m = out.match(/text returned:(.*?)(?:, gave up:(?:true|false))?\s*$/s);
  const value = m?.[1]?.trim();
  if (!value) throw emptyError();
  return value;
}

async function askLinux(message: string, opts: DialogOpts): Promise<string> {
  const title = opts.title ?? "Telegram for Houston";
  const base = opts.hidden ? ["zenity", "--password"] : ["zenity", "--entry", `--text=${message}`];
  const argv = [...base, `--title=${title}`, `--timeout=${DIALOG_GIVE_UP_SECONDS}`];
  if (opts.hidden) {
    // --password ignores --text; the title carries the question instead.
    argv[argv.indexOf(`--title=${title}`)] = `--title=${title} — ${message.split("\n")[0]}`;
  }
  let res: { out: string; exit: number };
  try {
    res = await runPrompt(argv);
  } catch (err: any) {
    throw new Error(
      "dialog_unavailable — zenity is not installed. Install it (e.g. apt install zenity) or fall back to chat per the skill instructions.",
    );
  }
  // zenity exit codes: 0 ok, 1 cancel, 5 timeout.
  if (res.exit === 5) throw timeoutError();
  if (res.exit !== 0) throw cancelledError();
  const value = res.out.trim();
  if (!value) throw emptyError();
  return value;
}

async function askWindows(message: string, opts: DialogOpts): Promise<string> {
  const title = opts.title ?? "Telegram for Houston";
  // A minimal WinForms prompt: label + (optionally masked) textbox + OK/Cancel,
  // topmost so it cannot hide behind the agent host. Auto-closes on timeout.
  // The secret leaves only via stdout.
  const ps = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = ${JSON.stringify(title)}
$form.Size = New-Object System.Drawing.Size(420, 190)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Text = ${JSON.stringify(message)}
$label.AutoSize = $false
$label.Size = New-Object System.Drawing.Size(380, 60)
$label.Location = New-Object System.Drawing.Point(12, 12)
$box = New-Object System.Windows.Forms.TextBox
$box.Size = New-Object System.Drawing.Size(380, 24)
$box.Location = New-Object System.Drawing.Point(12, 78)
$box.UseSystemPasswordChar = ${opts.hidden ? "$true" : "$false"}
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'OK'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.Location = New-Object System.Drawing.Point(232, 112)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object System.Drawing.Point(317, 112)
$form.Controls.AddRange(@($label, $box, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = ${DIALOG_GIVE_UP_SECONDS * 1000}
$timer.Add_Tick({ $form.Tag = 'timeout'; $form.Close() })
$timer.Start()
$result = $form.ShowDialog()
$timer.Stop()
if ($form.Tag -eq 'timeout') { Write-Output '__TG_TIMEOUT__'; exit 0 }
if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }
Write-Output $box.Text
`;
  const { out, exit } = await runPrompt([
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    ps,
  ]);
  if (out.includes("__TG_TIMEOUT__")) throw timeoutError();
  if (exit !== 0) throw cancelledError();
  const value = out.trim();
  if (!value) throw emptyError();
  return value;
}

export async function askDialog(message: string, opts: DialogOpts = {}): Promise<string> {
  switch (process.platform) {
    case "darwin":
      return askMac(message, opts);
    case "win32":
      return askWindows(message, opts);
    case "linux":
      return askLinux(message, opts);
    default:
      throw new Error(
        `dialog_unavailable — no native dialog support on ${process.platform}. Fall back to chat per the skill instructions.`,
      );
  }
}
