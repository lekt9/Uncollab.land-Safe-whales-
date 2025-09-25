import { config } from './config';
import * as db from './db/drizzle';
import {
  approveChatJoinRequest,
  createChatInviteLink,
  initializeBot,
  kickChatMember,
  sendMessage,
  unbanChatMember,
  type TelegramMessage,
  type TelegramChatJoinRequest,
  type TelegramChatMemberUpdated,
  type ChatInviteLink,
} from './services/telegram';
import { findMatchingTransfer, verifyOwnership } from './services/solana';
import { getRandomVerificationAmount } from './utils/random';
import * as logger from './utils/logger';
import type { UserRow } from './db/drizzle';

const VERIFICATION_WINDOW_MINUTES = 30;
const TELEGRAM_MESSAGE_CHARACTER_LIMIT = 3500;

function formatPercent(value: number): string {
  return (value * 100).toFixed(4);
}

function sanitizeWallet(address?: string): string {
  if (!address) return '';
  return address.trim();
}

function isAdmin(telegramId: string): boolean {
  return config.adminIds.includes(telegramId);
}

async function notifyAdmins(message: string): Promise<void> {
  if (!config.adminIds.length) return;
  await Promise.all(
    config.adminIds.map(async (adminId) => {
      const numericId = Number(adminId);
      if (!Number.isFinite(numericId)) {
        logger.warn(`Skipping admin notification for non-numeric ID ${adminId}`);
        return;
      }
      try {
        await sendMessage(numericId, message, { parseMode: undefined });
      } catch (error) {
        logger.warn(`Failed to notify admin ${adminId}`, error);
      }
    })
  );
}

function formatUserIdentifier(user: UserRow | null): string {
  if (!user) {
    return 'unknown user';
  }
  if (user.username) {
    return `@${user.username}`;
  }
  return `ID ${user.telegramId}`;
}

function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const line of lines) {
    if (currentLength + line.length + 1 > TELEGRAM_MESSAGE_CHARACTER_LIMIT) {
      chunks.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += line.length + 1;
  }
  if (current.length) {
    chunks.push(current.join('\n'));
  }
  return chunks;
}

function formatAuditLine(user: UserRow, index: number): string {
  const balance = user.lastBalance ?? 0;
  const verifiedAt = user.verifiedAt ? new Date(user.verifiedAt).toISOString() : 'unknown';
  const lastChecked = user.lastCheckedAt ? new Date(user.lastCheckedAt).toISOString() : 'unknown';
  const wallet = user.walletAddress ?? 'n/a';
  const status = user.isWhitelisted ? 'whitelisted' : 'verified';
  return `${index + 1}. ${formatUserIdentifier(user)} — ${status}\n    Wallet: ${wallet}\n    Balance: ${balance}\n    Verified: ${verifiedAt}\n    Last sweep: ${lastChecked}`;
}

async function handleStart(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  if (!from) return;
  db.upsertUser(String(from.id), from.username || from.first_name || '');
  const instructions = [
    '*Welcome to the SafeSol Gating Bot!*',
    '',
    '1. Request to join the gated Telegram group.',
    `2. Run /verify <wallet> with the Solana wallet that holds your ${config.tokenMint ? `SPL token (${config.tokenMint})` : 'token'}.`,
    '3. You will receive a unique token amount to send to the treasury wallet as a verification code.',
    '4. Send the token transfer and then run /confirm to finish.',
    '',
    `You must continue to hold at least ${formatPercent(config.requiredPercent)}% of the total token supply to stay in the group. The bot checks this hourly.`,
  ].join('\n');
  await sendMessage(chatId, instructions);
}

async function handleVerify(message: TelegramMessage, args: string[]): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  if (!from) return;
  db.upsertUser(String(from.id), from.username || from.first_name || '');
  const wallet = sanitizeWallet(args[0]);
  if (!wallet) {
    await sendMessage(chatId, 'Please provide a wallet address. Example: /verify YourWalletAddress');
    return;
  }
  const verificationAmount = getRandomVerificationAmount();
  const expiresAt = new Date(Date.now() + VERIFICATION_WINDOW_MINUTES * 60 * 1000);
  db.saveVerificationRequest(String(from.id), wallet, verificationAmount, expiresAt, config.groupId || null);
  const instructions = [
    'Your verification amount is:',
    '```',
    `${verificationAmount} tokens`,
    '```',
    `Send exactly this amount of the configured SPL token to the treasury wallet: \`${config.treasuryWallet}\`.`,
    '',
    `Once the transfer is confirmed on-chain, run /confirm to finish. This code expires in ${VERIFICATION_WINDOW_MINUTES} minutes.`,
  ].join('\n');
  await sendMessage(chatId, instructions, { parseMode: 'Markdown' });
}

