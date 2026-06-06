import type { MappedChat, MappedChatDetail } from "../mappers/chat";
import type { MappedMessage } from "../mappers/message";
import type { MappedUser, MappedContact } from "../mappers/user";

export interface ListChatsResponse {
  chats: MappedChat[];
  has_more: boolean;
}

export interface GetChatResponse extends MappedChatDetail {}

export interface ChatHistoryResponse {
  messages: MappedMessage[];
  has_more: boolean;
}

export interface SendMessageResponse {
  message_id: number;
  date: number;
}

export interface ForwardMessagesResponse {
  forwarded_message_ids: number[];
}

export interface SearchMessagesResponse {
  messages: (MappedMessage & { chat_id: number; chat_title: string })[];
  total_count: number;
}

export interface ContactsResponse {
  contacts: MappedContact[];
}

export interface UserResponse extends MappedUser {}

export interface UnreadCountResponse {
  unread_count: number;
  unread_unmuted_count: number;
}

export interface SuccessResponse {
  success: boolean;
}

export interface DownloadFileResponse {
  local_path: string;
  size_bytes: number;
}
