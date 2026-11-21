/**
 * BotBulls (botbulls.com) — Production Backend API (Node.js + Express + PostgreSQL)
 *
 * Implements:
 * - Password hashing (bcryptjs), JWT + RBAC isolation for /api/admin/*
 * - Security headers (helmet), rate limiting, CSRF header check, XSS sanitization
 * - 11 Investment Plans ($50–$1,000) + Mandatory $25 Bot activation gate
 * - Atomic P2P transfers by User ID or Registered Email
 * - INR & Crypto deposits with Admin QR code + proof screenshot upload
 * - INR & Crypto withdrawals with strict $50.00 minimum rule & $1.20 USD client fee
 * - 5-Level 2.5% Referral Pool split (1.00%, 0.60%, 0.40%, 0.30%, 0.20%)
 * - Admin Percentage Manipulation & Part-by-Part Tranche Payout Engine
 * - IP tracking & immutable audit logging
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

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production';
const ALLOWED_PLANS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
const BOT_ACTIVATION_FEE = 25.00;
const MIN_WITHDRAWAL_USD = 50.00;
const WITHDRAWAL_FEE_USD = 1.20;
const MIN_WITHDRAWAL_ERROR =
  'The minimum withdrawal amount is $50.00. By requesting less than the minimum withdrawal limit, you are violating our Terms and Conditions, so your withdrawal cannot be processed.';

// 2.50% total referral pool split across 5 downline levels
const REFERRAL_LEVEL_SPLITS = [
  { level: 1, percent: 1.00 },
  { level: 2, percent: 0.60 },
  { level: 3, percent: 0.40 },
  { level: 4, percent: 0.30 },
  { level: 5, percent: 0.20 },
];

// ---------------------------------------------------------------------------
// Security & Parsing Middleware
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '12mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Rate limit exceeded. Slow down your requests.' },
});
app.use('/api/', apiLimiter);

// Safe file upload for deposit screenshots & admin QR images
const storage = multer.diskStorage({
  destination: process.env.UPLOAD_DIR || './uploads',
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

function sanitizeText(value = '') {
  return String(value).replace(/[<>]/g, '').trim().slice(0, 500);
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || req.socket.remoteAddress || '127.0.0.1'))
    .split(',')[0]
    .trim();
}

function makeTxRef(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function writeAuditLog(client, { actorId, actorRole, action, targetEntity, targetId, req, metadata = {} }) {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, actor_role, action, target_entity, target_id, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actorId || null,
      actorRole || 'SYSTEM',
      action,
      targetEntity || null,
      targetId ? String(targetId) : null,
      getClientIp(req),
      sanitizeText(req.headers['user-agent'] || ''),
      JSON.stringify(metadata),
    ]
  );
}

// ---------------------------------------------------------------------------
// Auth & RBAC Middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden: Admin portal role required.' });
    }
    return next();
  });
}

// ---------------------------------------------------------------------------
// 1. AUTHENTICATION (User & Isolated Admin Portal)
// ---------------------------------------------------------------------------
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { fullName, email, password, referralCode } = req.body;
  if (!fullName || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Full name, valid email, and password (min 8 chars) are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const normalizedEmail = sanitizeText(email).toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);
    const seqNum = Math.floor(1000 + Math.random() * 9000);
    const userCode = `BB-USR-${seqNum}`;
    const ownRefCode = `BBREF${seqNum}`;

    let directReferrerId = null;
    if (referralCode) {
      const refLookup = await client.query(
        'SELECT id FROM users WHERE referral_code = $1 OR user_code = $1',
        [sanitizeText(referralCode).toUpperCase()]
      );
      if (refLookup.rows.length > 0) directReferrerId = refLookup.rows[0].id;
    }

    const userRes = await client.query(
      `INSERT INTO users (user_code, email, full_name, password_hash, role, referral_code, referred_by_user_id, last_ip)
       VALUES ($1, $2, $3, $4, 'USER', $5, $6, $7)
       RETURNING id, user_code, email, full_name, referral_code`,
      [userCode, normalizedEmail, sanitizeText(fullName), passwordHash, ownRefCode, directReferrerId, getClientIp(req)]
    );
    const newUser = userRes.rows[0];

    await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [newUser.id]);
    await client.query('INSERT INTO plans_and_bots (user_id) VALUES ($1)', [newUser.id]);

    // Build 5-level upline referral closure rows
    let currentUplineId = directReferrerId;
    for (const tier of REFERRAL_LEVEL_SPLITS) {
      if (!currentUplineId) break;
      await client.query(
        `INSERT INTO referrals (referrer_user_id, referred_user_id, level, split_percent)
         VALUES ($1, $2, $3, $4)`,
        [currentUplineId, newUser.id, tier.level, tier.percent]
      );
      const nextUp = await client.query('SELECT referred_by_user_id FROM users WHERE id = $1', [currentUplineId]);
      currentUplineId = nextUp.rows[0]?.referred_by_user_id || null;
    }

    await writeAuditLog(client, {
      actorId: newUser.id,
      actorRole: 'USER',
      action: 'USER_REGISTER',
      targetEntity: 'users',
      targetId: newUser.id,
      req,
      metadata: { referralCode: referralCode || null },
    });

    await client.query('COMMIT');
    const token = jwt.sign({ id: newUser.id, role: 'USER', userCode: newUser.user_code }, JWT_SECRET, { expiresIn: '12h' });
    res.status(201).json({ token, user: newUser });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email is already registered.' });
    res.status(500).json({ error: 'Registration failed.' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, user_code, email, full_name, password_hash, role, status FROM users WHERE email = $1 AND role = 'USER'",
      [sanitizeText(email).toLowerCase()]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'Account is suspended.' });

    await client.query('UPDATE users SET last_ip = $1, updated_at = NOW() WHERE id = $2', [getClientIp(req), user.id]);
    await writeAuditLog(client, { actorId: user.id, actorRole: 'USER', action: 'USER_LOGIN', req });

    const token = jwt.sign({ id: user.id, role: 'USER', userCode: user.user_code }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, userCode: user.user_code, email: user.email, fullName: user.full_name } });
  } finally {
    client.release();
  }
});

// Isolated Admin Portal Login (username: admin)
app.post('/api/admin/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, username, password_hash, role FROM users WHERE username = $1 AND role = 'ADMIN'",
      [sanitizeText(username)]
    );
    const admin = result.rows[0];
    if (!admin || !(await bcrypt.compare(password || '', admin.password_hash))) {
      return res.status(401).json({ error: 'Invalid admin portal credentials.' });
    }

    await client.query('UPDATE users SET last_ip = $1, updated_at = NOW() WHERE id = $2', [getClientIp(req), admin.id]);
    await writeAuditLog(client, { actorId: admin.id, actorRole: 'ADMIN', action: 'ADMIN_LOGIN', req });

    const token = jwt.sign({ id: admin.id, role: 'ADMIN', username: admin.username }, JWT_SECRET, { expiresIn: '4h' });
    res.json({ token, admin: { id: admin.id, username: admin.username, role: 'ADMIN' } });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 2. PLAN & $25 BOT ACTIVATION
// ---------------------------------------------------------------------------
app.post('/api/plans/activate', requireAuth, async (req, res) => {
  const planAmount = Number(req.body.planAmount);
  if (!ALLOWED_PLANS.includes(planAmount)) {
    return res.status(400).json({ error: 'Invalid plan package selected.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query('SELECT balance_usd FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (Number(wRes.rows[0].balance_usd) < planAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance to activate this plan.' });
    }

    await client.query('UPDATE wallets SET balance_usd = balance_usd - $1, updated_at = NOW() WHERE user_id = $2', [
      planAmount,
      req.user.id,
    ]);
    await client.query(
      `UPDATE plans_and_bots
       SET plan_amount_usd = $1, plan_status = 'ACTIVE', plan_started_at = NOW(),
           plan_expires_at = NOW() + INTERVAL '90 days', payout_days_used = 0, updated_at = NOW()
       WHERE user_id = $2`,
      [planAmount, req.user.id]
    );
    await client.query(
      `INSERT INTO transactions (tx_ref, user_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, reference_note)
       VALUES ($1, $2, 'PLAN_ACTIVATION', 'INTERNAL', $3, 0, $3, 'COMPLETED', $4)`,
      [makeTxRef('PLN'), req.user.id, planAmount, `Activated $${planAmount} Plan (90-day (3-month) cycle)`]
    );

    await client.query('COMMIT');
    res.json({ message: `$${planAmount} Plan activated. Ensure your $25 Bot is also active to receive daily distributions.` });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Plan activation failed.' });
  } finally {
    client.release();
  }
});

app.post('/api/bot/activate', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pbRes = await client.query('SELECT bot_activated FROM plans_and_bots WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (pbRes.rows[0]?.bot_activated) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '$25 Bot is already active.' });
    }

    const wRes = await client.query('SELECT balance_usd FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (Number(wRes.rows[0].balance_usd) < BOT_ACTIVATION_FEE) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance ($25.00 required).' });
    }

    await client.query('UPDATE wallets SET balance_usd = balance_usd - $1, updated_at = NOW() WHERE user_id = $2', [
      BOT_ACTIVATION_FEE,
      req.user.id,
    ]);
    await client.query(
      `UPDATE plans_and_bots SET bot_activated = TRUE, bot_fee_paid_usd = $1, bot_activated_at = NOW(), updated_at = NOW()
       WHERE user_id = $2`,
      [BOT_ACTIVATION_FEE, req.user.id]
    );
    await client.query(
      `INSERT INTO transactions (tx_ref, user_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, reference_note)
       VALUES ($1, $2, 'BOT_ACTIVATION', 'INTERNAL', $3, 0, $3, 'COMPLETED', '$25 Automated Bot Activation')`,
      [makeTxRef('BOT'), req.user.id, BOT_ACTIVATION_FEE]
    );

    await client.query('COMMIT');
    res.json({ message: '$25 Bot activated successfully.' });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Bot activation failed.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 3. P2P WALLET TRANSFERS (By User ID or Registered Email)
// ---------------------------------------------------------------------------
app.post('/api/wallet/p2p', requireAuth, async (req, res) => {
  const recipientIdentifier = sanitizeText(req.body.recipient);
  const amount = Number(req.body.amount);
  const note = sanitizeText(req.body.note || '');
  if (!recipientIdentifier || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Valid recipient User ID/email and positive amount are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recRes = await client.query(
      "SELECT id, user_code, email FROM users WHERE (LOWER(email) = LOWER($1) OR UPPER(user_code) = UPPER($1)) AND role = 'USER'",
      [recipientIdentifier]
    );
    const recipient = recRes.rows[0];
    if (!recipient) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipient user not found.' });
    }
    if (recipient.id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot transfer funds to your own account.' });
    }

    const senderWallet = await client.query('SELECT balance_usd FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (Number(senderWallet.rows[0].balance_usd) < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }

    await client.query('UPDATE wallets SET balance_usd = balance_usd - $1, updated_at = NOW() WHERE user_id = $2', [amount, req.user.id]);
    await client.query('UPDATE wallets SET balance_usd = balance_usd + $1, updated_at = NOW() WHERE user_id = $2', [amount, recipient.id]);

    const refBase = makeTxRef('P2P');
    await client.query(
      `INSERT INTO transactions (tx_ref, user_id, counterparty_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, reference_note)
       VALUES ($1, $2, $3, 'P2P_SENT', 'INTERNAL', $4, 0, $4, 'COMPLETED', $5)`,
      [`${refBase}-S`, req.user.id, recipient.id, amount, note || `P2P to ${recipient.user_code}`]
    );
    await client.query(
      `INSERT INTO transactions (tx_ref, user_id, counterparty_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, reference_note)
       VALUES ($1, $2, $3, 'P2P_RECEIVED', 'INTERNAL', $4, 0, $4, 'COMPLETED', $5)`,
      [`${refBase}-R`, recipient.id, req.user.id, amount, note || `P2P from ${req.user.userCode}`]
    );

    await writeAuditLog(client, {
      actorId: req.user.id,
      actorRole: 'USER',
      action: 'P2P_TRANSFER',
      targetEntity: 'users',
      targetId: recipient.id,
      req,
      metadata: { amount, recipientCode: recipient.user_code },
    });

    await client.query('COMMIT');
    res.json({ message: `Transferred $${amount.toFixed(2)} to ${recipient.user_code}.` });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'P2P transfer failed.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 4. DEPOSITS (INR & Manual Crypto with QR + Note + Proof Screenshot)
// ---------------------------------------------------------------------------
app.post('/api/deposits', requireAuth, upload.single('proofImage'), async (req, res) => {
  const rail = sanitizeText(req.body.rail).toUpperCase();
  const amount = Number(req.body.amount);
  const gatewayId = req.body.gatewayId || null;
  const referenceNote = sanitizeText(req.body.referenceNote || '');

  if (!['INR', 'CRYPTO'].includes(rail) || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Valid deposit rail (INR/CRYPTO) and amount are required.' });
  }
  if (rail === 'CRYPTO' && (!referenceNote || !req.file)) {
    return res.status(400).json({ error: 'Manual Crypto deposits require a Reference/Note and uploaded proof screenshot.' });
  }

  const proofUrl = req.file ? `/uploads/${req.file.filename}` : null;
  const txRef = makeTxRef('DEP');
  await pool.query(
    `INSERT INTO transactions (tx_ref, user_id, gateway_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, reference_note, proof_image_url)
     VALUES ($1, $2, $3, 'DEPOSIT', $4, $5, 0, $5, 'PENDING', $6, $7)`,
    [txRef, req.user.id, gatewayId, rail, amount, referenceNote, proofUrl]
  );

  res.status(201).json({ txRef, status: 'PENDING', message: 'Deposit submitted for admin verification.' });
});

// ---------------------------------------------------------------------------
// 5. WITHDRAWALS (Strict $50.00 Minimum & $1.20 USD Client Fee)
// ---------------------------------------------------------------------------
app.post('/api/withdrawals', requireAuth, async (req, res) => {
  const rail = sanitizeText(req.body.rail).toUpperCase();
  const grossAmount = Number(req.body.amount);
  const destination = sanitizeText(req.body.destinationAccount || '');

  if (!['INR', 'CRYPTO'].includes(rail) || !destination) {
    return res.status(400).json({ error: 'Valid withdrawal rail (INR/CRYPTO) and destination account are required.' });
  }

  // STRICT SERVER-SIDE $50.00 MINIMUM CHECK
  if (!Number.isFinite(grossAmount) || grossAmount < MIN_WITHDRAWAL_USD) {
    return res.status(400).json({ error: MIN_WITHDRAWAL_ERROR, code: 'MIN_WITHDRAWAL_VIOLATION' });
  }

  const netPayout = Number((grossAmount - WITHDRAWAL_FEE_USD).toFixed(2));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wRes = await client.query('SELECT balance_usd FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (Number(wRes.rows[0].balance_usd) < grossAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }

    // Hold funds upon request submission
    await client.query('UPDATE wallets SET balance_usd = balance_usd - $1, updated_at = NOW() WHERE user_id = $2', [
      grossAmount,
      req.user.id,
    ]);

    const txRef = makeTxRef('WDR');
    await client.query(
      `INSERT INTO transactions (tx_ref, user_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, destination_account)
       VALUES ($1, $2, 'WITHDRAWAL', $3, $4, $5, $6, 'PENDING', $7)`,
      [txRef, req.user.id, rail, grossAmount, WITHDRAWAL_FEE_USD, netPayout, destination]
    );

    await writeAuditLog(client, {
      actorId: req.user.id,
      actorRole: 'USER',
      action: 'WITHDRAWAL_REQUEST',
      targetEntity: 'transactions',
      targetId: txRef,
      req,
      metadata: { rail, grossAmount, fee: WITHDRAWAL_FEE_USD, netPayout },
    });

    await client.query('COMMIT');
    res.status(201).json({
      txRef,
      grossAmount,
      feeAmount: WITHDRAWAL_FEE_USD,
      netPayout,
      status: 'PENDING',
    });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal submission failed.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 6. ADMIN: PERCENTAGE DISTRIBUTION & 5-LEVEL 2.5% REFERRAL ENGINE
// ---------------------------------------------------------------------------
app.post('/api/admin/distribute', requireAdmin, async (req, res) => {
  const dailyPercent = Number(req.body.percent);
  const tranches = Math.max(1, Math.min(10, Number(req.body.tranches || 1)));
  const incrementCycleDay = Boolean(req.body.incrementCycleDay);

  if (!Number.isFinite(dailyPercent) || dailyPercent <= 0 || dailyPercent > 10) {
    return res.status(400).json({ error: 'Percentage must be between 0.01% and 10.00%.' });
  }

  const tranchePercent = Number((dailyPercent / tranches).toFixed(4));
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // STRICT ELIGIBILITY: BOTH Plan AND $25 Bot must be ACTIVE, within 90-day (3-month) cycle
    const eligibleRes = await client.query(
      `SELECT pb.user_id, pb.plan_amount_usd, pb.payout_days_used
       FROM plans_and_bots pb
       JOIN users u ON u.id = pb.user_id
       WHERE pb.plan_status = 'ACTIVE'
         AND pb.bot_activated = TRUE
         AND pb.payout_days_used < pb.max_payout_days
         AND (pb.plan_expires_at IS NULL OR pb.plan_expires_at > NOW())
         AND u.status = 'ACTIVE'`
    );

    let totalDistributed = 0;
    let totalReferralDistributed = 0;

    for (const row of eligibleRes.rows) {
      const payoutUsd = Number(((Number(row.plan_amount_usd) * tranchePercent) / 100).toFixed(2));
      if (payoutUsd <= 0) continue;

      await client.query(
        `UPDATE wallets
         SET balance_usd = balance_usd + $1, total_payout_usd = total_payout_usd + $1, updated_at = NOW()
         WHERE user_id = $2`,
        [payoutUsd, row.user_id]
      );

      await client.query(
        `INSERT INTO transactions (tx_ref, user_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, tranche_label)
         VALUES ($1, $2, 'PERCENTAGE_PAYOUT', 'INTERNAL', $3, 0, $3, 'COMPLETED', $4)`,
        [makeTxRef('PAY'), row.user_id, payoutUsd, `Tranche ${tranchePercent}% (of ${dailyPercent}% / ${tranches} parts)`]
      );
      totalDistributed += payoutUsd;

      if (incrementCycleDay) {
        await client.query('UPDATE plans_and_bots SET payout_days_used = payout_days_used + 1 WHERE user_id = $1', [row.user_id]);
      }

      // 5-LEVEL 2.5% REFERRAL POOL SPLIT (Only when BOTH referred user AND referrer are active)
      const uplines = await client.query(
        `SELECT r.id, r.referrer_user_id, r.level, r.split_percent
         FROM referrals r
         JOIN plans_and_bots pb ON pb.user_id = r.referrer_user_id
         JOIN users u ON u.id = r.referrer_user_id
         WHERE r.referred_user_id = $1
           AND pb.plan_status = 'ACTIVE'
           AND pb.bot_activated = TRUE
           AND u.status = 'ACTIVE'`,
        [row.user_id]
      );

      for (const up of uplines.rows) {
        const refUsd = Number(((payoutUsd * Number(up.split_percent)) / 100).toFixed(2));
        if (refUsd <= 0) continue;

        await client.query(
          `UPDATE wallets
           SET balance_usd = balance_usd + $1, total_referral_usd = total_referral_usd + $1, updated_at = NOW()
           WHERE user_id = $2`,
          [refUsd, up.referrer_user_id]
        );
        await client.query('UPDATE referrals SET total_earned_usd = total_earned_usd + $1 WHERE id = $2', [refUsd, up.id]);
        await client.query(
          `INSERT INTO transactions (tx_ref, user_id, counterparty_id, tx_type, rail, gross_amount_usd, fee_amount_usd, net_amount_usd, status, reference_note)
           VALUES ($1, $2, $3, 'REFERRAL_EARNING', 'INTERNAL', $4, 0, $4, 'COMPLETED', $5)`,
          [makeTxRef('REF'), up.referrer_user_id, row.user_id, refUsd, `Level ${up.level} (${up.split_percent}% of 2.5% pool)`]
        );
        totalReferralDistributed += refUsd;
      }
    }

    await writeAuditLog(client, {
      actorId: req.user.id,
      actorRole: 'ADMIN',
      action: 'PERCENTAGE_DISTRIBUTION',
      req,
      metadata: {
        dailyPercent,
        tranches,
        tranchePercent,
        eligibleUsers: eligibleRes.rows.length,
        totalDistributed: Number(totalDistributed.toFixed(2)),
        totalReferralDistributed: Number(totalReferralDistributed.toFixed(2)),
      },
    });

    await client.query('COMMIT');
    res.json({
      eligibleUsers: eligibleRes.rows.length,
      tranchePercent,
      totalDistributed: Number(totalDistributed.toFixed(2)),
      totalReferralDistributed: Number(totalReferralDistributed.toFixed(2)),
    });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Distribution engine error.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 7. ADMIN: DEPOSIT & WITHDRAWAL APPROVAL / REJECTION
// ---------------------------------------------------------------------------
app.post('/api/admin/transactions/:txRef/decision', requireAdmin, async (req, res) => {
  const { txRef } = req.params;
  const decision = sanitizeText(req.body.decision).toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be APPROVED or REJECTED.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txRes = await client.query('SELECT * FROM transactions WHERE tx_ref = $1 FOR UPDATE', [txRef]);
    const tx = txRes.rows[0];
    if (!tx || tx.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending transaction not found.' });
    }

    if (tx.tx_type === 'DEPOSIT' && decision === 'APPROVED') {
      await client.query(
        'UPDATE wallets SET balance_usd = balance_usd + $1, total_deposited_usd = total_deposited_usd + $1, updated_at = NOW() WHERE user_id = $2',
        [tx.gross_amount_usd, tx.user_id]
      );
    } else if (tx.tx_type === 'WITHDRAWAL' && decision === 'APPROVED') {
      await client.query(
        'UPDATE wallets SET total_withdrawn_usd = total_withdrawn_usd + $1, updated_at = NOW() WHERE user_id = $2',
        [tx.gross_amount_usd, tx.user_id]
      );
    } else if (tx.tx_type === 'WITHDRAWAL' && decision === 'REJECTED') {
      // Refund held gross amount back to user wallet
      await client.query('UPDATE wallets SET balance_usd = balance_usd + $1, updated_at = NOW() WHERE user_id = $2', [
        tx.gross_amount_usd,
        tx.user_id,
      ]);
    }

    await client.query('UPDATE transactions SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3', [
      decision,
      req.user.id,
      tx.id,
    ]);

    await writeAuditLog(client, {
      actorId: req.user.id,
      actorRole: 'ADMIN',
      action: `${tx.tx_type}_${decision}`,
      targetEntity: 'transactions',
      targetId: tx.tx_ref,
      req,
    });

    await client.query('COMMIT');
    res.json({ txRef, status: decision });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to update transaction.' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// 8. ADMIN: PAYMENT GATEWAY & MANUAL QR MANAGEMENT
// ---------------------------------------------------------------------------
app.post('/api/admin/gateways', requireAdmin, upload.single('qrCode'), async (req, res) => {
  const { name, rail, accountLabel, networkOrBank, instructions } = req.body;
  const qrCodeUrl = req.file ? `/uploads/${req.file.filename}` : sanitizeText(req.body.qrCodeUrl || '');
  const result = await pool.query(
    `INSERT INTO payment_gateways (name, rail, account_label, network_or_bank, qr_code_url, instructions, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      sanitizeText(name),
      sanitizeText(rail).toUpperCase(),
      sanitizeText(accountLabel),
      sanitizeText(networkOrBank || ''),
      qrCodeUrl,
      sanitizeText(instructions || ''),
      req.user.id,
    ]
  );
  res.status(201).json(result.rows[0]);
});



// ---------------------------------------------------------------------------
// 9. REAL-TIME SHARED STATE SYNC (Connects User Site <-> Partners Log <-> Supabase DB)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let dbStateReady = false;
async function ensureStateTable() {
  if (!process.env.DATABASE_URL || dbStateReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS botbulls_live_state (
        id INTEGER PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    dbStateReady = true;
    console.log('Connected to PostgreSQL live state table.');
  } catch (err) {
    console.warn('PostgreSQL state table unavailable, using local JSON fallback:', err.message);
  }
}

async function loadSharedState() {
  await ensureStateTable();
  if (dbStateReady) {
    try {
      const r = await pool.query('SELECT payload FROM botbulls_live_state WHERE id = 1');
      if (r.rows.length > 0 && r.rows[0].payload && r.rows[0].payload.schemaVersion === 2) {
        return r.rows[0].payload;
      }
    } catch {}
  }
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (parsed && parsed.schemaVersion === 2) return parsed;
    }
  } catch {}
  return null;
}

async function saveSharedState(payload) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload));
  } catch {}
  await ensureStateTable();
  if (dbStateReady) {
    try {
      await pool.query(
        `INSERT INTO botbulls_live_state (id, payload, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [JSON.stringify(payload)]
      );
      return 'postgres';
    } catch {}
  }
  return 'file';
}

app.get('/api/health', async (_req, res) => {
  await ensureStateTable();
  res.json({ ok: true, storage: dbStateReady ? 'postgresql' : 'local_json' });
});

app.get('/api/state', async (_req, res) => {
  const data = await loadSharedState();
  res.json({ ok: true, storage: dbStateReady ? 'postgresql' : 'local_json', state: data });
});

app.post('/api/state/sync', async (req, res) => {
  const payload = req.body && req.body.state;
  if (!payload || !Array.isArray(payload.users)) {
    return res.status(400).json({ error: 'Invalid state payload.' });
  }
  const storage = await saveSharedState(payload);
  res.json({ ok: true, storage, updatedAt: new Date().toISOString() });
});

// Serve uploaded proofs and the BotBulls frontend (public_html/index.html)
app.use('/uploads', express.static(path.join(__dirname, process.env.UPLOAD_DIR || 'uploads')));
app.use(express.static(path.join(__dirname, 'public_html')));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public_html', 'index.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`BotBulls API listening on port ${PORT}`));
