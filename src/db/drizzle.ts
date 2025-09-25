import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';

const DB_PATH = config.databasePath;

export interface UserRow {
  id: number;
  telegram_id: string;
  username: string | null;
  wallet_address: string | null;
  verification_code: number | null;
  verification_expires_at: string | null;
  verified: 0 | 1;
  verified_at: string | null;
  last_balance: number | null;
  last_checked_at: string | null;
  is_whitelisted: 0 | 1;
  requested_group_id: string | null;
  created_at: string;
  updated_at: string;
}

function ensureDatabaseDirectory(): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function runSql(sql: string): void {
  ensureDatabaseDirectory();
  execFileSync('sqlite3', [DB_PATH, sql]);
}

function runSqlScript(lines: string[]): void {
  const script = lines.join('\n');
  ensureDatabaseDirectory();
  execFileSync('sqlite3', [DB_PATH], { input: script });
}

function queryJson<T>(sql: string): T[] {
  ensureDatabaseDirectory();
  const output = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
    encoding: 'utf8',
  });
  if (!output) {
    return [];
  }
  try {
    return JSON.parse(output) as T[];
  } catch (error) {
    console.error('Failed to parse sqlite JSON output', error, output);
    return [];
  }
}

function escapeValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  const sanitized = String(value).replace(/'/g, "''");
  return `'${sanitized}'`;
}

function formatSql(sql: string, params: unknown[]): string {
  let formatted = sql;
  for (const param of params) {
    formatted = formatted.replace('?', escapeValue(param));
  }
  return formatted;
}

function run(sql: string, params: unknown[] = []): void {
  const formatted = formatSql(sql, params);
  runSql(formatted);
}

function all<T>(sql: string, params: unknown[] = []): T[] {
  const formatted = formatSql(sql, params);
  return queryJson<T>(formatted);
}

function get<T>(sql: string, params: unknown[] = []): T | null {
  const rows = all<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export function initializeSchema(): void {
  runSqlScript([
    'PRAGMA journal_mode = WAL;',
    `CREATE TABLE IF NOT EXISTS users (
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
    );`,
    `CREATE TABLE IF NOT EXISTS verification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );`,
    `CREATE TRIGGER IF NOT EXISTS users_updated_at
    AFTER UPDATE ON users
    BEGIN
      UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
    END;`,
  ]);
}

export function upsertUser(telegramId: string, username?: string): UserRow | null {
  const existing = get<UserRow>('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
  if (existing) {
    run("UPDATE users SET username = ?, updated_at = datetime('now') WHERE telegram_id = ?", [username || existing.username, telegramId]);
    return get<UserRow>('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
  }
  run('INSERT INTO users (telegram_id, username) VALUES (?, ?)', [telegramId, username || null]);
  return get<UserRow>('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
}

export function saveVerificationRequest(
  telegramId: string,
  walletAddress: string,
  verificationCode: number,
  expiresAt: Date | null,
  requestedGroupId: string | null
): void {
  const user = upsertUser(telegramId);
  run(
    `UPDATE users SET wallet_address = ?, verification_code = ?, verification_expires_at = ?, verified = 0, requested_group_id = COALESCE(?, requested_group_id) WHERE telegram_id = ?`,
    [walletAddress, verificationCode, expiresAt ? expiresAt.toISOString() : null, requestedGroupId || null, telegramId]
  );
  if (user) {
    run('INSERT INTO verification_events (user_id, event_type, payload) VALUES (?, ?, ?)', [
      user.id,
      'verification_requested',
      JSON.stringify({ walletAddress, verificationCode, expiresAt: expiresAt ? expiresAt.toISOString() : null }),
    ]);
  }
}

export function markVerified(telegramId: string, balance: number): void {
  const user = get<UserRow>('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
  if (!user) return;
  run(
    "UPDATE users SET verified = 1, verified_at = datetime('now'), last_balance = ?, last_checked_at = datetime('now') WHERE telegram_id = ?",
    [balance, telegramId]
  );
  run('INSERT INTO verification_events (user_id, event_type, payload) VALUES (?, ?, ?)', [
    user.id,
    'verified',
    JSON.stringify({ balance }),
  ]);
}

export function updateBalance(telegramId: string, balance: number): void {
  const user = get<UserRow>('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
  if (!user) return;
  run(
    "UPDATE users SET last_balance = ?, last_checked_at = datetime('now') WHERE telegram_id = ?",
    [balance, telegramId]
  );
}

export function setWhitelist(telegramId: string, isWhitelisted: boolean): void {
  const user = upsertUser(telegramId);
  run('UPDATE users SET is_whitelisted = ? WHERE telegram_id = ?', [isWhitelisted ? 1 : 0, telegramId]);
  if (user) {
    run('INSERT INTO verification_events (user_id, event_type, payload) VALUES (?, ?, ?)', [
      user.id,
      'whitelist_updated',
      JSON.stringify({ isWhitelisted }),
    ]);
  }
}

export function clearVerification(telegramId: string): void {
  run(
    'UPDATE users SET verification_code = NULL, verification_expires_at = NULL WHERE telegram_id = ?',
    [telegramId]
  );
}

export function getUserByTelegramId(telegramId: string): UserRow | null {
  return get<UserRow>('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
}

export function getVerifiedUsers(): UserRow[] {
  return all<UserRow>('SELECT * FROM users WHERE verified = 1');
}

export function getPendingUsers(): UserRow[] {
  return all<UserRow>('SELECT * FROM users WHERE verified = 0 AND verification_code IS NOT NULL');
}

export function findUserByUsername(username: string): UserRow | null {
  return get<UserRow>('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username]);
}

export function setRequestedGroup(telegramId: string, groupId: string): void {
  const user = upsertUser(telegramId);
  run('UPDATE users SET requested_group_id = ? WHERE telegram_id = ?', [groupId, telegramId]);
  if (user) {
    run('INSERT INTO verification_events (user_id, event_type, payload) VALUES (?, ?, ?)', [
      user.id,
      'group_requested',
      JSON.stringify({ groupId }),
    ]);
  }
}

export function clearRequestedGroup(telegramId: string): void {
  const user = get<UserRow>('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
  if (!user) return;
  run('UPDATE users SET requested_group_id = NULL WHERE telegram_id = ?', [telegramId]);
  run('INSERT INTO verification_events (user_id, event_type, payload) VALUES (?, ?, ?)', [
    user.id,
    'group_cleared',
    JSON.stringify({}),
  ]);
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
};
