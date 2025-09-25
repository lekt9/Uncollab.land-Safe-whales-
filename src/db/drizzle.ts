import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  sqliteTable,
  integer,
  text,
  real,
} from 'drizzle-orm/sqlite-core';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { config } from '../config';

const DB_PATH = config.databasePath;

function ensureDatabaseDirectory(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDatabaseDirectory();

const sqlite = new Database(DB_PATH);
const db: BetterSQLite3Database = drizzle(sqlite);

const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramId: text('telegram_id').notNull().unique(),
  username: text('username'),
  walletAddress: text('wallet_address'),
  verificationCode: real('verification_code'),
  verificationExpiresAt: text('verification_expires_at'),
  verified: integer('verified').notNull().default(0),
  verifiedAt: text('verified_at'),
  lastBalance: real('last_balance'),
  lastCheckedAt: text('last_checked_at'),
  isWhitelisted: integer('is_whitelisted').notNull().default(0),
  requestedGroupId: text('requested_group_id'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

const verificationEvents = sqliteTable('verification_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: text('payload'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

const groupInvites = sqliteTable('group_invites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  inviteLink: text('invite_link').notNull(),
  expiresAt: text('expires_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type UserRow = typeof users.$inferSelect;
export type GroupInviteRow = typeof groupInvites.$inferSelect;

let schemaInitialized = false;

function getUserRecord(telegramId: string): UserRow | null {
  return (
    db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId))
      .get() ?? null
  );
}

export function initializeSchema(): void {
  if (schemaInitialized) return;
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT,
      wallet_address TEXT,
      verification_code REAL,
      verification_expires_at TEXT,
      verified INTEGER DEFAULT 0,
      verified_at TEXT,
      last_balance REAL,
      last_checked_at TEXT,
      is_whitelisted INTEGER DEFAULT 0,
      requested_group_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS verification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS group_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      invite_link TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TRIGGER IF NOT EXISTS users_updated_at
    AFTER UPDATE ON users
    BEGIN
      UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
    END;
  `);
  schemaInitialized = true;
}

function ensureInitialized(): void {
  if (!schemaInitialized) {
    initializeSchema();
  }
}

function insertEvent(userId: number, eventType: string, payload: Record<string, unknown>): void {
  db
    .insert(verificationEvents)
    .values({
      userId,
      eventType,
      payload: Object.keys(payload).length ? JSON.stringify(payload) : null,
    })
    .run();
}

export function upsertUser(telegramId: string, username?: string): UserRow | null {
  ensureInitialized();
  const existing = getUserRecord(telegramId);
  if (existing) {
    const newUsername = username ?? existing.username ?? null;
    db
      .update(users)
      .set({
        username: newUsername,
      })
      .where(eq(users.telegramId, telegramId))
      .run();
    return getUserRecord(telegramId);
  }
  db
    .insert(users)
    .values({
      telegramId,
      username: username ?? null,
    })
    .run();
  return getUserRecord(telegramId);
}

export function saveVerificationRequest(
  telegramId: string,
  walletAddress: string,
  verificationCode: number,
  expiresAt: Date | null,
  requestedGroupId: string | null
): void {
  const user = upsertUser(telegramId);
  if (!user) return;
  const updates: Partial<typeof users.$inferInsert> = {
    walletAddress,
    verificationCode,
    verificationExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    verified: 0,
  };
  if (requestedGroupId !== null && requestedGroupId !== undefined) {
    updates.requestedGroupId = requestedGroupId;
  }
  db
    .update(users)
    .set(updates)
    .where(eq(users.telegramId, telegramId))
    .run();
  insertEvent(user.id, 'verification_requested', {
    walletAddress,
    verificationCode,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  });
}

export function markVerified(telegramId: string, balance: number): void {
  ensureInitialized();
  const user = getUserRecord(telegramId);
  if (!user) return;
  const now = new Date().toISOString();
  db
    .update(users)
    .set({
      verified: 1,
      verifiedAt: now,
      lastBalance: balance,
      lastCheckedAt: now,
    })
    .where(eq(users.telegramId, telegramId))
    .run();
  insertEvent(user.id, 'verified', { balance });
}

export function recordInviteLink(telegramId: string, inviteLink: string, expiresAt: Date | null): void {
  ensureInitialized();
  const user = upsertUser(telegramId);
  if (!user) return;
  db
    .insert(groupInvites)
    .values({
      userId: user.id,
      inviteLink,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    })
    .run();
  insertEvent(user.id, 'invite_link_created', {
    inviteLink,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  });
}

export function updateBalance(telegramId: string, balance: number): void {
  ensureInitialized();
  const now = new Date().toISOString();
  db
    .update(users)
    .set({
      lastBalance: balance,
      lastCheckedAt: now,
    })
    .where(eq(users.telegramId, telegramId))
    .run();
}

export function setWhitelist(telegramId: string, isWhitelisted: boolean): void {
  const user = upsertUser(telegramId);
  if (!user) return;
  db
    .update(users)
    .set({
      isWhitelisted: isWhitelisted ? 1 : 0,
    })
    .where(eq(users.telegramId, telegramId))
    .run();
  insertEvent(user.id, 'whitelist_updated', { isWhitelisted });
}

export function clearVerification(telegramId: string): void {
  ensureInitialized();
  db
    .update(users)
    .set({
      verificationCode: null,
      verificationExpiresAt: null,
    })
    .where(eq(users.telegramId, telegramId))
    .run();
}

export function getUserByTelegramId(telegramId: string): UserRow | null {
  ensureInitialized();
  return getUserRecord(telegramId);
}

export function getVerifiedUsers(): UserRow[] {
  ensureInitialized();
  return db.select().from(users).where(eq(users.verified, 1)).all();
}

export function getPendingUsers(): UserRow[] {
  ensureInitialized();
  return db
    .select()
    .from(users)
    .where(and(eq(users.verified, 0), isNotNull(users.verificationCode)))
    .all();
}

export function findUserByUsername(username: string): UserRow | null {
  ensureInitialized();
  return (
    db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .get() ?? null
  );
}

export function setRequestedGroup(telegramId: string, groupId: string): void {
  const user = upsertUser(telegramId);
  if (!user) return;
  db
    .update(users)
    .set({
      requestedGroupId: groupId,
    })
    .where(eq(users.telegramId, telegramId))
    .run();
  insertEvent(user.id, 'group_requested', { groupId });
}

export function clearRequestedGroup(telegramId: string): void {
  ensureInitialized();
  const user = getUserRecord(telegramId);
  if (!user) return;
  db
    .update(users)
    .set({
      requestedGroupId: null,
    })
    .where(eq(users.telegramId, telegramId))
    .run();
  insertEvent(user.id, 'group_cleared', {});
}

export function logEvent(
  telegramId: string,
  eventType: string,
  payload: Record<string, unknown> = {}
): void {
  ensureInitialized();
  const user = upsertUser(telegramId);
  if (!user) return;
  insertEvent(user.id, eventType, payload);
}

export default {
  initializeSchema,
  upsertUser,
  saveVerificationRequest,
  markVerified,
  updateBalance,
  setWhitelist,
  clearVerification,
  getUserByTelegramId,
  getVerifiedUsers,
  getPendingUsers,
  findUserByUsername,
  setRequestedGroup,
  clearRequestedGroup,
  recordInviteLink,
  logEvent,
};
