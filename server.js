/**
 * BotBulls v4.0 (botbulls.com — World's Trusted Saving Wallet)
 * Full-Stack Production Server (Express + PostgreSQL + Nodemailer + Exchange API)
 *
 * Rules Enforced:
 * - 12-Month (365-Day) Plan Cycle with Next-Generation Re-Activation
 * - Tiered Monthly Bot Fee: $10/mo ($50–$400 plans) | $50/mo ($500–$1,000 plans)
 * - Explicit User Auto-Pay Toggle (ON -> auto-deduct when due & funded; OFF -> manual only)
 * - Weekday-Only Schedule (Monday–Friday; NO payouts or GWC on Saturday/Sunday)
 * - Automatic 24-Hour Staggered Cents Distribution (00:00–24:00) reaching exact daily target
 *   ("up to 2.5% and more" baseline + Admin manual override) + Daily 5-Level 2.5% GWC
 * - Crypto-Only Deposits & Withdrawals (INR removed); 0% Company Fee; $1.20 TRC20 Client-Borne Network Fee
 * - Admin Portal Credentials: Botadmin / Videocon007tV (configurable via .env)
 */

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { sendAutomatedEmail } = require('./emailService');
const {
  getRuntimeConfig,
  maskSecret,
  testExchangeConnection,
  fetchDepositAddress,
  submitCryptoWithdrawal,
} = require('./exchangeService');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') && !process.env.DATABASE_URL.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false,
});

const JWT_SECRET = process.env.JWT_SECRET || 'botbulls_v4_change_this_secret_in_production';
const CONTROL_USERNAME = process.env.CONTROL_USERNAME || process.env.ADMIN_USERNAME || 'ops_desk';
const CONTROL_PASSWORD = process.env.CONTROL_PASSWORD || process.env.ADMIN_PASSWORD || 'Videocon007tV';
const ALLOWED_PLANS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
const CYCLE_TOTAL_DAYS = 264; // 12 Months × 22 Mon–Fri Payout Days (Sat & Sun excluded)
const MIN_WITHDRAWAL_USD = 10.00;
const WITHDRAWAL_COMPANY_DEDUCTION_RATE = 0.00; // 0% company deduction
const DEFAULT_CRYPTO_NETWORK_FEE_USD = 1.20;    // $1.20 TRC20 client-borne network fee
const MIN_WITHDRAWAL_ERROR =
  'The minimum withdrawal amount is $10.00 USD. Withdrawal requests below $10.00 cannot be processed under BotBulls Terms and Conditions.';

// 2.50% Daily GWC (Goodwill Commission) pool across 5 downline levels
const GWC_LEVEL_SPLITS = [
  { level: 1, percent: 1.00 },
  { level: 2, percent: 0.60 },
  { level: 3, percent: 0.40 },
  { level: 4, percent: 0.30 },
  { level: 5, percent: 0.20 },
];

// Realistic 24-hour varying weights (00:00–23:00) normalized so 24-hour sum hits exact daily target in cents
const HOURLY_WEIGHTS = [
  0.032, 0.028, 0.036, 0.031, 0.040, 0.038,
  0.044, 0.049, 0.056, 0.052, 0.046, 0.042,
  0.048, 0.054, 0.058, 0.050, 0.044, 0.040,
  0.038, 0.036, 0.034, 0.032, 0.036, 0.036,
];

function getRequiredMonthlyBotFee(planAmount) {
  return Number(planAmount) >= 500 ? 50.00 : 10.00;
}

function isWeekdayUtcOrIst(date = new Date()) {
  const ist = new Date(date.getTime() + 19800000);
  const dow = ist.getUTCDay(); // 0 = Sun, 6 = Sat
  return dow >= 1 && dow <= 5;
}

function getIstDateAndHour(date = new Date()) {
  const ist = new Date(date.getTime() + 19800000);
  const dateKey = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
  return { dateKey, hour: ist.getUTCHours(), dow: ist.getUTCDay() };
}

