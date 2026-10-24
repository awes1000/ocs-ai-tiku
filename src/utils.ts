import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '..');

/** 项目根目录下的相对路径 → 绝对路径 */
export function fromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 生成 URL 安全的随机 token */
export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** scrypt 密码哈希，格式：scrypt$<salt hex>$<hash hex> */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [alg, saltHex, hashHex] = stored.split('$');
    if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 恒定时间字符串比较（token 校验用） */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把任意异常转成人话 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
