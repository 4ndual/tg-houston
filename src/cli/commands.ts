import { getClient, waitForMessageSend } from "../tdlib/connection";
import { mapChat, mapChatDetail } from "../mappers/chat";
import { mapMessage } from "../mappers/message";
import { mapUser, mapContact } from "../mappers/user";
import {
  formatChatList,
  formatChatDetail,
  formatMessages,
  formatSearchResults,
  formatUser,
  formatContacts,
  formatUnreadChats,
  formatSuccess,
  formatForumTopics,
  formatForumTopic,
  formatChatPrivacy,
  formatInviteLinks,
  formatInviteLink,
  type FormattedChatPrivacy,
  type FormattedInviteLink,
} from "./formatter";
import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync, realpathSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// HubV2 stores its topics (Bot API 9.4 DM-with-topics) in a JSON file on disk.
// Resolve human topic names ("PA (Personal Assistant)") to thread_ids so
// callers can do `tg send <chat> "msg" --hub-topic="PA"` without looking up
// numeric IDs by hand. Matches by exact name, slug, or case-insensitive
// substring on either.
function resolveHubTopic(query: string): { thread_id: number; name: string; slug: string } | null {
  const path = join(homedir(), "Documents/HubV2/data/topicStore.json");
  if (!existsSync(path)) return null;
  let entries: any[] = [];
  try {
    entries = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  const open = entries.filter((t) => t.status === "open");
  const q = query.toLowerCase();
  // Exact name or slug first
  let hit = open.find((t) => t.name?.toLowerCase() === q || t.slug?.toLowerCase() === q);
  // Then substring
  if (!hit) hit = open.find((t) => t.name?.toLowerCase().includes(q) || t.slug?.toLowerCase().includes(q));
  if (!hit) return null;
  return { thread_id: hit.thread_id, name: hit.name, slug: hit.slug };
}

export async function chats(args: string[]): Promise<string> {
  const limit = parseIntFlag(args, "--limit", 20);
  const archive = args.includes("--archive");

  const client = await getClient();
  const chatList = archive
    ? { _: "chatListArchive" as const }
    : { _: "chatListMain" as const };

  const result = await client.invoke({
    _: "getChats",
    chat_list: chatList,
    limit: limit + 1,
  });

  const chatIds = result.chat_ids;
  const hasMore = chatIds.length > limit;
  const ids = hasMore ? chatIds.slice(0, limit) : chatIds;

  const chatDetails = await Promise.all(
    ids.map((id: number) => client.invoke({ _: "getChat", chat_id: id }))
  );

  return formatChatList(chatDetails.map(mapChat), hasMore);
}

export async function chat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");

  const client = await getClient();
  const chatData = await client.invoke({ _: "getChat", chat_id: chatId });

  let memberCount: number | undefined;
  let description: string | undefined;
  let isForum = false;

  if (chatData.type._ === "chatTypeSupergroup") {
    const sg = await client.invoke({
      _: "getSupergroupFullInfo",
      supergroup_id: chatData.type.supergroup_id,
    });
    memberCount = sg.member_count;
    description = sg.description;
    // Check supergroup object itself for is_forum flag
    const sgInfo = await client.invoke({
      _: "getSupergroup",
      supergroup_id: chatData.type.supergroup_id,
    });
    isForum = !!(sgInfo as any).is_forum;
  } else if (chatData.type._ === "chatTypeBasicGroup") {
    const bg = await client.invoke({
      _: "getBasicGroupFullInfo",
      basic_group_id: chatData.type.basic_group_id,
    });
    memberCount = bg.members?.length;
    description = bg.description;
  }

  const base = formatChatDetail(mapChatDetail(chatData, { member_count: memberCount, description }));

  if (!isForum) return base;

  // Forum chat: append topic summary (open topics + count of closed)
  const lines: string[] = [base, `  forum: yes`];
  try {
    const topicsRes = await client.invoke({
      _: "getForumTopics",
      chat_id: chatId,
      query: "",
      offset_date: 0,
      offset_message_id: 0,
      offset_forum_topic_id: 0,
      limit: 100,
    });
    const topics = (topicsRes as any).topics || [];
    const open = topics.filter((t: any) => !t.info?.is_closed).length;
    const closed = topics.filter((t: any) => t.info?.is_closed).length;
    lines.push(`  topics: ${topics.length} total (${open} open, ${closed} closed) — use "tg forum-topics ${chatId}" to list`);
  } catch {
    lines.push(`  topics: (unable to enumerate — use "tg forum-topics ${chatId}")`);
  }
  return lines.join("\n");
}

export async function history(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const limit = parseIntFlag(args, "--limit", 50);
  const full = args.includes("--full");
  const fetchAll = args.includes("--all");
  const fromMsgId = parseIntFlag(args, "--from", 0);
  const threadId = parseIntFlag(args, "--topic", 0);

  // Date filters: --date=YYYY-MM-DD (shortcut for single day) or --from-date / --to-date
  const dateStr = parseStringFlag(args, "--date");
  const fromDateStr = parseStringFlag(args, "--from-date");
  const toDateStr = parseStringFlag(args, "--to-date");

  let fromDateTs = 0;
  let toDateTs = 0;

  if (dateStr) {
    // Single day: from start of that day to end of that day
    fromDateTs = parseDateToUnix(dateStr);
    toDateTs = fromDateTs + 86400; // +24h
  } else {
    if (fromDateStr) fromDateTs = parseDateToUnix(fromDateStr);
    if (toDateStr) toDateTs = parseDateToUnix(toDateStr) + 86400; // include the whole end day
  }

  const client = await getClient();
  const detail = full ? "full" : "preview";

  // If a date is specified, find the starting message ID via getChatMessageByDate
  let startMsgId = fromMsgId;
  if (toDateTs && !fromMsgId) {
    try {
      const msg = await client.invoke({
        _: "getChatMessageByDate",
        chat_id: chatId,
        date: toDateTs,
      });
      if (msg?.id) startMsgId = msg.id;
    } catch {
      // Fall through — start from latest
    }
  }

  // Determine if we need to auto-paginate
  const shouldPaginate = fetchAll || fromDateTs > 0;
  const batchSize = shouldPaginate ? 100 : limit;
  const maxMessages = fetchAll ? Infinity : limit;

  const allMessages: any[] = [];
  let currentFromId = startMsgId;
  let done = false;

  while (!done && allMessages.length < maxMessages) {
    const fetchLimit = Math.min(batchSize, (maxMessages - allMessages.length) + 1);
    const result = threadId
      ? await client.invoke({
          _: "getMessageThreadHistory",
          chat_id: chatId,
          message_id: threadId,
          from_message_id: currentFromId,
          offset: 0,
          limit: fetchLimit,
        })
      : await client.invoke({
          _: "getChatHistory",
          chat_id: chatId,
          from_message_id: currentFromId,
          offset: 0,
          limit: fetchLimit,
          only_local: false,
        });

    const batch = result.messages || [];
    if (batch.length === 0) {
      done = true;
      break;
    }

    for (const m of batch) {
      // Stop if we've gone past the from-date boundary (messages are newest-first)
      if (fromDateTs && m.date < fromDateTs) {
        done = true;
        break;
      }
      // Skip messages newer than to-date (shouldn't happen often with getChatMessageByDate, but safety)
      if (toDateTs && m.date >= toDateTs) continue;

      allMessages.push(m);
      if (allMessages.length >= maxMessages) break;
    }

    currentFromId = batch[batch.length - 1].id;

    // If we got fewer than requested, no more messages
    if (batch.length < fetchLimit) {
      done = true;
    }
  }

  const hasMore = !done && allMessages.length >= maxMessages;
  const mapped = await resolveSenderNames(
    client,
    allMessages.map((m: any) => mapMessage(m, detail))
  );

  const header = allMessages.length > 0
    ? `Fetched ${allMessages.length} message(s)${fromDateTs || toDateTs ? ` (date range: ${fromDateStr || dateStr || "earliest"} → ${toDateStr || dateStr || "latest"})` : ""}\n\n`
    : "";

  return header + formatMessages(mapped, hasMore);
}

// Telegram caps a single text message at 4096 UTF-16 code units.
// We use a slightly lower cap to leave room for the "(N/M) " chunk prefix.
export const TG_MAX_TEXT_LEN = 4096;
const CHUNK_SIZE = 3900;

/**
 * Split a long message into chunks ≤ chunkSize chars.
 * Prefers paragraph (\n\n), then line, then sentence, then word boundaries.
 * Hard-breaks only if no boundary found in the latter half of a chunk.
 */
export function splitMessage(text: string, chunkSize: number = CHUNK_SIZE): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let remaining = text;
  const minSplitFraction = 0.5; // require boundary within latter half of window

  while (remaining.length > chunkSize) {
    const window = remaining.slice(0, chunkSize);
    const minPos = Math.floor(chunkSize * minSplitFraction);
    let splitAt = -1;
    let delimLen = 0;

    const paraIdx = window.lastIndexOf("\n\n");
    if (paraIdx >= minPos) {
      splitAt = paraIdx;
      delimLen = 2;
    } else {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx >= minPos) {
        splitAt = lineIdx;
        delimLen = 1;
      } else {
        const sentIdx = window.lastIndexOf(". ");
        if (sentIdx >= minPos) {
          splitAt = sentIdx + 1; // keep the period, break at the space
          delimLen = 1;
        } else {
          const spaceIdx = window.lastIndexOf(" ");
          if (spaceIdx >= minPos) {
            splitAt = spaceIdx;
            delimLen = 1;
          } else {
            splitAt = chunkSize; // hard break
            delimLen = 0;
          }
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt + delimLen);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// Cache chat-type lookups within a single CLI invocation so we don't refetch
// for every chunk of a split message.
const chatTypeCache = new Map<number, string>();
async function getChatTypeKind(client: any, chatId: number): Promise<string> {
  const cached = chatTypeCache.get(chatId);
  if (cached) return cached;
  try {
    const chat = await client.invoke({ _: "getChat", chat_id: chatId });
    const kind = chat?.type?._ ?? "unknown";
    chatTypeCache.set(chatId, kind);
    return kind;
  } catch {
    return "unknown";
  }
}

// Build the topic_id payload (TDLib's MessageTopic) appropriate for the chat
// kind. Bot DMs with forum topics (Bot API 9.4, used by HubV2) need
// messageTopicForum; supergroup forum threads need messageTopicThread.
// Verified empirically on TDLib 1.8.64: messageTopicThread on a bot DM is
// rejected with "Chat doesn't have threads"; the legacy message_thread_id
// field is silently dropped. messageTopicForum is the only variant that
// actually sets topic_id on bot DM sends.
async function buildTopicId(
  client: any,
  chatId: number,
  threadId: number
): Promise<any | undefined> {
  if (!threadId) return undefined;
  const kind = await getChatTypeKind(client, chatId);
  if (kind === "chatTypePrivate") {
    return { _: "messageTopicForum", forum_topic_id: threadId };
  }
  return { _: "messageTopicThread", message_thread_id: threadId };
}

async function resolveTopicReplyTo(client: any, chatId: number, threadId: number): Promise<any> {
  try {
    const history = await client.invoke({
      _: "getChatHistory",
      chat_id: chatId,
      from_message_id: 0,
      offset: 0,
      limit: 1,
      only_local: false,
      message_thread_id: threadId,
    });
    const lastMsg = history?.messages?.[0];
    if (lastMsg?.id) {
      return { _: "inputMessageReplyToMessage", message_id: lastMsg.id };
    }
  } catch {}
  return { _: "inputMessageReplyToMessage", message_id: threadId };
}

async function sendTextChunk(
  client: any,
  chatId: number,
  text: string,
  replyToMsgId?: number,
  messageThreadId?: number,
  formatted?: any,
  quote?: any,
): Promise<{ localId: number; newId?: number; ok: boolean; error?: string }> {
  const payload = formatted ?? { _: "formattedText", text };
  const req: any = {
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: {
      _: "inputMessageText",
      text: payload,
    },
  };
  if (replyToMsgId) {
    req.reply_to = { _: "inputMessageReplyToMessage", message_id: replyToMsgId };
    if (quote) req.reply_to.quote = quote;
  } else if (messageThreadId) {
    req.reply_to = await resolveTopicReplyTo(client, chatId, messageThreadId);
  }
  const result = await client.invoke(req);
  const res = await waitForMessageSend(client, result.id);
  if (res.ok) return { localId: result.id, newId: res.newMessageId, ok: true };
  return { localId: result.id, ok: false, error: res.error };
}

export async function send(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  let threadId = parseIntFlag(args, "--topic", 0);
  const hubTopic = parseStringFlag(args, "--hub-topic");
  if (hubTopic) {
    const resolved = resolveHubTopic(hubTopic);
    if (!resolved) {
      throw new Error(
        `--hub-topic="${hubTopic}" did not match any open HubV2 topic. ` +
          `Check ~/Documents/HubV2/data/topicStore.json for available names.`
      );
    }
    threadId = resolved.thread_id;
  }
  const mode = detectFormatMode(args);
  const text = args
    .slice(1)
    .filter((a) => !a.startsWith("--topic=") && !a.startsWith("--hub-topic=") && a !== "--markdown" && a !== "--md" && a !== "--html")
    .join(" ");
  if (!text)
    throw new Error("Usage: tg send <chat_id> <text> [--topic=<thread_id>|--hub-topic=<name>] [--markdown|--html]");

  const client = await getClient();
  const chunks = splitMessage(text);

  if (chunks.length === 1) {
    const formatted = mode === "plain" ? undefined : await parseFormattedText(client, chunks[0], mode);
    const r = await sendTextChunk(client, chatId, chunks[0], undefined, threadId || undefined, formatted);
    if (!r.ok) throw new Error(`Send failed: ${r.error}`);
    return formatSuccess({ message_id: r.newId ?? r.localId, status: "sent" });
  }

  const total = chunks.length;
  const ids: number[] = [];
  for (let i = 0; i < total; i++) {
    const body = `(${i + 1}/${total}) ${chunks[i]}`;
    const formatted = mode === "plain" ? undefined : await parseFormattedText(client, body, mode);
    const r = await sendTextChunk(client, chatId, body, undefined, threadId || undefined, formatted);
    if (!r.ok) {
      throw new Error(
        `Send failed on chunk ${i + 1}/${total}: ${r.error}. ` +
          `Prior chunks sent (ids): ${ids.join(",") || "none"}`
      );
    }
    ids.push(r.newId ?? r.localId);
  }
  return formatSuccess({
    message_ids: ids.join(","),
    chunks: total,
    status: "sent",
  });
}

export async function sendFile(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseIntFlag(args, "--topic", 0);
  const positional = args.filter((a) => !a.startsWith("--topic=") && a !== "--quiet");
  const filePath = positional[1];
  if (!filePath) throw new Error("Usage: tg send-file <chat_id> <file_path> [caption] [--topic=<thread_id>] [--quiet]");
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const caption = positional.slice(2).join(" ");
  const usePrimary = args.includes("--primary");
  const client = await getClient(usePrimary ? "primary" : "upload");
  const req: any = {
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: {
      _: "inputMessageDocument",
      document: { _: "inputFileLocal", path: filePath },
      caption: caption ? { _: "formattedText", text: caption } : undefined,
    },
  };
  if (threadId) {
    req.reply_to = await resolveTopicReplyTo(client, chatId, threadId);
  }

  const canonicalPath = realpathSync(filePath);
  const fileSize = statSync(filePath).size;
  const quiet = args.includes("--quiet");
  const showProgress = !quiet;
  const totalMiB = fileSize / 1048576;
  const startedAt = Date.now();
  let lastUploaded = 0;
  let lastProgressAt = startedAt;
  let lastPrintedPct = -5;
  const stallMs = 120_000;
  let uploadFileId: number | null = null;
  const progressHandler = (update: any) => {
    if (update._ !== "updateFile") return;
    const f = update.file;
    if (process.env.TG_DEBUG_FILE === "1") {
      process.stderr.write(`[updateFile] id=${f?.id} local.path=${f?.local?.path} remote.uploaded=${f?.remote?.uploaded_size} size=${f?.size}\n`);
    }
    const matchesPath = f?.local?.path && (f.local.path === filePath || f.local.path === canonicalPath);
    const matchesId = uploadFileId !== null && f?.id === uploadFileId;
    if (!matchesPath && !matchesId) return;
    if (uploadFileId === null && f?.id) uploadFileId = f.id;
    const uploaded = f.remote?.uploaded_size ?? 0;
    if (uploaded > lastUploaded) {
      lastUploaded = uploaded;
      lastProgressAt = Date.now();
      if (showProgress && fileSize > 0) {
        const pct = (uploaded / fileSize) * 100;
        if (pct - lastPrintedPct >= 5 || uploaded === fileSize) {
          lastPrintedPct = pct;
          const elapsed = (Date.now() - startedAt) / 1000;
          const mbps = uploaded / 1048576 / Math.max(elapsed, 0.001);
          process.stderr.write(
            `upload: ${(uploaded / 1048576).toFixed(1)}/${totalMiB.toFixed(1)} MiB (${pct.toFixed(1)}%) — ${mbps.toFixed(2)} MiB/s\n`,
          );
        }
      }
    }
  };
  client.on("update", progressHandler);

  // Roomy timeout: scaled to size (assume ~250 KB/s worst case) + 60s overhead, clamped 5min–2h.
  const timeoutMs = Math.min(2 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, (fileSize / 250_000) * 1000 + 60_000));

  try {
    const result = await client.invoke(req);
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > stallMs && lastUploaded > 0 && lastUploaded < fileSize) {
        if (showProgress) process.stderr.write(`[warn] upload stalled — no progress in ${stallMs / 1000}s\n`);
      }
    }, 30_000);
    const res = await waitForMessageSend(client, result.id, timeoutMs);
    clearInterval(stallTimer);
    if (!res.ok) throw new Error(`Send-file failed: ${res.error}`);
    return formatSuccess({ message_id: res.newMessageId ?? result.id, status: "sent", bytes: fileSize });
  } finally {
    client.off("update", progressHandler);
  }
}

