-- ============================================================================
-- BotBulls v5.0 (botbulls.com — World's Trusted Saving Wallet)
-- Production 14-Table PostgreSQL Database Schema
-- Rules: 12-Month (264 Mon-Fri Payout Days) Plans + Generations | $10/$50 Tiered Bot + Auto-Pay
--        Mon–Fri Hourly Staggered Cents ("Up to 2.5% and more") + 2.5% GWC
--        Crypto-Only Deposits/Withdrawals | 0% Company Fee | $1.20 TRC20 Client Fee
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. USERS
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_code           VARCHAR(20) NOT NULL UNIQUE,
    username            VARCHAR(60) UNIQUE,
    email               VARCHAR(255) NOT NULL UNIQUE,
    phone               VARCHAR(32),
    full_name           VARCHAR(120) NOT NULL,
    password_hash       TEXT NOT NULL,
    role                VARCHAR(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    referral_code       VARCHAR(24) NOT NULL UNIQUE,
    referred_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    auto_pay_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    preferred_lang      VARCHAR(10) NOT NULL DEFAULT 'en',
    last_ip             INET,
    status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_ref_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_user_id);

-- 2. WALLETS
CREATE TABLE IF NOT EXISTS wallets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance_usd         NUMERIC(14, 2) NOT NULL DEFAULT 0.00 CHECK (balance_usd >= 0),
    total_deposited_usd NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_withdrawn_usd NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_payout_usd    NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_gwc_usd       NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. PLANS & TIERED MONTHLY BOTS (12-Month / 365-Day Cycle + Generation Number; $10 or $50 Bot Fee)
CREATE TABLE IF NOT EXISTS plans_and_monthly_bots (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_ref                VARCHAR(32) NOT NULL UNIQUE,
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    generation_number       SMALLINT NOT NULL DEFAULT 1,
    plan_amount_usd         NUMERIC(10, 2) NOT NULL
                            CHECK (plan_amount_usd IN (50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000)),
    required_bot_fee_usd    NUMERIC(10, 2) NOT NULL CHECK (required_bot_fee_usd IN (10, 50)),
    plan_status             VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (plan_status IN ('INACTIVE', 'ACTIVE', 'COMPLETED_DEACTIVATED')),
    plan_started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    plan_expires_at         TIMESTAMPTZ NOT NULL,                 -- 12 Months (264 Mon-Fri Payout Days, Sat/Sun excluded) from activation
    bot_active              BOOLEAN NOT NULL DEFAULT FALSE,
    bot_auto_pay            BOOLEAN NOT NULL DEFAULT TRUE,
    bot_activated_at        TIMESTAMPTZ,
    bot_payout_days_limit   SMALLINT NOT NULL DEFAULT 22,
    bot_payout_days_used    SMALLINT NOT NULL DEFAULT 0,
    bot_expires_at          TIMESTAMPTZ,
    last_payout_ist_date    DATE,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plans_bot_eligible ON plans_and_monthly_bots(user_id, plan_status, bot_active, bot_expires_at, plan_expires_at);

-- 4. CRYPTO PAYMENT GATEWAYS & MANUAL QR CONFIG (CRYPTO-ONLY)
CREATE TABLE IF NOT EXISTS payment_gateways (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(100) NOT NULL,
    rail                VARCHAR(10) NOT NULL DEFAULT 'CRYPTO' CHECK (rail IN ('CRYPTO')),
    account_label       VARCHAR(180) NOT NULL,
    network_or_bank     VARCHAR(80),
    qr_code_url         TEXT,
    instructions        TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. TRANSACTIONS (Crypto-Only; 0% Company Fee; $1.20 TRC20 Client-Borne Network Fee)
CREATE TABLE IF NOT EXISTS transactions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_ref                VARCHAR(36) NOT NULL UNIQUE,
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    counterparty_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    gateway_id            UUID REFERENCES payment_gateways(id) ON DELETE SET NULL,
    tx_type               VARCHAR(32) NOT NULL CHECK (tx_type IN (
                              'DEPOSIT', 'WITHDRAWAL', 'P2P_SENT', 'P2P_RECEIVED',
                              'PLAN_ACTIVATION', 'MONTHLY_BOT_RENEWAL', 'MONTHLY_BOT_AUTO_RENEWAL',
                              'DAILY_PAYOUT', 'GWC_DAILY', 'ADMIN_ADJUSTMENT'
                          )),
    rail                  VARCHAR(12) CHECK (rail IN ('CRYPTO', 'INTERNAL')),
    gross_amount_usd      NUMERIC(14, 2) NOT NULL CHECK (gross_amount_usd > 0),
    company_deduction_usd NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    network_fee_usd       NUMERIC(10, 2) NOT NULL DEFAULT 1.20,
    net_amount_usd        NUMERIC(14, 2) NOT NULL CHECK (net_amount_usd >= 0),
    status                VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'
                          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED')),
    destination_account   VARCHAR(180),
    exchange_tx_id        VARCHAR(120),
    reference_note        TEXT,
    proof_image_url       TEXT,
    tranche_label         VARCHAR(80),
    reviewed_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_user_created ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_type_status ON transactions(tx_type, status);

-- 6. HOURLY STAGGERED CENTS PAYOUT RUNS (Mon–Fri 00:00–23:00)
CREATE TABLE IF NOT EXISTS hourly_payout_runs (
    id                  BIGSERIAL PRIMARY KEY,
    payout_ist_date     DATE NOT NULL,
    payout_hour         SMALLINT NOT NULL CHECK (payout_hour BETWEEN 0 AND 23),
    users_credited      INTEGER NOT NULL DEFAULT 0,
    total_payout_usd    NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_gwc_usd       NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (payout_ist_date, payout_hour)
);

-- 7. REFERRALS (5-Level Downline Closure Table — 2.50% Daily GWC Split: 1.00, 0.60, 0.40, 0.30, 0.20)
CREATE TABLE IF NOT EXISTS referrals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level               SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 5),
    gwc_split_percent   NUMERIC(5, 2) NOT NULL,
    total_gwc_usd       NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (referrer_user_id, referred_user_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id, level);

-- 8. GWC RECORDS (Goodwill Commission — Mon–Fri Daily/Hourly Payout Ledger)
CREATE TABLE IF NOT EXISTS gwc_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gwc_ref             VARCHAR(36) NOT NULL UNIQUE,
    upline_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    downline_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level               SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 5),
    base_payout_usd     NUMERIC(14, 2) NOT NULL,
    gwc_percent         NUMERIC(5, 2) NOT NULL,
    gwc_amount_usd      NUMERIC(14, 2) NOT NULL,
    payout_ist_date     DATE NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gwc_upline_date ON gwc_records(upline_user_id, payout_ist_date DESC);

-- 9. REWARDS & MILESTONES (₹1 Lakh to ₹1 Crore + 2.5% Company Gift Pool)
CREATE TABLE IF NOT EXISTS rewards_milestones (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                VARCHAR(32) NOT NULL UNIQUE,
    title               VARCHAR(120) NOT NULL,
    target_business_inr NUMERIC(14, 2) NOT NULL,
    photo_url           TEXT,
    description         TEXT,
    sort_order          SMALLINT NOT NULL DEFAULT 1,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_reward_claims (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone_id        UUID NOT NULL REFERENCES rewards_milestones(id) ON DELETE CASCADE,
    business_volume_inr NUMERIC(14, 2) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'ACHIEVED' CHECK (status IN ('ACHIEVED', 'DISPATCHED')),
    achieved_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, milestone_id)
);

-- 10. EXCHANGE / CRYPTO WALLET API CONFIGS (Binance, KuCoin, Custom — Default $1.20 TRC20 Network Fee)
CREATE TABLE IF NOT EXISTS exchange_api_configs (
    id                  INTEGER PRIMARY KEY DEFAULT 1,
    provider            VARCHAR(32) NOT NULL DEFAULT 'MANUAL' CHECK (provider IN ('MANUAL', 'LIQUIDITY_API_A', 'LIQUIDITY_API_B', 'CUSTOM')),
    mode                VARCHAR(16) NOT NULL DEFAULT 'MANUAL' CHECK (mode IN ('MANUAL', 'SANDBOX', 'LIVE')),
    api_key_enc         TEXT,
    api_secret_enc      TEXT,
    passphrase_enc      TEXT,
    custom_base_url     TEXT,
    default_network     VARCHAR(24) NOT NULL DEFAULT 'TRC20',
    network_fee_usd     NUMERIC(10, 2) NOT NULL DEFAULT 1.20,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. NEWS ITEMS
CREATE TABLE IF NOT EXISTS news_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    headline            VARCHAR(240) NOT NULL,
    summary             TEXT NOT NULL,
    category            VARCHAR(40) NOT NULL DEFAULT 'MARKETS',
    source_name         VARCHAR(80) NOT NULL,
    source_url          TEXT,
    published_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. PASSWORD RESETS
CREATE TABLE IF NOT EXISTS password_resets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash          TEXT NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    used_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON password_resets(user_id, expires_at DESC);

-- 13. EMAIL LOGS
CREATE TABLE IF NOT EXISTS email_logs (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    recipient_email     VARCHAR(255) NOT NULL,
    template_type       VARCHAR(40) NOT NULL CHECK (template_type IN (
                            'WELCOME', 'DAILY_PAYOUT_GWC', 'BOT_AUTO_RENEWAL',
                            'DEPOSIT_STATUS', 'WITHDRAWAL_STATUS', 'FORGOT_PASSWORD'
                        )),
    subject             VARCHAR(200) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'SENT' CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'LOGGED_NO_SMTP')),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 14. AUDIT LOGS
CREATE TABLE IF NOT EXISTS audit_logs (
    id                  BIGSERIAL PRIMARY KEY,
    actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_role          VARCHAR(20) NOT NULL,
    action              VARCHAR(80) NOT NULL,
    target_entity       VARCHAR(60),
    target_id           VARCHAR(64),
    ip_address          INET,
    user_agent          TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);

-- 15. SUPPORT TICKETS (User Panel <-> Control Console Live Support Desk)
CREATE TABLE IF NOT EXISTS support_tickets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_ref          VARCHAR(24) NOT NULL UNIQUE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category            VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
    subject             VARCHAR(180) NOT NULL,
    message             TEXT NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED')),
    operator_reply      TEXT,
    replied_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON support_tickets(user_id, status, created_at DESC);