function inviteExpirationNotice(): string {
  if (config.inviteLinkTtlMinutes <= 0) {
    return '';
  }
  if (config.inviteLinkTtlMinutes === 1) {
    return 'The invite link expires in 1 minute.';
  }
  return `The invite link expires in ${config.inviteLinkTtlMinutes} minutes.`;
}

async function deliverInviteLink(userId: number, groupId: number): Promise<ChatInviteLink> {
  const expireSeconds = config.inviteLinkTtlMinutes > 0 ? Math.max(60, Math.floor(config.inviteLinkTtlMinutes * 60)) : undefined;
  const invite = await createChatInviteLink(groupId, {
    expireDate: expireSeconds ? Math.floor(Date.now() / 1000) + expireSeconds : undefined,
    memberLimit: config.inviteLinkMemberLimit > 0 ? Math.floor(config.inviteLinkMemberLimit) : undefined,
    createsJoinRequest: false,
    name: `SafeSol whale invite ${userId}`,
  });
  const expiresAt = invite.expire_date ? new Date(invite.expire_date * 1000) : undefined;
  db.recordInviteLink(String(userId), invite.invite_link, expiresAt ?? null);
  const lines = [
    'Verification successful! Tap the button below to enter the gated chat.',
  ];
  const expirationLine = inviteExpirationNotice();
  if (expirationLine) {
    lines.push('', expirationLine);
  }
  await sendMessage(userId, lines.join('\n'), {
    replyMarkup: {
      inline_keyboard: [[{ text: 'Join the whale group', url: invite.invite_link }]],
    },
  });
  return invite;
}

async function handleConfirm(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  if (!from) return;
  const user = db.getUserByTelegramId(String(from.id));
  if (!user || user.verificationCode === null) {
    await sendMessage(chatId, 'No active verification request found. Use /verify <wallet> to start.');
    return;
  }
  if (!user.walletAddress) {
    await sendMessage(chatId, 'Please set your wallet address using /verify <wallet> first.');
    return;
  }
  if (!config.tokenMint || !config.treasuryWallet) {
    await sendMessage(chatId, 'The bot is missing token mint or treasury configuration. Please contact an admin.');
    return;
  }
  if (user.verificationExpiresAt) {
    const expires = new Date(user.verificationExpiresAt);
    if (Date.now() > expires.getTime()) {
      db.clearVerification(String(from.id));
      await sendMessage(chatId, 'Your verification code expired. Please start again with /verify <wallet>.');
      return;
    }
  }
  try {
    const transfer = await findMatchingTransfer({
      userWallet: user.walletAddress,
      treasuryWallet: config.treasuryWallet,
      mint: config.tokenMint,
      expectedAmount: user.verificationCode,
    });
    if (!transfer) {
      await sendMessage(chatId, 'Could not find the matching transfer yet. Please wait a few moments and try /confirm again.');
      return;
    }
    const ownership = await verifyOwnership({
      walletAddress: user.walletAddress,
      mint: config.tokenMint,
      requiredPercent: config.requiredPercent,
    });
    if (!ownership.isQualified) {
      await sendMessage(chatId, `We confirmed your transfer but your holdings (${formatPercent(ownership.percentOwned)}% of supply) are below the required threshold of ${formatPercent(config.requiredPercent)}%.`);
      return;
    }
    db.markVerified(String(from.id), ownership.balance);
    db.clearVerification(String(from.id));
    const groupId = user.requestedGroupId || config.groupId;
    if (groupId) {
      const numericGroupId = Number(groupId);
      if (user.requestedGroupId) {
        try {
          await approveChatJoinRequest(numericGroupId, from.id);
        } catch (approvalError) {
          logger.warn('Failed to approve historical join request before issuing invite', approvalError);
        }
      }
      let invite: ChatInviteLink | null = null;
      try {
        invite = await deliverInviteLink(from.id, numericGroupId);
      } catch (inviteError) {
        logger.error('Failed to deliver invite link', inviteError);
        await sendMessage(chatId, 'Verification succeeded but we could not generate an invite link. Please contact an admin.');
        return;
      } finally {
        db.clearRequestedGroup(String(from.id));
      }
      const latestUser = db.getUserByTelegramId(String(from.id));
      const adminLines = [
        `✅ Verified ${formatUserIdentifier(latestUser)} (${from.id})`,
        `Wallet: ${latestUser?.walletAddress ?? user.walletAddress}`,
        `Balance: ${ownership.balance}`,
      ];
      if (invite) {
        adminLines.push(`Invite link: ${invite.invite_link}`);
      }
      await notifyAdmins(adminLines.join('\n'));
    } else {
      await sendMessage(chatId, 'Verification successful! An admin will add you to the group shortly.');
      await notifyAdmins(
        [`✅ Verified ${formatUserIdentifier(user)} (${from.id})`, `Wallet: ${user.walletAddress}`, `Balance: ${ownership.balance}`].join('\n')
      );
    }
  } catch (error) {
    logger.error('Verification failed', error);
    const messageText = error instanceof Error ? error.message : 'Unknown error';
    await sendMessage(chatId, `Verification failed: ${messageText}`);
  }
}