export async function sendSticker(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const stickerInput = args[1];
  if (!stickerInput)
    throw new Error(
      "Usage: tg send-sticker <chat_id> <file_path | remote_file_id>\n" +
      "  file_path: local .webp/.tgs/.webm sticker file\n" +
      "  remote_file_id: TDLib remote file ID from 'tg stickers' output"
    );

  const client = await getClient();

  // Determine input file type: local path vs remote file ID
  let inputFile: Record<string, unknown>;
  if (existsSync(stickerInput)) {
    inputFile = { _: "inputFileLocal", path: stickerInput };
  } else {
    // Treat as remote file ID string
    inputFile = { _: "inputFileRemote", id: stickerInput };
  }

  const result = await client.invoke({
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: {
      _: "inputMessageSticker",
      sticker: inputFile,
    },
  });

  const res = await waitForMessageSend(client, result.id);
  if (!res.ok) throw new Error(`Send-sticker failed: ${res.error}`);
  return formatSuccess({ message_id: res.newMessageId ?? result.id, status: "sent" });
}

export async function stickers(args: string[]): Promise<string> {
  const query = args.join(" ");
  if (!query)
    throw new Error(
      "Usage: tg stickers <emoji_or_query>\n" +
      "  Search for stickers by emoji (e.g. tg stickers 👋) or keyword (e.g. tg stickers hello)"
    );

  const client = await getClient();

  // Try searching installed sticker sets by emoji first
  let stickerIds: any[] = [];
  try {
    const result = await client.invoke({
      _: "searchStickers",
      sticker_type: { _: "stickerTypeRegular" },
      emojis: query,
      limit: 20,
    });
    stickerIds = (result as any).sticker_ids || (result as any).stickers || [];
  } catch {
    // searchStickers throws EMOTICON_EMPTY for non-emoji queries — fall through to pack name search
  }

  if (!Array.isArray(stickerIds) || stickerIds.length === 0) {
    // Try searching by sticker set name
    const sets = await client.invoke({
      _: "searchStickerSets",
      sticker_type: { _: "stickerTypeRegular" },
      query,
      limit: 5,
    });

    const setResults: string[] = [];
    const stickerSets = (sets as any).sets || [];
    for (const set of stickerSets.slice(0, 5)) {
      setResults.push(
        `[SET] ${set.title} (${set.name}) — ${set.size || "?"} stickers`
      );

      // Get first few stickers from this set
      const fullSet = await client.invoke({
        _: "getStickerSet",
        set_id: set.id,
      });
      const setStickers = (fullSet as any).stickers || [];
      for (const s of setStickers.slice(0, 10)) {
        const remoteId = s.sticker?.remote?.id || "unknown";
        const emoji = s.emoji || "";
        setResults.push(`  ${emoji} remote_file_id: ${remoteId}`);
      }
    }

    if (setResults.length === 0) {
      return "No stickers found for: " + query;
    }
    return setResults.join("\n");
  }

  // Format sticker results
  const lines: string[] = [];
  for (const sticker of stickerIds.slice(0, 20)) {
    if (typeof sticker === "object" && sticker !== null) {
      const remoteId = sticker.sticker?.remote?.id || "unknown";
      const emoji = sticker.emoji || "";
      const setId = sticker.set_id || "";
      lines.push(`${emoji} remote_file_id: ${remoteId} (set: ${setId})`);
    }
  }

  if (lines.length === 0) {
    return "No stickers found for: " + query;
  }

  return `Found ${lines.length} stickers for "${query}":\n` + lines.join("\n");
}

export async function stickerPacks(args: string[]): Promise<string> {
  const client = await getClient();
  const filter = args.join(" ").toLowerCase();

  const result = await client.invoke({
    _: "getInstalledStickerSets",
    sticker_type: { _: "stickerTypeRegular" },
  });

  const sets = (result as any).sets || [];
  const lines: string[] = [];

  for (const set of sets) {
    const title = set.title || "";
    const name = set.name || "";
    const size = set.size || "?";

    if (filter && !title.toLowerCase().includes(filter) && !name.toLowerCase().includes(filter)) {
      continue;
    }

    lines.push(`[SET] ${title} (${name}) — ${size} stickers — id: ${set.id}`);
  }

  if (lines.length === 0) {
    return filter ? `No installed packs matching "${filter}"` : "No installed sticker packs";
  }

  return `Installed sticker packs${filter ? ` matching "${filter}"` : ""}:\n` + lines.join("\n");
}

export async function stickerPackStickers(args: string[]): Promise<string> {
  const client = await getClient();
  const setId = args[0];
  if (!setId) throw new Error("Usage: tg sticker-pack-stickers <set_id>");

  // TDLib also supports searching by name — try name first, then numeric id
  let fullSet: any;
  if (/^\d+$/.test(setId)) {
    // Try as name first by searching, then fall back to numeric
    try {
      fullSet = await client.invoke({
        _: "searchStickerSet",
        name: setId,
      });
    } catch {
      fullSet = await client.invoke({
        _: "getStickerSet",
        set_id: setId,
      });
    }
  } else {
    fullSet = await client.invoke({
      _: "searchStickerSet",
      name: setId,
    });
  }

  const title = (fullSet as any).title || "Unknown";
  const setStickers = (fullSet as any).stickers || [];
  const lines: string[] = [`Pack: ${title} — ${setStickers.length} stickers\n`];

  for (let i = 0; i < setStickers.length; i++) {
    const s = setStickers[i];
    const remoteId = s.sticker?.remote?.id || "unknown";
    const emoji = s.emoji || "";
    lines.push(`  ${i + 1}. ${emoji} remote_file_id: ${remoteId}`);
  }

  return lines.join("\n");
}

export async function reply(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const replyToId = parseRequiredNumber(args[1], "reply_to_id");
  let threadId = parseIntFlag(args, "--topic", 0);
  const hubTopic = parseStringFlag(args, "--hub-topic");
  if (hubTopic) {
    const resolved = resolveHubTopic(hubTopic);
    if (!resolved) {
      throw new Error(
        `--hub-topic="${hubTopic}" did not match any open HubV2 topic.`
      );
    }
    threadId = resolved.thread_id;
  }
  const mode = detectFormatMode(args);
  const quoteRaw = parseStringFlag(args, "--quote");
  const text = args
    .slice(2)
    .filter((a) => !a.startsWith("--topic=") && !a.startsWith("--hub-topic=") && !a.startsWith("--quote=") && a !== "--markdown" && a !== "--md" && a !== "--html")
    .join(" ");
  if (!text)
    throw new Error(
      "Usage: tg reply <chat_id> <reply_to_id> <text> [--topic=<thread_id>|--hub-topic=<name>] [--quote=<substring>] [--markdown|--html]"
    );

  const client = await getClient();
  const quote = quoteRaw ? { _: "inputTextQuote", text: { _: "formattedText", text: quoteRaw, entities: [] }, position: 0 } : undefined;
  const chunks = splitMessage(text);

  if (chunks.length === 1) {
    const formatted = mode === "plain" ? undefined : await parseFormattedText(client, chunks[0], mode);
    const r = await sendTextChunk(client, chatId, chunks[0], replyToId, threadId || undefined, formatted, quote);
    if (!r.ok) throw new Error(`Reply failed: ${r.error}`);
    return formatSuccess({ message_id: r.newId ?? r.localId, status: "sent" });
  }

  const total = chunks.length;
  const ids: number[] = [];
  for (let i = 0; i < total; i++) {
    const body = `(${i + 1}/${total}) ${chunks[i]}`;
    const formatted = mode === "plain" ? undefined : await parseFormattedText(client, body, mode);
    const r = await sendTextChunk(client, chatId, body, i === 0 ? replyToId : undefined, threadId || undefined, formatted, i === 0 ? quote : undefined);
    if (!r.ok) {
      throw new Error(
        `Reply failed on chunk ${i + 1}/${total}: ${r.error}. ` +
          `Prior chunks sent (ids): ${ids.join(",") || "none"}`
      );
    }
    ids.push(r.newId ?? r.localId);
  }
  return formatSuccess({
    message_ids: ids.join(","),
    chunks: total,
    status: "sent",
  });
}

export async function forward(args: string[]): Promise<string> {
  const fromChatId = parseRequiredNumber(args[0], "from_chat_id");
  const toChatId = parseRequiredNumber(args[1], "to_chat_id");
  const msgIds = args.slice(2).map((id) => {
    const n = Number(id);
    if (isNaN(n)) throw new Error(`Invalid message ID: ${id}`);
    return n;
  });
  if (msgIds.length === 0) throw new Error("Usage: tg forward <from_chat> <to_chat> <msg_ids...>");

  const client = await getClient();
  const result = await client.invoke({
    _: "forwardMessages",
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_ids: msgIds,
  });

  const forwardedIds = result.messages?.map((m: any) => m.id) || [];
  return formatSuccess({ forwarded_ids: forwardedIds.join(", "), status: "forwarded" });
}

export async function edit(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "message_id");
  const mode = detectFormatMode(args);
  const text = args.slice(2).filter((a) => a !== "--markdown" && a !== "--md" && a !== "--html").join(" ");
  if (!text) throw new Error("Usage: tg edit <chat_id> <message_id> <text> [--markdown|--html]");

  const client = await getClient();
  const formatted = mode === "plain" ? { _: "formattedText", text, entities: [] } : await parseFormattedText(client, text, mode);
  await client.invoke({
    _: "editMessageText",
    chat_id: chatId,
    message_id: msgId,
    input_message_content: {
      _: "inputMessageText",
      text: formatted,
    },
  });

  return formatSuccess({ status: "edited" });
}

export async function editCaption(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "message_id");
  const mode = detectFormatMode(args);
  const text = args.slice(2).filter((a) => a !== "--markdown" && a !== "--md" && a !== "--html").join(" ");
  const client = await getClient();
  const formatted = !text
    ? { _: "formattedText", text: "", entities: [] }
    : mode === "plain"
      ? { _: "formattedText", text, entities: [] }
      : await parseFormattedText(client, text, mode);
  await client.invoke({
    _: "editMessageCaption",
    chat_id: chatId,
    message_id: msgId,
    caption: formatted,
  });
  return formatSuccess({ status: "edited" });
}

export async function deleteMessages(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const silent = args.includes("--silent");
  const msgIds = args
    .slice(1)
    .filter((a) => !a.startsWith("--"))
    .map((id) => {
      const n = Number(id);
      if (isNaN(n)) throw new Error(`Invalid message ID: ${id}`);
      return n;
    });
  if (msgIds.length === 0) throw new Error("Usage: tg delete <chat_id> <msg_ids...> [--silent]");

  const client = await getClient();
  await client.invoke({
    _: "deleteMessages",
    chat_id: chatId,
    message_ids: msgIds,
    revoke: !silent,
  });

  return formatSuccess({ deleted: msgIds.join(", "), status: "deleted" });
}