function generate24HourCentsSchedule(dailyTargetUsd, seedNum = 1) {
  const totalCents = Math.round(Number(dailyTargetUsd || 0) * 100);
  if (totalCents <= 0) return Array(24).fill(0);
  const weights = HOURLY_WEIGHTS.map((w, idx) => {
    const jitter = ((Math.sin((idx + 1) * 12.9898 + seedNum * 78.233) * 43758.5453) % 1);
    return w * (0.85 + Math.abs(jitter) * 0.30);
  });
  const wSum = weights.reduce((a, b) => a + b, 0);
  const cents = weights.map(w => Math.floor((w / wSum) * totalCents));
  let rem = totalCents - cents.reduce((a, b) => a + b, 0);
  for (let i = 0; rem > 0; i = (i + 1) % 24) {
    cents[i]++;
    rem--;
  }
  return cents.map(c => Number((c / 100).toFixed(2)));
}

// ---------------------------------------------------------------------------
// Security & Middleware (Nginx Reverse Proxy Ready)
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '15mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 240 }));

const UPLOAD_DIR = path.join(__dirname, process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)),
});

function sanitizeText(v = '') {
  return String(v).replace(/[<>]/g, '').trim().slice(0, 500);
}
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || req.socket.remoteAddress || '127.0.0.1')).split(',')[0].trim();
}
function makeRef(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ---------------------------------------------------------------------------
// 1. AUTH: REGISTER, USER LOGIN, ADMIN LOGIN (Botadmin), FORGOT PASSWORD OTP
// ---------------------------------------------------------------------------
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { fullName, email, phone, password, referralCode } = req.body;
  if (!fullName || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Full name, unique email, and password (min 6 chars) are required.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cleanEmail = sanitizeText(email).toLowerCase();
    const hash = await bcrypt.hash(password, 12);
    const num = Math.floor(1000 + Math.random() * 9000);
    const userCode = `BB-USR-${num}`;
    const refCode = `BBREF${num}`;

    let uplineId = null;
    if (referralCode) {
      let cleanRef = sanitizeText(referralCode);
      const urlM = cleanRef.match(/[?&#](?:ref|referral|sponsor)=([^&#\s]+)/i);
      if (urlM && urlM[1]) cleanRef = decodeURIComponent(urlM[1]).trim();
      const r = await client.query(
        'SELECT id FROM users WHERE UPPER(referral_code) = UPPER($1) OR UPPER(user_code) = UPPER($1) OR UPPER(email) = UPPER($1)',
        [cleanRef]
      );
      if (r.rows[0]) uplineId = r.rows[0].id;
    }

    const uRes = await client.query(
      `INSERT INTO users (user_code, email, phone, full_name, password_hash, role, referral_code, referred_by_user_id, last_ip)
       VALUES ($1, $2, $3, $4, $5, 'USER', $6, $7, $8)
       RETURNING id, user_code, email, full_name, referral_code`,
      [userCode, cleanEmail, sanitizeText(phone || ''), sanitizeText(fullName), hash, refCode, uplineId, getClientIp(req)]
    );
    const u = uRes.rows[0];
    await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [u.id]);

    let currUp = uplineId;
    for (const tier of GWC_LEVEL_SPLITS) {
      if (!currUp) break;
      await client.query(
        'INSERT INTO referrals (referrer_user_id, referred_user_id, level, gwc_split_percent) VALUES ($1, $2, $3, $4)',
        [currUp, u.id, tier.level, tier.percent]
      );
      const next = await client.query('SELECT referred_by_user_id FROM users WHERE id = $1', [currUp]);
      currUp = next.rows[0]?.referred_by_user_id || null;
    }

    await client.query('COMMIT');
    sendAutomatedEmail({
      pool,
      userId: u.id,
      to: u.email,
      templateType: 'WELCOME',
      data: { fullName: u.full_name, userCode: u.user_code, referralCode: u.referral_code },
    }).catch(() => {});

    const token = jwt.sign({ id: u.id, role: 'USER', userCode: u.user_code }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: u });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email is already registered.' });
    res.status(500).json({ error: 'Registration failed.' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = sanitizeText(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const r = await pool.query('SELECT id, user_code, email, full_name, password_hash, role, referral_code, status FROM users WHERE email = $1', [email]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (u.status !== 'ACTIVE') return res.status(403).json({ error: 'Account is suspended.' });
    await pool.query('UPDATE users SET last_ip = $1, updated_at = NOW() WHERE id = $2', [getClientIp(req), u.id]);
    const token = jwt.sign({ id: u.id, role: u.role, userCode: u.user_code }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: u.id, userCode: u.user_code, email: u.email, fullName: u.full_name, referralCode: u.referral_code, role: u.role } });
  } catch {
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post(['/api/control/login', '/api/admin/login'], authLimiter, async (req, res) => {
  const username = sanitizeText(req.body.username);
  const password = String(req.body.password || '');
  if (username === CONTROL_USERNAME && password === CONTROL_PASSWORD) {
    const token = jwt.sign({ id: 'admin-root', role: 'ADMIN', username }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ ok: true, token, role: 'ADMIN' });
  }
  return res.status(401).json({ error: 'Invalid Control Console credentials.' });
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const cleanEmail = sanitizeText(req.body.email).toLowerCase();
  if (!cleanEmail) return res.status(400).json({ error: 'Registered email is required.' });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const tokenHash = crypto.createHash('sha256').update(otp).digest('hex');

  try {
    const uRes = await pool.query('SELECT id, full_name, email FROM users WHERE email = $1', [cleanEmail]);
    if (uRes.rows[0]) {
      const u = uRes.rows[0];
      await pool.query(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')",
        [u.id, tokenHash]
      );
      await sendAutomatedEmail({
        pool,
        userId: u.id,
        to: u.email,
        templateType: 'FORGOT_PASSWORD',
        data: { fullName: u.full_name, otpCode: otp, resetUrl: `${process.env.APP_URL || 'https://botbulls.com'}/#/forgot` },
      });
    }
    res.json({ message: 'If that email is registered, a 6-digit password reset code has been sent.' });
  } catch {
    res.status(500).json({ error: 'Could not process password reset.' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Email, 6-digit code, and new password (min 6 chars) are required.' });
  }
  const tokenHash = crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT pr.id, pr.user_id FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE u.email = $1 AND pr.token_hash = $2 AND pr.used_at IS NULL AND pr.expires_at > NOW()
       ORDER BY pr.created_at DESC LIMIT 1`,
      [sanitizeText(email).toLowerCase(), tokenHash]
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }
    const newHash = await bcrypt.hash(newPassword, 12);
    await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, r.rows[0].user_id]);
    await client.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [r.rows[0].id]);
    await client.query('COMMIT');
    res.json({ message: 'Password reset successful. You can now sign in.' });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Password reset failed.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 2. CRYPTO-ONLY WITHDRAWALS ($10.00 MIN | 0% COMPANY FEE | $1.20 TRC20 CLIENT FEE)
// ---------------------------------------------------------------------------
app.post('/api/withdrawals', requireAuth, async (req, res) => {
  const rail = sanitizeText(req.body.rail || 'CRYPTO').toUpperCase();
  const gross = Number(req.body.amount);
  const destination = sanitizeText(req.body.destinationAccount || '');
  const network = sanitizeText(req.body.network || 'TRC20').toUpperCase();
  if (rail !== 'CRYPTO' || !destination) {
    return res.status(400).json({ error: 'Crypto withdrawal rail (CRYPTO) and destination wallet address are required.' });
  }
  if (!Number.isFinite(gross) || gross < MIN_WITHDRAWAL_USD) {
    return res.status(400).json({ error: MIN_WITHDRAWAL_ERROR, code: 'MIN_WITHDRAWAL_VIOLATION' });
  }

  const exCfg = getRuntimeConfig(runtimeExchangeConfig);
  const networkFee = Number(exCfg.networkFeeUsd ?? DEFAULT_CRYPTO_NETWORK_FEE_USD);
  const companyDeduction = Number((gross * WITHDRAWAL_COMPANY_DEDUCTION_RATE).toFixed(2));
  const net = Number(Math.max(0, gross - companyDeduction - networkFee).toFixed(2));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query('SELECT balance_usd FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (Number(w.rows[0]?.balance_usd || 0) < gross) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }
    await client.query('UPDATE wallets SET balance_usd = balance_usd - $1, updated_at = NOW() WHERE user_id = $2', [gross, req.user.id]);
    const txRef = makeRef('WDR');
    await client.query(
      `INSERT INTO transactions (tx_ref, user_id, tx_type, rail, gross_amount_usd, company_deduction_usd, network_fee_usd, net_amount_usd, status, destination_account, reference_note)
       VALUES ($1, $2, 'WITHDRAWAL', 'CRYPTO', $3, $4, $5, $6, 'PENDING', $7, $8)`,
      [txRef, req.user.id, gross, companyDeduction, networkFee, net, destination, `Crypto ${network} (0% Co. Fee; $${networkFee.toFixed(2)} client-borne network fee)`]
    );
    await client.query('COMMIT');
    res.status(201).json({ txRef, gross, companyDeduction, networkFee, net, status: 'PENDING' });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal failed.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 3. EXCHANGE / CRYPTO WALLET API ROUTES
// ---------------------------------------------------------------------------
let runtimeExchangeConfig = { networkFeeUsd: DEFAULT_CRYPTO_NETWORK_FEE_USD, defaultNetwork: 'TRC20' };

app.get('/api/exchange/public-info', (_req, res) => {
  const cfg = getRuntimeConfig(runtimeExchangeConfig);
  res.json({
    ok: true,
    provider: cfg.provider,
    mode: cfg.mode,
    defaultNetwork: cfg.defaultNetwork,
    networkFeeUsd: cfg.networkFeeUsd,
    companyWithdrawalDeductionPct: 0,
  });
});

app.get('/api/admin/exchange/config', (_req, res) => {
  const cfg = getRuntimeConfig(runtimeExchangeConfig);
  res.json({
    ok: true,
    provider: cfg.provider,
    mode: cfg.mode,
    apiKeyMasked: maskSecret(cfg.apiKey),
    apiSecretMasked: maskSecret(cfg.apiSecret),
    passphraseSet: Boolean(cfg.passphrase),
    customBaseUrl: cfg.customBaseUrl,
    defaultNetwork: cfg.defaultNetwork,
    networkFeeUsd: cfg.networkFeeUsd,
    configured: cfg.configured,
  });
});

app.post('/api/admin/exchange/config', (req, res) => {
  const { provider, mode, apiKey, apiSecret, passphrase, customBaseUrl, defaultNetwork, networkFeeUsd } = req.body || {};
  runtimeExchangeConfig = {
    provider: sanitizeText(provider || runtimeExchangeConfig.provider || 'MANUAL').toUpperCase(),
    mode: sanitizeText(mode || runtimeExchangeConfig.mode || 'MANUAL').toUpperCase(),
    apiKey: apiKey ? String(apiKey).trim() : runtimeExchangeConfig.apiKey,
    apiSecret: apiSecret ? String(apiSecret).trim() : runtimeExchangeConfig.apiSecret,
    passphrase: passphrase ? String(passphrase).trim() : runtimeExchangeConfig.passphrase,
    customBaseUrl: customBaseUrl !== undefined ? sanitizeText(customBaseUrl) : runtimeExchangeConfig.customBaseUrl,
    defaultNetwork: sanitizeText(defaultNetwork || runtimeExchangeConfig.defaultNetwork || 'TRC20').toUpperCase(),
    networkFeeUsd: networkFeeUsd !== undefined ? Math.max(0, Number(networkFeeUsd) || 0) : (runtimeExchangeConfig.networkFeeUsd ?? DEFAULT_CRYPTO_NETWORK_FEE_USD),
  };
  const cfg = getRuntimeConfig(runtimeExchangeConfig);
  res.json({ ok: true, provider: cfg.provider, mode: cfg.mode, configured: cfg.configured, networkFeeUsd: cfg.networkFeeUsd });
});

app.post('/api/admin/exchange/test', async (_req, res) => {
  const result = await testExchangeConnection(runtimeExchangeConfig);
  res.json(result);
});

app.post('/api/admin/exchange/deposit-address', async (req, res) => {
  const { coin = 'USDT', network = 'TRC20' } = req.body || {};
  try {
    const result = await fetchDepositAddress(runtimeExchangeConfig, sanitizeText(coin).toUpperCase(), sanitizeText(network).toUpperCase());
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/exchange/withdraw', async (req, res) => {
  const { txRef, coin = 'USDT', network = 'TRC20', address, amountUsd } = req.body || {};
  if (!txRef || !address || !amountUsd) return res.status(400).json({ ok: false, error: 'txRef, address, and amountUsd are required.' });
  try {
    const result = await submitCryptoWithdrawal(runtimeExchangeConfig, { txRef, coin, network, address, amountUsd });
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});


// ---------------------------------------------------------------------------
// 3B. LIVE MARKET RATES & CANDLESTICK PROXY (Server-Side API Key — Source Masked)
// ---------------------------------------------------------------------------
const MARKET_UPSTREAM = Buffer.from('aHR0cHM6Ly9kYXRhLWFwaS5iaW5hbmNlLnZpc2lvbg==', 'base64').toString('utf8');
const MARKET_API_KEY = process.env.MARKET_API_KEY || process.env.EXCHANGE_API_KEY || '';

app.get('/api/market/live', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const syms = encodeURIComponent(JSON.stringify(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'PAXGUSDT', 'EURUSDT', 'GBPUSDT']));
    const headers = MARKET_API_KEY ? { 'X-MBX-APIKEY': MARKET_API_KEY } : {};
    const r = await fetch(`${MARKET_UPSTREAM}/api/v3/ticker/24hr?symbols=${syms}`, { headers });
    if (!r.ok) throw new Error('Market feed upstream error');
    const arr = await r.json();
    const mapSym = { BTCUSDT: 'BTC/USD', ETHUSDT: 'ETH/USD', SOLUSDT: 'SOL/USD', XRPUSDT: 'XRP/USD', PAXGUSDT: 'XAUT/USD', EURUSDT: 'EUR/USD', GBPUSDT: 'GBP/USD' };
    const quotes = arr.map(item => ({
      symbol: mapSym[item.symbol] || item.symbol,
      open: Number(item.openPrice),
      high: Number(item.highPrice),
      low: Number(item.lowPrice),
      price: Number(item.lastPrice),
      change: Number(item.priceChangePercent),
    }));
    res.json({ ok: true, source: 'BotBulls Live Market Feed', updatedAt: new Date().toISOString(), quotes });
  } catch {
    res.status(502).json({ ok: false, source: 'BotBulls Live Market Feed', quotes: [] });
  }
});

app.get('/api/market/klines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const pairMap = { 'BTC/USD': 'BTCUSDT', 'ETH/USD': 'ETHUSDT', 'EUR/USD': 'EURUSDT', 'XAUT/USD': 'PAXGUSDT', 'SOL/USD': 'SOLUSDT' };
  const sym = pairMap[String(req.query.pair || 'BTC/USD').toUpperCase()] || 'BTCUSDT';
  const interval = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(String(req.query.interval)) ? String(req.query.interval) : '1h';
  try {
    const headers = MARKET_API_KEY ? { 'X-MBX-APIKEY': MARKET_API_KEY } : {};
    const r = await fetch(`${MARKET_UPSTREAM}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=44`, { headers });
    if (!r.ok) throw new Error('Klines upstream error');
    const rows = await r.json();
    const candles = rows.map(k => ({
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }));
    res.json({ ok: true, source: 'BotBulls Live Market Feed', candles });
  } catch {
    res.status(502).json({ ok: false, candles: [] });
  }
});

// ---------------------------------------------------------------------------
// 4. EMAIL TRIGGER ENDPOINT
// ---------------------------------------------------------------------------
app.post('/api/email/notify', async (req, res) => {
  const { to, templateType, data } = req.body || {};
  if (!to || !templateType) return res.status(400).json({ error: 'Recipient and templateType required.' });
  try {
    const result = await sendAutomatedEmail({ pool, to: sanitizeText(to), templateType, data });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 5. STATE SYNC + AUTO-PAY BOT SWEEP + MON–FRI HOURLY CENTS SCHEDULER
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state_v7.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let dbStateReady = false;
async function ensureStateTable() {
  if (!process.env.DATABASE_URL || dbStateReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS botbulls_v5_state (
        id INTEGER PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    dbStateReady = true;
  } catch {}
}

function runAutoBotRenewalOnState(payload) {
  if (!payload || !Array.isArray(payload.users)) return 0;
  const now = Date.now();
  let renewedCount = 0;

  for (const u of payload.users) {
    const activePlans = (u.activePlans || []).filter(p => p.active);
    if (!activePlans.length) continue;

    const maxPlan = Math.max(...activePlans.map(p => Number(p.amount || 0)));
    const fee = getRequiredMonthlyBotFee(maxPlan);
    u.botTierFee = fee;

    const expired = !u.botActive || !u.botExpiresAt || Number(u.botExpiresAt) <= now;
    if (expired) {
      // Respect explicit User Auto Pay toggle!
      const autoPayOn = u.autoPayEnabled !== false;
      if (autoPayOn && Number(u.wallet || 0) >= fee) {
        u.wallet = Number((Number(u.wallet) - fee).toFixed(2));
        u.botActive = true;
        u.botActivatedAt = now;
        u.botExpiresAt = now + 22 * 86400000; u.botPayoutDaysRemaining = 22;
        const expDate = new Date(u.botExpiresAt).toISOString().slice(0, 10);
        renewedCount++;
        if (Array.isArray(payload.transactions)) {
          payload.transactions.unshift({
            ref: 'BOTA-' + Math.floor(10000 + Math.random() * 90000),
            userId: u.id,
            type: 'MONTHLY_BOT_AUTO_RENEWAL',
            rail: 'INTERNAL',
            gross: fee,
            deduction: 0,
            networkFee: 0,
            net: fee,
            status: 'COMPLETED',
            note: `Auto-Pay deducted $${fee}/mo Bot from wallet (22 payout days/mo through ${expDate})`,
            proof: '',
            time: new Date().toISOString().slice(0, 16).replace('T', ' '),
          });
        }
      } else if (expired) {
        u.botActive = false;
      }
    }
  }
  return renewedCount;
}

// Automated Mon–Fri Hourly Cents Distribution (00:00–23:00 IST)
function runHourlyWeekdayDistribution(payload) {
  if (!payload || !Array.isArray(payload.users)) return { credited: 0, skippedWeekend: false };
  if (!isWeekdayUtcOrIst()) return { credited: 0, skippedWeekend: true };

  const { dateKey, hour } = getIstDateAndHour();
  const hourStampKey = `${dateKey}T${String(hour).padStart(2, '0')}`;
  payload.hourlyLedger = payload.hourlyLedger || {};
  if (payload.hourlyLedger[hourStampKey]) return { credited: 0, alreadyRan: true };

  const dailyPct = Number(payload.payoutConfig?.percent ?? 2.5);
  let totalCredited = 0;
  let userCount = 0;

  const isEligible = (u) => {
    const aps = (u.activePlans || []).filter(p => p.active);
    return aps.length > 0 && Boolean(u.botActive) && Number(u.botExpiresAt || 0) > Date.now();
  };

  for (const u of payload.users) {
    if (!isEligible(u)) continue;
    const totPlan = (u.activePlans || []).filter(p => p.active).reduce((s, p) => s + Number(p.amount || 0), 0);
    const dailyTarget = Number(((totPlan * dailyPct) / 100).toFixed(2));
    const seed = parseInt(String(u.id).replace(/\D/g, '') || '1', 10) + Number(dateKey.replace(/-/g, ''));
    const schedule = generate24HourCentsSchedule(dailyTarget, seed);
    const hrCredit = schedule[hour] || 0;
    if (hrCredit <= 0) continue;

    u.wallet = Number((Number(u.wallet || 0) + hrCredit).toFixed(2));
    totalCredited = Number((totalCredited + hrCredit).toFixed(2));
    userCount++;

    const timeLabel = `${dateKey} ${String(hour).padStart(2, '0')}:00`;
    payload.transactions.unshift({
      ref: `HPY-${String(hour).padStart(2, '0')}${Math.floor(1000 + Math.random() * 9000)}`,
      userId: u.id,
      type: 'DAILY_PAYOUT',
      rail: 'INTERNAL',
      gross: hrCredit,
      deduction: 0,
      net: hrCredit,
      status: 'COMPLETED',
      note: `Hourly Auto-Credit (${String(hour).padStart(2, '0')}:00) • Up to ${dailyPct}%/day ($${dailyTarget.toFixed(2)} 24h target)`,
      proof: '',
      time: timeLabel,
    });

    // Proportional Hourly 5-Level 2.5% GWC to Active Uplines
    let cur = u;
    for (const tier of GWC_LEVEL_SPLITS) {
      if (!cur || !cur.referredBy) break;
      const up = payload.users.find(x => x.id === cur.referredBy);
      if (!up) break;
      if (isEligible(up)) {
        const gwcAmt = Number(((hrCredit * tier.percent) / 100).toFixed(2));
        if (gwcAmt > 0) {
          up.wallet = Number((Number(up.wallet || 0) + gwcAmt).toFixed(2));
          payload.transactions.unshift({
            ref: `HGW-${String(hour).padStart(2, '0')}${Math.floor(1000 + Math.random() * 9000)}`,
            userId: up.id,
            type: 'GWC_DAILY',
            rail: 'INTERNAL',
            gross: gwcAmt,
            deduction: 0,
            net: gwcAmt,
            status: 'COMPLETED',
            note: `Hourly GWC L${tier.level} (${tier.percent.toFixed(2)}% of 2.5% pool) from ${u.id}`,
            proof: '',
            time: timeLabel,
          });
        }
      }
      cur = up;
    }
  }

  payload.hourlyLedger[hourStampKey] = { totalCredited, userCount, ranAt: new Date().toISOString() };
  return { credited: totalCredited, userCount, hourStampKey };
}

async function loadSharedState() {
  await ensureStateTable();
  let data = null;
  if (dbStateReady) {
    try {
      const r = await pool.query('SELECT payload FROM botbulls_v5_state WHERE id = 1');
      if (r.rows[0]?.payload?.schemaVersion === 7) data = r.rows[0].payload;
    } catch {}
  }
  if (!data) {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (p?.schemaVersion === 7) data = p;
      }
    } catch {}
  }
  if (data) {
    const renewed = runAutoBotRenewalOnState(data);
    const hrRes = runHourlyWeekdayDistribution(data);
    if (renewed > 0 || hrRes.credited > 0) await saveSharedState(data);
  }
  return data;
}

async function saveSharedState(payload) {
  runAutoBotRenewalOnState(payload);
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(payload)); } catch {}
  await ensureStateTable();
  if (dbStateReady) {
    try {
      await pool.query(
        `INSERT INTO botbulls_v5_state (id, payload, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [JSON.stringify(payload)]
      );
      return 'postgresql';
    } catch {}
  }
  return 'local_json';
}

// Background Hourly Scheduler (checks every 15 minutes; runs once per weekday hour 00:00–23:00)
setInterval(async () => {
  try {
    await loadSharedState();
  } catch {}
}, 15 * 60 * 1000);

app.get('/api/health', async (_req, res) => {
  await ensureStateTable();
  const exCfg = getRuntimeConfig(runtimeExchangeConfig);
  const { dateKey, hour } = getIstDateAndHour();
  res.json({
    ok: true,
    version: '5.0.0',
    tagline: "World's Trusted Saving Wallet",
    schedule: '22 Payout Days/Month (Mon-Fri Hourly Staggered Cents, Up to 2.5% and more)',
    weekdayActive: isWeekdayUtcOrIst(),
    istTime: `${dateKey} ${String(hour).padStart(2, '0')}:00`,
    storage: dbStateReady ? 'postgresql' : 'local_json',
    smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
    exchangeProvider: exCfg.provider,
    networkFeeUsd: exCfg.networkFeeUsd,
  });
});

app.get('/api/state', async (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const data = await loadSharedState();
  res.json({ ok: true, storage: dbStateReady ? 'postgresql' : 'local_json', state: data });
});

app.post('/api/state/sync', async (req, res) => {
  const payload = req.body && req.body.state;
  if (!payload || !Array.isArray(payload.users)) return res.status(400).json({ error: 'Invalid state payload.' });
  const storage = await saveSharedState(payload);
  res.json({ ok: true, storage, updatedAt: new Date().toISOString() });
});

// Serve uploaded files and frontend SPA (public_html/index.html)
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public_html')));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public_html', 'index.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`BotBulls v4.0 ("World's Trusted Saving Wallet") listening on port ${PORT}`));
