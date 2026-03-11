#!/bin/bash
set -e

echo "🔧 Running Migration"

DB_HOST=localhost
DB_PORT=5432
DB_NAME=trading_db

echo "💾 Creating backup..."
BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"

sudo -u postgres pg_dump -h $DB_HOST -p $DB_PORT -d $DB_NAME > "$BACKUP_FILE"

echo "🚀 Running migration..."
sudo -u postgres psql -v ON_ERROR_STOP=1 -h $DB_HOST -p $DB_PORT -d $DB_NAME -f data/migration_add_pending_status.sql

echo "✅ Migration completed!"