export async function search(args: string[]): Promise<string> {
  const query = args.filter((a) => !a.startsWith("--")).join(" ");

  const chatId = parseIntFlag(args, "--chat", 0);
  const limit = parseIntFlag(args, "--limit", 50);
  const full = args.includes("--full");
  const filter = parseFilterType(args);
  const senderId = parseIntFlag(args, "--sender", 0);
  const fromMsgId = parseIntFlag(args, "--from", 0);

  // Accept both unix timestamps and YYYY-MM-DD dates
  const fromDateRaw = parseStringFlag(args, "--from-date");
  const toDateRaw = parseStringFlag(args, "--to-date");
  const fromDate = fromDateRaw ? (isNaN(Number(fromDateRaw)) ? parseDateToUnix(fromDateRaw) : Number(fromDateRaw)) : 0;
  const toDate = toDateRaw ? (isNaN(Number(toDateRaw)) ? parseDateToUnix(toDateRaw) + 86400 : Number(toDateRaw)) : 0;

  if (!query && !chatId && !filter) {
    throw new Error(
      "Usage: tg search <query> [--chat=<id>] [--type=voice|photo|video|document|link|audio] [--sender=<id>] [--from=<msg_id>] [--limit=50] [--from-date=YYYY-MM-DD] [--to-date=YYYY-MM-DD] [--full]"
    );
  }

  if (!chatId && !query) {
    throw new Error("Global search requires a query. Use --chat=<id> for type-only filtering.");
  }

  const client = await getClient();
  const detail = full ? "full" : "preview";

  if (chatId) {
    const shouldPaginate = (fromDate > 0 || toDate > 0) && !fromMsgId;
    const batchSize = shouldPaginate ? 100 : limit;
    const senderParam = senderId
      ? { _: "messageSenderUser" as const, user_id: senderId }
      : undefined;

    const allMessages: any[] = [];
    let currentFromId = fromMsgId;
    let done = false;
    let totalCount = 0;

    while (!done && allMessages.length < limit) {
      const fetchLimit = Math.min(batchSize, limit - allMessages.length + 1);
      const result = await client.invoke({
        _: "searchChatMessages",
        chat_id: chatId,
        query,
        sender_id: senderParam,
        from_message_id: currentFromId,
        offset: 0,
        limit: fetchLimit,
        filter,
        message_thread_id: 0,
        saved_messages_topic_id: 0,
      });

      totalCount = result.total_count;
      const batch = result.messages || [];
      if (batch.length === 0) { done = true; break; }

      for (const m of batch) {
        if (fromDate && m.date < fromDate) { done = true; break; }
        if (toDate && m.date >= toDate) continue;
        allMessages.push(m);
        if (allMessages.length >= limit) break;
      }

      currentFromId = batch[batch.length - 1].id;
      if (batch.length < fetchLimit) done = true;
      if (!shouldPaginate) done = true;
    }

    const chatData = await client.invoke({ _: "getChat", chat_id: chatId });
    const mapped = await resolveSenderNames(
      client,
      allMessages.map((m: any) => ({
        ...mapMessage(m, detail),
        chat_id: chatId,
        chat_title: chatData.title,
      }))
    );

    const hasMore = !done || allMessages.length >= limit;
    const lastId = allMessages.length > 0 ? allMessages[allMessages.length - 1].id : undefined;
    return formatSearchResults(mapped as any, totalCount, hasMore, lastId);
  }

  // Global search
  const result = await client.invoke({
    _: "searchMessages",
    chat_list: { _: "chatListMain" as const },
    only_in_channels: false,
    query,
    offset: "",
    limit,
    filter,
    min_date: fromDate,
    max_date: toDate,
  });

  const messages = await Promise.all(
    (result.messages || []).map(async (m: any) => {
      const chatData = await client.invoke({ _: "getChat", chat_id: m.chat_id });
      return {
        ...mapMessage(m, detail),
        chat_id: m.chat_id,
        chat_title: chatData.title,
      };
    })
  );

  const resolved = await resolveSenderNames(client, messages);
  const hasMore = messages.length >= limit;
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : undefined;
  return formatSearchResults(resolved as any, result.total_count, hasMore, lastId);
}

export async function contacts(args: string[]): Promise<string> {
  const limit = parseIntFlag(args, "--limit", 50);

  const client = await getClient();
  const result = await client.invoke({ _: "getContacts" });

  const userIds = result.user_ids.slice(0, limit);
  const users = await Promise.all(
    userIds.map((id: number) => client.invoke({ _: "getUser", user_id: id }))
  );

  return formatContacts(users.map(mapContact));
}

export async function user(args: string[]): Promise<string> {
  const userId = parseRequiredNumber(args[0], "user_id");

  const client = await getClient();
  const userData = await client.invoke({ _: "getUser", user_id: userId });
  const fullInfo = await client.invoke({ _: "getUserFullInfo", user_id: userId });

  return formatUser(mapUser(userData, fullInfo.bio?.text));
}

export async function dm(args: string[]): Promise<string> {
  const identifier = args[0];
  if (!identifier) throw new Error("Usage: tg dm <username|phone|user_id>");

  const client = await getClient();
  let resolvedUserId: number | undefined;

  // Try as number (user_id)
  const asNum = Number(identifier);
  if (!isNaN(asNum) && String(asNum) === identifier) {
    resolvedUserId = asNum;
  }

  // Try as username
  if (!resolvedUserId) {
    const username = identifier.replace(/^@/, "");
    try {
      const result = await client.invoke({ _: "searchPublicChat", username });
      if (result.type?._ === "chatTypePrivate") {
        resolvedUserId = result.type.user_id;
      } else {
        return `Error: "${username}" is not a private user`;
      }
    } catch {
      // Try as phone number
      try {
        const result = await client.invoke({
          _: "searchUserByPhoneNumber",
          phone_number: identifier,
        });
        resolvedUserId = result.id;
      } catch {
        return `Error: Could not find user "${identifier}"`;
      }
    }
  }

  const chatResult = await client.invoke({
    _: "createPrivateChat",
    user_id: resolvedUserId!,
    force: false,
  });

  return formatSuccess({ chat_id: chatResult.id, status: "ready" });
}

export async function read(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgIds = args.slice(1).map(Number).filter((n) => !isNaN(n));

  const client = await getClient();

  if (msgIds.length > 0) {
    await client.invoke({
      _: "viewMessages",
      chat_id: chatId,
      message_ids: msgIds,
      force_read: true,
    });
  } else {
    const chatData = await client.invoke({ _: "getChat", chat_id: chatId });
    if (chatData.last_message) {
      await client.invoke({
        _: "viewMessages",
        chat_id: chatId,
        message_ids: [chatData.last_message.id],
        force_read: true,
      });
    }
  }

  return formatSuccess({ status: "read" });
}

export async function unread(_args: string[]): Promise<string> {
  const client = await getClient();
  const result = await client.invoke({
    _: "getChats",
    chat_list: { _: "chatListMain" },
    limit: 100,
  });

  const allChats = await Promise.all(
    result.chat_ids.map((id: number) => client.invoke({ _: "getChat", chat_id: id }))
  );

  const unreadChats = allChats
    .filter((c: any) => c.unread_count > 0)
    .map((c: any) => ({
      id: c.id,
      title: c.title,
      unread_count: c.unread_count,
      muted: !!(c.notification_settings?.mute_for),
    }));

  return formatUnreadChats(unreadChats);
}

export async function pin(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "message_id");
  const silent = args.includes("--silent");

  const client = await getClient();
  await client.invoke({
    _: "pinChatMessage",
    chat_id: chatId,
    message_id: msgId,
    disable_notification: silent,
    only_for_self: false,
  });

  return formatSuccess({ status: "pinned" });
}

export async function unpin(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "message_id");

  const client = await getClient();
  await client.invoke({
    _: "unpinChatMessage",
    chat_id: chatId,
    message_id: msgId,
  });

  return formatSuccess({ status: "unpinned" });
}

export async function download(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgIds = args
    .slice(1)
    .filter((a) => !a.startsWith("--"))
    .map((id) => {
      const n = Number(id);
      if (isNaN(n)) throw new Error(`Invalid message ID: ${id}`);
      return n;
    });
  if (msgIds.length === 0) throw new Error("Usage: tg download <chat_id> <msg_id...> [--out=<dir>]");

  const outDir = parseStringFlag(args, "--out") || process.cwd();
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const client = await getClient();
  const results: string[] = [];

  for (const msgId of msgIds) {
    const msg = await client.invoke({
      _: "getMessage",
      chat_id: chatId,
      message_id: msgId,
    });

    const file = extractFileFromContent(msg.content);
    if (!file) {
      results.push(`[MSG ${msgId}] no downloadable media found (type: ${msg.content._})`);
      continue;
    }

    const { fileObj, extension, mediaType } = file;

    // Download via TDLib
    const downloaded = await client.invoke({
      _: "downloadFile",
      file_id: fileObj.id,
      priority: 32,
      offset: 0,
      limit: 0,
      synchronous: true,
    });

    const localPath = downloaded.local?.path;
    if (!localPath || !downloaded.local?.is_downloading_completed) {
      results.push(`[MSG ${msgId}] download failed — file not ready`);
      continue;
    }

    // Copy to output dir with a descriptive name
    const timestamp = new Date(msg.date * 1000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outName = `${mediaType}_${msgId}_${timestamp}${extension}`;
    const outPath = join(outDir, outName);
    copyFileSync(localPath, outPath);

    results.push(`[MSG ${msgId}] ${mediaType} → ${outPath}`);
  }

  return results.join("\n");
}

function extractFileFromContent(
  content: Record<string, any>
): { fileObj: any; extension: string; mediaType: string } | null {
  switch (content._) {
    case "messageVoiceNote":
      return {
        fileObj: content.voice_note?.voice,
        extension: ".ogg",
        mediaType: "voice_note",
      };
    case "messageAudio":
      return {
        fileObj: content.audio?.audio,
        extension: content.audio?.file_name
          ? getExtension(content.audio.file_name)
          : ".mp3",
        mediaType: "audio",
      };
    case "messageVideo":
      return {
        fileObj: content.video?.video,
        extension: content.video?.file_name
          ? getExtension(content.video.file_name)
          : ".mp4",
        mediaType: "video",
      };
    case "messageVideoNote":
      return {
        fileObj: content.video_note?.video,
        extension: ".mp4",
        mediaType: "video_note",
      };
    case "messageDocument":
      return {
        fileObj: content.document?.document,
        extension: content.document?.file_name
          ? getExtension(content.document.file_name)
          : "",
        mediaType: "document",
      };
    case "messagePhoto": {
      // Pick the largest photo size
      const sizes = content.photo?.sizes || [];
      const largest = sizes[sizes.length - 1];
      if (!largest) return null;
      return {
        fileObj: largest.photo,
        extension: ".jpg",
        mediaType: "photo",
      };
    }
    case "messageSticker":
      return {
        fileObj: content.sticker?.sticker,
        extension: content.sticker?.format?._ === "stickerFormatWebp" ? ".webp" : ".tgs",
        mediaType: "sticker",
      };
    case "messageAnimation":
      return {
        fileObj: content.animation?.animation,
        extension: ".mp4",
        mediaType: "animation",
      };
    default:
      return null;
  }
}

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot) : "";
}

// --- Chat creation / lifecycle ---

export async function createChannel(args: string[]): Promise<string> {
  const description = parseStringFlag(args, "--description") ?? "";
  const title = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!title) {
    throw new Error("Usage: tg create-channel <title> [--description=<text>]");
  }

  const client = await getClient();
  const result = await client.invoke({
    _: "createNewSupergroupChat",
    title,
    is_forum: false,
    is_channel: true,
    description,
    location: undefined,
    message_auto_delete_time: 0,
    for_import: false,
  });

  return formatSuccess({
    chat_id: (result as any).id,
    title: (result as any).title ?? title,
    type: "channel",
    status: "created",
  });
}

export async function createBasicGroup(args: string[]): Promise<string> {
  // Args: <title> <user_ids...>
  // Basic group needs at least one other member per TDLib.
  const nonFlag = args.filter((a) => !a.startsWith("--"));
  const title = nonFlag[0];
  const userIds = nonFlag.slice(1).map((s) => {
    const n = Number(s);
    if (isNaN(n)) throw new Error(`Invalid user_id: ${s}`);
    return n;
  });
  if (!title || userIds.length === 0) {
    throw new Error("Usage: tg create-basic-group <title> <user_id> [<user_id>...]");
  }

  const client = await getClient();
  const result = await client.invoke({
    _: "createNewBasicGroupChat",
    user_ids: userIds,
    title,
    message_auto_delete_time: 0,
  });

  const chatId = (result as any).chat_id ?? (result as any).id;
  return formatSuccess({
    chat_id: chatId,
    title,
    type: "basic_group",
    members: userIds.join(","),
    status: "created",
  });
}

export async function upgradeToSupergroup(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  if (!chatId) {
    throw new Error("Usage: tg upgrade-to-supergroup <chat_id>");
  }

  const client = await getClient();
  const chatData: any = await client.invoke({ _: "getChat", chat_id: chatId });
  if (chatData.type?._ !== "chatTypeBasicGroup") {
    throw new Error(
      `Chat ${chatId} is not a basic group (type=${chatData.type?._}). ` +
        `Only basic groups can be upgraded to supergroups.`,
    );
  }
  const oldBasicGroupId = chatData.type.basic_group_id;

  // TDLib returns a Chat object for the new supergroup.
  const newChat: any = await client.invoke({
    _: "upgradeBasicGroupChatToSupergroupChat",
    chat_id: chatId,
  });

  return formatSuccess({
    old_chat_id: chatId,
    old_basic_group_id: oldBasicGroupId,
    new_chat_id: newChat.id ?? newChat.chat_id,
    type: "supergroup",
    status: "upgraded",
  });
}

export async function createSecretChat(args: string[]): Promise<string> {
  const userId = parseRequiredNumber(args[0], "user_id");
  const client = await getClient();
  const result = await client.invoke({
    _: "createNewSecretChat",
    user_id: userId,
  });
  return formatSuccess({
    chat_id: (result as any).id,
    type: "secret",
    status: "created",
  });
}

export async function joinChat(args: string[]): Promise<string> {
  const arg = args[0];
  if (!arg) throw new Error("Usage: tg join-chat <chat_id|invite_link>");

  const client = await getClient();
  // Invite link detection: starts with https:// or t.me or contains /joinchat
  if (/^https?:\/\//i.test(arg) || arg.startsWith("t.me/") || arg.startsWith("+")) {
    const link = arg.startsWith("+") ? `https://t.me/${arg}` : arg;
    const chat = await client.invoke({
      _: "joinChatByInviteLink",
      invite_link: link,
    });
    return formatSuccess({
      chat_id: (chat as any).id,
      title: (chat as any).title ?? "",
      status: "joined",
    });
  }

  const chatId = parseRequiredNumber(arg, "chat_id");
  await client.invoke({ _: "joinChat", chat_id: chatId });
  return formatSuccess({ chat_id: chatId, status: "joined" });
}

export async function leaveChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  await client.invoke({ _: "leaveChat", chat_id: chatId });
  return formatSuccess({ chat_id: chatId, status: "left" });
}

export async function deleteChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  await client.invoke({ _: "deleteChat", chat_id: chatId });
  return formatSuccess({ chat_id: chatId, status: "deleted" });
}

// --- Member management ---

async function resolveUserInput(client: any, input: string): Promise<number> {
  // Accepts numeric user_id, @username, or username without @
  const asNum = Number(input);
  if (!isNaN(asNum) && String(asNum) === input.replace(/^@/, "")) return asNum;

  const uname = input.replace(/^@/, "");
  try {
    const chat = await client.invoke({ _: "searchPublicChat", username: uname });
    if (chat?.type?._ === "chatTypePrivate") return chat.type.user_id;
    // For bots, this is fine — they're chatTypePrivate
  } catch {}
  throw new Error(`Could not resolve user: ${input}`);
}

