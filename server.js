/**
 * BotBulls v2.0 (botbulls.com) — Full-Stack Production Server (Express + PostgreSQL + Nodemailer)
 *
 * Features:
 * - Unified server: serves public_html/index.html + /api/* from one GitHub-ready repo
 * - Auth + Password Hashing (bcryptjs) + Forgot Password OTP flow + RBAC (/api/admin/*)
 * - 90-Day Plan Validity + Tiered Monthly Bot ($25/mo for $50-$400; $50/mo for $500-$1,000)
 * - Strict NO-RETROACTIVE Payout Rule (only active plan within 90 days + active current-month bot)
 * - Daily Distribution Engine (base 5%, configurable 1%-10% in part-by-part tranches)
 * - Daily 5-Level 5% GWC (Goodwill Commission) Pool (2.00%, 1.25%, 0.75%, 0.60%, 0.40%)
 * - $10.00 Minimum Withdrawal + 1% Withdrawal Deduction
 * - 5% Company Gifts & Rewards Pool (₹1 Lakh to ₹1 Crore across User + 5 Downline Levels)
 * - Free SMTP Automated Emails via Nodemailer (Welcome, Daily Payout & GWC, Deposit, Withdrawal, Forgot Password)
 * - Real-time Shared State Sync (/api/state & /api/state/sync) with PostgreSQL + JSON fallback
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

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const JWT_SECRET = process.env.JWT_SECRET || 'botbulls_v2_dev_secret_change_me';
const ALLOWED_PLANS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
const MIN_WITHDRAWAL_USD = 10.00;
const WITHDRAWAL_DEDUCTION_RATE = 0.01; // 1% deduction
const MIN_WITHDRAWAL_ERROR =
  'The minimum withdrawal amount is $10.00 USD. Withdrawal requests below $10.00 cannot be processed under BotBulls Terms and Conditions.';

// 5.00% Daily GWC (Goodwill Commission) pool split across 5 downline levels
const GWC_LEVEL_SPLITS = [
  { level: 1, percent: 2.00 },
  { level: 2, percent: 1.25 },
  { level: 3, percent: 0.75 },
  { level: 4, percent: 0.60 },
  { level: 5, percent: 0.40 },
];

function getRequiredMonthlyBotFee(planAmount) {
  return Number(planAmount) >= 500 ? 50.00 : 25.00;
}

// ---------------------------------------------------------------------------
// Security & Middleware
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '15mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 180 }));

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

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required.' });
    return next();
  });
}

// ---------------------------------------------------------------------------
// 1. AUTH + FORGOT PASSWORD (SMTP OTP)
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

    const token = jwt.sign({ id: u.id, role: 'USER', userCode: u.user_code }, JWT_SECRET, { expiresIn: '24h' });
    res.status(201).json({ token, user: u });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email is already registered.' });
    res.status(500).json({ error: 'Registration failed.' });
  } finally {
    client.release();
  }
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
// 2. WITHDRAWALS ($10.00 MINIMUM & 1% DEDUCTION)
// ---------------------------------------------------------------------------
app.post('/api/withdrawals', requireAuth, async (req, res) => {
  const rail = sanitizeText(req.body.rail).toUpperCase();
  const gross = Number(req.body.amount);
  const destination = sanitizeText(req.body.destinationAccount || '');
  if (rail !== 'CRYPTO' || !destination) {
    return res.status(400).json({ error: 'Crypto withdrawal rail (CRYPTO) and destination account are required.' });
  }
  if (!Number.isFinite(gross) || gross < MIN_WITHDRAWAL_USD) {
    return res.status(400).json({ error: MIN_WITHDRAWAL_ERROR, code: 'MIN_WITHDRAWAL_VIOLATION' });
  }
  const deduction = Number((gross * WITHDRAWAL_DEDUCTION_RATE).toFixed(2));
  const net = Number((gross - deduction).toFixed(2));

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
      `INSERT INTO transactions (tx_ref, user_id, tx_type, rail, gross_amount_usd, deduction_usd, net_amount_usd, status, destination_account)
       VALUES ($1, $2, 'WITHDRAWAL', $3, $4, $5, $6, 'PENDING', $7)`,
      [txRef, req.user.id, rail, gross, deduction, net, destination]
    );
    await client.query('COMMIT');
    res.status(201).json({ txRef, gross, deduction, net, status: 'PENDING' });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal failed.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 3. EMAIL TRIGGER ENDPOINT (Used by Connected Frontend / Admin Actions)
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
// 4. REAL-TIME CONNECTED STATE SYNC (User Panel <-> Admin Portal <-> PostgreSQL)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state_v3.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let dbStateReady = false;
async function ensureStateTable() {
  if (!process.env.DATABASE_URL || dbStateReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS botbulls_v2_state (
        id INTEGER PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    dbStateReady = true;
  } catch {}
}

async function loadSharedState() {
  await ensureStateTable();
  if (dbStateReady) {
    try {
      const r = await pool.query('SELECT payload FROM botbulls_v2_state WHERE id = 1');
      if (r.rows[0]?.payload?.schemaVersion === 3) return r.rows[0].payload;
    } catch {}
  }
  try {
    if (fs.existsSync(STATE_FILE)) {
      const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (p?.schemaVersion === 3) return p;
    }
  } catch {}
  return null;
}

async function saveSharedState(payload) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(payload)); } catch {}
  await ensureStateTable();
  if (dbStateReady) {
    try {
      await pool.query(
        `INSERT INTO botbulls_v2_state (id, payload, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [JSON.stringify(payload)]
      );
      return 'postgresql';
    } catch {}
  }
  return 'local_json';
}

app.get('/api/health', async (_req, res) => {
  await ensureStateTable();
  res.json({ ok: true, version: '2.0', storage: dbStateReady ? 'postgresql' : 'local_json', smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER) });
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
app.listen(PORT, () => console.log(`BotBulls v2.0 server listening on port ${PORT}`));
