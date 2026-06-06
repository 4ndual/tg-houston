import type { MappedChat, MappedChatDetail } from "../mappers/chat";
import type { MappedMessage } from "../mappers/message";
import type { MappedUser, MappedContact } from "../mappers/user";

/**
 * Wraps user-generated content in delimiters to prevent prompt injection.
 * Claude should treat everything between these delimiters as opaque data.
 */
function wrapUserContent(text: string | null | undefined): string {
  if (!text) return "";
  return `<<<USER_CONTENT\n${text}\nUSER_CONTENT>>>`;
}

function formatDate(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString().replace(".000Z", "Z");
}

export function formatChatList(chats: MappedChat[], hasMore: boolean): string {
  const lines: string[] = [];
  for (const chat of chats) {
    lines.push(`[CHAT id=${chat.id} type=${chat.type} unread=${chat.unread_count}]`);
    lines.push(`  title: ${wrapUserContent(chat.title)}`);
    if (chat.last_message_preview) {
      lines.push(`  last: ${wrapUserContent(chat.last_message_preview)}`);
    }
    lines.push("");
  }
  if (hasMore) {
    lines.push("(more chats available — use --limit to fetch more)");
  }
  return lines.join("\n");
}

export function formatChatDetail(chat: MappedChatDetail): string {
  const lines: string[] = [
    `[CHAT id=${chat.id} type=${chat.type} unread=${chat.unread_count}]`,
    `  title: ${wrapUserContent(chat.title)}`,
  ];
  if (chat.member_count !== null) {
    lines.push(`  members: ${chat.member_count}`);
  }
  if (chat.description) {
    lines.push(`  description: ${wrapUserContent(chat.description)}`);
  }
  return lines.join("\n");
}

export function formatMessages(messages: MappedMessage[], hasMore: boolean): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const mediaPart = msg.media_type ? ` media=${msg.media_type}` : "";
    lines.push(
      `[MSG id=${msg.id} from="${msg.sender_name}" (${msg.sender_id ?? "unknown"}) date=${formatDate(msg.date)}${mediaPart}]`
    );
    const text = msg.text_full ?? msg.text_preview;
    if (text) {
      lines.push(wrapUserContent(text));
    }
    lines.push("");
  }
  if (hasMore) {
    lines.push("(more messages available — use --from=<last_msg_id> to paginate)");
  }
  return lines.join("\n");
}

export function formatSearchResults(
  messages: Array<MappedMessage & { chat_id: number; chat_title: string }>,
  totalCount: number,
  hasMore: boolean = false,
  nextFromId?: number
): string {
  const lines: string[] = [`Found ${totalCount} result(s)${messages.length < totalCount ? ` (showing ${messages.length})` : ""}:`, ""];
  for (const msg of messages) {
    const mediaPart = msg.media_type ? ` media=${msg.media_type}` : "";
    lines.push(
      `[MSG id=${msg.id} chat=${msg.chat_id} chat_title=${wrapUserContent(msg.chat_title)} from="${msg.sender_name}" date=${formatDate(msg.date)}${mediaPart}]`
    );
    const text = msg.text_full ?? msg.text_preview;
    if (text) {
      lines.push(wrapUserContent(text));
    }
    lines.push("");
  }
  if (hasMore && nextFromId) {
    lines.push(`(more results available — use --from=${nextFromId} to see next page)`);
  }
  return lines.join("\n");
}

export function formatUser(user: MappedUser): string {
  const lines: string[] = [
    `[USER id=${user.id}]`,
    `  name: ${wrapUserContent(`${user.first_name} ${user.last_name}`.trim())}`,
  ];
  if (user.username) lines.push(`  username: @${user.username}`);
  if (user.phone) lines.push(`  phone: ${user.phone}`);
  if (user.status) lines.push(`  status: ${user.status}`);
  if (user.bio) lines.push(`  bio: ${wrapUserContent(user.bio)}`);
  return lines.join("\n");
}

export function formatContacts(contacts: MappedContact[]): string {
  const lines: string[] = [];
  for (const c of contacts) {
    const usernamePart = c.username ? ` @${c.username}` : "";
    const phonePart = c.phone ? ` phone=${c.phone}` : "";
    lines.push(
      `[CONTACT id=${c.id}${usernamePart}${phonePart}] ${wrapUserContent(`${c.first_name} ${c.last_name}`.trim())}`
    );
  }
  return lines.join("\n");
}

export function formatUnreadChats(
  chats: Array<{ id: number; title: string; unread_count: number; muted: boolean }>
): string {
  const lines: string[] = [];
  for (const chat of chats) {
    const mutedPart = chat.muted ? " (muted)" : "";
    lines.push(
      `[CHAT id=${chat.id} unread=${chat.unread_count}${mutedPart}] ${wrapUserContent(chat.title)}`
    );
  }
  if (lines.length === 0) {
    return "No unread messages.";
  }
  return lines.join("\n");
}

