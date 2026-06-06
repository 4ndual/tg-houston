# tg-houston — Telegram for your agents

Give your AI agents full access to **your real Telegram account** — read chats, search history, send messages and media, manage groups. Not a bot: your actual account, via [TDLib](https://core.telegram.org/tdlib).

Setup is fully conversational. Your agent installs the CLI itself and walks you through login — the code and your 2FA password go into **native macOS dialogs**, never into the chat. Works with any agent that supports skills: Claude Code, Cursor, Codex, Windsurf, [Houston](https://github.com/gethouston/houston), and friends.

## Install (~1 minute)

With the [skills CLI](https://www.skills.sh/):

```bash
npx skills add 4ndual/tg-houston
```

Or with any chat-based agent (e.g. Houston), just say:

> Install the telegram skill from https://raw.githubusercontent.com/4ndual/tg-houston/main/SKILL.md and set up my Telegram.

Either way, on first use the agent will:
1. Download and verify the `tg` CLI (to `~/.tg-houston/`).
2. Pop native dialogs for your phone → login code → 2FA password.
3. Send a hello to your Saved Messages to confirm.

## What your agent can do after that

- List chats, read and search history, see unread
- Send / reply / edit / delete / forward messages, react
- Send photos, videos, voice notes, files, albums; download media
- Create and manage groups, channels, forum topics, invite links
- ~100 verbs total — `tg help` for the index

## Security

- Login codes and 2FA passwords are entered in **native macOS dialogs** (hidden input for passwords) — they never appear in chat transcripts or shell history.
- All session state lives in `~/.tg-houston/` on your Mac. Nothing is sent anywhere except to Telegram itself.
- All message content in CLI output is wrapped in `<<<USER_CONTENT ... USER_CONTENT>>>` delimiters so agents treat it as data, not instructions (prompt-injection hardening).
- Sign out anytime: `~/.tg-houston/bin/tg logout --yes`, or revoke the "tg-houston" device from Telegram → Settings → Devices.

## Requirements

- macOS on Apple Silicon (darwin-arm64). Intel, Windows and Linux builds not yet published.
- An agent with shell access.

## Build from source

```bash
bun install
TG_BUILD_API_ID=... TG_BUILD_API_HASH=... bun run build   # creds from https://my.telegram.org/apps
```

Produces `dist/tg-houston-darwin-arm64.tar.gz` (binary + `libtdjson.dylib` + `SHA256SUMS`). Releases are built by CI from tags (`v*`) with credentials from repo secrets; runtime env vars `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` override the embedded ones.

## License

MIT. Built on [tdl](https://github.com/Bannerets/tdl) and [prebuilt-tdlib](https://www.npmjs.com/package/prebuilt-tdlib); TDLib © Telegram (BSL-1.0).
