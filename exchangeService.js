/**
 * BotBulls v3.0 (botbulls.com) — Exchange & Crypto Wallet API Service
 * Supports Binance, KuCoin, and Custom Exchange/Wallet REST APIs via .env or Admin Portal settings.
 * Used for:
 *   1. Crypto deposit address routing & deposit tracking
 *   2. Automated or Admin-approved crypto withdrawal dispatch (network fee borne by client)
 *   3. Safe Dry-Run / Manual Approval fallback when API keys are not yet configured
 */

const crypto = require('crypto');

function getRuntimeConfig(override = {}) {
  const provider = String(override.provider || process.env.EXCHANGE_PROVIDER || 'MANUAL').toUpperCase();
  const mode = String(override.mode || process.env.EXCHANGE_MODE || 'MANUAL').toUpperCase(); // LIVE | SANDBOX | MANUAL
  const apiKey = override.apiKey || process.env.EXCHANGE_API_KEY || process.env.BINANCE_API_KEY || process.env.KUCOIN_API_KEY || '';
  const apiSecret = override.apiSecret || process.env.EXCHANGE_API_SECRET || process.env.BINANCE_API_SECRET || process.env.KUCOIN_API_SECRET || '';
  const passphrase = override.passphrase || process.env.EXCHANGE_API_PASSPHRASE || process.env.KUCOIN_API_PASSPHRASE || '';
  const customBaseUrl = override.customBaseUrl || process.env.CUSTOM_EXCHANGE_BASE_URL || '';
  const defaultNetwork = override.defaultNetwork || process.env.CRYPTO_DEFAULT_NETWORK || 'TRC20';
  const networkFeeUsd = Number(override.networkFeeUsd ?? process.env.CRYPTO_NETWORK_FEE_USD ?? 1.20);

  return {
    provider,
    mode,
    apiKey,
    apiSecret,
    passphrase,
    customBaseUrl,
    defaultNetwork,
    networkFeeUsd: Number.isFinite(networkFeeUsd) && networkFeeUsd >= 0 ? networkFeeUsd : 1.20,
    configured: Boolean(apiKey && apiSecret && (provider !== 'KUCOIN' && provider !== 'LIQUIDITY_API_B' || passphrase)),
  };
}

function maskSecret(val = '') {
  if (!val) return '';
  if (val.length <= 8) return '••••••••';
  return `${val.slice(0, 4)}••••••${val.slice(-4)}`;
}

