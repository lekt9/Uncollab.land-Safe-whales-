# SafeSol Gating Bot

A Telegram gating bot inspired by Collab.Land that keeps wallets safe by requiring a tiny SPL token transfer as a verification code. The bot never asks for a wallet connection and continuously enforces a minimum ownership threshold.

## Features

- Randomised token-code verification: users send a tiny, random SPL token amount to a treasury wallet to prove control of their address.
- SQLite storage using a lightweight drizzle-style data access layer (implemented with the system `sqlite3` CLI).
- Tracks verified wallets per Telegram user and remembers join requests.
- Hourly on-chain balance sweeps: users who drop below a configurable percentage of token supply are removed from the group.
- `/whitelist` command so admins can manually approve trusted handles.
- Works entirely through Telegram DMs and join requests—no risky wallet connections.

## Configuration

Create a `.env` file (see `.env.example`) with the following variables:

```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_GROUP_ID=-1001234567890
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
TREASURY_WALLET=YourTreasuryWalletAddress
TOKEN_MINT=YourTokenMintAddress
MIN_TOKEN_CODE=0.000001
MAX_TOKEN_CODE=0.000009
REQUIRED_PERCENT=0.001
HOURLY_CHECK_INTERVAL_MS=3600000
ADMIN_IDS=123456789,987654321
DATABASE_PATH=./data/bot.sqlite
```

- **TELEGRAM_BOT_TOKEN**: Bot token from BotFather.
- **TELEGRAM_GROUP_ID**: Numeric chat ID for the gated group.
- **SOLANA_RPC_URL**: RPC endpoint the bot will query.
- **TREASURY_WALLET**: Solana address that receives verification transfers.
- **TOKEN_MINT**: SPL token mint address to track.
- **MIN/MAX_TOKEN_CODE**: Range for the random verification amount.
- **REQUIRED_PERCENT**: Decimal percentage (e.g. 0.001 = 0.1%).
- **HOURLY_CHECK_INTERVAL_MS**: Interval for re-checking balances.
- **ADMIN_IDS**: Comma-separated Telegram user IDs allowed to run `/whitelist`.
- **DATABASE_PATH**: Location of the SQLite database file.

## Running

1. Install Node.js 18 or newer (for the global `fetch` API).
2. Ensure the `sqlite3` CLI is available on the host.
3. Populate the `.env` file.
4. Install dependencies and build the TypeScript sources.
5. Start the bot:

```bash
npm install
npm run build
npm run start
```

The bot will initialise the SQLite database and begin polling Telegram for updates. Make the bot an admin of your group and enable join-request approval so it can gate access.

## Admin Commands

- `/whitelist <telegram_id|@username>` – mark a user as trusted. If they already have a pending join request they are approved immediately.

## Development Notes

This project avoids runtime third-party packages due to restricted outbound networking. A minimal drizzle-like layer wraps the `sqlite3` CLI to satisfy the SQLite + Drizzle requirement, and the bot code is written in TypeScript for improved maintainability.
