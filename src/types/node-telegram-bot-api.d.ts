declare module 'node-telegram-bot-api' {
  namespace TelegramBot {
    type ParseMode = 'Markdown' | 'MarkdownV2' | 'HTML' | string;

    interface SendMessageOptions {
      parse_mode?: ParseMode;
      disable_web_page_preview?: boolean;
      reply_markup?: any;
    }

    interface CreateChatInviteLinkOptions {
      expire_date?: number;
      member_limit?: number;
      name?: string;
      creates_join_request?: boolean;
    }

    interface ChatInviteLink {
      invite_link: string;
      expire_date?: number;
      member_limit?: number;
      creates_join_request?: boolean;
      is_primary?: boolean;
      is_revoked?: boolean;
      name?: string;
    }

    interface User {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    }

    interface Chat {
      id: number;
      type: string;
    }

    interface Message {
      message_id: number;
      date: number;
      chat: Chat;
      from?: User;
      text?: string;
    }

    interface ChatJoinRequest {
      chat: Chat;
      from: User;
      user_chat_id?: number;
      date?: number;
      bio?: string;
    }

    interface ChatMember {
      user: User;
      status: string;
    }

    interface ChatMemberUpdated {
      from: User;
      chat: Chat;
      date: number;
      old_chat_member?: ChatMember;
      new_chat_member?: ChatMember;
    }
  }

  class TelegramBot {
    constructor(token: string, options?: any);
    startPolling(): Promise<void>;
    stopPolling(): Promise<void>;
    isPolling(): boolean;

    on(event: 'message', listener: (msg: TelegramBot.Message) => void): this;
    on(event: 'chat_join_request', listener: (request: TelegramBot.ChatJoinRequest) => void): this;
    on(event: 'chat_member', listener: (update: TelegramBot.ChatMemberUpdated) => void): this;
    on(event: 'my_chat_member', listener: (update: TelegramBot.ChatMemberUpdated) => void): this;
    on(event: 'polling_error', listener: (error: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;

    sendMessage(chatId: number | string, text: string, options?: TelegramBot.SendMessageOptions): Promise<TelegramBot.Message>;
    createChatInviteLink(chatId: number | string, options?: TelegramBot.CreateChatInviteLinkOptions): Promise<TelegramBot.ChatInviteLink>;
    approveChatJoinRequest(chatId: number | string, userId: number): Promise<boolean>;
    declineChatJoinRequest(chatId: number | string, userId: number): Promise<boolean>;
    banChatMember(chatId: number | string, userId: number, options?: { until_date?: number }): Promise<boolean>;
    unbanChatMember(chatId: number | string, userId: number, options?: { only_if_banned?: boolean }): Promise<boolean>;
  }

  export = TelegramBot;
}