async function handleStatus(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  if (!from) return;
  const user = db.getUserByTelegramId(String(from.id));
  if (!user) {
    await sendMessage(chatId, 'No profile found. Use /verify <wallet> to start the verification process.');
    return;
  }
  const lines: string[] = [];
  lines.push(`Wallet: ${user.walletAddress || 'Not set'}`);
  lines.push(`Verified: ${user.verified ? 'Yes' : 'No'}`);
  if (user.lastBalance !== null && user.lastBalance !== undefined) {
    lines.push(`Last balance: ${user.lastBalance}`);
  }
  if (user.verifiedAt) {
    lines.push(`Verified at: ${user.verifiedAt}`);
  }
  if (user.verificationCode) {
    lines.push(`Pending verification amount: ${user.verificationCode}`);
  }
  await sendMessage(chatId, lines.join('\n'));
}

async function handleWhitelist(message: TelegramMessage, args: string[]): Promise<void> {
  const from = message.from;
  if (!from) return;
  const fromId = String(from.id);
  if (!isAdmin(fromId)) {
    await sendMessage(message.chat.id, 'You are not authorized to use this command.');
    return;
  }
  if (!args[0]) {
    await sendMessage(message.chat.id, 'Usage: /whitelist <telegram_id|@username>');
    return;
  }
  let targetId = args[0];
  if (targetId.startsWith('@')) {
    targetId = targetId.slice(1);
    const match = db.findUserByUsername(targetId);
    if (match) {
      targetId = String(match.telegramId);
    } else {
      await sendMessage(message.chat.id, `Could not find a user with username @${targetId}.`);
      return;
    }
  }
  db.setWhitelist(String(targetId), true);
  const user = db.getUserByTelegramId(String(targetId));
  if (user && user.requestedGroupId) {
    try {
      await approveChatJoinRequest(Number(user.requestedGroupId), Number(user.telegramId));
      await sendMessage(Number(user.telegramId), 'An admin added you to the whitelist and you have been approved to join.');
      db.clearRequestedGroup(String(user.telegramId));
    } catch (error) {
      logger.error('Failed to approve whitelisted user', error);
    }
  }
  await sendMessage(message.chat.id, `Whitelisted user ${targetId}.`);
}

async function handleAudit(message: TelegramMessage): Promise<void> {
  const from = message.from;
  if (!from) return;
  if (!isAdmin(String(from.id))) {
    await sendMessage(message.chat.id, 'You are not authorized to use this command.');
    return;
  }
  const verifiedUsers = db.getVerifiedUsers();
  const pendingUsers = db.getPendingUsers();
  if (!verifiedUsers.length && !pendingUsers.length) {
    await sendMessage(message.chat.id, 'No whales have verified yet.');
    return;
  }
  const sortedVerified = [...verifiedUsers].sort((a, b) => {
    const aBalance = a.lastBalance ?? 0;
    const bBalance = b.lastBalance ?? 0;
    return bBalance - aBalance;
  });
  const lines: string[] = [];
  lines.push(`Verified whales: ${sortedVerified.length}`);
  lines.push(`Pending verifications: ${pendingUsers.length}`);
  lines.push('');
  sortedVerified.forEach((user, index) => {
    lines.push(formatAuditLine(user, index));
    lines.push('');
  });
  if (pendingUsers.length) {
    lines.push('Pending users:');
    pendingUsers.forEach((user) => {
      lines.push(
        `- ${formatUserIdentifier(user)} — wallet: ${user.walletAddress ?? 'n/a'}, requested group: ${user.requestedGroupId ?? 'n/a'}`
      );
    });
  }
  const messageChunks = chunkLines(lines.filter(Boolean));
  for (const chunk of messageChunks) {
    await sendMessage(message.chat.id, chunk, { parseMode: undefined });
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!message.text) return;
  const text = message.text.trim();
  if (!text.startsWith('/')) return;
  const [command, ...rest] = text.split(/\s+/);
  switch (command.toLowerCase()) {
    case '/start':
      await handleStart(message);
      break;
    case '/verify':
      await handleVerify(message, rest);
      break;
    case '/confirm':
      await handleConfirm(message);
      break;
    case '/status':
      await handleStatus(message);
      break;
    case '/whitelist':
      await handleWhitelist(message, rest);
      break;
    case '/audit':
      await handleAudit(message);
      break;
    default:
      await sendMessage(
        message.chat.id,
        'Unknown command. Available commands: /start, /verify, /confirm, /status, /whitelist, /audit.'
      );
  }
}