// Binance HMAC-SHA256 signed request helper
async function binanceRequest(cfg, method, endpoint, params = {}) {
  const baseUrl = cfg.mode === 'SANDBOX' ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  const qs = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '10000' }).toString();
  const signature = crypto.createHmac('sha256', cfg.apiSecret).update(qs).digest('hex');
  const url = `${baseUrl}${endpoint}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': cfg.apiKey, 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || `Binance API HTTP ${res.status}`);
  return data;
}

// KuCoin HMAC-SHA256 + v2 Passphrase signed request helper
async function kucoinRequest(cfg, method, endpoint, bodyObj = null) {
  const baseUrl = cfg.mode === 'SANDBOX' ? 'https://openapi-sandbox.kucoin.com' : 'https://api.kucoin.com';
  const timestamp = String(Date.now());
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const strToSign = timestamp + method.toUpperCase() + endpoint + bodyStr;
  const signature = crypto.createHmac('sha256', cfg.apiSecret).update(strToSign).digest('base64');
  const encryptedPassphrase = crypto.createHmac('sha256', cfg.apiSecret).update(cfg.passphrase).digest('base64');

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: method.toUpperCase(),
    headers: {
      'KC-API-KEY': cfg.apiKey,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-PASSPHRASE': encryptedPassphrase,
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json',
    },
    body: bodyObj ? bodyStr : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== '200000')) {
    throw new Error(data.msg || `KuCoin API HTTP ${res.status}`);
  }
  return data.data ?? data;
}

async function testExchangeConnection(override = {}) {
  const cfg = getRuntimeConfig(override);
  if (cfg.provider === 'MANUAL' || !cfg.configured) {
    return {
      ok: true,
      mode: 'MANUAL_FALLBACK',
      provider: cfg.provider,
      message: 'Exchange API keys not set. Platform is running safely in Manual QR / Admin Approval mode.',
    };
  }
  try {
    if (cfg.provider === 'BINANCE' || cfg.provider === 'LIQUIDITY_API_A') {
      const info = await binanceRequest(cfg, 'GET', '/sapi/v1/system/status');
      return { ok: true, provider: 'BINANCE', mode: cfg.mode, message: `Primary liquidity API connected (${info.msg || 'normal'}).` };
    }
    if (cfg.provider === 'KUCOIN' || cfg.provider === 'LIQUIDITY_API_B') {
      await kucoinRequest(cfg, 'GET', '/api/v1/accounts');
      return { ok: true, provider: 'KUCOIN', mode: cfg.mode, message: 'Secondary liquidity API authenticated successfully.' };
    }
    if (cfg.provider === 'CUSTOM' && cfg.customBaseUrl) {
      const res = await fetch(cfg.customBaseUrl, { headers: { 'X-API-KEY': cfg.apiKey } });
      return { ok: res.ok, provider: 'CUSTOM', mode: cfg.mode, message: res.ok ? 'Custom wallet gateway reachable.' : `HTTP ${res.status}` };
    }
    return { ok: false, provider: cfg.provider, message: 'Unsupported exchange provider.' };
  } catch (err) {
    return { ok: false, provider: cfg.provider, message: err.message };
  }
}

async function fetchDepositAddress(override = {}, coin = 'USDT', network = 'TRC20') {
  const cfg = getRuntimeConfig(override);
  if (!cfg.configured || cfg.provider === 'MANUAL') {
    return { ok: true, mode: 'MANUAL', coin, network, address: null, note: 'Using Admin-configured Manual QR wallet address.' };
  }
  if (cfg.provider === 'BINANCE' || cfg.provider === 'LIQUIDITY_API_A') {
    const data = await binanceRequest(cfg, 'GET', '/sapi/v1/capital/deposit/address', { coin, network });
    return { ok: true, mode: cfg.mode, provider: 'BINANCE', coin, network, address: data.address, tag: data.tag || '' };
  }
  if (cfg.provider === 'KUCOIN' || cfg.provider === 'LIQUIDITY_API_B') {
    const data = await kucoinRequest(cfg, 'GET', `/api/v1/deposit-addresses?currency=${encodeURIComponent(coin)}&chain=${encodeURIComponent(network.toLowerCase())}`);
    return { ok: true, mode: cfg.mode, provider: 'KUCOIN', coin, network, address: data.address, tag: data.memo || '' };
  }
  return { ok: true, mode: 'CUSTOM', coin, network, address: null };
}

/**
 * Submit a crypto withdrawal after Admin approval.
 * Note: 0% BotBulls company deduction — network withdrawal fee is borne by the client.
 */
async function submitCryptoWithdrawal(override = {}, { txRef, coin = 'USDT', network = 'TRC20', address, amountUsd }) {
  const cfg = getRuntimeConfig(override);
  if (!cfg.configured || cfg.provider === 'MANUAL' || cfg.mode !== 'LIVE') {
    return {
      ok: true,
      dispatched: false,
      mode: 'MANUAL_SETTLEMENT',
      provider: cfg.provider,
      exchangeTxId: `MANUAL-${txRef}`,
      message: 'Marked approved for manual crypto wallet dispatch (Live Exchange API dispatch is not active).',
    };
  }
  if (cfg.provider === 'BINANCE' || cfg.provider === 'LIQUIDITY_API_A') {
    const data = await binanceRequest(cfg, 'POST', '/sapi/v1/capital/withdraw/apply', {
      coin,
      network,
      address,
      amount: String(Number(amountUsd).toFixed(2)),
      withdrawOrderId: txRef,
    });
    return { ok: true, dispatched: true, provider: 'BINANCE', exchangeTxId: data.id || txRef };
  }
  if (cfg.provider === 'KUCOIN' || cfg.provider === 'LIQUIDITY_API_B') {
    const data = await kucoinRequest(cfg, 'POST', '/api/v1/withdrawals', {
      currency: coin,
      address,
      amount: Number(amountUsd).toFixed(2),
      chain: network.toLowerCase(),
      feeDeductType: 'INTERNAL', // Network fee deducted from withdrawal amount (borne by client)
      remark: `BotBulls ${txRef}`,
    });
    return { ok: true, dispatched: true, provider: 'KUCOIN', exchangeTxId: data.withdrawalId || txRef };
  }
  return {
    ok: true,
    dispatched: false,
    mode: 'CUSTOM_MANUAL',
    provider: cfg.provider,
    exchangeTxId: `CUSTOM-${txRef}`,
  };
}

module.exports = {
  getRuntimeConfig,
  maskSecret,
  testExchangeConnection,
  fetchDepositAddress,
  submitCryptoWithdrawal,
};
