require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

async function init() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL in .env first.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    await client.query(fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8'));
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ayaz1104', 12);
    await client.query(
      `INSERT INTO users (user_code, username, email, full_name, password_hash, role, referral_code)
       VALUES ('BB-ADM-0001', $1, 'admin@botbulls.com', 'BotBulls Admin', $2, 'ADMIN', 'BBADM001')
       ON CONFLICT (username) DO NOTHING`,
      [process.env.ADMIN_USERNAME || 'admin', hash]
    );
    const milestones = [
      ['M1', 'Wrist Watch', 100000, '₹1 Lakh Business Milestone', 1],
      ['M2', 'Mobile Phone', 300000, '₹3 Lakh Business Milestone', 2],
      ['M3', 'Thailand Tour (2 Nights / 3 Days)', 500000, '₹5 Lakh Business Milestone', 3],
      ['M4', 'Dubai Tour (3 Nights / 4 Days)', 1000000, '₹10 Lakh Business Milestone', 4],
      ['M5', 'Honda Shine Bike', 2000000, '₹20 Lakh Business Milestone', 5],
      ['M6', 'Bike + Refrigerator', 4000000, '₹40 Lakh Business Milestone', 6],
      ['M7', 'Car', 10000000, '₹1 Crore Business Milestone', 7],
    ];
    for (const [code, title, target, desc, ord] of milestones) {
      await client.query(
        `INSERT INTO rewards_milestones (code, title, target_business_inr, description, sort_order)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING`,
        [code, title, target, desc, ord]
      );
    }
    console.log('BotBulls v2.0 database initialized cleanly!');
  } finally {
    client.release();
    await pool.end();
  }
}
init();
