// tg-houston is fully standalone: API credentials are embedded at build time
// (env vars TELEGRAM_API_ID / TELEGRAM_API_HASH override), and all state lives
// under ~/.tg-houston (override with TG_HOUSTON_HOME). No .env files are read.
import { VERSION } from "./build-config";

const HELP_CATEGORIES: Record<string, string[]> = {
  Auth: ["auth-status", "login", "logout"],
  Messaging: ["send", "reply", "edit", "edit-caption", "delete", "forward", "copy", "schedule", "draft", "react", "unreact"],
  Reading: ["chats", "chat", "history", "search", "unread", "read", "viewers", "translate", "translate-msg"],
  Media: ["send-file", "send-photo", "send-video", "send-audio", "send-voice", "send-video-note", "send-animation", "send-album", "send-sticker", "stickers", "sticker-packs", "sticker-pack-stickers", "download"],
  Specials: ["send-location", "send-venue", "send-contact", "poll", "dice", "pin", "unpin", "ttl"],
  "Chats — lifecycle": ["create-group", "create-channel", "create-basic-group", "upgrade-to-supergroup", "create-secret-chat", "join-chat", "leave-chat", "delete-chat", "rename", "archive", "unarchive", "mark-unread", "mute", "unmute"],
  "Chats — admin": ["set-description", "set-photo-chat", "delete-photo-chat", "set-permissions", "slow-mode", "protect-content", "all-history", "sign-messages", "forum-mode", "hidden-members", "antispam", "set-sticker-set", "set-custom-emoji-set", "post-as", "link-discussion", "unlink-discussion", "transfer-ownership"],
  Members: ["add-member", "chat-members", "promote", "demote", "kick", "ban", "unban", "restrict", "block", "unblock", "blocked", "join-requests", "approve-join", "decline-join"],
  Forum: ["forum-topics", "topic", "create-topic", "close-topic", "reopen-topic", "edit-topic", "delete-topic", "pin-topic"],
  "Invite links": ["invite-links", "create-invite-link", "edit-invite-link", "revoke-invite-link", "delete-invite-link", "invite-link-members", "invite-link-counts"],
  Privacy: ["chat-privacy", "set-private", "set-public", "event-log"],
  "Self & account": ["me", "profile", "set-bio", "set-name", "set-username", "set-photo", "contacts", "user", "dm", "sessions", "terminate-session", "terminate-others", "folders", "stats", "msg-stats", "boost", "boost-status"],
};

function buildOverview(): string {
  const lines: string[] = [
    `tg-houston ${VERSION} — Telegram for Houston agents`,
    "Usage: tg <command> [args...]   |   tg help <command>   |   tg help all",
    "",
    "Run `tg <command>` with no/missing args to see that command's usage.",
    "First time? Run `tg auth-status` and follow the login steps.",
    "",
  ];
  for (const [cat, verbs] of Object.entries(HELP_CATEGORIES)) {
    lines.push(`# ${cat}`);
    // Render as a wrapped, comma-separated list to keep things compact.
    let line = "  ";
    for (const v of verbs) {
      const fragment = (line === "  " ? v : `, ${v}`);
      if (line.length + fragment.length > 78) {
        lines.push(line);
        line = "  " + v;
      } else {
        line += fragment;
      }
    }
    if (line.trim()) lines.push(line);
    lines.push("");
  }
  lines.push("Common global flags: --markdown / --html (formatted text),");
  lines.push("                     --topic=<thread_id> / --hub-topic=<name> (forum topic),");
  lines.push("                     --quiet (suppress upload progress), --primary (force primary slot)");
  return lines.join("\n");
}

