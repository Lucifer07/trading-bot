require('dotenv').config();
const { Pool } = require('pg');
const logger = require('./src/utils/logger');
const { config } = require('./src/config');

async function runMigration() {
  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
  });

  try {
    logger.info('🔧 Running migration: Add exit_reason column');

    // Connect to database
    await pool.connect();
    logger.info('✅ Connected to database');

    // Add exit_reason column
    const addColumnQuery = `
      ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS exit_reason TEXT;
    `;

    await pool.query(addColumnQuery);
    logger.info('✅ Added exit_reason column to trades table');

    // Add comment
    const commentQuery = `
      COMMENT ON COLUMN trades.exit_reason IS 'Reason for trade exit or failure (e.g., Stop Loss, Take Profit, Orphan trade)';
    `;

    await pool.query(commentQuery);
    logger.info('✅ Added comment to exit_reason column');

    // Create index
    const indexQuery = `
      CREATE INDEX IF NOT EXISTS idx_trades_exit_reason
      ON trades(exit_reason) WHERE exit_reason IS NOT NULL;
    `;

    await pool.query(indexQuery);
    logger.info('✅ Created index for exit_reason column');

    logger.info('🎉 Migration completed successfully!');

    // Verify column exists
    const checkQuery = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'trades' AND column_name = 'exit_reason';
    `;

    const result = await pool.query(checkQuery);
    if (result.rows.length > 0) {
      logger.info('✅ Verified: exit_reason column exists', {
        column_name: result.rows[0].column_name,
        data_type: result.rows[0].data_type,
      });
    }

  } catch (error) {
    logger.error('❌ Migration failed', { error: error.message, stack: error.stack });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();