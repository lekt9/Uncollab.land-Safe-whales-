import { config } from '../config';

interface RpcResponse<T> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

async function rpcRequest<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(config.solanaRpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params,
    }),
  });
  if (!response.ok) {
    throw new Error(`Solana RPC request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as RpcResponse<T>;
  if (payload.error) {
    const error = new Error(`Solana RPC error: ${payload.error.message || 'Unknown error'}`) as Error & {
      code?: number;
      data?: unknown;
    };
    error.code = payload.error.code;
    error.data = payload.error.data;
    throw error;
  }
  if (payload.result === undefined) {
    throw new Error('Solana RPC response missing result field');
  }
  return payload.result;
}

async function getTokenSupply(mint: string): Promise<number> {
  const result = await rpcRequest<{ value?: { uiAmount?: number | null } }>('getTokenSupply', [mint]);
  if (!result || !result.value) {
    throw new Error('Invalid getTokenSupply response');
  }
  const uiAmount = result.value.uiAmount;
  if (uiAmount === null || uiAmount === undefined) {
    throw new Error('Token supply missing uiAmount');
  }
  return uiAmount;
}

async function getTokenBalance(walletAddress: string, mint: string): Promise<number> {
  const result = await rpcRequest<{ value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> }>(
    'getTokenAccountsByOwner',
    [walletAddress, { mint }, { encoding: 'jsonParsed' }]
  );
  if (!result || !result.value) {
    return 0;
  }
  let total = 0;
  for (const account of result.value) {
    const parsed = account?.account?.data?.parsed;
    const amount = parsed?.info?.tokenAmount?.uiAmount;
    if (typeof amount === 'number') {
      total += amount;
    }
  }
  return total;
}

function almostEqual(a: number, b: number, tolerance = 0.000001): boolean {
  return Math.abs(a - b) <= tolerance;
}

export interface MatchingTransfer {
  signature: string;
  slot: number;
  blockTime?: number;
  userDelta: number;
  treasuryDelta: number;
}

interface FindMatchingTransferOptions {
  userWallet: string;
  treasuryWallet: string;
  mint: string;
  expectedAmount: number;
  searchLimit?: number;
}

async function findMatchingTransfer({
  userWallet,
  treasuryWallet,
  mint,
  expectedAmount,
  searchLimit = 25,
}: FindMatchingTransferOptions): Promise<MatchingTransfer | null> {
  const signatures = await rpcRequest<Array<{ signature: string }>>('getSignaturesForAddress', [userWallet, { limit: searchLimit }]);
  if (!Array.isArray(signatures)) {
    return null;
  }
  for (const signatureInfo of signatures) {
    const signature = signatureInfo.signature;
    const tx = await rpcRequest<{
      slot: number;
      blockTime?: number;
      meta?: {
        preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number | string } }>;
        postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number | string } }>;
      };
    }>('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx || !tx.meta) continue;
    const { meta } = tx;
    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];
    const userPre = preBalances.find((entry) => entry.owner === userWallet && entry.mint === mint);
    const userPost = postBalances.find((entry) => entry.owner === userWallet && entry.mint === mint);
    const treasuryPre = preBalances.find((entry) => entry.owner === treasuryWallet && entry.mint === mint);
    const treasuryPost = postBalances.find((entry) => entry.owner === treasuryWallet && entry.mint === mint);
    if (!userPre || !userPost || !treasuryPost) {
      continue;
    }
    const userUiPre = Number(userPre.uiTokenAmount?.uiAmount || 0);
    const userUiPost = Number(userPost.uiTokenAmount?.uiAmount || 0);
    const treasuryUiPre = Number(treasuryPre?.uiTokenAmount?.uiAmount || 0);
    const treasuryUiPost = Number(treasuryPost.uiTokenAmount?.uiAmount || 0);
    const userDelta = userUiPre - userUiPost;
    const treasuryDelta = treasuryUiPost - treasuryUiPre;
    if (almostEqual(userDelta, expectedAmount) && almostEqual(treasuryDelta, expectedAmount)) {
      return {
        signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        userDelta,
        treasuryDelta,
      };
    }
  }
  return null;
}

interface VerifyOwnershipOptions {
  walletAddress: string;
  mint: string;
  requiredPercent: number;
}

export interface OwnershipResult {
  isQualified: boolean;
  percentOwned: number;
  balance: number;
  supply: number;
}

async function verifyOwnership({ walletAddress, mint, requiredPercent }: VerifyOwnershipOptions): Promise<OwnershipResult> {
  const [supply, balance] = await Promise.all([
    getTokenSupply(mint),
    getTokenBalance(walletAddress, mint),
  ]);
  if (supply === 0) {
    throw new Error('Token supply is zero, cannot verify ownership.');
  }
  const percentOwned = balance / supply;
  const isQualified = percentOwned >= requiredPercent;
  return { isQualified, percentOwned, balance, supply };
}

export default {
  rpcRequest,
  getTokenSupply,
  getTokenBalance,
  findMatchingTransfer,
  verifyOwnership,
};

export { rpcRequest, getTokenSupply, getTokenBalance, findMatchingTransfer, verifyOwnership };
