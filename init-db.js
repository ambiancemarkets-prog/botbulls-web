require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env. Paste your free Neon or Supabase PostgreSQL URL first.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8');
    await client.query(schemaSql);

    // Seed Partners Log administrator account (admin / ayaz1104)
    const adminUser = process.env.PARTNERS_LOG_USER || 'admin';
    const adminPass = process.env.PARTNERS_LOG_PASS || 'ayaz1104';
    const hash = await bcrypt.hash(adminPass, 12);

    await client.query(
      `INSERT INTO users (user_code, username, email, full_name, password_hash, role, referral_code)
       VALUES ('BB-PL-0001', $1, 'partners@botbulls.com', 'BotBulls Partners Log', $2, 'ADMIN', 'BBPL0001')
       ON CONFLICT (username) DO NOTHING`,
      [adminUser, hash]
    );

    // Seed default Crypto & INR Payment Gateways
    const gwCount = await client.query('SELECT COUNT(*)::int AS cnt FROM payment_gateways');
    if (gwCount.rows[0].cnt === 0) {
      await client.query(
        `INSERT INTO payment_gateways (name, rail, account_label, network_or_bank, instructions)
         VALUES
           ('USDT (TRC20) Manual QR', 'CRYPTO', 'TY8x9kBotBullsTRC20Wallet7741aPq', 'TRON (TRC20)', 'Send USDT TRC20 and upload payment screenshot + TxHash.'),
           ('INR UPI Instant Transfer', 'INR', 'botbulls.treasury@okaxis', 'UPI / IMPS', 'Pay via UPI and upload 12-digit UTR + screenshot.')`
      );
    }

    console.log('BotBulls PostgreSQL database initialized successfully!');
  } catch (err) {
    console.error('Database init error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

initDatabase();