export function formatSuccess(data: Record<string, any>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export interface FormattedForumTopic {
  thread_id: number;
  name: string;
  is_closed: boolean;
  is_hidden: boolean;
  is_general: boolean;
  unread_count: number;
  last_message_id: number | null;
  last_message_date: number | null;
}

export function formatForumTopics(topics: FormattedForumTopic[]): string {
  if (topics.length === 0) return "No topics.";
  const lines: string[] = [];
  for (const t of topics) {
    const flags = [
      t.is_closed ? "closed" : "open",
      t.is_hidden ? "hidden" : null,
      t.is_general ? "general" : null,
    ].filter(Boolean).join(",");
    lines.push(
      `[TOPIC thread_id=${t.thread_id} unread=${t.unread_count} flags=${flags}]`
    );
    lines.push(`  name: ${wrapUserContent(t.name)}`);
    if (t.last_message_id && t.last_message_date) {
      lines.push(`  last_message_id: ${t.last_message_id} date=${formatDate(t.last_message_date)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatForumTopic(t: FormattedForumTopic): string {
  const flags = [
    t.is_closed ? "closed" : "open",
    t.is_hidden ? "hidden" : null,
    t.is_general ? "general" : null,
  ].filter(Boolean).join(",");
  const lines: string[] = [
    `[TOPIC thread_id=${t.thread_id} unread=${t.unread_count} flags=${flags}]`,
    `  name: ${wrapUserContent(t.name)}`,
  ];
  if (t.last_message_id && t.last_message_date) {
    lines.push(`  last_message_id: ${t.last_message_id} date=${formatDate(t.last_message_date)}`);
  }
  return lines.join("\n");
}

export interface FormattedChatPrivacy {
  chat_id: number;
  title: string;
  type: "group" | "supergroup" | "channel" | "basic_group" | "private" | "secret";
  is_public: boolean;
  username: string | null;
  active_usernames: string[];
  disabled_usernames: string[];
  has_linked_chat: boolean;
  has_protected_content: boolean;
  message_auto_delete_time: number;
  invite_link_url: string | null;
}

export function formatChatPrivacy(p: FormattedChatPrivacy): string {
  const lines: string[] = [
    `[CHAT id=${p.chat_id} type=${p.type}]`,
    `  title: ${wrapUserContent(p.title)}`,
    `  public: ${p.is_public ? "yes" : "no"}`,
    `  username: ${p.username ? `@${p.username}` : "(none)"}`,
  ];
  if (p.active_usernames.length > 0) {
    lines.push(`  active_usernames: ${p.active_usernames.map((u) => `@${u}`).join(",")}`);
  }
  if (p.disabled_usernames.length > 0) {
    lines.push(`  disabled_usernames: ${p.disabled_usernames.map((u) => `@${u}`).join(",")}`);
  }
  lines.push(`  has_linked_chat: ${p.has_linked_chat ? "yes" : "no"}`);
  lines.push(`  has_protected_content: ${p.has_protected_content ? "yes" : "no"}`);
  lines.push(`  message_auto_delete_time: ${p.message_auto_delete_time}`);
  if (p.invite_link_url) {
    lines.push(`  primary_invite_link: ${p.invite_link_url}`);
  }
  return lines.join("\n");
}

export interface FormattedInviteLink {
  url: string;
  name: string;
  creator_user_id: number;
  created_date: number;
  edit_date: number;
  expiration_date: number;
  member_limit: number;
  member_count: number;
  pending_join_request_count: number;
  creates_join_request: boolean;
  is_primary: boolean;
  is_revoked: boolean;
}

function formatExpiration(ts: number): string {
  if (!ts) return "(never)";
  return formatDate(ts);
}

function formatMemberLimit(n: number): string {
  if (!n) return "(unlimited)";
  return String(n);
}

export function formatInviteLink(l: FormattedInviteLink): string {
  const lines: string[] = [
    `[LINK url=${l.url} primary=${l.is_primary ? "yes" : "no"} revoked=${l.is_revoked ? "yes" : "no"}]`,
  ];
  if (l.name) lines.push(`  name: ${wrapUserContent(l.name)}`);
  lines.push(`  created_by: ${l.creator_user_id}`);
  lines.push(`  created: ${formatDate(l.created_date)}`);
  if (l.edit_date) lines.push(`  edited: ${formatDate(l.edit_date)}`);
  lines.push(`  expires: ${formatExpiration(l.expiration_date)}`);
  lines.push(`  member_limit: ${formatMemberLimit(l.member_limit)}`);
  lines.push(`  member_count: ${l.member_count}`);
  lines.push(`  pending_join_requests: ${l.pending_join_request_count}`);
  lines.push(`  creates_join_request: ${l.creates_join_request ? "yes" : "no"}`);
  return lines.join("\n");
}

export function formatInviteLinks(
  links: FormattedInviteLink[],
  totalCount: number,
  includeRevoked: boolean
): string {
  const suffix = includeRevoked ? "including revoked" : "active only";
  if (links.length === 0) {
    return `Total: 0 (${suffix})`;
  }
  const header = `Total: ${totalCount} (${suffix})`;
  return `${header}\n\n${links.map(formatInviteLink).join("\n\n")}`;
}
