const { getDatabase } = require('./src/storage/db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  console.log('🔄 Running migration: Add leverage column to trades table...');
  
  const db = getDatabase();
  
  try {
    const migrationPath = path.join(__dirname, './data/migration_add_leverage.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    await db.query(migrationSQL);
    
    console.log('✅ Migration completed successfully!');
    console.log('   Added "leverage" column to trades table');
    console.log('   Default value: 3');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();