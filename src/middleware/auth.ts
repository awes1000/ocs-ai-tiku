import type { NextFunction, Request, Response } from 'express';
import { getDb, type UserRow } from '../db';
import { env } from '../env';
import { nowSec, randomToken, safeEqual, sha256 } from '../utils';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      apiUser?: UserRow | null;
      sessionToken?: string;
    }
  }
}

export const SESSION_COOKIE = 'tiku_session';
export const SESSION_TTL = 7 * 24 * 3600; // 7 天

/* ---------------------------- 搜题 API 鉴权 ---------------------------- */

/** 从 query / body / header 中提取 token */
export function extractApiToken(req: Request): string {
  const q = req.query?.token;
  if (typeof q === 'string' && q) return q;
  const b = (req.body as any)?.token;
  if (typeof b === 'string' && b) return b;
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/iu);
  if (m) return m[1].trim();
  const alt = req.get('x-token');
  if (alt) return alt;
  return '';
}

/**
 * 搜题接口鉴权：token 有效则挂载 apiUser；
 * 未提供 token 且允许匿名时放行（apiUser = null）；否则 401。
 */
export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractApiToken(req);
  if (!token) {
    if (env.ALLOW_ANONYMOUS) {
      req.apiUser = null;
      next();
      return;
    }
    res.status(401).json({ code: 0, msg: '缺少 token 参数' });
    return;
  }
  const row = getDb().prepare(`SELECT * FROM users WHERE token=?`).get(token) as UserRow | undefined;
  if (!row || !safeEqual(row.token, token)) {
    res.status(401).json({ code: 0, msg: 'token 无效' });
    return;
  }
  if (row.status !== 'active') {
    res.status(403).json({ code: 0, msg: '账号已被停用' });
    return;
  }
  req.apiUser = row;
  next();
}

/* ---------------------------- WebGUI 鉴权 ---------------------------- */

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function setSessionCookie(res: Response, token: string, maxAgeSec = SESSION_TTL): void {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function createSession(userId: number, userAgent: string): string {
  const token = randomToken(32);
  const now = nowSec();
  const db = getDb();
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  // 数据库只存 token 的哈希，泄露 DB 也无法直接冒用会话
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at, user_agent) VALUES (?,?,?,?,?)`).run(
    sha256(token),
    userId,
    now + SESSION_TTL,
    now,
    userAgent.slice(0, 200),
  );
  return token;
}

export function destroySession(token: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE token=?`).run(sha256(token));
  getDb().prepare(`DELETE FROM sessions WHERE token=?`).run(token);
}

export function userFromSession(req: Request): UserRow | null {
  const cookies = parseCookies(req.get('cookie'));
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=? AND s.expires_at > ?`,
    )
    .get(sha256(token), nowSec()) as UserRow | undefined;
  if (row && row.status === 'active') {
    req.sessionToken = token;
    return row;
  }
  return null;
}

/** WebGUI 页面/接口鉴权 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = userFromSession(req);
  if (!user) {
    res.status(401).json({ code: 0, msg: '未登录或会话已过期' });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ code: 0, msg: '未登录' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ code: 0, msg: '需要管理员权限' });
    return;
  }
  next();
}