export async function addMember(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const remaining = args.slice(1).filter((a) => !a.startsWith("--"));
  if (remaining.length === 0) {
    throw new Error("Usage: tg add-member <chat_id> <user_id|username> [<user_id|username>...] [--forward-limit=N]");
  }
  const forwardLimit = parseIntFlag(args, "--forward-limit", 0);

  const client = await getClient();
  const userIds: number[] = [];
  for (const input of remaining) {
    userIds.push(await resolveUserInput(client, input));
  }

  if (userIds.length === 1) {
    await client.invoke({
      _: "addChatMember",
      chat_id: chatId,
      user_id: userIds[0],
      forward_limit: forwardLimit,
    });
  } else {
    await client.invoke({
      _: "addChatMembers",
      chat_id: chatId,
      user_ids: userIds,
    });
  }

  return formatSuccess({
    chat_id: chatId,
    added: userIds.join(","),
    status: "member_added",
  });
}

const ADMIN_RIGHT_FLAGS = [
  "can-manage-chat",
  "can-change-info",
  "can-post-messages",
  "can-edit-messages",
  "can-delete-messages",
  "can-invite-users",
  "can-restrict-members",
  "can-pin-messages",
  "can-manage-topics",
  "can-promote-members",
  "can-manage-video-chats",
  "can-post-stories",
  "can-edit-stories",
  "can-delete-stories",
  "is-anonymous",
];

function buildAdminRights(args: string[]): Record<string, boolean> {
  const allAdmin = args.includes("--all");
  const rights: Record<string, boolean> = {};
  for (const flag of ADMIN_RIGHT_FLAGS) {
    const key = flag.replace(/-/g, "_");
    rights[key] = allAdmin || args.includes(`--${flag}`);
  }
  return rights;
}

export async function promote(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput || userInput.startsWith("--")) {
    throw new Error(
      "Usage: tg promote <chat_id> <user_id|username> [--title=<text>] [--all | --can-xxx flags]\n" +
      "  Flags: " + ADMIN_RIGHT_FLAGS.map((f) => `--${f}`).join(" ")
    );
  }
  const customTitle = parseStringFlag(args, "--title") ?? "";
  const rights = buildAdminRights(args);

  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);

  await client.invoke({
    _: "setChatMemberStatus",
    chat_id: chatId,
    member_id: { _: "messageSenderUser", user_id: userId },
    status: {
      _: "chatMemberStatusAdministrator",
      custom_title: customTitle,
      can_be_edited: true,
      rights: {
        _: "chatAdministratorRights",
        ...rights,
      },
    },
  });

  const enabled = Object.entries(rights)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(",");
  return formatSuccess({
    chat_id: chatId,
    user_id: userId,
    title: customTitle || "(none)",
    rights: enabled || "(none)",
    status: "promoted",
  });
}

export async function demote(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput) throw new Error("Usage: tg demote <chat_id> <user_id|username>");

  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);

  await client.invoke({
    _: "setChatMemberStatus",
    chat_id: chatId,
    member_id: { _: "messageSenderUser", user_id: userId },
    status: { _: "chatMemberStatusMember", member_until_date: 0 },
  });

  return formatSuccess({ chat_id: chatId, user_id: userId, status: "demoted" });
}

export async function kick(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput) throw new Error("Usage: tg kick <chat_id> <user_id|username>");

  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);

  await client.invoke({
    _: "setChatMemberStatus",
    chat_id: chatId,
    member_id: { _: "messageSenderUser", user_id: userId },
    status: { _: "chatMemberStatusLeft" },
  });

  return formatSuccess({ chat_id: chatId, user_id: userId, status: "kicked" });
}

export async function ban(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput) throw new Error("Usage: tg ban <chat_id> <user_id|username> [--until=<unix_ts>]");
  const until = parseIntFlag(args, "--until", 0);

  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);

  await client.invoke({
    _: "setChatMemberStatus",
    chat_id: chatId,
    member_id: { _: "messageSenderUser", user_id: userId },
    status: {
      _: "chatMemberStatusBanned",
      banned_until_date: until,
    },
  });

  return formatSuccess({ chat_id: chatId, user_id: userId, until, status: "banned" });
}

export async function chatMembers(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const limit = parseIntFlag(args, "--limit", 100);
  const filter = parseStringFlag(args, "--filter") ?? "recent";

  const client = await getClient();
  const chat = await client.invoke({ _: "getChat", chat_id: chatId });
  const lines: string[] = [];

  if (chat.type._ === "chatTypeSupergroup") {
    const filterMap: Record<string, string> = {
      recent: "supergroupMembersFilterRecent",
      admins: "supergroupMembersFilterAdministrators",
      banned: "supergroupMembersFilterBanned",
      bots: "supergroupMembersFilterBots",
      restricted: "supergroupMembersFilterRestricted",
    };
    const tdlibFilter = filterMap[filter];
    if (!tdlibFilter) {
      throw new Error(`Unknown --filter: ${filter}. Valid: ${Object.keys(filterMap).join(", ")}`);
    }
    const result = await client.invoke({
      _: "getSupergroupMembers",
      supergroup_id: chat.type.supergroup_id,
      filter: { _: tdlibFilter },
      offset: 0,
      limit,
    });
    for (const m of (result as any).members || []) {
      const userId = m.member_id?.user_id;
      const status = m.status?._?.replace("chatMemberStatus", "") || "?";
      lines.push(`[MEMBER user_id=${userId} status=${status}]`);
    }
    lines.unshift(`Total: ${(result as any).total_count}`);
  } else if (chat.type._ === "chatTypeBasicGroup") {
    const bg = await client.invoke({
      _: "getBasicGroupFullInfo",
      basic_group_id: chat.type.basic_group_id,
    });
    for (const m of (bg as any).members || []) {
      const userId = m.member_id?.user_id;
      const status = m.status?._?.replace("chatMemberStatus", "") || "?";
      lines.push(`[MEMBER user_id=${userId} status=${status}]`);
    }
    lines.unshift(`Total: ${(bg as any).members?.length ?? 0}`);
  } else {
    throw new Error("chat-members only works on groups/supergroups/channels");
  }

  return lines.join("\n");
}

export async function createGroup(args: string[]): Promise<string> {
  const isForum = args.includes("--forum");
  const isChannel = args.includes("--channel");
  const description = parseStringFlag(args, "--description") ?? "";
  const title = args
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!title) {
    throw new Error(
      "Usage: tg create-group <title> [--forum] [--channel] [--description=<text>]"
    );
  }

  const client = await getClient();
  // TDLib quirk: passing `is_forum: true` to createNewSupergroupChat silently produces
  // a broadcast channel (ignoring is_channel: false). Workaround: create a plain
  // supergroup first, then flip is_forum via toggleSupergroupIsForum.
  const result = await client.invoke({
    _: "createNewSupergroupChat",
    title,
    is_forum: false,
    is_channel: isChannel,
    description,
    location: undefined,
    message_auto_delete_time: 0,
    for_import: false,
  });

  const chatId = (result as any).id;
  const supergroupId = (result as any).type?.supergroup_id;

  if (isForum && supergroupId && !isChannel) {
    await client.invoke({
      _: "toggleSupergroupIsForum",
      supergroup_id: supergroupId,
      is_forum: true,
      has_forum_tabs: false,
    });
  }

  return formatSuccess({
    chat_id: chatId,
    title: (result as any).title ?? title,
    is_forum: isForum && !isChannel ? "yes" : "no",
    is_channel: isChannel ? "yes" : "no",
    status: "created",
  });
}

// --- Forum topic verbs ---

export async function forumTopics(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const limit = parseIntFlag(args, "--limit", 100);
  const query = parseStringFlag(args, "--query") ?? "";

  const client = await getClient();
  const result = await client.invoke({
    _: "getForumTopics",
    chat_id: chatId,
    query,
    offset_date: 0,
    offset_message_id: 0,
    offset_forum_topic_id: 0,
    limit,
  });

  const topics = (result as any).topics || [];
  const mapped = topics.map((t: any) => mapForumTopic(t));
  return formatForumTopics(mapped);
}

export async function topic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseRequiredNumber(args[1], "thread_id");

  const client = await getClient();
  const result = await client.invoke({
    _: "getForumTopic",
    chat_id: chatId,
    forum_topic_id: threadId,
  });
  return formatForumTopic(mapForumTopic(result));
}

export async function createTopic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const name = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!name) throw new Error("Usage: tg create-topic <chat_id> <name>");

  const client = await getClient();
  // icon is optional — pass a default (no custom emoji, default color)
  const result = await client.invoke({
    _: "createForumTopic",
    chat_id: chatId,
    name,
    icon: {
      _: "forumTopicIcon",
      color: 0x6FB9F0,
      custom_emoji_id: "0",
    },
  });

  const info = (result as any).info ?? result;
  const threadId = info.forum_topic_id ?? info.message_thread_id ?? info.thread_id;
  return formatSuccess({
    thread_id: threadId,
    name,
    status: "created",
  });
}

export async function closeTopic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseRequiredNumber(args[1], "thread_id");

  const client = await getClient();
  await client.invoke({
    _: "toggleForumTopicIsClosed",
    chat_id: chatId,
    forum_topic_id: threadId,
    is_closed: true,
  });
  return formatSuccess({ thread_id: threadId, status: "closed" });
}

export async function reopenTopic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseRequiredNumber(args[1], "thread_id");

  const client = await getClient();
  await client.invoke({
    _: "toggleForumTopicIsClosed",
    chat_id: chatId,
    forum_topic_id: threadId,
    is_closed: false,
  });
  return formatSuccess({ thread_id: threadId, status: "reopened" });
}

export async function editTopic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseRequiredNumber(args[1], "thread_id");
  const name = args.slice(2).filter((a) => !a.startsWith("--")).join(" ");
  if (!name) throw new Error("Usage: tg edit-topic <chat_id> <thread_id> <name>");

  const client = await getClient();
  await client.invoke({
    _: "editForumTopic",
    chat_id: chatId,
    forum_topic_id: threadId,
    name,
    edit_icon_custom_emoji: false,
    icon_custom_emoji_id: "0",
  });
  return formatSuccess({ thread_id: threadId, name, status: "edited" });
}

export async function deleteTopic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseRequiredNumber(args[1], "thread_id");

  const client = await getClient();
  await client.invoke({
    _: "deleteForumTopic",
    chat_id: chatId,
    forum_topic_id: threadId,
  });
  return formatSuccess({ thread_id: threadId, status: "deleted" });
}

export async function rename(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const title = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!title) throw new Error("Usage: tg rename <chat_id> <new title>");
  if (title.length > 128) throw new Error("Title must be 1-128 characters");

  const client = await getClient();
  await client.invoke({
    _: "setChatTitle",
    chat_id: chatId,
    title,
  });
  return formatSuccess({ chat_id: chatId, title, status: "renamed" });
}

interface MappedForumTopic {
  thread_id: number;
  name: string;
  is_closed: boolean;
  is_hidden: boolean;
  is_general: boolean;
  unread_count: number;
  last_message_id: number | null;
  last_message_date: number | null;
}

function mapForumTopic(t: any): MappedForumTopic {
  const info = t.info ?? t;
  const lastMessage = t.last_message;
  return {
    thread_id: info.forum_topic_id ?? info.message_thread_id ?? info.thread_id ?? 0,
    name: info.name ?? "",
    is_closed: !!info.is_closed,
    is_hidden: !!info.is_hidden,
    is_general: !!info.is_general,
    unread_count: t.unread_count ?? 0,
    last_message_id: lastMessage?.id ?? null,
    last_message_date: lastMessage?.date ?? null,
  };
}

// --- Chat privacy / username verbs ---

async function requireSupergroupId(client: any, chatId: number): Promise<number> {
  const chat = await client.invoke({ _: "getChat", chat_id: chatId });
  if (chat.type?._ !== "chatTypeSupergroup") {
    const kind = chat.type?._?.replace("chatType", "").toLowerCase() ?? "unknown";
    throw new Error(
      `chat ${chatId} is a ${kind}, not a supergroup/channel — ` +
      `public usernames only apply to supergroups and channels`
    );
  }
  return chat.type.supergroup_id;
}

function mapChatPrivacy(
  chatId: number,
  chat: any,
  supergroup: any | null,
  fullInfo: any | null,
  currentType: FormattedChatPrivacy["type"]
): FormattedChatPrivacy {
  const usernamesObj = supergroup?.usernames ?? null;
  const activeUsernames: string[] = usernamesObj?.active_usernames ?? [];
  const disabledUsernames: string[] = usernamesObj?.disabled_usernames ?? [];
  const editableUsername: string = usernamesObj?.editable_username ?? "";
  const primaryUsername = activeUsernames[0] ?? editableUsername ?? "";

  return {
    chat_id: chatId,
    title: chat.title ?? "",
    type: currentType,
    is_public: activeUsernames.length > 0,
    username: primaryUsername || null,
    active_usernames: activeUsernames,
    disabled_usernames: disabledUsernames,
    has_linked_chat: !!supergroup?.has_linked_chat,
    has_protected_content: !!chat.has_protected_content,
    message_auto_delete_time: chat.message_auto_delete_time ?? 0,
    invite_link_url: fullInfo?.invite_link?.invite_link ?? null,
  };
}

export async function chatPrivacy(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  const chat = await client.invoke({ _: "getChat", chat_id: chatId });

  let supergroup: any = null;
  let fullInfo: any = null;
  let currentType: FormattedChatPrivacy["type"];

  if (chat.type?._ === "chatTypeSupergroup") {
    supergroup = await client.invoke({
      _: "getSupergroup",
      supergroup_id: chat.type.supergroup_id,
    });
    fullInfo = await client.invoke({
      _: "getSupergroupFullInfo",
      supergroup_id: chat.type.supergroup_id,
    });
    currentType = supergroup.is_channel ? "channel" : "supergroup";
  } else if (chat.type?._ === "chatTypeBasicGroup") {
    fullInfo = await client.invoke({
      _: "getBasicGroupFullInfo",
      basic_group_id: chat.type.basic_group_id,
    });
    currentType = "basic_group";
  } else if (chat.type?._ === "chatTypePrivate") {
    currentType = "private";
  } else if (chat.type?._ === "chatTypeSecret") {
    currentType = "secret";
  } else {
    currentType = "group";
  }

  return formatChatPrivacy(mapChatPrivacy(chatId, chat, supergroup, fullInfo, currentType));
}

