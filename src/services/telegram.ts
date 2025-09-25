import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';

export type TelegramMessage = TelegramBot.Message;
export type TelegramChatJoinRequest = TelegramBot.ChatJoinRequest;
export type TelegramChatMemberUpdated = TelegramBot.ChatMemberUpdated;
export type ChatInviteLink = TelegramBot.ChatInviteLink;

export interface SendMessageOptions {
  parseMode?: TelegramBot.ParseMode;
  disablePreview?: boolean;
  replyMarkup?: TelegramBot.SendMessageOptions['reply_markup'];
}

export interface CreateChatInviteLinkOptions {
  expireDate?: number;
  memberLimit?: number;
  name?: string;
  createsJoinRequest?: boolean;
}

let botInstance: TelegramBot | null = null;

function ensureBot(): TelegramBot {
  if (!config.telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }
  if (!botInstance) {
    botInstance = new TelegramBot(config.telegramToken, { polling: false });
  }
  return botInstance;
}

export async function initializeBot(): Promise<TelegramBot> {
  const bot = ensureBot();
  if (!bot.isPolling()) {
    await bot.startPolling();
  }
  return bot;
}

export function sendMessage(chatId: number, text: string, options: SendMessageOptions = {}): Promise<TelegramBot.Message> {
  const bot = ensureBot();
  return bot.sendMessage(chatId, text, {
    parse_mode: options.parseMode ?? 'Markdown',
    disable_web_page_preview: options.disablePreview ?? true,
    reply_markup: options.replyMarkup,
  });
}

export function createChatInviteLink(chatId: number, options: CreateChatInviteLinkOptions = {}): Promise<ChatInviteLink> {
  const bot = ensureBot();
  const payload: TelegramBot.CreateChatInviteLinkOptions = {
    expire_date: options.expireDate,
    member_limit: options.memberLimit,
    name: options.name,
    creates_join_request: options.createsJoinRequest,
  };
  return bot.createChatInviteLink(chatId, payload);
}

export function approveChatJoinRequest(chatId: number, userId: number): Promise<boolean> {
  return ensureBot().approveChatJoinRequest(chatId, userId);
}

export function declineChatJoinRequest(chatId: number, userId: number): Promise<boolean> {
  return ensureBot().declineChatJoinRequest(chatId, userId);
}

export function kickChatMember(chatId: number, userId: number, untilDate?: number): Promise<boolean> {
  if (untilDate) {
    return ensureBot().banChatMember(chatId, userId, { until_date: untilDate });
  }
  return ensureBot().banChatMember(chatId, userId);
}

export function unbanChatMember(chatId: number, userId: number): Promise<boolean> {
  return ensureBot().unbanChatMember(chatId, userId);
}

export function getBot(): TelegramBot {
  return ensureBot();
}

