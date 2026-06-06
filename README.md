# Telegram for Houston

Give your [Houston](https://github.com/gethouston/houston) agents full access to **your real Telegram account** — read chats, search history, send messages and media, manage groups. Not a bot: your actual account, via [TDLib](https://core.telegram.org/tdlib).

Setup is fully conversational. Your agent installs the CLI itself and walks you through login — the code and your 2FA password go into **native macOS dialogs**, never into the chat.

## Install (any Houston user, ~1 minute)

Tell any Houston agent:

> Install the telegram skill from https://raw.githubusercontent.com/4ndual/tg-houston/main/SKILL.md and set up my Telegram.

That's it. The agent will:
1. Save the skill into its skills folder.
2. Download and verify the `tg` CLI (to `~/.tg-houston/`).
3. Pop native dialogs for your phone → login code → 2FA password.
4. Send a hello to your Saved Messages to confirm.

Alternatively, paste the contents of [SKILL.md](./SKILL.md) into Houston's skill editor yourself.

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

- macOS on Apple Silicon (darwin-arm64). Intel build not yet published.
- A Houston agent with shell access (default).

## Build from source

```bash
bun install
TG_BUILD_API_ID=... TG_BUILD_API_HASH=... bun run build   # creds from https://my.telegram.org/apps
```

Produces `dist/tg-houston-darwin-arm64.tar.gz` (binary + `libtdjson.dylib` + `SHA256SUMS`). Releases are built by CI from tags (`v*`) with credentials from repo secrets; runtime env vars `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` override the embedded ones.

## License

MIT. Built on [tdl](https://github.com/Bannerets/tdl) and [prebuilt-tdlib](https://www.npmjs.com/package/prebuilt-tdlib); TDLib © Telegram (BSL-1.0).
