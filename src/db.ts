import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, env } from './env';
import { ensureDir, hashPassword, nowSec, randomToken } from './utils';

export type DB = Database.Database;

let db: DB | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  token         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  note          TEXT DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  title_norm    TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'single',
  options       TEXT NOT NULL DEFAULT '',
  answer        TEXT NOT NULL DEFAULT '',
  answer_letter TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'ai',
  model         TEXT DEFAULT '',
  hits          INTEGER NOT NULL DEFAULT 0,
  user_id       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_norm ON questions(title_norm, type);
CREATE INDEX IF NOT EXISTS idx_questions_updated ON questions(updated_at DESC);

CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  title       TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  hit         TEXT NOT NULL DEFAULT 'none',
  status      TEXT NOT NULL DEFAULT 'ok',
  message     TEXT DEFAULT '',
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  tokens      INTEGER NOT NULL DEFAULT 0,
  question_id INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_hit ON requests(hit);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  api_key     TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  api_type    TEXT NOT NULL DEFAULT 'chat_completions',
  temperature REAL NOT NULL DEFAULT 0.1,
  max_tokens  INTEGER NOT NULL DEFAULT 1024,
  timeout_ms  INTEGER NOT NULL DEFAULT 35000,
  proxy       TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  extra_headers TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`;

export function getDb(): DB {
  if (db) return db;
  const file = path.resolve(DB_PATH);
  ensureDir(path.dirname(file));
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 轻量迁移：补齐后续版本新增的列 */
function migrate(d: DB): void {
  addColumnIfMissing(d, 'users', 'note', "TEXT DEFAULT ''");
  addColumnIfMissing(d, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(d, 'requests', 'status', "TEXT NOT NULL DEFAULT 'ok'");
  addColumnIfMissing(d, 'requests', 'message', "TEXT DEFAULT ''");
  addColumnIfMissing(d, 'requests', 'question_id', 'INTEGER');
}

function addColumnIfMissing(d: DB, table: string, column: string, ddl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  token: string;
  status: 'active' | 'disabled';
  must_change_password: number;
  note: string;
  created_at: number;
  last_login_at: number | null;
}

export interface QuestionRow {
  id: number;
  title: string;
  title_norm: string;
  type: string;
  options: string;
  answer: string;
  answer_letter: string;
  source: string;
  model: string;
  hits: number;
  user_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProviderRow {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  api_type: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  proxy: string;
  enabled: number;
  priority: number;
  extra_headers: string;
  created_at: number;
  updated_at: number;
}

/**
 * 首次启动创建默认管理员。
 * 用户名/密码优先取 env，密码为空则随机生成并打印（只在创建时出现一次）。
 */
export function ensureAdmin(d: DB): void {
  const count = d.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin'`).get() as { c: number };
  if (count.c > 0) return;

  const username = (env.ADMIN_USERNAME || 'admin').trim();
  const generated = !env.ADMIN_PASSWORD;
  const password = env.ADMIN_PASSWORD || randomToken(9);
  const now = nowSec();
  d.prepare(
    `INSERT INTO users (username, password_hash, role, token, status, must_change_password, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(username, hashPassword(password), 'admin', randomToken(24), 'active', generated ? 1 : 0, '初始管理员', now);

  const user = d.prepare(`SELECT token FROM users WHERE username=?`).get(username) as { token: string };
  const line = '='.repeat(64);
  console.log(`\n${line}`);
  console.log('  已创建初始管理员账号（请登录后立即修改密码）');
  console.log(`  用户名: ${username}`);
  console.log(`  密码  : ${password}`);
  console.log(`  搜题Token: ${user.token}`);
  console.log(`  控制台: http://127.0.0.1:${env.PORT}/`);
  console.log(`${line}\n`);
}
