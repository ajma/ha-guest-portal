// src/server/store/db.ts

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portal (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  theme      TEXT NOT NULL,
  password   TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exposed_device (
  entity_id       TEXT NOT NULL,
  portal_id       TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (portal_id, entity_id)
);

CREATE TABLE IF NOT EXISTS action_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  role      TEXT NOT NULL,
  ok        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guest_interaction (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  entity_id TEXT,
  label     TEXT,
  action    TEXT,
  ok        INTEGER NOT NULL
);
`

export function openDb(path: string): DatabaseSync {
  // Create parent directories if this is a file path (not :memory:)
  if (path !== ':memory:') {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
  }

  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