export async function setPrivate(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  const supergroupId = await requireSupergroupId(client, chatId);

  // Fetch current usernames. TDLib splits them in two buckets:
  //   - editable_username: the main @handle, changed via setSupergroupUsername
  //   - active_usernames:  includes the editable + any extra collectible usernames
  // Extra usernames must be disabled one-by-one via toggleSupergroupUsernameIsActive;
  // TDLib rejects that call on the editable username (returns "Wrong username specified").
  const sg = await client.invoke({ _: "getSupergroup", supergroup_id: supergroupId });
  const active: string[] = sg.usernames?.active_usernames ?? [];
  const editable: string = sg.usernames?.editable_username ?? "";
  const extraUsernames = active.filter((u) => u !== editable);

  for (const uname of extraUsernames) {
    await client.invoke({
      _: "toggleSupergroupUsernameIsActive",
      supergroup_id: supergroupId,
      username: uname,
      is_active: false,
    });
  }

  if (editable) {
    await client.invoke({
      _: "setSupergroupUsername",
      supergroup_id: supergroupId,
      username: "",
    });
  }

  return formatSuccess({
    chat_id: chatId,
    previous_active_usernames: active.length > 0 ? active.join(",") : "(none)",
    status: "private",
  });
}

export async function setPublic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const username = (args[1] ?? "").replace(/^@/, "");
  if (!username) {
    throw new Error("Usage: tg set-public <chat_id> <username>");
  }

  const client = await getClient();
  const supergroupId = await requireSupergroupId(client, chatId);

  await client.invoke({
    _: "setSupergroupUsername",
    supergroup_id: supergroupId,
    username,
  });

  return formatSuccess({
    chat_id: chatId,
    username: `@${username}`,
    public_url: `https://t.me/${username}`,
    status: "public",
  });
}

// --- Invite link verbs ---

async function getMyUserId(client: any): Promise<number> {
  const me = await client.invoke({ _: "getMe" });
  return me.id;
}

function mapInviteLink(l: any): FormattedInviteLink {
  return {
    url: l.invite_link ?? "",
    name: l.name ?? "",
    creator_user_id: l.creator_user_id ?? 0,
    created_date: l.date ?? 0,
    edit_date: l.edit_date ?? 0,
    expiration_date: l.expiration_date ?? 0,
    member_limit: l.member_limit ?? 0,
    member_count: l.member_count ?? 0,
    pending_join_request_count: l.pending_join_request_count ?? 0,
    creates_join_request: !!l.creates_join_request,
    is_primary: !!l.is_primary,
    is_revoked: !!l.is_revoked,
  };
}

export async function inviteLinks(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const includeRevoked = args.includes("--include-revoked");
  const limit = parseIntFlag(args, "--limit", 100);

  const client = await getClient();
  const creatorId = await getMyUserId(client);

  const fetchLinks = async (isRevoked: boolean) => {
    const result = await client.invoke({
      _: "getChatInviteLinks",
      chat_id: chatId,
      creator_user_id: creatorId,
      is_revoked: isRevoked,
      offset_date: 0,
      offset_invite_link: "",
      limit,
    });
    return {
      total_count: (result as any).total_count ?? 0,
      invite_links: ((result as any).invite_links ?? []) as any[],
    };
  };

  const active = await fetchLinks(false);
  let combined = active.invite_links;
  let total = active.total_count;

  if (includeRevoked) {
    const revoked = await fetchLinks(true);
    combined = [...combined, ...revoked.invite_links];
    total += revoked.total_count;
  }

  const mapped = combined.map(mapInviteLink);
  return formatInviteLinks(mapped, total, includeRevoked);
}

function parseExpires(val: string | undefined): number {
  if (!val) return 0;
  // Accept unix seconds or ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS).
  const asNum = Number(val);
  if (!isNaN(asNum) && val.trim() === String(asNum)) return asNum;
  return parseDateToUnix(val);
}

export async function createInviteLink(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const name = parseStringFlag(args, "--name") ?? "";
  const expiresRaw = parseStringFlag(args, "--expires");
  const memberLimit = parseIntFlag(args, "--member-limit", 0);
  const createsJoinRequest = args.includes("--creates-join-request");

  if (memberLimit && createsJoinRequest) {
    throw new Error(
      "--member-limit and --creates-join-request are mutually exclusive per Telegram's invite-link rules"
    );
  }

  const expirationDate = parseExpires(expiresRaw);
  const client = await getClient();

  const result = await client.invoke({
    _: "createChatInviteLink",
    chat_id: chatId,
    name,
    expiration_date: expirationDate,
    member_limit: memberLimit,
    creates_join_request: createsJoinRequest,
  });

  return formatInviteLink(mapInviteLink(result));
}

export async function revokeInviteLink(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const link = args[1];
  if (!link) throw new Error("Usage: tg revoke-invite-link <chat_id> <link_url>");

  const client = await getClient();
  const result = await client.invoke({
    _: "revokeChatInviteLink",
    chat_id: chatId,
    invite_link: link,
  });

  // revokeChatInviteLink returns chatInviteLinks { total_count, invite_links[] }.
  // When revoking a primary link, TDLib auto-generates a new primary, so the
  // result may contain both the revoked link and the freshly-created primary.
  const rawLinks = ((result as any).invite_links ?? []) as any[];
  const mapped = rawLinks.map(mapInviteLink);

  if (mapped.length === 0) {
    return formatSuccess({ link, status: "revoked" });
  }

  const header = `Revoked. TDLib returned ${mapped.length} link${mapped.length === 1 ? "" : "s"} (revoked + any auto-generated primary):`;
  return `${header}\n\n${mapped.map(formatInviteLink).join("\n\n")}`;
}

export async function deleteInviteLink(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const link = args[1];
  if (!link) throw new Error("Usage: tg delete-invite-link <chat_id> <link_url>");

  const client = await getClient();
  // deleteRevokedChatInviteLink requires the link to be already revoked.
  await client.invoke({
    _: "deleteRevokedChatInviteLink",
    chat_id: chatId,
    invite_link: link,
  });

  return formatSuccess({ link, status: "deleted" });
}

// --- Helpers ---

const FILTER_MAP: Record<string, string> = {
  voice: "searchMessagesFilterVoiceNote",
  photo: "searchMessagesFilterPhoto",
  video: "searchMessagesFilterVideo",
  document: "searchMessagesFilterDocument",
  link: "searchMessagesFilterUrl",
  audio: "searchMessagesFilterAudio",
  animation: "searchMessagesFilterAnimation",
  video_note: "searchMessagesFilterVideoNote",
};

function parseFilterType(args: string[]): { _: string } | undefined {
  const typeStr = parseStringFlag(args, "--type");
  if (!typeStr) return undefined;
  const tdlibFilter = FILTER_MAP[typeStr.toLowerCase()];
  if (!tdlibFilter) {
    throw new Error(
      `Unknown type: ${typeStr}. Valid: ${Object.keys(FILTER_MAP).join(", ")}`
    );
  }
  return { _: tdlibFilter };
}

function parseIntFlag(args: string[], flag: string, defaultVal: number): number {
  // Check --flag=value format
  const prefix = `${flag}=`;
  const found = args.find((a) => a.startsWith(prefix));
  if (found) {
    const val = Number(found.slice(prefix.length));
    if (!isNaN(val)) return val;
  }
  return defaultVal;
}

function parseStringFlag(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const found = args.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  return undefined;
}

function parseDateToUnix(dateStr: string): number {
  // Accept YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr} (use YYYY-MM-DD format)`);
  return Math.floor(d.getTime() / 1000);
}

function parseRequiredNumber(val: string | undefined, name: string): number {
  if (!val) throw new Error(`Missing required argument: ${name}`);
  const n = Number(val);
  if (isNaN(n)) throw new Error(`Invalid ${name}: ${val} (must be a number)`);
  return n;
}

async function resolveSenderNames(
  client: any,
  messages: Array<{ sender_name: string; sender_id: number | null } & Record<string, any>>
) {
  const userIds = new Set<number>();
  const chatIds = new Set<number>();

  for (const msg of messages) {
    if (msg.sender_name.startsWith("user:") && msg.sender_id) {
      userIds.add(msg.sender_id);
    } else if (msg.sender_name.startsWith("chat:") && msg.sender_id) {
      chatIds.add(msg.sender_id);
    }
  }

  const nameCache = new Map<string, string>();

  await Promise.all([
    ...Array.from(userIds).map(async (id) => {
      try {
        const u = await client.invoke({ _: "getUser", user_id: id });
        const name = `${u.first_name || ""} ${u.last_name || ""}`.trim() || `user:${id}`;
        nameCache.set(`user:${id}`, name);
      } catch {
        nameCache.set(`user:${id}`, `user:${id}`);
      }
    }),
    ...Array.from(chatIds).map(async (id) => {
      try {
        const c = await client.invoke({ _: "getChat", chat_id: id });
        nameCache.set(`chat:${id}`, c.title || `chat:${id}`);
      } catch {
        nameCache.set(`chat:${id}`, `chat:${id}`);
      }
    }),
  ]);

  return messages.map((msg) => ({
    ...msg,
    sender_name: nameCache.get(msg.sender_name) ?? msg.sender_name,
  }));
}

// ============================================================================
// New verbs (P0/P1/P2 user + admin) added 2026-05-19
// ============================================================================

// --- shared helpers for new verbs ---

async function parseFormattedText(client: any, raw: string, mode: "plain" | "markdown" | "html"): Promise<any> {
  if (mode === "plain" || !raw) return { _: "formattedText", text: raw, entities: [] };
  const parseMode = mode === "html"
    ? { _: "textParseModeHTML" }
    : { _: "textParseModeMarkdown", version: 2 };
  try {
    const parsed = await client.invoke({ _: "parseTextEntities", text: raw, parse_mode: parseMode });
    return parsed;
  } catch (err: any) {
    throw new Error(`Failed to parse ${mode}: ${err.message ?? err}`);
  }
}

function detectFormatMode(args: string[]): "plain" | "markdown" | "html" {
  if (args.includes("--markdown") || args.includes("--md")) return "markdown";
  if (args.includes("--html")) return "html";
  return "plain";
}

function parseAtTime(spec: string): number {
  // Accepts: unix seconds, ISO date, +5m / +30s / +1h relative
  if (/^\+\d+[smhd]$/.test(spec)) {
    const n = parseInt(spec.slice(1, -1), 10);
    const unit = spec.slice(-1);
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
    return Math.floor(Date.now() / 1000) + n * mult;
  }
  const asNum = Number(spec);
  if (!isNaN(asNum) && asNum > 1_000_000_000) return Math.floor(asNum);
  const asDate = new Date(spec);
  if (!isNaN(asDate.getTime())) return Math.floor(asDate.getTime() / 1000);
  throw new Error(`Invalid time spec: ${spec} (use unix seconds, ISO date, or +5m / +30s / +1h)`);
}

function parseOnOff(args: string[]): boolean {
  if (args.includes("--on")) return true;
  if (args.includes("--off")) return false;
  throw new Error("Specify --on or --off");
}

// Attach an upload-progress listener to a TDLib client and return the cleanup fn
// + a promise of completion. Shared between sendFile and the media verbs.
function attachUploadProgress(client: any, filePath: string, fileSize: number, quiet: boolean) {
  const canonicalPath = realpathSync(filePath);
  const showProgress = !quiet;
  const totalMiB = fileSize / 1048576;
  const startedAt = Date.now();
  let lastUploaded = 0;
  let lastPrintedPct = -5;
  let uploadFileId: number | null = null;
  const handler = (update: any) => {
    if (update._ !== "updateFile") return;
    const f = update.file;
    const matchesPath = f?.local?.path && (f.local.path === filePath || f.local.path === canonicalPath);
    const matchesId = uploadFileId !== null && f?.id === uploadFileId;
    if (!matchesPath && !matchesId) return;
    if (uploadFileId === null && f?.id) uploadFileId = f.id;
    const uploaded = f.remote?.uploaded_size ?? 0;
    if (uploaded > lastUploaded) {
      lastUploaded = uploaded;
      if (showProgress && fileSize > 0) {
        const pct = (uploaded / fileSize) * 100;
        if (pct - lastPrintedPct >= 5 || uploaded === fileSize) {
          lastPrintedPct = pct;
          const elapsed = (Date.now() - startedAt) / 1000;
          const mbps = uploaded / 1048576 / Math.max(elapsed, 0.001);
          process.stderr.write(
            `upload: ${(uploaded / 1048576).toFixed(1)}/${totalMiB.toFixed(1)} MiB (${pct.toFixed(1)}%) — ${mbps.toFixed(2)} MiB/s\n`,
          );
        }
      }
    }
  };
  client.on("update", handler);
  return () => client.off("update", handler);
}

// Pick a roomy send timeout scaled to file size (5min–2h).
function uploadTimeoutMs(fileSize: number): number {
  return Math.min(2 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, (fileSize / 250_000) * 1000 + 60_000));
}

async function resolveSenderId(client: any, input: string): Promise<any> {
  // Accepts user_id (positive), chat_id (negative for chats/channels), or @username.
  const stripped = input.replace(/^@/, "");
  const asNum = Number(stripped);
  if (!isNaN(asNum)) {
    if (asNum < 0) return { _: "messageSenderChat", chat_id: asNum };
    return { _: "messageSenderUser", user_id: asNum };
  }
  const chat = await client.invoke({ _: "searchPublicChat", username: stripped });
  if (chat?.type?._ === "chatTypePrivate") {
    return { _: "messageSenderUser", user_id: chat.type.user_id };
  }
  return { _: "messageSenderChat", chat_id: chat.id };
}

// --- USER P0 ---

export async function me(_args: string[]): Promise<string> {
  const client = await getClient();
  const u = await client.invoke({ _: "getMe" });
  const username = (u.usernames?.active_usernames ?? [])[0] ?? "";
  return formatSuccess({
    user_id: u.id,
    first_name: u.first_name ?? "",
    last_name: u.last_name ?? "",
    username: username ? `@${username}` : "(none)",
    is_premium: u.is_premium ? "yes" : "no",
    phone_number: u.phone_number ? `+${u.phone_number}` : "(hidden)",
    language_code: u.language_code ?? "",
  });
}

export async function react(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "msg_id");
  const emoji = args[2];
  if (!emoji) throw new Error("Usage: tg react <chat_id> <msg_id> <emoji>");
  const isBig = args.includes("--big");
  const client = await getClient();
  await client.invoke({
    _: "addMessageReaction",
    chat_id: chatId,
    message_id: msgId,
    reaction_type: { _: "reactionTypeEmoji", emoji },
    is_big: isBig,
    update_recent_reactions: false,
  });
  return formatSuccess({ chat_id: chatId, message_id: msgId, reaction: emoji, status: "added" });
}

export async function unreact(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "msg_id");
  const emoji = args[2];
  if (!emoji) throw new Error("Usage: tg unreact <chat_id> <msg_id> <emoji>");
  const client = await getClient();
  await client.invoke({
    _: "removeMessageReaction",
    chat_id: chatId,
    message_id: msgId,
    reaction_type: { _: "reactionTypeEmoji", emoji },
  });
  return formatSuccess({ chat_id: chatId, message_id: msgId, reaction: emoji, status: "removed" });
}

