import fs from 'fs';
import path from 'path';

const ENV_PATH = path.resolve(process.cwd(), '.env');

type EnvRecord = Record<string, string>;

function parseEnvFile(filePath: string): EnvRecord {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const result: EnvRecord = {};
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const [key, ...rest] = line.split('=');
    if (!key) continue;
    const value = rest.join('=').trim();
    if (!value) continue;
    result[key.trim()] = value.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  }
  return result;
}

function loadEnv(): void {
  const envFromFile = parseEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(envFromFile)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

loadEnv();

export interface Config {
  telegramToken: string;
  groupId: string;
  solanaRpcUrl: string;
  treasuryWallet: string;
  tokenMint: string;
  minTokenCode: number;
  maxTokenCode: number;
  requiredPercent: number;
  hourlyCheckIntervalMs: number;
  adminIds: string[];
  databasePath: string;
}

export const config: Config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  groupId: process.env.TELEGRAM_GROUP_ID || '',
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  treasuryWallet: process.env.TREASURY_WALLET || '',
  tokenMint: process.env.TOKEN_MINT || '',
  minTokenCode: parseNumber(process.env.MIN_TOKEN_CODE, 0.000001),
  maxTokenCode: parseNumber(process.env.MAX_TOKEN_CODE, 0.000009),
  requiredPercent: parseNumber(process.env.REQUIRED_PERCENT, 0.001),
  hourlyCheckIntervalMs: parseNumber(process.env.HOURLY_CHECK_INTERVAL_MS, 60 * 60 * 1000),
  adminIds: parseStringArray(process.env.ADMIN_IDS),
  databasePath: process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data', 'bot.sqlite'),
};

if (!config.telegramToken) {
  console.warn('Warning: TELEGRAM_BOT_TOKEN is not configured. The bot will not work until it is set.');
}
