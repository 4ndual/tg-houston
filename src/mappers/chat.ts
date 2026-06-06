export interface MappedChat {
  id: number;
  title: string;
  type: "private" | "group" | "supergroup" | "channel" | "secret";
  unread_count: number;
  last_message_preview: string | null;
}

export interface MappedChatDetail {
  id: number;
  title: string;
  type: "private" | "group" | "supergroup" | "channel" | "secret";
  member_count: number | null;
  description: string | null;
  unread_count: number;
}

function chatType(tdType: Record<string, any>): MappedChat["type"] {
  switch (tdType._) {
    case "chatTypePrivate":
      return "private";
    case "chatTypeBasicGroup":
      return "group";
    case "chatTypeSupergroup":
      return tdType.is_channel ? "channel" : "supergroup";
    case "chatTypeSecret":
      return "secret";
    default:
      return "private";
  }
}

function extractTextPreview(message: Record<string, any> | null, maxLen = 200): string | null {
  if (!message) return null;
  const content = message.content;
  if (!content) return null;

  switch (content._) {
    case "messageText":
      return content.text?.text?.slice(0, maxLen) ?? null;
    case "messagePhoto":
      return content.caption?.text?.slice(0, maxLen) || "[Photo]";
    case "messageVideo":
      return content.caption?.text?.slice(0, maxLen) || "[Video]";
    case "messageDocument":
      return content.caption?.text?.slice(0, maxLen) || `[Document: ${content.document?.file_name || "file"}]`;
    case "messageVoiceNote":
      return "[Voice note]";
    case "messageAudio":
      return `[Audio: ${content.audio?.title || "audio"}]`;
    case "messageSticker":
      return `[Sticker: ${content.sticker?.emoji || ""}]`;
    case "messageAnimation":
      return "[GIF]";
    case "messageVideoNote":
      return "[Video note]";
    case "messageLocation":
      return "[Location]";
    case "messageContact":
      return "[Contact]";
    case "messagePoll":
      return `[Poll: ${content.poll?.question?.text || ""}]`;
    default:
      return `[${content._.replace("message", "")}]`;
  }
}

export function mapChat(chat: Record<string, any>): MappedChat {
  return {
    id: chat.id,
    title: chat.title,
    type: chatType(chat.type),
    unread_count: chat.unread_count ?? 0,
    last_message_preview: extractTextPreview(chat.last_message),
  };
}

export function mapChatDetail(
  chat: Record<string, any>,
  extra: { member_count?: number; description?: string } = {}
): MappedChatDetail {
  return {
    id: chat.id,
    title: chat.title,
    type: chatType(chat.type),
    member_count: extra.member_count ?? null,
    description: extra.description ?? null,
    unread_count: chat.unread_count ?? 0,
  };
}

export { extractTextPreview };