// Generic media sender: photo/video/voice/video-note share the same upload+progress flow.
async function sendMediaFile(
  kind: "photo" | "video" | "voice" | "video_note" | "animation" | "audio",
  args: string[],
): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseIntFlag(args, "--topic", 0);
  const positional = args.filter((a) => !a.startsWith("--"));
  const filePath = positional[1];
  if (!filePath) throw new Error(`Usage: tg send-${kind.replace("_", "-")} <chat_id> <path> [caption] [--topic=<id>] [--markdown|--html] [--quiet] [--primary]`);
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const captionRaw = positional.slice(2).join(" ");
  const mode = detectFormatMode(args);
  const quiet = args.includes("--quiet");
  const usePrimary = args.includes("--primary");
  const fileSize = statSync(filePath).size;

  const client = await getClient(usePrimary ? "primary" : "upload");
  const caption = captionRaw ? await parseFormattedText(client, captionRaw, mode) : undefined;

  const inputFile: any = { _: "inputFileLocal", path: filePath };
  let inputMessage: any;
  switch (kind) {
    case "photo":
      inputMessage = { _: "inputMessagePhoto", photo: inputFile, caption };
      break;
    case "video":
      inputMessage = { _: "inputMessageVideo", video: inputFile, caption, supports_streaming: true };
      break;
    case "voice":
      inputMessage = { _: "inputMessageVoiceNote", voice_note: inputFile, caption, duration: 0 };
      break;
    case "video_note":
      inputMessage = { _: "inputMessageVideoNote", video_note: inputFile, length: 240, duration: 0 };
      break;
    case "animation":
      inputMessage = { _: "inputMessageAnimation", animation: inputFile, caption };
      break;
    case "audio": {
      // Optional ID3-style metadata flags so Telegram's native player shows artist/title
      const title = parseStringFlag(args, "--title") ?? "";
      const performer = parseStringFlag(args, "--performer") ?? "";
      const duration = parseIntFlag(args, "--duration", 0);
      inputMessage = {
        _: "inputMessageAudio",
        audio: inputFile,
        caption,
        title,
        performer,
        duration,
      };
      break;
    }
  }

  const req: any = { _: "sendMessage", chat_id: chatId, input_message_content: inputMessage };
  if (threadId) req.reply_to = await resolveTopicReplyTo(client, chatId, threadId);

  const detach = attachUploadProgress(client, filePath, fileSize, quiet);
  try {
    const result = await client.invoke(req);
    const res = await waitForMessageSend(client, result.id, uploadTimeoutMs(fileSize));
    if (!res.ok) throw new Error(`Send-${kind} failed: ${res.error}`);
    return formatSuccess({ message_id: res.newMessageId ?? result.id, kind, bytes: fileSize, status: "sent" });
  } finally {
    detach();
  }
}

export async function sendPhoto(args: string[]): Promise<string> { return sendMediaFile("photo", args); }
export async function sendVideo(args: string[]): Promise<string> { return sendMediaFile("video", args); }
export async function sendVoice(args: string[]): Promise<string> { return sendMediaFile("voice", args); }
export async function sendVideoNote(args: string[]): Promise<string> { return sendMediaFile("video_note", args); }
export async function sendAnimation(args: string[]): Promise<string> { return sendMediaFile("animation", args); }
export async function sendAudio(args: string[]): Promise<string> { return sendMediaFile("audio", args); }

export async function sendAlbum(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseIntFlag(args, "--topic", 0);
  const positional = args.filter((a) => !a.startsWith("--"));
  const paths = positional.slice(1);
  if (paths.length < 2) throw new Error("Usage: tg send-album <chat_id> <path1> <path2> ... [--caption=<text>] [--topic=<id>] [--markdown|--html] [--primary] [--quiet]");
  if (paths.length > 10) throw new Error("Albums support max 10 items per group");
  for (const p of paths) if (!existsSync(p)) throw new Error(`File not found: ${p}`);

  const captionRaw = parseStringFlag(args, "--caption") ?? "";
  const mode = detectFormatMode(args);
  const usePrimary = args.includes("--primary");
  const quiet = args.includes("--quiet");

  const client = await getClient(usePrimary ? "primary" : "upload");
  const caption = captionRaw ? await parseFormattedText(client, captionRaw, mode) : undefined;

  const contents = paths.map((p, i) => {
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    const isPhoto = ["jpg", "jpeg", "png", "webp", "heic"].includes(ext);
    const inputFile = { _: "inputFileLocal", path: p };
    if (isPhoto) return { _: "inputMessagePhoto", photo: inputFile, caption: i === 0 ? caption : undefined };
    return { _: "inputMessageVideo", video: inputFile, caption: i === 0 ? caption : undefined, supports_streaming: true };
  });

  const req: any = {
    _: "sendMessageAlbum",
    chat_id: chatId,
    input_message_contents: contents,
  };
  if (threadId) req.reply_to = await resolveTopicReplyTo(client, chatId, threadId);

  const totalBytes = paths.reduce((s, p) => s + statSync(p).size, 0);
  const detachers = paths.map((p) => attachUploadProgress(client, p, statSync(p).size, quiet));
  try {
    const result: any = await client.invoke(req);
    const ids: number[] = [];
    for (const m of result.messages ?? []) {
      const res = await waitForMessageSend(client, m.id, uploadTimeoutMs(totalBytes));
      if (!res.ok) throw new Error(`send-album failed: ${res.error}`);
      ids.push(res.newMessageId ?? m.id);
    }
    return formatSuccess({ chat_id: chatId, message_ids: ids.join(","), count: paths.length, bytes: totalBytes, status: "sent" });
  } finally {
    for (const d of detachers) d();
  }
}

export async function markUnread(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const target = !args.includes("--off");
  const client = await getClient();
  await client.invoke({ _: "toggleChatIsMarkedAsUnread", chat_id: chatId, is_marked_as_unread: target });
  return formatSuccess({ chat_id: chatId, is_marked_as_unread: target ? "yes" : "no", status: "ok" });
}

function parseDurationToSeconds(spec: string): number {
  if (spec === "forever" || spec === "permanent") return 0x7fffffff;
  const m = spec.match(/^(\d+)([smhd])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
    return n * mult;
  }
  const n = parseInt(spec, 10);
  if (!isNaN(n)) return n;
  throw new Error(`Invalid duration: ${spec} (use 30s / 5m / 2h / 1d / forever)`);
}

export async function muteChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const forSpec = parseStringFlag(args, "--for");
  const forever = args.includes("--forever");
  const muteFor = forever ? 0x7fffffff : (forSpec ? parseDurationToSeconds(forSpec) : 0x7fffffff);
  const client = await getClient();
  await client.invoke({
    _: "setChatNotificationSettings",
    chat_id: chatId,
    notification_settings: {
      _: "chatNotificationSettings",
      use_default_mute_for: false,
      mute_for: muteFor,
      use_default_sound: true,
      sound_id: 0,
      use_default_show_preview: true,
      show_preview: true,
      use_default_mute_stories: true,
      mute_stories: false,
      use_default_story_sound: true,
      story_sound_id: 0,
      use_default_show_story_sender: true,
      show_story_sender: true,
      use_default_disable_pinned_message_notifications: true,
      disable_pinned_message_notifications: false,
      use_default_disable_mention_notifications: true,
      disable_mention_notifications: false,
    },
  });
  return formatSuccess({ chat_id: chatId, mute_for_seconds: muteFor, status: "muted" });
}

export async function unmuteChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  await client.invoke({
    _: "setChatNotificationSettings",
    chat_id: chatId,
    notification_settings: {
      _: "chatNotificationSettings",
      use_default_mute_for: false,
      mute_for: 0,
      use_default_sound: true,
      sound_id: 0,
      use_default_show_preview: true,
      show_preview: true,
      use_default_mute_stories: true,
      mute_stories: false,
      use_default_story_sound: true,
      story_sound_id: 0,
      use_default_show_story_sender: true,
      show_story_sender: true,
      use_default_disable_pinned_message_notifications: true,
      disable_pinned_message_notifications: false,
      use_default_disable_mention_notifications: true,
      disable_mention_notifications: false,
    },
  });
  return formatSuccess({ chat_id: chatId, status: "unmuted" });
}

async function setChatList(chatId: number, listType: "chatListMain" | "chatListArchive"): Promise<string> {
  const client = await getClient();
  await client.invoke({ _: "addChatToList", chat_id: chatId, chat_list: { _: listType } });
  return formatSuccess({ chat_id: chatId, chat_list: listType.replace("chatList", "").toLowerCase(), status: "moved" });
}
export async function archiveChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  return setChatList(chatId, "chatListArchive");
}
export async function unarchiveChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  return setChatList(chatId, "chatListMain");
}

// --- USER P1 ---

export async function schedule(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const atSpec = parseStringFlag(args, "--at");
  if (!atSpec) throw new Error("Usage: tg schedule <chat_id> <text> --at=<unix|ISO|+5m>");
  const sendAt = parseAtTime(atSpec);
  const mode = detectFormatMode(args);
  const text = args
    .slice(1)
    .filter((a) => !a.startsWith("--at=") && !a.startsWith("--markdown") && !a.startsWith("--md") && !a.startsWith("--html"))
    .join(" ");
  if (!text) throw new Error("Empty message text");

  const client = await getClient();
  const formatted = await parseFormattedText(client, text, mode);
  const result: any = await client.invoke({
    _: "sendMessage",
    chat_id: chatId,
    options: {
      _: "messageSendOptions",
      scheduling_state: { _: "messageSchedulingStateSendAtDate", send_date: sendAt },
    },
    input_message_content: { _: "inputMessageText", text: formatted, disable_web_page_preview: false, clear_draft: false },
  });
  return formatSuccess({ message_id: result.id, send_at: sendAt, status: "scheduled" });
}

export async function copyMessages(args: string[]): Promise<string> {
  const fromChat = parseRequiredNumber(args[0], "from_chat_id");
  const toChat = parseRequiredNumber(args[1], "to_chat_id");
  const ids = args.slice(2).filter((a) => !a.startsWith("--")).map((s) => parseRequiredNumber(s, "msg_id"));
  if (ids.length === 0) throw new Error("Usage: tg copy <from_chat> <to_chat> <msg_id1> [<msg_id2>...] [--no-captions]");
  const dropCaptions = args.includes("--no-captions");
  const client = await getClient();
  const result: any = await client.invoke({
    _: "forwardMessages",
    chat_id: toChat,
    from_chat_id: fromChat,
    message_ids: ids,
    options: { _: "messageSendOptions" },
    send_copy: true,
    remove_caption: dropCaptions,
  });
  const newIds = (result.messages ?? []).map((m: any) => m.id);
  return formatSuccess({ from: fromChat, to: toChat, new_ids: newIds.join(","), count: newIds.length, status: "copied" });
}

export async function draft(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const clear = args.includes("--clear");
  const text = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  const mode = detectFormatMode(args);
  const client = await getClient();
  let draftMessage: any = null;
  if (!clear) {
    if (!text) {
      const chat: any = await client.invoke({ _: "getChat", chat_id: chatId });
      const d = chat.draft_message;
      if (!d) return formatSuccess({ chat_id: chatId, draft: "(none)" });
      return formatSuccess({ chat_id: chatId, draft: d.input_message_text?.text?.text ?? "" });
    }
    const formatted = await parseFormattedText(client, text, mode);
    draftMessage = {
      _: "draftMessage",
      reply_to: undefined,
      date: Math.floor(Date.now() / 1000),
      input_message_text: { _: "inputMessageText", text: formatted, disable_web_page_preview: false, clear_draft: false },
    };
  }
  await client.invoke({ _: "setChatDraftMessage", chat_id: chatId, message_thread_id: 0, draft_message: draftMessage });
  return formatSuccess({ chat_id: chatId, status: clear ? "cleared" : "set" });
}

export async function blockUser(args: string[]): Promise<string> {
  if (!args[0]) throw new Error("Usage: tg block <user_id|username>");
  const client = await getClient();
  const sender = await resolveSenderId(client, args[0]);
  await client.invoke({ _: "setMessageSenderBlockList", sender_id: sender, block_list: { _: "blockListMain" } });
  return formatSuccess({ target: args[0], status: "blocked" });
}
export async function unblockUser(args: string[]): Promise<string> {
  if (!args[0]) throw new Error("Usage: tg unblock <user_id|username>");
  const client = await getClient();
  const sender = await resolveSenderId(client, args[0]);
  await client.invoke({ _: "setMessageSenderBlockList", sender_id: sender, block_list: null });
  return formatSuccess({ target: args[0], status: "unblocked" });
}
export async function blockedList(_args: string[]): Promise<string> {
  const client = await getClient();
  const result: any = await client.invoke({
    _: "getBlockedMessageSenders",
    block_list: { _: "blockListMain" },
    offset: 0,
    limit: 100,
  });
  const lines: string[] = [`Total: ${result.total_count ?? 0}`];
  for (const s of result.senders ?? []) {
    lines.push(`[BLOCKED ${s._ === "messageSenderUser" ? `user_id=${s.user_id}` : `chat_id=${s.chat_id}`}]`);
  }
  return lines.join("\n");
}

export async function sessions(_args: string[]): Promise<string> {
  const client = await getClient();
  const result: any = await client.invoke({ _: "getActiveSessions" });
  const inactiveAfter = result.inactive_session_ttl_days ?? "?";
  const lines: string[] = [`inactive_after_days: ${inactiveAfter}`];
  for (const s of result.sessions ?? []) {
    lines.push(`[SESSION id=${s.id} device="${s.device_model}" app="${s.application_name} ${s.application_version}" platform="${s.platform}" country="${s.country}" ip=${s.ip_address ?? "?"} current=${s.is_current ? "yes" : "no"} can_accept_calls=${s.can_accept_calls ? "yes" : "no"}]`);
  }
  return lines.join("\n");
}
export async function terminateSession(args: string[]): Promise<string> {
  const id = args[0];
  if (!id) throw new Error("Usage: tg terminate-session <session_id>");
  const client = await getClient();
  await client.invoke({ _: "terminateSession", session_id: id });
  return formatSuccess({ session_id: id, status: "terminated" });
}
export async function terminateOthers(_args: string[]): Promise<string> {
  const client = await getClient();
  await client.invoke({ _: "terminateAllOtherSessions" });
  return formatSuccess({ status: "terminated_all_other_sessions" });
}

export async function ttl(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const spec = args[1];
  if (!spec) throw new Error("Usage: tg ttl <chat_id> <seconds|off>");
  const seconds = spec === "off" ? 0 : (typeof spec === "string" && /[smhd]$/.test(spec) ? parseDurationToSeconds(spec) : parseRequiredNumber(spec, "seconds"));
  const client = await getClient();
  await client.invoke({ _: "setChatMessageAutoDeleteTime", chat_id: chatId, message_auto_delete_time: seconds });
  return formatSuccess({ chat_id: chatId, auto_delete_seconds: seconds, status: "set" });
}

