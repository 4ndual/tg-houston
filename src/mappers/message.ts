export interface MappedMessage {
  id: number;
  sender_name: string;
  sender_id: number | null;
  date: number;
  text_preview: string | null;
  text_full: string | null;
  has_media: boolean;
  media_type: string | null;
}

function getSenderName(sender: Record<string, any> | null): string {
  if (!sender) return "Unknown";
  switch (sender._) {
    case "messageSenderUser":
      return `user:${sender.user_id}`;
    case "messageSenderChat":
      return `chat:${sender.chat_id}`;
    default:
      return "Unknown";
  }
}

function getSenderId(sender: Record<string, any> | null): number | null {
  if (!sender) return null;
  switch (sender._) {
    case "messageSenderUser":
      return sender.user_id;
    case "messageSenderChat":
      return sender.chat_id;
    default:
      return null;
  }
}

function getMediaType(content: Record<string, any>): string | null {
  switch (content._) {
    case "messagePhoto":
      return "photo";
    case "messageVideo":
      return "video";
    case "messageDocument":
      return "document";
    case "messageVoiceNote":
      return "voice_note";
    case "messageAudio":
      return "audio";
    case "messageSticker":
      return "sticker";
    case "messageAnimation":
      return "animation";
    case "messageVideoNote":
      return "video_note";
    case "messageLocation":
      return "location";
    case "messageContact":
      return "contact";
    case "messagePoll":
      return "poll";
    default:
      return null;
  }
}

function extractText(content: Record<string, any>): string | null {
  switch (content._) {
    case "messageText":
      return content.text?.text ?? null;
    case "messagePhoto":
    case "messageVideo":
    case "messageDocument":
    case "messageAudio":
    case "messageVoiceNote":
      return content.caption?.text ?? null;
    default:
      return null;
  }
}

export function mapMessage(
  msg: Record<string, any>,
  detail: "preview" | "full" = "preview"
): MappedMessage {
  const fullText = extractText(msg.content);
  const mediaType = getMediaType(msg.content);

  return {
    id: msg.id,
    sender_name: getSenderName(msg.sender_id),
    sender_id: getSenderId(msg.sender_id),
    date: msg.date,
    text_preview: fullText ? fullText.slice(0, 200) : null,
    text_full: detail === "full" ? fullText : null,
    has_media: mediaType !== null && msg.content._ !== "messageText",
    media_type: mediaType,
  };
}
