#!/usr/bin/env bash
#
# Markup backup — snapshot the durable state to a timestamped file.
#
# Postgres (DATABASE_URL set): logical dump via pg_dump (custom format, so
#   pg_restore can do selective/parallel restores). This is the production
#   path; pair it with the provider's PITR/WAL archiving for sub-dump RPO
#   (see PHASE2_OPS.md "Backups").
# SQLite (DATABASE_URL unset): online `.backup` of both stores — markup-docs
#   (Yjs state, written by the Hocuspocus SQLite extension) and markup-meta
#   (doc metadata + version history). `.backup` is consistent against a live
#   server; a plain `cp` is not.
#
# Usage:
#   scripts/backup.sh [OUT_DIR]            # OUT_DIR defaults to ./backups
#   MARKUP_DATA_DIR=/var/lib/markup scripts/backup.sh /backups
#
# Restore:
#   Postgres: pg_restore --clean --if-exists -d "$DATABASE_URL" <dump>
#   SQLite:   stop the server, copy the .sqlite files back into MARKUP_DATA_DIR.
set -euo pipefail

OUT_DIR="${1:-backups}"
DATA_DIR="${MARKUP_DATA_DIR:-.}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

if [[ -n "${DATABASE_URL:-}" ]]; then
  command -v pg_dump >/dev/null || { echo "pg_dump not found on PATH" >&2; exit 1; }
  DEST="$OUT_DIR/markup-pg-$STAMP.dump"
  echo "Postgres → $DEST"
  pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$DEST"
  echo "Done. Restore: pg_restore --clean --if-exists -d \"\$DATABASE_URL\" $DEST"
else
  command -v sqlite3 >/dev/null || { echo "sqlite3 not found on PATH" >&2; exit 1; }
  for db in markup-docs markup-meta; do
    SRC="$DATA_DIR/$db.sqlite"
    [[ -f "$SRC" ]] || { echo "skip: $SRC not found"; continue; }
    DEST="$OUT_DIR/$db-$STAMP.sqlite"
    echo "SQLite $SRC → $DEST"
    # .backup takes a consistent snapshot even while the server holds the file.
    sqlite3 "$SRC" ".backup '$DEST'"
  done
  echo "Done. Restore: stop the server, copy the .sqlite files into $DATA_DIR."
fi