export async function viewers(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "msg_id");
  const client = await getClient();
  const result: any = await client.invoke({ _: "getMessageViewers", chat_id: chatId, message_id: msgId });
  const v = result.viewers ?? [];
  const lines: string[] = [`Total: ${v.length}`];
  for (const vw of v) lines.push(`[VIEWER user_id=${vw.user_id} view_date=${vw.view_date}]`);
  return lines.join("\n");
}

export async function sendLocation(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const lat = parseFloat(args[1] ?? "");
  const lon = parseFloat(args[2] ?? "");
  if (isNaN(lat) || isNaN(lon)) throw new Error("Usage: tg send-location <chat_id> <lat> <lon> [--live=<seconds>] [--topic=<id>]");
  const live = parseIntFlag(args, "--live", 0);
  const threadId = parseIntFlag(args, "--topic", 0);
  const client = await getClient();
  const req: any = {
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: {
      _: "inputMessageLocation",
      location: { _: "location", latitude: lat, longitude: lon, horizontal_accuracy: 0 },
      live_period: live,
      heading: 0,
      proximity_alert_radius: 0,
    },
  };
  if (threadId) req.reply_to = await resolveTopicReplyTo(client, chatId, threadId);
  const result: any = await client.invoke(req);
  const res = await waitForMessageSend(client, result.id);
  if (!res.ok) throw new Error(`send-location failed: ${res.error}`);
  return formatSuccess({ message_id: res.newMessageId ?? result.id, lat, lon, live_period: live, status: "sent" });
}

export async function sendVenue(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const lat = parseFloat(args[1] ?? "");
  const lon = parseFloat(args[2] ?? "");
  const title = args[3];
  const address = args[4];
  if (isNaN(lat) || isNaN(lon) || !title || !address) {
    throw new Error('Usage: tg send-venue <chat_id> <lat> <lon> "<title>" "<address>"');
  }
  const threadId = parseIntFlag(args, "--topic", 0);
  const client = await getClient();
  const req: any = {
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: {
      _: "inputMessageVenue",
      venue: {
        _: "venue",
        location: { _: "location", latitude: lat, longitude: lon, horizontal_accuracy: 0 },
        title,
        address,
        provider: "foursquare",
        id: "",
        type: "",
      },
    },
  };
  if (threadId) req.reply_to = await resolveTopicReplyTo(client, chatId, threadId);
  const result: any = await client.invoke(req);
  const res = await waitForMessageSend(client, result.id);
  if (!res.ok) throw new Error(`send-venue failed: ${res.error}`);
  return formatSuccess({ message_id: res.newMessageId ?? result.id, status: "sent" });
}

export async function sendContact(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const phone = args[1];
  const first = args[2];
  const last = args[3] ?? "";
  if (!phone || !first) throw new Error('Usage: tg send-contact <chat_id> <phone> <first_name> [last_name]');
  const threadId = parseIntFlag(args, "--topic", 0);
  const client = await getClient();
  const req: any = {
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: {
      _: "inputMessageContact",
      contact: { _: "contact", phone_number: phone, first_name: first, last_name: last, vcard: "", user_id: 0 },
    },
  };
  if (threadId) req.reply_to = await resolveTopicReplyTo(client, chatId, threadId);
  const result: any = await client.invoke(req);
  const res = await waitForMessageSend(client, result.id);
  if (!res.ok) throw new Error(`send-contact failed: ${res.error}`);
  return formatSuccess({ message_id: res.newMessageId ?? result.id, status: "sent" });
}

// --- USER P2 ---

export async function poll(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const positional = args.slice(1).filter((a) => !a.startsWith("--"));
  const question = positional[0];
  const options = positional.slice(1);
  if (!question || options.length < 2) {
    throw new Error('Usage: tg poll <chat_id> "Question" "opt1" "opt2" [...] [--anonymous] [--multiple] [--quiz=<correct_idx>]');
  }
  const anon = args.includes("--anonymous");
  const multiple = args.includes("--multiple");
  const quizIdx = parseIntFlag(args, "--quiz", -1);
  const client = await getClient();
  const type = quizIdx >= 0
    ? { _: "inputPollTypeQuiz", correct_option_ids: [quizIdx], explanation: { _: "formattedText", text: "", entities: [] } }
    : { _: "inputPollTypeRegular", allow_adding_options: false };
  // Note: the multiple-answers flag has moved to the parent inputMessagePoll
  // in TDLib 1.8.64+ (allows_multiple_answers), but only for inputPollTypeRegular.
  const allowsMultiple = quizIdx < 0 && multiple;
  const result: any = await client.invoke({
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: {
      _: "inputMessagePoll",
      question: { _: "formattedText", text: question, entities: [] },
      options: options.map((o) => ({
        _: "inputPollOption",
        text: { _: "formattedText", text: o, entities: [] },
        media: null,
      })),
      is_anonymous: anon,
      allows_multiple_answers: allowsMultiple,
      type,
      open_period: 0,
      close_date: 0,
      is_closed: false,
    },
  });
  const res = await waitForMessageSend(client, result.id);
  if (!res.ok) throw new Error(`poll failed: ${res.error}`);
  return formatSuccess({ message_id: res.newMessageId ?? result.id, options: options.length, status: "sent" });
}

export async function dice(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const emoji = args[1] ?? "🎲";
  const client = await getClient();
  const result: any = await client.invoke({
    _: "sendMessage",
    chat_id: chatId,
    input_message_content: { _: "inputMessageDice", emoji, clear_draft: false },
  });
  const res = await waitForMessageSend(client, result.id);
  if (!res.ok) throw new Error(`dice failed: ${res.error}`);
  return formatSuccess({ message_id: res.newMessageId ?? result.id, emoji, status: "sent" });
}

export async function translate(args: string[]): Promise<string> {
  const to = parseStringFlag(args, "--to");
  const text = args.filter((a) => !a.startsWith("--")).join(" ");
  if (!text || !to) throw new Error('Usage: tg translate "<text>" --to=<lang_code>');
  const client = await getClient();
  const result: any = await client.invoke({
    _: "translateText",
    text: { _: "formattedText", text, entities: [] },
    to_language_code: to,
  });
  return result.text ?? "";
}

export async function translateMsg(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "msg_id");
  const to = parseStringFlag(args, "--to");
  if (!to) throw new Error("Usage: tg translate-msg <chat_id> <msg_id> --to=<lang_code>");
  const client = await getClient();
  const result: any = await client.invoke({
    _: "translateMessageText",
    chat_id: chatId,
    message_id: msgId,
    to_language_code: to,
  });
  return result.text ?? "";
}

export async function stats(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  const result: any = await client.invoke({ _: "getChatStatistics", chat_id: chatId, is_dark: false });
  return JSON.stringify({
    type: result._,
    member_count: result.member_count?.value,
    mean_view_count: result.mean_view_count?.value,
    mean_share_count: result.mean_share_count?.value,
    period: result.period,
  }, null, 2);
}

export async function msgStats(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const msgId = parseRequiredNumber(args[1], "msg_id");
  const client = await getClient();
  const result: any = await client.invoke({ _: "getMessageStatistics", chat_id: chatId, message_id: msgId, is_dark: false });
  return JSON.stringify({ type: result._, message_interaction_graph: !!result.message_interaction_graph }, null, 2);
}

export async function profile(_args: string[]): Promise<string> {
  const client = await getClient();
  const u: any = await client.invoke({ _: "getMe" });
  let full: any = null;
  try { full = await client.invoke({ _: "getUserFullInfo", user_id: u.id }); } catch {}
  const username = (u.usernames?.active_usernames ?? [])[0] ?? "";
  return formatSuccess({
    user_id: u.id,
    first_name: u.first_name ?? "",
    last_name: u.last_name ?? "",
    username: username ? `@${username}` : "(none)",
    is_premium: u.is_premium ? "yes" : "no",
    bio: full?.bio?.text ?? "",
    phone: u.phone_number ? `+${u.phone_number}` : "",
    has_photo: u.profile_photo ? "yes" : "no",
  });
}
export async function setBio(args: string[]): Promise<string> {
  const text = args.filter((a) => !a.startsWith("--")).join(" ");
  const client = await getClient();
  await client.invoke({ _: "setBio", bio: text });
  return formatSuccess({ bio: text, status: "set" });
}
export async function setName(args: string[]): Promise<string> {
  const first = args[0];
  const last = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  if (!first) throw new Error("Usage: tg set-name <first> [last]");
  const client = await getClient();
  await client.invoke({ _: "setName", first_name: first, last_name: last });
  return formatSuccess({ first_name: first, last_name: last, status: "set" });
}
export async function setUsername(args: string[]): Promise<string> {
  const uname = (args[0] ?? "").replace(/^@/, "");
  const client = await getClient();
  await client.invoke({ _: "setUsername", username: uname });
  return formatSuccess({ username: uname ? `@${uname}` : "(cleared)", status: "set" });
}
export async function setProfilePhoto(args: string[]): Promise<string> {
  const path = args[0];
  if (!path) throw new Error("Usage: tg set-photo <path>");
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const client = await getClient();
  await client.invoke({
    _: "setProfilePhoto",
    photo: { _: "inputChatPhotoStatic", photo: { _: "inputFileLocal", path } },
    is_public: false,
  });
  return formatSuccess({ photo: path, status: "set" });
}

export async function boostStatus(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  const result: any = await client.invoke({ _: "getChatBoostStatus", chat_id: chatId });
  return formatSuccess({
    chat_id: chatId,
    level: result.level ?? 0,
    boost_count: result.boost_count ?? 0,
    current_level_boost_count: result.current_level_boost_count ?? 0,
    next_level_boost_count: result.next_level_boost_count ?? 0,
    premium_member_count: result.premium_member_count ?? 0,
    premium_member_percentage: result.premium_member_percentage ?? 0,
  });
}
export async function boost(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  const slots: any = await client.invoke({ _: "getAvailableChatBoostSlots" });
  const slotIds = (slots.slots ?? []).filter((s: any) => !s.currently_boosted_chat_id).map((s: any) => s.slot_id);
  if (slotIds.length === 0) return formatSuccess({ chat_id: chatId, status: "no_free_slots" });
  await client.invoke({ _: "boostChat", chat_id: chatId, slot_ids: slotIds });
  return formatSuccess({ chat_id: chatId, slots: slotIds.join(","), status: "boosted" });
}

export async function folders(_args: string[]): Promise<string> {
  // TDLib emits updateChatFolders once the folder list is ready. Subscribe
  // before triggering any call, since the update may have already fired during
  // session warm-up — we keep the listener attached and also call loadChats to
  // nudge any deferred state.
  const client = await getClient();
  const update: any = await new Promise((resolve) => {
    const timer = setTimeout(() => { client.off("update", handler); resolve(null); }, 6000);
    const handler = (u: any) => {
      if (u._ === "updateChatFolders") {
        clearTimeout(timer);
        client.off("update", handler);
        resolve(u);
      }
    };
    client.on("update", handler);
    client.invoke({ _: "loadChats", chat_list: { _: "chatListMain" }, limit: 1 }).catch(() => {});
    client.invoke({ _: "getRecommendedChatFolders" }).then((res: any) => {
      // If user has no custom folders, recommended list comes back instead.
      if (res && Array.isArray(res.chat_folders)) {
        clearTimeout(timer);
        client.off("update", handler);
        resolve({ chat_folders: [], main_chat_list_position: 0, recommended: res.chat_folders });
      }
    }).catch(() => {});
  });
  if (!update) return "(no folders / no updateChatFolders received)";
  const lines: string[] = [];
  if ("main_chat_list_position" in update) {
    lines.push(`main_chat_list_position: ${update.main_chat_list_position}`);
  }
  for (const f of update.chat_folders ?? []) {
    lines.push(`[FOLDER id=${f.id} title="${f.title?.text ?? f.name ?? ""}" icon=${f.icon?.name ?? ""}]`);
  }
  if (update.recommended) {
    lines.push(`recommended_count: ${update.recommended.length}`);
  }
  if (lines.length === 0 || (lines.length === 1 && lines[0].startsWith("main_chat_list_position"))) {
    lines.push("(no custom folders configured)");
  }
  return lines.join("\n");
}

// --- ADMIN P0 ---

export async function setDescription(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const text = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
  const client = await getClient();
  await client.invoke({ _: "setChatDescription", chat_id: chatId, description: text });
  return formatSuccess({ chat_id: chatId, description: text || "(cleared)", status: "set" });
}

export async function setPhotoChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const path = args[1];
  if (!path) throw new Error("Usage: tg set-photo-chat <chat_id> <path>");
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const client = await getClient();
  await client.invoke({
    _: "setChatPhoto",
    chat_id: chatId,
    photo: { _: "inputChatPhotoStatic", photo: { _: "inputFileLocal", path } },
  });
  return formatSuccess({ chat_id: chatId, photo: path, status: "set" });
}
export async function deletePhotoChat(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  await client.invoke({ _: "setChatPhoto", chat_id: chatId, photo: null });
  return formatSuccess({ chat_id: chatId, status: "cleared" });
}

function parseBoolFlag(args: string[], flag: string, defaultVal: boolean): boolean {
  const prefix = `${flag}=`;
  const found = args.find((a) => a.startsWith(prefix));
  if (!found) return defaultVal;
  const v = found.slice(prefix.length).toLowerCase();
  return v === "true" || v === "yes" || v === "on" || v === "1";
}

export async function setPermissions(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  const send = parseBoolFlag(args, "--send", true);
  const media = parseBoolFlag(args, "--media", true);
  const polls = parseBoolFlag(args, "--polls", true);
  const links = parseBoolFlag(args, "--links", true);
  const pin = parseBoolFlag(args, "--pin", false);
  const invite = parseBoolFlag(args, "--invite", true);
  const info = parseBoolFlag(args, "--info", false);
  const audios = parseBoolFlag(args, "--audios", media);
  const documents = parseBoolFlag(args, "--documents", media);
  const photos = parseBoolFlag(args, "--photos", media);
  const videos = parseBoolFlag(args, "--videos", media);
  const videoNotes = parseBoolFlag(args, "--video-notes", media);
  const voiceNotes = parseBoolFlag(args, "--voice-notes", media);
  const stickersGifs = parseBoolFlag(args, "--stickers-gifs", media);
  const topics = parseBoolFlag(args, "--topics", false);

  await client.invoke({
    _: "setChatPermissions",
    chat_id: chatId,
    permissions: {
      _: "chatPermissions",
      can_send_basic_messages: send,
      can_send_audios: audios,
      can_send_documents: documents,
      can_send_photos: photos,
      can_send_videos: videos,
      can_send_video_notes: videoNotes,
      can_send_voice_notes: voiceNotes,
      can_send_polls: polls,
      can_send_other_messages: stickersGifs,
      can_add_link_previews: links,
      can_invite_users: invite,
      can_pin_messages: pin,
      can_change_info: info,
      can_create_topics: topics,
    },
  });
  return formatSuccess({ chat_id: chatId, status: "permissions_set" });
}

