// BotBulls (botbulls.com) — PM2 Production Process Manager Config
// Start: pm2 start ecosystem.config.js --env production
// Save across reboots: pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: 'botbulls-app',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
