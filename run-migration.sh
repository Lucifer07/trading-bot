#!/bin/bash

# Migration Runner Script
# Usage: ./run-migration.sh

set -e

echo "🔧 Running Migration: Add PENDING and FAILED Status"

# Check if PostgreSQL is running
if ! command -v psql &> /dev/null; then
    echo "❌ psql command not found. Please install PostgreSQL client."
    exit 1
fi

# Load database config from .env if exists
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Use environment variables or defaults
DB_HOST=${POSTGRES_HOST:-localhost}
DB_PORT=${POSTGRES_PORT:-5432}
DB_NAME=${POSTGRES_DB:-trading_db}
DB_USER=${POSTGRES_USER:-trading}

echo ""
echo "📊 Database Configuration:"
echo "   Host: $DB_HOST"
echo "   Port: $DB_PORT"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER"
echo ""

# Prompt for password if not set
if [ -z "$POSTGRES_PASSWORD" ]; then
    read -s -p "Enter database password: " POSTGRES_PASSWORD
    echo ""
    export PGPASSWORD=$POSTGRES_PASSWORD
else
    export PGPASSWORD=$POSTGRES_PASSWORD
fi

# Backup database first
echo "💾 Creating backup..."
BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"
pg_dump -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Backup created: $BACKUP_FILE"
else
    echo "❌ Backup failed. Aborting migration."
    exit 1
fi

# Run migration
echo ""
echo "🚀 Running migration..."
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f data/migration_add_pending_status.sql

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Migration completed successfully!"
    echo ""
    echo "📋 Verification:"
    echo "   Checking for orphan trades..."

    # Check for orphan trades (OPEN but no orders)
    ORPHAN_COUNT=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "
        SELECT COUNT(*) FROM trades t
        LEFT JOIN orders o ON t.trade_id = o.trade_id
        WHERE t.status = 'OPEN'
        AND o.order_id IS NULL;
    " | tr -d ' ')

    echo "   Orphan trades found: $ORPHAN_COUNT"

    if [ "$ORPHAN_COUNT" -gt 0 ]; then
        echo ""
        echo "⚠️  Warning: Found $ORPHAN_COUNT orphan trades!"
        echo "   These trades will be marked as FAILED during migration."
    fi

    echo ""
    echo "✅ Migration complete. You can now start the bot."
else
    echo ""
    echo "❌ Migration failed!"
    echo ""
    echo "🔄 To restore backup:"
    echo "   psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME < $BACKUP_FILE"
    exit 1
fi