export async function slowMode(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const spec = args[1];
  if (!spec) throw new Error("Usage: tg slow-mode <chat_id> <seconds|off>");
  const seconds = spec === "off" ? 0 : (/[smhd]$/.test(spec) ? parseDurationToSeconds(spec) : parseRequiredNumber(spec, "seconds"));
  const client = await getClient();
  await client.invoke({ _: "setChatSlowModeDelay", chat_id: chatId, slow_mode_delay: seconds });
  return formatSuccess({ chat_id: chatId, slow_mode_seconds: seconds, status: "set" });
}

export async function restrict(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput) throw new Error("Usage: tg restrict <chat_id> <user_id|username> [--until=<unix>] [--no-send] [--no-media] [--no-polls] [--no-links] [--no-pin]");
  const until = parseIntFlag(args, "--until", 0);
  const allowSend = !args.includes("--no-send");
  const allowMedia = !args.includes("--no-media");
  const allowPolls = !args.includes("--no-polls");
  const allowLinks = !args.includes("--no-links");
  const allowPin = !args.includes("--no-pin");
  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);
  await client.invoke({
    _: "setChatMemberStatus",
    chat_id: chatId,
    member_id: { _: "messageSenderUser", user_id: userId },
    status: {
      _: "chatMemberStatusRestricted",
      is_member: true,
      restricted_until_date: until,
      permissions: {
        _: "chatPermissions",
        can_send_basic_messages: allowSend,
        can_send_audios: allowMedia,
        can_send_documents: allowMedia,
        can_send_photos: allowMedia,
        can_send_videos: allowMedia,
        can_send_video_notes: allowMedia,
        can_send_voice_notes: allowMedia,
        can_send_polls: allowPolls,
        can_send_other_messages: allowMedia,
        can_add_link_previews: allowLinks,
        can_invite_users: true,
        can_pin_messages: allowPin,
        can_change_info: false,
        can_create_topics: false,
      },
    },
  });
  return formatSuccess({ chat_id: chatId, user_id: userId, until, status: "restricted" });
}

export async function unban(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput) throw new Error("Usage: tg unban <chat_id> <user_id|username>");
  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);
  await client.invoke({
    _: "setChatMemberStatus",
    chat_id: chatId,
    member_id: { _: "messageSenderUser", user_id: userId },
    status: { _: "chatMemberStatusLeft" },
  });
  return formatSuccess({ chat_id: chatId, user_id: userId, status: "unbanned" });
}

export async function protectContent(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const on = parseOnOff(args);
  const client = await getClient();
  await client.invoke({ _: "toggleChatHasProtectedContent", chat_id: chatId, has_protected_content: on });
  return formatSuccess({ chat_id: chatId, has_protected_content: on ? "yes" : "no", status: "set" });
}

const EVENT_LOG_FILTER_MAP: Record<string, string> = {
  joins: "message_edits", // sentinel fallback (placeholder; replaced below)
};

function buildEventLogFilters(args: string[]): any {
  // Default: all filters true
  const filters: any = { _: "chatEventLogFilters" };
  const subset = parseStringFlag(args, "--filter");
  const keys = [
    "message_edits", "message_deletions", "message_pins", "member_joins",
    "member_leaves", "member_invites", "member_promotions", "member_restrictions",
    "info_changes", "setting_changes", "invite_link_changes", "video_chat_changes",
    "forum_changes",
  ];
  if (!subset) {
    for (const k of keys) filters[k] = true;
    return filters;
  }
  for (const k of keys) filters[k] = false;
  const subsetMap: Record<string, string[]> = {
    joins: ["member_joins", "member_invites"],
    leaves: ["member_leaves"],
    edits: ["message_edits"],
    deletes: ["message_deletions"],
    admins: ["member_promotions"],
    members: ["member_joins", "member_leaves", "member_invites", "member_promotions", "member_restrictions"],
    info: ["info_changes"],
    settings: ["setting_changes"],
    invites: ["invite_link_changes"],
    video_chats: ["video_chat_changes"],
    forum: ["forum_changes"],
    pins: ["message_pins"],
  };
  for (const part of subset.split(",")) {
    const fields = subsetMap[part.trim()];
    if (!fields) throw new Error(`Unknown filter: ${part}. Valid: ${Object.keys(subsetMap).join(", ")}`);
    for (const f of fields) filters[f] = true;
  }
  return filters;
}

export async function eventLog(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const limit = parseIntFlag(args, "--limit", 50);
  const fromEventId = parseStringFlag(args, "--from") ?? "0";
  const filters = buildEventLogFilters(args);
  const client = await getClient();
  const result: any = await client.invoke({
    _: "getChatEventLog",
    chat_id: chatId,
    query: "",
    from_event_id: fromEventId,
    limit,
    filters,
    user_ids: [],
  });
  const lines: string[] = [];
  for (const e of result.events ?? []) {
    const kind = e.action?._?.replace("chatEventAction", "") ?? "?";
    lines.push(`[EVENT id=${e.id} date=${e.date} user_id=${e.user_id} action=${kind}]`);
  }
  if (lines.length === 0) lines.push("(no events)");
  return lines.join("\n");
}

export async function joinRequests(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const limit = parseIntFlag(args, "--limit", 100);
  const client = await getClient();
  const result: any = await client.invoke({
    _: "getChatJoinRequests",
    chat_id: chatId,
    invite_link: "",
    query: "",
    offset_request: null,
    limit,
  });
  const lines: string[] = [`Total: ${result.total_count ?? 0}`];
  for (const r of result.requests ?? []) {
    lines.push(`[REQUEST user_id=${r.user_id} date=${r.date} bio=${JSON.stringify(r.bio ?? "")}]`);
  }
  return lines.join("\n");
}
export async function approveJoin(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput) throw new Error("Usage: tg approve-join <chat_id> <user_id|username>");
  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);
  await client.invoke({ _: "processChatJoinRequest", chat_id: chatId, user_id: userId, approve: true });
  return formatSuccess({ chat_id: chatId, user_id: userId, status: "approved" });
}
export async function declineJoin(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  if (!userInput) throw new Error("Usage: tg decline-join <chat_id> <user_id|username>");
  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);
  await client.invoke({ _: "processChatJoinRequest", chat_id: chatId, user_id: userId, approve: false });
  return formatSuccess({ chat_id: chatId, user_id: userId, status: "declined" });
}

export async function linkDiscussion(args: string[]): Promise<string> {
  const channelId = parseRequiredNumber(args[0], "channel_chat_id");
  const groupId = parseRequiredNumber(args[1], "discussion_group_chat_id");
  const client = await getClient();
  await client.invoke({ _: "setChatDiscussionGroup", chat_id: channelId, discussion_chat_id: groupId });
  return formatSuccess({ channel: channelId, group: groupId, status: "linked" });
}
export async function unlinkDiscussion(args: string[]): Promise<string> {
  const channelId = parseRequiredNumber(args[0], "channel_chat_id");
  const client = await getClient();
  await client.invoke({ _: "setChatDiscussionGroup", chat_id: channelId, discussion_chat_id: 0 });
  return formatSuccess({ channel: channelId, status: "unlinked" });
}

export async function transferOwnership(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const userInput = args[1];
  const password = parseStringFlag(args, "--password");
  if (!userInput || !password || !args.includes("--yes")) {
    throw new Error("Usage: tg transfer-ownership <chat_id> <user_id|username> --password=<2fa> --yes\nWARNING: DESTRUCTIVE — you lose ownership of this chat.");
  }
  const client = await getClient();
  const userId = await resolveUserInput(client, userInput);
  await client.invoke({ _: "transferChatOwnership", chat_id: chatId, user_id: userId, password });
  return formatSuccess({ chat_id: chatId, new_owner: userId, status: "transferred" });
}

// --- ADMIN P1 ---

async function toggleSupergroupFlag(args: string[], field: string, tdlibMethod: string, extra: Record<string, any> = {}): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const on = parseOnOff(args);
  const client = await getClient();
  const supergroupId = await requireSupergroupId(client, chatId);
  await client.invoke({ _: tdlibMethod, supergroup_id: supergroupId, [field]: on, ...extra });
  return formatSuccess({ chat_id: chatId, [field]: on ? "yes" : "no", status: "set" });
}

export async function signMessages(args: string[]): Promise<string> {
  return toggleSupergroupFlag(args, "sign_messages", "toggleSupergroupSignMessages", { show_message_sender: false });
}
export async function allHistory(args: string[]): Promise<string> {
  return toggleSupergroupFlag(args, "is_all_history_available", "toggleSupergroupIsAllHistoryAvailable");
}
export async function forumMode(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const on = parseOnOff(args);
  const client = await getClient();
  const supergroupId = await requireSupergroupId(client, chatId);
  await client.invoke({ _: "toggleSupergroupIsForum", supergroup_id: supergroupId, is_forum: on, has_forum_tabs: false });
  return formatSuccess({ chat_id: chatId, is_forum: on ? "yes" : "no", status: "set" });
}
export async function hiddenMembers(args: string[]): Promise<string> {
  return toggleSupergroupFlag(args, "has_hidden_members", "toggleSupergroupHasHiddenMembers");
}
export async function antispam(args: string[]): Promise<string> {
  return toggleSupergroupFlag(args, "has_aggressive_anti_spam_enabled", "toggleSupergroupHasAggressiveAntiSpamEnabled");
}
export async function pinTopic(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const threadId = parseRequiredNumber(args[1], "thread_id");
  const on = parseOnOff(args);
  const client = await getClient();
  // TDLib 1.8.64 only allows pinning via setPinnedForumTopics (full list semantics).
  // Read the current pinned list, mutate, and write back.
  const topicsList: any = await client.invoke({ _: "getForumTopics", chat_id: chatId, query: "", offset_date: 0, offset_message_id: 0, offset_forum_topic_id: 0, limit: 100 });
  const currentPinned: number[] = [];
  for (const t of topicsList.topics ?? []) {
    if (t.info?.is_pinned || t.is_pinned) {
      const id = t.info?.forum_topic_id ?? t.info?.message_thread_id ?? t.message_thread_id;
      if (id != null) currentPinned.push(id);
    }
  }
  const next = on
    ? Array.from(new Set([threadId, ...currentPinned]))
    : currentPinned.filter((id) => id !== threadId);
  await client.invoke({ _: "setPinnedForumTopics", chat_id: chatId, message_thread_ids: next });
  return formatSuccess({ chat_id: chatId, thread_id: threadId, is_pinned: on ? "yes" : "no", pinned_now: next.join(",") || "(none)", status: "set" });
}

export async function setStickerSetCmd(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const setSpec = args[1];
  const setId = setSpec === "off" ? "0" : setSpec;
  if (!setSpec) throw new Error("Usage: tg set-sticker-set <chat_id> <set_id|off>");
  const client = await getClient();
  const supergroupId = await requireSupergroupId(client, chatId);
  await client.invoke({ _: "setSupergroupStickerSet", supergroup_id: supergroupId, sticker_set_id: setId });
  return formatSuccess({ chat_id: chatId, sticker_set_id: setId, status: "set" });
}
export async function setCustomEmojiSet(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const setSpec = args[1];
  const setId = setSpec === "off" ? "0" : setSpec;
  if (!setSpec) throw new Error("Usage: tg set-custom-emoji-set <chat_id> <set_id|off>");
  const client = await getClient();
  const supergroupId = await requireSupergroupId(client, chatId);
  await client.invoke({ _: "setSupergroupCustomEmojiStickerSet", supergroup_id: supergroupId, custom_emoji_sticker_set_id: setId });
  return formatSuccess({ chat_id: chatId, custom_emoji_sticker_set_id: setId, status: "set" });
}

export async function postAs(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const senderInput = args[1];
  if (!senderInput) throw new Error("Usage: tg post-as <chat_id> <sender_chat_id_or_user>");
  const client = await getClient();
  const sender = await resolveSenderId(client, senderInput);
  await client.invoke({ _: "setChatMessageSender", chat_id: chatId, message_sender_id: sender });
  return formatSuccess({ chat_id: chatId, sender: JSON.stringify(sender), status: "set" });
}

// --- ADMIN P2 ---

export async function editInviteLink(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const link = args[1];
  if (!link) throw new Error("Usage: tg edit-invite-link <chat_id> <link> [--name=…] [--expires=…] [--member-limit=N] [--creates-join-request]");
  const name = parseStringFlag(args, "--name") ?? "";
  const expiresSpec = parseStringFlag(args, "--expires");
  const memberLimit = parseIntFlag(args, "--member-limit", 0);
  const createsJoinRequest = args.includes("--creates-join-request");
  const expirationDate = expiresSpec ? parseExpires(expiresSpec) : 0;
  const client = await getClient();
  const result: any = await client.invoke({
    _: "editChatInviteLink",
    chat_id: chatId,
    invite_link: link,
    name,
    expiration_date: expirationDate,
    member_limit: createsJoinRequest ? 0 : memberLimit,
    creates_join_request: createsJoinRequest,
  });
  return formatSuccess({
    url: result.invite_link,
    name: result.name ?? "",
    expires: result.expiration_date ?? 0,
    member_limit: result.member_limit ?? 0,
    creates_join_request: result.creates_join_request ? "yes" : "no",
    status: "edited",
  });
}

export async function inviteLinkMembers(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const link = args[1];
  if (!link) throw new Error("Usage: tg invite-link-members <chat_id> <link> [--limit=N]");
  const limit = parseIntFlag(args, "--limit", 100);
  const client = await getClient();
  const result: any = await client.invoke({
    _: "getChatInviteLinkMembers",
    chat_id: chatId,
    invite_link: link,
    only_with_expired_subscription: false,
    offset_member: null,
    limit,
  });
  const lines: string[] = [`Total: ${result.total_count ?? 0}`];
  for (const m of result.members ?? []) {
    lines.push(`[MEMBER user_id=${m.user_id} joined=${m.joined_chat_date} approver=${m.approver_user_id ?? 0}]`);
  }
  return lines.join("\n");
}

export async function inviteLinkCounts(args: string[]): Promise<string> {
  const chatId = parseRequiredNumber(args[0], "chat_id");
  const client = await getClient();
  const result: any = await client.invoke({ _: "getChatInviteLinkCounts", chat_id: chatId });
  const lines: string[] = [];
  for (const c of result.invite_link_counts ?? []) {
    lines.push(`[ADMIN user_id=${c.user_id} link_count=${c.invite_link_count} revoked_count=${c.revoked_invite_link_count}]`);
  }
  if (lines.length === 0) lines.push("(no admin invite-link counts)");
  return lines.join("\n");
}
