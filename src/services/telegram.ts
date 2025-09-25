import { config } from '../config';

const API_BASE = `https://api.telegram.org/bot${config.telegramToken}`;

export interface SendMessageOptions {
  parseMode?: string;
  disablePreview?: boolean;
  replyMarkup?: unknown;
}

async function apiRequest<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!config.telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }
  const url = `${API_BASE}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${text}`);
  }
  const json = await response.json();
  if (!json.ok) {
    throw new Error(`Telegram API responded with error: ${JSON.stringify(json)}`);
  }
  return json.result as T;
}

export function sendMessage(chatId: number, text: string, options: SendMessageOptions = {}): Promise<unknown> {
  return apiRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode || 'Markdown',
    disable_web_page_preview: options.disablePreview !== false,
    reply_markup: options.replyMarkup,
  });
}

export function approveChatJoinRequest(chatId: number, userId: number): Promise<unknown> {
  return apiRequest('approveChatJoinRequest', {
    chat_id: chatId,
    user_id: userId,
  });
}

export function declineChatJoinRequest(chatId: number, userId: number): Promise<unknown> {
  return apiRequest('declineChatJoinRequest', {
    chat_id: chatId,
    user_id: userId,
  });
}

export function kickChatMember(chatId: number, userId: number, untilDate?: number): Promise<unknown> {
  return apiRequest('banChatMember', {
    chat_id: chatId,
    user_id: userId,
    until_date: untilDate,
  });
}

export function unbanChatMember(chatId: number, userId: number): Promise<unknown> {
  return apiRequest('unbanChatMember', {
    chat_id: chatId,
    user_id: userId,
  });
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
  };
  chat_join_request?: {
    from: { id: number; username?: string; first_name?: string };
    chat: { id: number };
  };
  chat_member?: Record<string, unknown>;
  my_chat_member?: Record<string, unknown>;
}

export function getUpdates(offset: number, timeout = 30): Promise<TelegramUpdate[]> {
  return apiRequest('getUpdates', {
    offset,
    timeout,
    allowed_updates: ['message', 'chat_join_request', 'chat_member', 'my_chat_member'],
  });
}

export default {
  apiRequest,
  sendMessage,
  approveChatJoinRequest,
  declineChatJoinRequest,
  kickChatMember,
  unbanChatMember,
  getUpdates,
};
