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
} from './services/telegram';
import { findMatchingTransfer, verifyOwnership } from './services/solana';
import { getRandomVerificationAmount } from './utils/random';
import * as logger from './utils/logger';

const VERIFICATION_WINDOW_MINUTES = 30;

function formatPercent(value: number): string {
  return (value * 100).toFixed(4);
}

function sanitizeWallet(address?: string): string {
  if (!address) return '';
  return address.trim();
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
    `Your verification amount is *${verificationAmount}* tokens.`,
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

async function deliverInviteLink(userId: number, groupId: number): Promise<void> {
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
}

async function handleConfirm(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  if (!from) return;
  const user = db.getUserByTelegramId(String(from.id));
  if (!user || user.verification_code === null) {
    await sendMessage(chatId, 'No active verification request found. Use /verify <wallet> to start.');
    return;
  }
  if (!user.wallet_address) {
    await sendMessage(chatId, 'Please set your wallet address using /verify <wallet> first.');
    return;
  }
  if (!config.tokenMint || !config.treasuryWallet) {
    await sendMessage(chatId, 'The bot is missing token mint or treasury configuration. Please contact an admin.');
    return;
  }
  if (user.verification_expires_at) {
    const expires = new Date(user.verification_expires_at);
    if (Date.now() > expires.getTime()) {
      db.clearVerification(String(from.id));
      await sendMessage(chatId, 'Your verification code expired. Please start again with /verify <wallet>.');
      return;
    }
  }
  try {
    const transfer = await findMatchingTransfer({
      userWallet: user.wallet_address,
      treasuryWallet: config.treasuryWallet,
      mint: config.tokenMint,
      expectedAmount: user.verification_code,
    });
    if (!transfer) {
      await sendMessage(chatId, 'Could not find the matching transfer yet. Please wait a few moments and try /confirm again.');
      return;
    }
    const ownership = await verifyOwnership({
      walletAddress: user.wallet_address,
      mint: config.tokenMint,
      requiredPercent: config.requiredPercent,
    });
    if (!ownership.isQualified) {
      await sendMessage(chatId, `We confirmed your transfer but your holdings (${formatPercent(ownership.percentOwned)}% of supply) are below the required threshold of ${formatPercent(config.requiredPercent)}%.`);
      return;
    }
    db.markVerified(String(from.id), ownership.balance);
    db.clearVerification(String(from.id));
    const groupId = user.requested_group_id || config.groupId;
    if (groupId) {
      const numericGroupId = Number(groupId);
      if (user.requested_group_id) {
        try {
          await approveChatJoinRequest(numericGroupId, from.id);
        } catch (approvalError) {
          logger.warn('Failed to approve historical join request before issuing invite', approvalError);
        }
      }
      try {
        await deliverInviteLink(from.id, numericGroupId);
      } catch (inviteError) {
        logger.error('Failed to deliver invite link', inviteError);
        await sendMessage(chatId, 'Verification succeeded but we could not generate an invite link. Please contact an admin.');
        return;
      } finally {
        db.clearRequestedGroup(String(from.id));
      }
    } else {
      await sendMessage(chatId, 'Verification successful! An admin will add you to the group shortly.');
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
  lines.push(`Wallet: ${user.wallet_address || 'Not set'}`);
  lines.push(`Verified: ${user.verified ? 'Yes' : 'No'}`);
  if (user.last_balance !== null && user.last_balance !== undefined) {
    lines.push(`Last balance: ${user.last_balance}`);
  }
  if (user.verified_at) {
    lines.push(`Verified at: ${user.verified_at}`);
  }
  if (user.verification_code) {
    lines.push(`Pending verification amount: ${user.verification_code}`);
  }
  await sendMessage(chatId, lines.join('\n'));
}

async function handleWhitelist(message: TelegramMessage, args: string[]): Promise<void> {
  const from = message.from;
  if (!from) return;
  const fromId = String(from.id);
  if (!config.adminIds.includes(fromId)) {
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
      targetId = String(match.telegram_id);
    } else {
      await sendMessage(message.chat.id, `Could not find a user with username @${targetId}.`);
      return;
    }
  }
  db.setWhitelist(String(targetId), true);
  const user = db.getUserByTelegramId(String(targetId));
  if (user && user.requested_group_id) {
    try {
      await approveChatJoinRequest(Number(user.requested_group_id), Number(user.telegram_id));
      await sendMessage(Number(user.telegram_id), 'An admin added you to the whitelist and you have been approved to join.');
      db.clearRequestedGroup(String(user.telegram_id));
    } catch (error) {
      logger.error('Failed to approve whitelisted user', error);
    }
  }
  await sendMessage(message.chat.id, `Whitelisted user ${targetId}.`);
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
    default:
      await sendMessage(message.chat.id, 'Unknown command. Available commands: /start, /verify, /confirm, /status.');
  }
}

async function handleChatJoinRequest(request: TelegramChatJoinRequest): Promise<void> {
  const userId = String(request.from.id);
  const username = request.from.username || request.from.first_name || '';
  db.setRequestedGroup(userId, String(request.chat.id));
  db.upsertUser(userId, username);
  const user = db.getUserByTelegramId(userId);
  if (user && user.is_whitelisted) {
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
    if (user.is_whitelisted) {
      continue;
    }
    try {
      if (!user.wallet_address) {
        continue;
      }
      const ownership = await verifyOwnership({
        walletAddress: user.wallet_address,
        mint: config.tokenMint,
        requiredPercent: config.requiredPercent,
      });
      db.updateBalance(String(user.telegram_id), ownership.balance);
      if (!ownership.isQualified) {
        logger.warn(`User ${user.telegram_id} dropped below threshold. Kicking.`);
        if (config.groupId) {
          await kickChatMember(Number(config.groupId), Number(user.telegram_id));
          await unbanChatMember(Number(config.groupId), Number(user.telegram_id));
        }
        await sendMessage(
          Number(user.telegram_id),
          `You were removed from the group because your holdings fell to ${formatPercent(ownership.percentOwned)}% of supply. Required: ${formatPercent(config.requiredPercent)}%.`
        );
      }
    } catch (error) {
      logger.error('Ownership sweep error for user', user.telegram_id, error);
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
