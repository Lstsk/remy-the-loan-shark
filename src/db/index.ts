import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema.ts'

const databaseUrl = process.env.REMY_DATABASE_URL ?? 'data/remy.sqlite'
mkdirSync(dirname(databaseUrl), { recursive: true })

export const sqlite = new Database(databaseUrl)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

export function ensureDatabase(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      phone TEXT,
      preferred_payout_method TEXT,
      payout_handle TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      display_name TEXT NOT NULL,
      phone TEXT,
      imessage_handle TEXT,
      preferred_payout_method TEXT,
      payout_handle TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS contacts_owner_phone_idx
      ON contacts(owner_user_id, phone);

    CREATE TABLE IF NOT EXISTS contact_aliases (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS contact_aliases_owner_alias_idx
      ON contact_aliases(owner_user_id, normalized_alias);

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      payer_name TEXT NOT NULL,
      title TEXT NOT NULL,
      total REAL NOT NULL,
      split_mode TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expense_participants (
      id TEXT PRIMARY KEY,
      expense_id TEXT NOT NULL REFERENCES expenses(id),
      contact_id TEXT REFERENCES contacts(id),
      display_name TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY,
      expense_id TEXT NOT NULL REFERENCES expenses(id),
      participant_id TEXT NOT NULL REFERENCES expense_participants(id),
      contact_id TEXT REFERENCES contacts(id),
      friend_name TEXT NOT NULL,
      amount REAL NOT NULL,
      url TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      reminder_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      current_expense_id TEXT REFERENCES expenses(id),
      last_message TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS conversation_state_owner_idx
      ON conversation_state(owner_user_id);
  `)
}
