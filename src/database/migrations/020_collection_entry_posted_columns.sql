-- Migration 020: Add posted_at tracking to collection_entry for automatic product ledger integration

ALTER TABLE collection_entry ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;
ALTER TABLE collection_entry ADD COLUMN IF NOT EXISTS posted_reference TEXT;

CREATE INDEX IF NOT EXISTS idx_collection_posted ON collection_entry(posted_at) WHERE NOT is_deleted;