async function handleChatJoinRequest(request: TelegramChatJoinRequest): Promise<void> {
  const userId = String(request.from.id);
  const username = request.from.username || request.from.first_name || '';
  db.setRequestedGroup(userId, String(request.chat.id));
  db.upsertUser(userId, username);
  const user = db.getUserByTelegramId(userId);
  if (user && user.isWhitelisted) {
    await approveChatJoinRequest(request.chat.id, request.from.id);
    await sendMessage(request.from.id, 'You are whitelisted and have been approved to join the group.');
    db.clearRequestedGroup(userId);
    return;
  }
  const messageLines = [
    `Hi ${request.from.first_name || 'there'}!`,
    'To join the group you must verify token ownership.',
    '',
    'Please start a private chat with me and run /start followed by /verify <wallet_address>.',
    'Once verified, I will send you a single-use invite button.',
    `Treasury wallet: \`${config.treasuryWallet}\``,
  ];
  await sendMessage(request.from.id, messageLines.join('\n'), { parseMode: 'Markdown' });
}

async function handleChatMemberUpdate(update: TelegramChatMemberUpdated): Promise<void> {
  const userIdValue = update.from?.id || update.new_chat_member?.user?.id;
  if (!userIdValue) return;
  const userId = String(userIdValue);
  if (update.new_chat_member?.status === 'left' || update.new_chat_member?.status === 'kicked') {
    const user = db.getUserByTelegramId(userId);
    if (user) {
      db.updateBalance(userId, 0);
    }
  }
}

async function runOwnershipSweep(): Promise<void> {
  const users = db.getVerifiedUsers();
  if (!users.length) {
    logger.log('Ownership sweep: no verified users to check.');
    return;
  }
  logger.log(`Ownership sweep: checking ${users.length} users.`);
  for (const user of users) {
    if (user.isWhitelisted) {
      continue;
    }
    try {
      if (!user.walletAddress) {
        continue;
      }
      const ownership = await verifyOwnership({
        walletAddress: user.walletAddress,
        mint: config.tokenMint,
        requiredPercent: config.requiredPercent,
      });
      db.updateBalance(String(user.telegramId), ownership.balance);
      if (!ownership.isQualified) {
        logger.warn(`User ${user.telegramId} dropped below threshold. Kicking.`);
        if (config.groupId) {
          await kickChatMember(Number(config.groupId), Number(user.telegramId));
          await unbanChatMember(Number(config.groupId), Number(user.telegramId));
        }
        await sendMessage(
          Number(user.telegramId),
          `You were removed from the group because your holdings fell to ${formatPercent(ownership.percentOwned)}% of supply. Required: ${formatPercent(config.requiredPercent)}%.`
        );
        db.logEvent(String(user.telegramId), 'ownership_revoked', {
          balance: ownership.balance,
          percentOwned: ownership.percentOwned,
        });
        await notifyAdmins(
          [
            `⚠️ Removed ${formatUserIdentifier(user)} (${user.telegramId}) for dropping below threshold`,
            `Latest balance: ${ownership.balance}`,
            `Percent owned: ${formatPercent(ownership.percentOwned)}%`,
          ].join('\n')
        );
      }
    } catch (error) {
      logger.error('Ownership sweep error for user', user.telegramId, error);
    }
  }
}

async function main(): Promise<void> {
  if (!config.telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN must be set.');
  }
  if (!config.treasuryWallet || !config.tokenMint) {
    logger.warn('Treasury wallet or token mint not configured. Verification cannot complete until they are set.');
  }
  db.initializeSchema();
  const botClient = await initializeBot();
  botClient.on('message', (message) => {
    handleMessage(message).catch((error) => {
      logger.error('Error processing message', error);
    });
  });
  botClient.on('chat_join_request', (request) => {
    handleChatJoinRequest(request).catch((error) => {
      logger.error('Error handling chat join request', error);
    });
  });
  botClient.on('chat_member', (update) => {
    handleChatMemberUpdate(update).catch((error) => {
      logger.error('Error handling chat member update', error);
    });
  });
  botClient.on('my_chat_member', (update) => {
    handleChatMemberUpdate(update).catch((error) => {
      logger.error('Error handling my_chat_member update', error);
    });
  });
  botClient.on('polling_error', (error) => {
    logger.error('Polling error', error);
  });
  setInterval(runOwnershipSweep, config.hourlyCheckIntervalMs);
  logger.log('SafeSol gating bot is running.');
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Fatal error', error);
    process.exit(1);
  });
}

export default main;