// Compact one-line signatures for verbs whose own argument-parser doesn't throw
// a "Usage: …" string up-front. `tg help <verb>` consults this map first.
const USAGE: Record<string, string> = {
  "auth-status": "tg auth-status — show login state (ready | wait_phone | wait_code | wait_password) and current user",
  login: "tg login --ask   (native dialog, preferred)  |  tg login --phone <+number> | --code <code> | --password <2FA password>   (exactly one; stepwise login)",
  logout: "tg logout --yes — sign out and wipe the local tg-houston session",
  // Legacy verbs that throw "Missing required argument" before showing usage.
  send: "tg send <chat_id> <text> [--topic=<thread_id>|--hub-topic=<name>] [--markdown|--html]",
  reply: "tg reply <chat_id> <reply_to_id> <text> [--topic=<id>|--hub-topic=<name>] [--quote=<substring>] [--markdown|--html]",
  edit: "tg edit <chat_id> <msg_id> <text> [--markdown|--html]",
  "edit-caption": "tg edit-caption <chat_id> <msg_id> <text> [--markdown|--html]",
  delete: "tg delete <chat_id> <msg_id>... [--silent]",
  forward: "tg forward <from_chat> <to_chat> <msg_id>...",
  chats: "tg chats [--limit=N] [--archive]",
  chat: "tg chat <chat_id>",
  history: "tg history <chat_id> [--limit=N] [--all] [--from=<msg>] [--date=YYYY-MM-DD] [--from-date=…] [--to-date=…] [--topic=<thread>] [--full]",
  search: "tg search [query] [--chat=<id>] [--type=voice|photo|video|document|link|audio|animation|video_note] [--sender=<u>] [--from=<msg>] [--limit=N] [--from-date=…] [--to-date=…] [--full]",
  unread: "tg unread — list chats with unread messages",
  read: "tg read <chat_id> [msg_id]...",
  pin: "tg pin <chat_id> <msg_id> [--silent]",
  unpin: "tg unpin <chat_id> <msg_id>",
  download: "tg download <chat_id> <msg_id>... [--out=<dir>]",
  contacts: "tg contacts [--limit=N]",
  user: "tg user <user_id>",
  dm: "tg dm <username|phone|user_id>",
  "send-file": "tg send-file <chat_id> <path> [caption] [--topic=<id>] [--quiet] [--primary]",
  "send-sticker": "tg send-sticker <chat_id> <file_path|remote_file_id>",
  stickers: "tg stickers <emoji_or_query>",
  "sticker-packs": "tg sticker-packs [filter]",
  "sticker-pack-stickers": "tg sticker-pack-stickers <set_id>",
  "create-group": "tg create-group <title> [--forum] [--channel] [--description=…]",
  "create-channel": "tg create-channel <title> [--description=…]",
  "create-basic-group": "tg create-basic-group <title> <user_id> [<user_id>...]",
  "upgrade-to-supergroup": "tg upgrade-to-supergroup <chat_id>   (basic group → supergroup; prints new chat_id)",
  "create-secret-chat": "tg create-secret-chat <user_id>",
  "join-chat": "tg join-chat <chat_id|invite_link|+hash>",
  "leave-chat": "tg leave-chat <chat_id>",
  "delete-chat": "tg delete-chat <chat_id>",
  rename: "tg rename <chat_id> <new title>",
  "add-member": "tg add-member <chat_id> <user_id|@username> [...]",
  "chat-members": "tg chat-members <chat_id> [--filter=recent|admins|banned|bots|restricted] [--limit=N]",
  promote: "tg promote <chat_id> <user> [--title=…] [--all | --can-XXX flags]",
  demote: "tg demote <chat_id> <user>",
  kick: "tg kick <chat_id> <user>",
  ban: "tg ban <chat_id> <user> [--until=<unix>]",
  "forum-topics": "tg forum-topics <chat_id> [--limit=N] [--query=…]",
  topic: "tg topic <chat_id> <thread_id>",
  "create-topic": "tg create-topic <chat_id> <name>",
  "close-topic": "tg close-topic <chat_id> <thread_id>",
  "reopen-topic": "tg reopen-topic <chat_id> <thread_id>",
  "edit-topic": "tg edit-topic <chat_id> <thread_id> <new name>",
  "delete-topic": "tg delete-topic <chat_id> <thread_id>",
  "chat-privacy": "tg chat-privacy <chat_id>",
  "set-private": "tg set-private <chat_id>",
  "set-public": "tg set-public <chat_id> <username>",
  "invite-links": "tg invite-links <chat_id> [--include-revoked] [--limit=N]",
  "create-invite-link": "tg create-invite-link <chat_id> [--name=…] [--expires=<unix|YYYY-MM-DD>] [--member-limit=N] [--creates-join-request]",
  "revoke-invite-link": "tg revoke-invite-link <chat_id> <link>",
  "delete-invite-link": "tg delete-invite-link <chat_id> <link>",
  me: "tg me — show self profile (user_id, username, premium, language)",
  react: "tg react <chat_id> <msg_id> <emoji> [--big]",
  unreact: "tg unreact <chat_id> <msg_id> <emoji>",
  "send-photo": "tg send-photo <chat_id> <path> [caption] [--topic=<id>] [--markdown|--html] [--quiet] [--primary]",
  "send-video": "tg send-video <chat_id> <path> [caption] [--topic=<id>] [--markdown|--html] [--quiet] [--primary]",
  "send-voice": "tg send-voice <chat_id> <path> [caption] [--topic=<id>] [--markdown|--html] [--quiet] [--primary]",
  "send-audio": "tg send-audio <chat_id> <path> [caption] [--title=<t>] [--performer=<p>] [--duration=<sec>] [--topic=<id>] [--markdown|--html] [--quiet] [--primary]",
  "send-video-note": "tg send-video-note <chat_id> <path> [--topic=<id>] [--quiet] [--primary]",
  "send-animation": "tg send-animation <chat_id> <path> [caption] [--topic=<id>] [--markdown|--html] [--quiet] [--primary]",
  "send-album": "tg send-album <chat_id> <path1> <path2> ... [--caption=<text>] [--topic=<id>] [--markdown|--html] [--primary] [--quiet]",
  "mark-unread": "tg mark-unread <chat_id> [--off]",
  mute: "tg mute <chat_id> [--for=8h | --forever]",
  unmute: "tg unmute <chat_id>",
  archive: "tg archive <chat_id>",
  unarchive: "tg unarchive <chat_id>",
  schedule: "tg schedule <chat_id> <text> --at=<unix|ISO|+5m> [--markdown|--html]",
  copy: "tg copy <from_chat_id> <to_chat_id> <msg_id>... [--no-captions]",
  draft: "tg draft <chat_id> [--clear | <text>] [--markdown|--html]",
  block: "tg block <user_id|@username>",
  unblock: "tg unblock <user_id|@username>",
  blocked: "tg blocked — list blocked senders",
  sessions: "tg sessions — list active device sessions",
  "terminate-session": "tg terminate-session <session_id>",
  "terminate-others": "tg terminate-others — kill all sessions except current",
  ttl: "tg ttl <chat_id> <seconds|off>",
  viewers: "tg viewers <chat_id> <msg_id>",
  "send-location": "tg send-location <chat_id> <lat> <lon> [--live=<seconds>] [--topic=<id>]",
  "send-venue": 'tg send-venue <chat_id> <lat> <lon> "<title>" "<address>" [--topic=<id>]',
  "send-contact": "tg send-contact <chat_id> <phone> <first_name> [last_name] [--topic=<id>]",
  poll: 'tg poll <chat_id> "Question" "opt1" "opt2" [...] [--anonymous] [--multiple] [--quiz=<correct_idx>]',
  dice: "tg dice <chat_id> [emoji]   (default 🎲; also 🎯 🏀 🎳 🎰)",
  translate: 'tg translate "<text>" --to=<lang_code>',
  "translate-msg": "tg translate-msg <chat_id> <msg_id> --to=<lang_code>",
  stats: "tg stats <chat_id>   (channel statistics)",
  "msg-stats": "tg msg-stats <chat_id> <msg_id>   (channel message interactions)",
  profile: "tg profile — show own profile (bio, photo, premium state)",
  "set-bio": "tg set-bio <text>",
  "set-name": "tg set-name <first> [last]",
  "set-username": "tg set-username <username>   (pass empty to clear)",
  "set-photo": "tg set-photo <path>",
  "boost-status": "tg boost-status <chat_id>",
  boost: "tg boost <chat_id>",
  folders: "tg folders — list chat folders",
  "set-description": "tg set-description <chat_id> <text>",
  "set-photo-chat": "tg set-photo-chat <chat_id> <path>",
  "delete-photo-chat": "tg delete-photo-chat <chat_id>",
  "set-permissions": "tg set-permissions <chat_id> --send=<bool> --media=<bool> --polls=<bool> --links=<bool> --pin=<bool> --invite=<bool> --info=<bool> [--photos --videos --audios --documents --voice-notes --video-notes --stickers-gifs --topics]",
  "slow-mode": "tg slow-mode <chat_id> <seconds|off>",
  restrict: "tg restrict <chat_id> <user> [--until=<unix>] [--no-send] [--no-media] [--no-polls] [--no-links] [--no-pin]",
  unban: "tg unban <chat_id> <user_id|@username>",
  "protect-content": "tg protect-content <chat_id> --on/--off",
  "event-log": "tg event-log <chat_id> [--filter=joins,leaves,edits,deletes,admins,members,info,settings,invites,video_chats,forum,pins] [--limit=N] [--from=<event_id>]",
  "join-requests": "tg join-requests <chat_id> [--limit=N]",
  "approve-join": "tg approve-join <chat_id> <user_id|@username>",
  "decline-join": "tg decline-join <chat_id> <user_id|@username>",
  "link-discussion": "tg link-discussion <channel_chat_id> <discussion_group_chat_id>",
  "unlink-discussion": "tg unlink-discussion <channel_chat_id>",
  "transfer-ownership": "tg transfer-ownership <chat_id> <user_id|@username> --password=<2fa> --yes   (DESTRUCTIVE)",
  "sign-messages": "tg sign-messages <channel_chat_id> --on/--off",
  "all-history": "tg all-history <chat_id> --on/--off",
  "forum-mode": "tg forum-mode <chat_id> --on/--off",
  "hidden-members": "tg hidden-members <chat_id> --on/--off   (chat needs ≥100 members)",
  antispam: "tg antispam <chat_id> --on/--off   (chat needs ≥100 members)",
  "pin-topic": "tg pin-topic <chat_id> <thread_id> --on/--off",
  "set-sticker-set": "tg set-sticker-set <chat_id> <set_id|off>",
  "set-custom-emoji-set": "tg set-custom-emoji-set <chat_id> <set_id|off>",
  "post-as": "tg post-as <chat_id> <sender_chat_id_or_user>",
  "edit-invite-link": "tg edit-invite-link <chat_id> <link> [--name=…] [--expires=<unix|YYYY-MM-DD>] [--member-limit=N] [--creates-join-request]",
  "invite-link-members": "tg invite-link-members <chat_id> <link> [--limit=N]",
  "invite-link-counts": "tg invite-link-counts <chat_id>",
};

