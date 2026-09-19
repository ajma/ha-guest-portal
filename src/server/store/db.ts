// src/server/store/db.ts

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exposed_device (
  entity_id       TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS action_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id        INTEGER PRIMARY KEY CHECK (id = 1),
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
  db.exec(SCHEMA)
  return db
}
