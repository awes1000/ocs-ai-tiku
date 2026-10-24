import 'dotenv/config';
import path from 'node:path';

function str(key: string, def = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}

function int(key: string, def: number): number {
  const n = Number.parseInt(str(key, ''), 10);
  return Number.isFinite(n) ? n : def;
}

function num(key: string, def: number): number {
  const n = Number.parseFloat(str(key, ''));
  return Number.isFinite(n) ? n : def;
}

function bool(key: string, def: boolean): boolean {
  const v = str(key, '').toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const env = {
  PORT: int('PORT', 8060),
  HOST: str('HOST', '0.0.0.0'),
  DB_PATH: str('DB_PATH', 'data/tiku.db'),
  ADMIN_USERNAME: str('ADMIN_USERNAME', 'admin'),
  ADMIN_PASSWORD: str('ADMIN_PASSWORD', ''),
  AI_BASE_URL: str('AI_BASE_URL', ''),
  AI_API_KEY: str('AI_API_KEY', ''),
  AI_MODEL: str('AI_MODEL', ''),
  AI_API_TYPE: str('AI_API_TYPE', 'chat_completions'),
  AI_TEMPERATURE: num('AI_TEMPERATURE', 0.1),
  AI_MAX_TOKENS: int('AI_MAX_TOKENS', 1024),
  AI_TIMEOUT_MS: int('AI_TIMEOUT_MS', 35000),
  AI_PROXY: str('AI_PROXY', ''),
  ALLOW_ANONYMOUS: bool('ALLOW_ANONYMOUS', false),
};

export const DB_PATH = path.isAbsolute(env.DB_PATH) ? env.DB_PATH : path.join(process.cwd(), env.DB_PATH);