async function main() {
  let args = process.argv.slice(2);
  let command = args[0];
  if (command === "--version" || command === "version" || command === "-v") {
    console.log(VERSION);
    process.exit(0);
  }
  // `tg help <verb>` — rebind to "<verb>" with no args so the dispatched handler
  // throws its own "Usage: tg <verb> …" message.
  const isHelpVerb = command === "help" || command === "--help" || command === "-h";
  if (!command || (isHelpVerb && (!args[1] || args[1] === "all"))) {
    console.log(buildOverview());
    process.exit(0);
  }
  if (isHelpVerb && args[1]) {
    const verb = args[1];
    if (USAGE[verb]) {
      console.log(USAGE[verb]);
      process.exit(0);
    }
    // Fall back: re-invoke the verb with no args so its own Usage-thrower fires.
    command = verb;
    args = [verb];
  }

  // Dynamic import AFTER env vars are set — critical for compiled binary
  const commands = await import("./cli/commands");
  const authCommands = await import("./cli/auth-commands");
  const { closeClient } = await import("./tdlib/connection");

  const COMMAND_MAP: Record<string, (args: string[]) => Promise<string>> = {
    "auth-status": authCommands.authStatus,
    login: authCommands.login,
    logout: authCommands.logout,
    chats: commands.chats,
    chat: commands.chat,
    history: commands.history,
    send: commands.send,
    reply: commands.reply,
    forward: commands.forward,
    edit: commands.edit,
    "edit-caption": commands.editCaption,
    delete: commands.deleteMessages,
    search: commands.search,
    contacts: commands.contacts,
    user: commands.user,
    dm: commands.dm,
    read: commands.read,
    unread: commands.unread,
    pin: commands.pin,
    unpin: commands.unpin,
    download: commands.download,
    "send-file": commands.sendFile,
    "send-sticker": commands.sendSticker,
    stickers: commands.stickers,
    "sticker-packs": commands.stickerPacks,
    "sticker-pack-stickers": commands.stickerPackStickers,
    "create-group": commands.createGroup,
    "create-channel": commands.createChannel,
    "create-basic-group": commands.createBasicGroup,
    "upgrade-to-supergroup": commands.upgradeToSupergroup,
    "create-secret-chat": commands.createSecretChat,
    "join-chat": commands.joinChat,
    "leave-chat": commands.leaveChat,
    "delete-chat": commands.deleteChat,
    rename: commands.rename,
    "add-member": commands.addMember,
    "chat-members": commands.chatMembers,
    promote: commands.promote,
    demote: commands.demote,
    kick: commands.kick,
    ban: commands.ban,
    "forum-topics": commands.forumTopics,
    topic: commands.topic,
    "create-topic": commands.createTopic,
    "close-topic": commands.closeTopic,
    "reopen-topic": commands.reopenTopic,
    "edit-topic": commands.editTopic,
    "delete-topic": commands.deleteTopic,
    "chat-privacy": commands.chatPrivacy,
    "set-private": commands.setPrivate,
    "set-public": commands.setPublic,
    "invite-links": commands.inviteLinks,
    "create-invite-link": commands.createInviteLink,
    "revoke-invite-link": commands.revokeInviteLink,
    "delete-invite-link": commands.deleteInviteLink,
    // --- USER P0 ---
    me: commands.me,
    react: commands.react,
    unreact: commands.unreact,
    "send-photo": commands.sendPhoto,
    "send-video": commands.sendVideo,
    "send-voice": commands.sendVoice,
    "send-audio": commands.sendAudio,
    "send-video-note": commands.sendVideoNote,
    "send-animation": commands.sendAnimation,
    "send-album": commands.sendAlbum,
    "mark-unread": commands.markUnread,
    mute: commands.muteChat,
    unmute: commands.unmuteChat,
    archive: commands.archiveChat,
    unarchive: commands.unarchiveChat,
    // --- USER P1 ---
    schedule: commands.schedule,
    copy: commands.copyMessages,
    draft: commands.draft,
    block: commands.blockUser,
    unblock: commands.unblockUser,
    blocked: commands.blockedList,
    sessions: commands.sessions,
    "terminate-session": commands.terminateSession,
    "terminate-others": commands.terminateOthers,
    ttl: commands.ttl,
    viewers: commands.viewers,
    "send-location": commands.sendLocation,
    "send-venue": commands.sendVenue,
    "send-contact": commands.sendContact,
    // --- USER P2 ---
    poll: commands.poll,
    dice: commands.dice,
    translate: commands.translate,
    "translate-msg": commands.translateMsg,
    stats: commands.stats,
    "msg-stats": commands.msgStats,
    profile: commands.profile,
    "set-bio": commands.setBio,
    "set-name": commands.setName,
    "set-username": commands.setUsername,
    "set-photo": commands.setProfilePhoto,
    "boost-status": commands.boostStatus,
    boost: commands.boost,
    folders: commands.folders,
    // --- ADMIN P0 ---
    "set-description": commands.setDescription,
    "set-photo-chat": commands.setPhotoChat,
    "delete-photo-chat": commands.deletePhotoChat,
    "set-permissions": commands.setPermissions,
    "slow-mode": commands.slowMode,
    restrict: commands.restrict,
    unban: commands.unban,
    "protect-content": commands.protectContent,
    "event-log": commands.eventLog,
    "join-requests": commands.joinRequests,
    "approve-join": commands.approveJoin,
    "decline-join": commands.declineJoin,
    "link-discussion": commands.linkDiscussion,
    "unlink-discussion": commands.unlinkDiscussion,
    "transfer-ownership": commands.transferOwnership,
    // --- ADMIN P1 ---
    "sign-messages": commands.signMessages,
    "all-history": commands.allHistory,
    "forum-mode": commands.forumMode,
    "hidden-members": commands.hiddenMembers,
    antispam: commands.antispam,
    "pin-topic": commands.pinTopic,
    "set-sticker-set": commands.setStickerSetCmd,
    "set-custom-emoji-set": commands.setCustomEmojiSet,
    "post-as": commands.postAs,
    // --- ADMIN P2 ---
    "edit-invite-link": commands.editInviteLink,
    "invite-link-members": commands.inviteLinkMembers,
    "invite-link-counts": commands.inviteLinkCounts,
  };

  const handler = COMMAND_MAP[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\nRun "tg help" for usage.`);
    process.exit(1);
  }

  try {
    const output = await handler(args.slice(1));
    console.log(output);
  } catch (err: any) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  } finally {
    await closeClient();
  }
}

main();
