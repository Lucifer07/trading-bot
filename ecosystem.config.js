module.exports = {
  apps: [
    {
      name: 'trading-bot',
      script: './src/index.js',
      cwd: '/home/jayz/code/pribadi/trade/trading-bot',
      
      // Instance management
      instances: 1,
      autorestart: true,          // Auto-restart on crash
      watch: false,               // Don't watch for file changes
      
      // Memory management
      max_memory_restart: '500M', // Restart if memory exceeds 500MB
      
      // Environment variables
      env: {
        NODE_ENV: 'production',
        TRADING_ENABLED: 'true',
        PAPER_TRADING: 'false',
      },
      
      // Logging
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
      
      // Restart behavior
      restart_delay: 5000,        // Wait 5s before restart
      min_uptime: 10000,         // Consider app up if running for 10s
      max_restarts: 10,          // Max restarts per hour
      exp_backoff_restart_delay: 100,
      
      // Process management
      kill_timeout: 5000,        // Wait 5s before force kill
      wait_ready: true,
      listen_timeout: 10000,
      
      // PM2 plus features (if available)
      pm2: true,
    }
  ]
};