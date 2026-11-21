-- ============================================================================
-- BotBulls (botbulls.com) — PostgreSQL Database Schema
-- Covers: users, wallets, plans_and_bots, transactions, referrals,
--         payment_gateways, news_items, audit_logs
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. USERS
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_code           VARCHAR(20) NOT NULL UNIQUE,           -- e.g. BB-USR-1001
    username            VARCHAR(60) UNIQUE,
    email               VARCHAR(255) NOT NULL UNIQUE,
    full_name           VARCHAR(120) NOT NULL,
    phone               VARCHAR(32),
    password_hash       TEXT NOT NULL,
    role                VARCHAR(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    referral_code       VARCHAR(24) NOT NULL UNIQUE,           -- e.g. BBREF1001
    referred_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    preferred_lang      VARCHAR(10) NOT NULL DEFAULT 'en',
    last_ip             INET,
    status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_referral_code ON users(referral_code);
CREATE INDEX idx_users_referred_by ON users(referred_by_user_id);

-- 2. WALLETS
CREATE TABLE wallets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance_usd         NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (balance_usd >= 0),
    total_deposited_usd NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_withdrawn_usd NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_payout_usd    NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_referral_usd  NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. PLANS & $25 BOT ACTIVATIONS
CREATE TABLE plans_and_bots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    plan_amount_usd     NUMERIC(10, 2) NOT NULL DEFAULT 0.00
                        CHECK (plan_amount_usd IN (0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000)),
    plan_status         VARCHAR(20) NOT NULL DEFAULT 'INACTIVE' CHECK (plan_status IN ('INACTIVE', 'ACTIVE', 'EXPIRED')),
    plan_started_at     TIMESTAMPTZ,
    plan_expires_at     TIMESTAMPTZ,                           -- 90 days (3 months) from activation
    payout_days_used    INT NOT NULL DEFAULT 0 CHECK (payout_days_used BETWEEN 0 AND 90),
    max_payout_days     INT NOT NULL DEFAULT 90,
    bot_activated       BOOLEAN NOT NULL DEFAULT FALSE,        -- Mandatory $25 Bot activation
    bot_fee_paid_usd    NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    bot_activated_at    TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_plans_eligible ON plans_and_bots(plan_status, bot_activated)
    WHERE plan_status = 'ACTIVE' AND bot_activated = TRUE;

-- 4. PAYMENT GATEWAYS & MANUAL QR CONFIG
CREATE TABLE payment_gateways (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(100) NOT NULL,                 -- e.g. USDT (TRC20), INR UPI
    rail                VARCHAR(10) NOT NULL CHECK (rail IN ('INR', 'CRYPTO')),
    account_label       VARCHAR(160) NOT NULL,                 -- UPI ID, Bank A/C, or Wallet Address
    network_or_bank     VARCHAR(80),                           -- TRC20, ERC20, IMPS/UPI
    qr_code_url         TEXT,                                  -- Admin-uploaded QR image URL / path
    instructions        TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. TRANSACTIONS (Deposits, Withdrawals, P2P, Referral Earnings, Percentage Payouts)
CREATE TABLE transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_ref              VARCHAR(32) NOT NULL UNIQUE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    counterparty_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    gateway_id          UUID REFERENCES payment_gateways(id) ON DELETE SET NULL,
    tx_type             VARCHAR(30) NOT NULL CHECK (tx_type IN (
                            'DEPOSIT', 'WITHDRAWAL', 'P2P_SENT', 'P2P_RECEIVED',
                            'PLAN_ACTIVATION', 'BOT_ACTIVATION',
                            'PERCENTAGE_PAYOUT', 'REFERRAL_EARNING', 'ADMIN_ADJUSTMENT'
                        )),
    rail                VARCHAR(12) CHECK (rail IN ('INR', 'CRYPTO', 'INTERNAL')),
    gross_amount_usd    NUMERIC(14, 2) NOT NULL CHECK (gross_amount_usd > 0),
    fee_amount_usd      NUMERIC(10, 2) NOT NULL DEFAULT 0.00,  -- $1.20 on WITHDRAWAL
    net_amount_usd      NUMERIC(14, 2) NOT NULL CHECK (net_amount_usd >= 0),
    status              VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'
                        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED')),
    destination_account VARCHAR(180),                          -- Payout UPI/Bank/Wallet address
    reference_note      TEXT,                                  -- User note / UTR / TxHash
    proof_image_url     TEXT,                                  -- Uploaded manual deposit screenshot
    tranche_label       VARCHAR(60),                           -- e.g. "Daily 2.5% (Part 1/2)"
    reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tx_user_created ON transactions(user_id, created_at DESC);
CREATE INDEX idx_tx_type_status ON transactions(tx_type, status);

-- 6. REFERRALS (5-Level Pre-Indexed Downline Closure Table)
CREATE TABLE referrals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level               SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 5),
    split_percent       NUMERIC(5, 2) NOT NULL,                -- 1.00, 0.60, 0.40, 0.30, 0.20 (Sum = 2.50%)
    total_earned_usd    NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (referrer_user_id, referred_user_id)
);

CREATE INDEX idx_referrals_referrer ON referrals(referrer_user_id, level);
CREATE INDEX idx_referrals_referred ON referrals(referred_user_id);

-- 7. NEWS ITEMS
CREATE TABLE news_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    headline            VARCHAR(240) NOT NULL,
    summary             TEXT NOT NULL,
    category            VARCHAR(40) NOT NULL DEFAULT 'MARKETS',
    source_name         VARCHAR(80) NOT NULL,
    source_url          TEXT,
    published_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_news_published ON news_items(published_at DESC);

-- 8. AUDIT LOGS (IP Tracking & Admin Action Ledger)
CREATE TABLE audit_logs (
    id                  BIGSERIAL PRIMARY KEY,
    actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role          VARCHAR(20) NOT NULL,
    action              VARCHAR(80) NOT NULL,                  -- LOGIN, PAYOUT_TRIGGER, WALLET_ADJUST, etc.
    target_entity       VARCHAR(60),
    target_id           VARCHAR(64),
    ip_address          INET,
    user_agent          TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);
