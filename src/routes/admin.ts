import { Router } from 'express';
import { getDb, type ProviderRow, type QuestionRow, type UserRow } from '../db';
import {
  clearSettingCache,
  getSetting,
  listProviders,
  primaryAiConfig,
  rowToConfig,
  runtimeAiConfigs,
  setSetting,
  DEFAULTS,
} from '../config';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireAdmin,
  requireAuth,
  setSessionCookie,
} from '../middleware/auth';
import { testConnection } from '../services/llm';
import { normalizeTitle, normalizeType, splitOptions } from '../services/similarity';
import { upsertQuestion } from '../services/resolver';
import { getTemplate, defaultTemplate, getAllTemplates, ANSWER_SHAPES } from '../services/prompt';
import { resolve, resolveWithAiOnly } from '../services/resolver';
import { errMsg, hashPassword, nowSec, randomToken, verifyPassword } from '../utils';

const router = Router();

/* ============================ 工具 ============================ */

function bad(res: any, msg: string, status = 400): void {
  res.status(status).json({ code: 0, msg });
}

function ok(res: any, data: unknown = {}): void {
  res.json({ code: 1, msg: 'ok', data });
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    token: u.token,
    status: u.status,
    note: u.note ?? '',
    must_change_password: u.must_change_password ?? 0,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

/* ============================ 认证 ============================ */

router.post('/auth/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!username || !password) return bad(res, '请输入用户名和密码');

  const db = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE username=?`).get(username) as UserRow | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return bad(res, '用户名或密码错误', 401);
  }
  if (user.status !== 'active') return bad(res, '账号已被停用', 403);

  const token = createSession(user.id, String(req.get('user-agent') ?? ''));
  setSessionCookie(res, token);
  db.prepare(`UPDATE users SET last_login_at=? WHERE id=?`).run(nowSec(), user.id);
  ok(res, { user: publicUser(user) });
});

router.post('/auth/logout', requireAuth, (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  clearSessionCookie(res);
  ok(res);
});

router.get('/auth/me', requireAuth, (req, res) => {
  ok(res, { user: publicUser(req.user!) });
});

router.post('/auth/password', requireAuth, (req, res) => {
  const oldPassword = String(req.body?.old_password ?? '');
  const newPassword = String(req.body?.new_password ?? '');
  if (newPassword.length < 6) return bad(res, '新密码至少 6 位');
  const user = req.user!;
  if (!verifyPassword(oldPassword, user.password_hash)) return bad(res, '原密码错误');
  getDb()
    .prepare(`UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?`)
    .run(hashPassword(newPassword), user.id);
  ok(res);
});

/* ============================ 用户管理（admin） ============================ */

router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  const rows = getDb().prepare(`SELECT * FROM users ORDER BY id ASC`).all() as UserRow[];
  ok(res, { users: rows.map(publicUser) });
});

router.post('/users', requireAuth, requireAdmin, (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  if (!/^[\w.@-]{2,32}$/u.test(username)) return bad(res, '用户名需为 2-32 位字母/数字/下划线');
  if (password.length < 6) return bad(res, '密码至少 6 位');

  const db = getDb();
  const exists = db.prepare(`SELECT id FROM users WHERE username=?`).get(username);
  if (exists) return bad(res, '用户名已存在');

  const now = nowSec();
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, token, status, must_change_password, note, created_at)
       VALUES (?,?,?,?, 'active', 0, ?, ?)`,
    )
    .run(username, hashPassword(password), role, randomToken(24), String(req.body?.note ?? ''), now);
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(info.lastInsertRowid) as UserRow;
  ok(res, { user: publicUser(user) });
});

router.patch('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(id) as UserRow | undefined;
  if (!user) return bad(res, '用户不存在', 404);

  const sets: string[] = [];
  const args: unknown[] = [];

  if (req.body?.password) {
    const pw = String(req.body.password);
    if (pw.length < 6) return bad(res, '密码至少 6 位');
    sets.push('password_hash=?');
    args.push(hashPassword(pw));
  }
  if (req.body?.role) {
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    // 不允许把最后一个管理员降级
    if (user.role === 'admin' && role !== 'admin') {
      const c = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'`).get() as { c: number };
      if (c.c <= 1) return bad(res, '不能降级最后一个管理员');
    }
    sets.push('role=?');
    args.push(role);
  }
  if (req.body?.status) {
    const status = req.body.status === 'disabled' ? 'disabled' : 'active';
    if (user.role === 'admin' && status === 'disabled') {
      const c = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin' AND status='active'`).get() as { c: number };
      if (c.c <= 1) return bad(res, '不能停用最后一个管理员');
    }
    sets.push('status=?');
    args.push(status);
  }
  if (req.body?.note !== undefined) {
    sets.push('note=?');
    args.push(String(req.body.note).slice(0, 200));
  }
  if (req.body?.regenerate_token) {
    sets.push('token=?');
    args.push(randomToken(24));
  }

  if (sets.length === 0) return bad(res, '没有需要更新的字段');
  args.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...(args as any[]));
  const updated = db.prepare(`SELECT * FROM users WHERE id=?`).get(id) as UserRow;
  ok(res, { user: publicUser(updated) });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return bad(res, '不能删除自己');
  const db = getDb();
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(id) as UserRow | undefined;
  if (!user) return bad(res, '用户不存在', 404);
  if (user.role === 'admin') {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role='admin'`).get() as { c: number };
    if (c.c <= 1) return bad(res, '不能删除最后一个管理员');
  }
  db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(id);
  db.prepare(`DELETE FROM users WHERE id=?`).run(id);
  ok(res);
});

/* ============================ 题库管理 ============================ */

router.get('/questions', requireAuth, (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(String(req.query.page_size ?? '20'), 10) || 20));
  const keyword = String(req.query.keyword ?? '').trim();
  const type = String(req.query.type ?? '').trim();
  const source = String(req.query.source ?? '').trim();

  const where: string[] = [];
  const args: unknown[] = [];
  if (keyword) {
    where.push('(title LIKE ? OR answer LIKE ? OR title_norm LIKE ?)');
    const k = `%${keyword}%`;
    args.push(k, k, `%${normalizeTitle(keyword)}%`);
  }
  if (type) {
    where.push('type=?');
    args.push(type);
  }
  if (source) {
    where.push('source=?');
    args.push(source);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM questions ${clause}`).get(...(args as any[])) as { c: number }).c;
  const rows = db
    .prepare(`SELECT * FROM questions ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...(args as any[]), pageSize, (page - 1) * pageSize) as QuestionRow[];
  ok(res, { total, page, page_size: pageSize, questions: rows });
});

router.post('/questions', requireAuth, (req, res) => {
  const title = String(req.body?.title ?? '').trim();
  if (!title) return bad(res, '题目不能为空');
  const type = normalizeType(req.body?.type);
  const options = splitOptions(req.body?.options);
  const answer = String(req.body?.answer ?? '').trim();
  const letter = String(req.body?.answer_letter ?? '').trim().toUpperCase();
  const id = upsertQuestion({
    title,
    type,
    options,
    answer,
    letter,
    model: '',
    source: 'manual',
    userId: req.user!.id,
  });
  const row = getDb().prepare(`SELECT * FROM questions WHERE id=?`).get(id) as QuestionRow;
  ok(res, { question: row });
});

router.patch('/questions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const row = db.prepare(`SELECT * FROM questions WHERE id=?`).get(id) as QuestionRow | undefined;
  if (!row) return bad(res, '题目不存在', 404);

  const title = req.body?.title !== undefined ? String(req.body.title).trim() : row.title;
  if (!title) return bad(res, '题目不能为空');
  const type = req.body?.type !== undefined ? normalizeType(req.body.type) : row.type;
  const options =
    req.body?.options !== undefined
      ? splitOptions(req.body.options)
      : splitOptions(row.options);
  const answer = req.body?.answer !== undefined ? String(req.body.answer).trim() : row.answer;
  const letter =
    req.body?.answer_letter !== undefined ? String(req.body.answer_letter).trim().toUpperCase() : row.answer_letter;

  db.prepare(
    `UPDATE questions SET title=?, title_norm=?, type=?, options=?, answer=?, answer_letter=?, updated_at=? WHERE id=?`,
  ).run(title, normalizeTitle(title), type, options.join('\n'), answer, letter, nowSec(), id);
  ok(res, { question: db.prepare(`SELECT * FROM questions WHERE id=?`).get(id) });
});

router.delete('/questions/:id', requireAuth, (req, res) => {
  const info = getDb().prepare(`DELETE FROM questions WHERE id=?`).run(Number(req.params.id));
  if (info.changes === 0) return bad(res, '题目不存在', 404);
  ok(res);
});

/** 批量删除 */
router.post('/questions/delete', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return bad(res, '请选择要删除的题目');
  const db = getDb();
  const del = db.prepare(`DELETE FROM questions WHERE id=?`);
  const tx = db.transaction((list: number[]) => list.forEach((id) => del.run(id)));
  tx(ids);
  ok(res, { deleted: ids.length });
});

/** 导出题库 */
router.get('/questions/export', requireAuth, (req, res) => {
  const format = String(req.query.format ?? 'json').toLowerCase();
  const rows = getDb().prepare(`SELECT * FROM questions ORDER BY id ASC`).all() as QuestionRow[];
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/gu, '""')}"`;
    const header = ['id', 'title', 'type', 'options', 'answer', 'answer_letter', 'source', 'model', 'hits', 'created_at'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          esc(r.title),
          r.type,
          esc(r.options),
          esc(r.answer),
          r.answer_letter,
          r.source,
          esc(r.model),
          r.hits,
          new Date(r.created_at * 1000).toISOString(),
        ].join(','),
      );
    }
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="tiku-${stamp}.csv"`);
    res.send('\ufeff' + lines.join('\r\n'));
    return;
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="tiku-${stamp}.json"`);
  res.send(JSON.stringify({ exported_at: nowSec(), count: rows.length, questions: rows }, null, 2));
});

/** 导入题库：JSON 数组 / {questions:[...]} / CSV */
router.post('/questions/import', requireAuth, (req, res) => {
  const payload = req.body?.data;
  const overwrite = Boolean(req.body?.overwrite);
  let items: any[] = [];

  if (Array.isArray(payload)) items = payload;
  else if (payload && Array.isArray(payload.questions)) items = payload.questions;
  else if (typeof payload === 'string') {
    const text = payload.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.questions) ? parsed.questions : [];
      } catch (err) {
        return bad(res, `JSON 解析失败：${errMsg(err)}`);
      }
    } else {
      items = parseCsv(text);
    }
  }
  if (!items.length) return bad(res, '没有可导入的数据');

  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const existing = db.prepare(`SELECT id FROM questions WHERE title_norm=? AND type=?`);
  const tx = db.transaction(() => {
    for (const raw of items) {
      const title = String(raw?.title ?? raw?.question ?? raw?.q ?? '').trim();
      if (!title) {
        skipped++;
        continue;
      }
      const type = normalizeType(raw?.type ?? 'single');
      const options = splitOptions(raw?.options ?? '');
      const answer = String(raw?.answer ?? raw?.a ?? '').trim();
      const letter = String(raw?.answer_letter ?? raw?.letter ?? '').trim().toUpperCase();
      const norm = normalizeTitle(title);
      const found = existing.get(norm, type) as { id: number } | undefined;
      if (found && !overwrite) {
        skipped++;
        continue;
      }
      upsertQuestion({ title, type, options, answer, letter, model: '', source: 'import', userId: req.user!.id });
      imported++;
    }
  });
  tx();
  ok(res, { imported, skipped, total: items.length });
});

function parseCsv(text: string): any[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iTitle = idx('title') >= 0 ? idx('title') : idx('question');
  const iType = idx('type');
  const iOptions = idx('options');
  const iAnswer = idx('answer');
  const iLetter = idx('answer_letter') >= 0 ? idx('answer_letter') : idx('letter');
  return rows.slice(1).map((r) => ({
    title: iTitle >= 0 ? r[iTitle] : r[0],
    type: iType >= 0 ? r[iType] : 'single',
    options: iOptions >= 0 ? r[iOptions] : '',
    answer: iAnswer >= 0 ? r[iAnswer] : '',
    answer_letter: iLetter >= 0 ? r[iLetter] : '',
  }));
}

/* ============================ 日志 & 统计 ============================ */

router.get('/logs', requireAuth, (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, Number.parseInt(String(req.query.page_size ?? '30'), 10) || 30));
  const hit = String(req.query.hit ?? '').trim();
  const userId = Number.parseInt(String(req.query.user_id ?? ''), 10);
  const keyword = String(req.query.keyword ?? '').trim();

  const where: string[] = [];
  const args: unknown[] = [];
  if (hit) {
    where.push('r.hit=?');
    args.push(hit);
  }
  if (Number.isFinite(userId)) {
    where.push('r.user_id=?');
    args.push(userId);
  }
  if (keyword) {
    where.push('r.title LIKE ?');
    args.push(`%${keyword}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM requests r ${clause}`).get(...(args as any[])) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT r.*, u.username FROM requests r LEFT JOIN users u ON u.id=r.user_id
       ${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...(args as any[]), pageSize, (page - 1) * pageSize);
  ok(res, { total, page, page_size: pageSize, logs: rows });
});

router.delete('/logs', requireAuth, requireAdmin, (req, res) => {
  const days = Number.parseInt(String(req.query.older_than_days ?? ''), 10);
  const db = getDb();
  if (Number.isFinite(days) && days > 0) {
    const cutoff = nowSec() - days * 86400;
    const info = db.prepare(`DELETE FROM requests WHERE created_at < ?`).run(cutoff);
    return ok(res, { deleted: info.changes });
  }
  const info = db.prepare(`DELETE FROM requests`).run();
  ok(res, { deleted: info.changes });
});

router.get('/stats', requireAuth, (req, res) => {
  const db = getDb();
  const dayAgo = nowSec() - 86400;
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM requests`).get() as { c: number }).c;
  const last24 = (
    db.prepare(`SELECT COUNT(*) AS c FROM requests WHERE created_at >= ?`).get(dayAgo) as { c: number }
  ).c;
  const byHit = db
    .prepare(`SELECT hit, COUNT(*) AS c FROM requests GROUP BY hit`)
    .all() as { hit: string; c: number }[];
  const quota = (db.prepare(`SELECT COUNT(*) AS c FROM questions`).get() as { c: number }).c;
  const tokens = (db.prepare(`SELECT COALESCE(SUM(tokens),0) AS t FROM requests`).get() as { t: number }).t;
  const tokens24 = (
    db.prepare(`SELECT COALESCE(SUM(tokens),0) AS t FROM requests WHERE created_at >= ?`).get(dayAgo) as { t: number }
  ).t;
  const avgLatency = (
    db.prepare(`SELECT COALESCE(AVG(latency_ms),0) AS a FROM requests WHERE created_at >= ?`).get(dayAgo) as {
      a: number;
    }
  ).a;
  const users = (db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c;

  // 近 24h 按小时分布
  const hourly: { hour: string; total: number; cache: number; ai: number }[] = [];
  const baseHour = new Date();
  baseHour.setMinutes(0, 0, 0);
  for (let i = 23; i >= 0; i--) {
    const start = Math.floor(baseHour.getTime() / 1000) - i * 3600;
    const end = start + 3600;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN hit IN ('cache','fuzzy') THEN 1 ELSE 0 END) AS cache,
                SUM(CASE WHEN hit='ai' THEN 1 ELSE 0 END) AS ai
         FROM requests WHERE created_at >= ? AND created_at < ?`,
      )
      .get(start, end) as { total: number; cache: number | null; ai: number | null };
    hourly.push({
      hour: new Date(start * 1000).toISOString().slice(11, 16),
      total: row.total ?? 0,
      cache: row.cache ?? 0,
      ai: row.ai ?? 0,
    });
  }

  // Top 用户
  const topUsers = db
    .prepare(
      `SELECT u.username, COUNT(r.id) AS c FROM requests r JOIN users u ON u.id=r.user_id
       WHERE r.created_at >= ? GROUP BY r.user_id ORDER BY c DESC LIMIT 5`,
    )
    .all(dayAgo) as { username: string; c: number }[];

  const hitMap: Record<string, number> = { cache: 0, fuzzy: 0, ai: 0, none: 0 };
  for (const row of byHit) hitMap[row.hit] = row.c;

  ok(res, {
    totals: {
      requests: total,
      requests_24h: last24,
      questions: quota,
      tokens,
      tokens_24h: tokens24,
      avg_latency_ms: Math.round(avgLatency),
      users,
      hit_map: hitMap,
      hit_rate: total ? Number((((hitMap.cache + hitMap.fuzzy) / total) * 100).toFixed(1)) : 0,
    },
    hourly,
    top_users: topUsers,
    ai_configured: runtimeAiConfigs().length > 0,
  });
});

/* ============================ 设置 ============================ */

router.get('/settings', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (map[k] === undefined) map[k] = String(v);
  }
  ok(res, {
    settings: map,
    templates: getAllTemplates(),
    defaults_templates: {
      single: defaultTemplate('single'),
      multiple: defaultTemplate('multiple'),
      judgement: defaultTemplate('judgement'),
      completion: defaultTemplate('completion'),
      unknown: defaultTemplate('unknown'),
    },
    answer_shapes: ANSWER_SHAPES,
  });
});

router.put('/settings', requireAuth, requireAdmin, (req, res) => {
  const incoming = req.body?.settings ?? req.body ?? {};
  const allowed = new Set([
    ...Object.keys(DEFAULTS),
    'public_base_url',
    'site_name',
    'prompt_system',
    'prompt_single',
    'prompt_multiple',
    'prompt_judgement',
    'prompt_completion',
    'prompt_unknown',
  ]);
  let count = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (!allowed.has(k)) continue;
    setSetting(k, String(v ?? ''));
    count++;
  }
  ok(res, { updated: count });
});

/** 恢复默认提示词 */
router.post('/settings/prompt-reset', requireAuth, requireAdmin, (req, res) => {
  const type = String(req.body?.type ?? '');
  const types = ['single', 'multiple', 'judgement', 'completion', 'unknown'];
  if (type && types.includes(type)) {
    setSetting(`prompt_${type}`, '');
  } else {
    for (const t of types) setSetting(`prompt_${t}`, '');
    setSetting('prompt_system', '');
  }
  clearSettingCache();
  ok(res, { templates: getAllTemplates() });
});

/* ============================ AI 提供商 ============================ */

function ppublic(p: ProviderRow, maskKey = true) {
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    api_key: maskKey && p.api_key ? `${p.api_key.slice(0, 4)}****${p.api_key.slice(-4)}` : p.api_key,
    has_key: Boolean(p.api_key),
    model: p.model,
    api_type: p.api_type,
    temperature: p.temperature,
    max_tokens: p.max_tokens,
    timeout_ms: p.timeout_ms,
    proxy: p.proxy,
    enabled: p.enabled,
    priority: p.priority,
    extra_headers: p.extra_headers,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

router.get('/providers', requireAuth, (_req, res) => {
  ok(res, { providers: listProviders().map((p) => ppublic(p)) });
});

function providerPayload(body: any, existing?: ProviderRow) {
  const base_url = String(body?.base_url ?? existing?.base_url ?? '').trim();
  const model = String(body?.model ?? existing?.model ?? '').trim();
  if (!base_url) throw new Error('请填写 base_url');
  if (!model) throw new Error('请填写模型名');
  const apiKey = body?.api_key === undefined || body?.api_key === '' ? existing?.api_key ?? '' : String(body.api_key);
  return {
    name: String(body?.name ?? existing?.name ?? '未命名').trim() || '未命名',
    base_url,
    api_key: apiKey,
    model,
    api_type: body?.api_type === 'responses' ? 'responses' : 'chat_completions',
    temperature: Number.isFinite(Number(body?.temperature)) ? Number(body.temperature) : existing?.temperature ?? 0.1,
    max_tokens: Number.isFinite(Number(body?.max_tokens)) ? Math.round(Number(body.max_tokens)) : existing?.max_tokens ?? 1024,
    timeout_ms: Number.isFinite(Number(body?.timeout_ms)) ? Math.round(Number(body.timeout_ms)) : existing?.timeout_ms ?? 35000,
    proxy: String(body?.proxy ?? existing?.proxy ?? '').trim(),
    enabled: body?.enabled === undefined ? existing?.enabled ?? 1 : body.enabled ? 1 : 0,
    priority: Number.isFinite(Number(body?.priority)) ? Math.round(Number(body.priority)) : existing?.priority ?? 0,
    extra_headers:
      body?.extra_headers === undefined ? existing?.extra_headers ?? '' : String(body.extra_headers ?? ''),
  };
}

router.post('/providers', requireAuth, requireAdmin, (req, res) => {
  try {
    const p = providerPayload(req.body);
    const now = nowSec();
    const info = getDb()
      .prepare(
        `INSERT INTO providers (name, base_url, api_key, model, api_type, temperature, max_tokens, timeout_ms, proxy, enabled, priority, extra_headers, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.name,
        p.base_url,
        p.api_key,
        p.model,
        p.api_type,
        p.temperature,
        p.max_tokens,
        p.timeout_ms,
        p.proxy,
        p.enabled,
        p.priority,
        p.extra_headers,
        now,
        now,
      );
    const row = getDb().prepare(`SELECT * FROM providers WHERE id=?`).get(info.lastInsertRowid) as ProviderRow;
    ok(res, { provider: ppublic(row) });
  } catch (err) {
    bad(res, errMsg(err));
  }
});

router.patch('/providers/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM providers WHERE id=?`).get(id) as ProviderRow | undefined;
  if (!existing) return bad(res, '提供商不存在', 404);
  try {
    const p = providerPayload(req.body, existing);
    db.prepare(
      `UPDATE providers SET name=?, base_url=?, api_key=?, model=?, api_type=?, temperature=?, max_tokens=?, timeout_ms=?, proxy=?, enabled=?, priority=?, extra_headers=?, updated_at=? WHERE id=?`,
    ).run(
      p.name,
      p.base_url,
      p.api_key,
      p.model,
      p.api_type,
      p.temperature,
      p.max_tokens,
      p.timeout_ms,
      p.proxy,
      p.enabled,
      p.priority,
      p.extra_headers,
      nowSec(),
      id,
    );
    const row = db.prepare(`SELECT * FROM providers WHERE id=?`).get(id) as ProviderRow;
    ok(res, { provider: ppublic(row) });
  } catch (err) {
    bad(res, errMsg(err));
  }
});

router.delete('/providers/:id', requireAuth, requireAdmin, (req, res) => {
  const info = getDb().prepare(`DELETE FROM providers WHERE id=?`).run(Number(req.params.id));
  if (info.changes === 0) return bad(res, '提供商不存在', 404);
  ok(res);
});

/** 测试连接：不传 id 时测试请求体里的配置（允许未保存直接试） */
router.post('/providers/test', requireAuth, requireAdmin, async (req, res) => {
  let config;
  const id = Number.parseInt(String(req.query.id ?? req.body?.id ?? ''), 10);
  if (Number.isFinite(id)) {
    const row = getDb().prepare(`SELECT * FROM providers WHERE id=?`).get(id) as ProviderRow | undefined;
    if (!row) return bad(res, '提供商不存在', 404);
    config = rowToConfig(row);
  } else if (req.body?.base_url && req.body?.model) {
    const p = providerPayload(req.body);
    config = rowToConfig({ ...(p as any), id: 0, created_at: 0, updated_at: 0 } as ProviderRow);
  } else {
    config = primaryAiConfig();
    if (!config) return bad(res, '尚未配置任何 AI 提供商');
  }
  const result = await testConnection(config);
  ok(res, result);
});

/* ============================ 在线测试台 ============================ */

router.post('/debug/solve', requireAuth, async (req, res) => {
  const useCache = Boolean(req.body?.use_cache);
  const title = String(req.body?.title ?? '').trim();
  const type = normalizeType(req.body?.type);
  const options = String(req.body?.options ?? '');
  if (!title) return bad(res, '请输入题目');

  if (useCache) {
    const out = await resolve({ title, type, options, userId: req.user!.id });
    return ok(res, out);
  }
  const out = await resolveWithAiOnly({ title, type, options, userId: req.user!.id });
  ok(res, out);
});

/* ============================ 接入向导 ============================ */

export function buildAnswererWrapper(baseUrl: string, token: string, opts?: { name?: string }) {
  const api = `${baseUrl.replace(/\/+$/, '')}/search`;
  const name = opts?.name || 'OCS AI 题库';
  return {
    name,
    type: 'GM_xmlhttpRequest',
    method: 'post',
    url: api,
    contentType: 'json',
    headers: { 'Content-Type': 'application/json' },
    data: {
      title: '${title}',
      type: '${type}',
      options: '${options}',
      token,
    },
    handler:
      "return (res) => { try { if (res && typeof res === 'string') res = JSON.parse(res); } catch (e) { return [String(res), undefined]; } if (res && res.code === 1 && res.data && Array.isArray(res.data.results) && res.data.results.length) return res.data.results; return [(res && res.msg && res.code !== 1 ? res.msg : '未找到答案'), undefined]; }",
  };
}

router.get('/wizard', requireAuth, (req, res) => {
  const base = String(req.query.base_url ?? '').trim().replace(/\/+$/, '');
  const tokenParam = String(req.query.token ?? '').trim();
  const user = tokenParam
    ? (getDb().prepare(`SELECT * FROM users WHERE token=?`).get(tokenParam) as UserRow | undefined)
    : req.user!;
  if (!user) return bad(res, 'token 无效', 404);
  const fallback = `${req.protocol}://${req.get('host')}`;
  const baseUrl = base || getSetting('public_base_url') || fallback;
  const wrapper = buildAnswererWrapper(baseUrl, user.token, { name: `OCS AI 题库（${user.username}）` });
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return '<你的服务器域名>';
    }
  })();
  ok(res, {
    base_url: baseUrl,
    username: user.username,
    token: user.token,
    answerer_wrapper: wrapper,
    json: JSON.stringify(wrapper, null, 2),
    connect_hint: `// @connect ${host}\n// @connect *`,
    curl: `curl -X POST '${baseUrl}/search' -H 'Content-Type: application/json' -d '{"title":"1+1=?","type":"single","options":"A.1\\nB.2\\nC.3","token":"${user.token}"}'`,
  });
});

/* ============================ 数据库备份 ============================ */

router.post('/backup', requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  try {
    const tables = ['users', 'questions', 'requests', 'settings', 'providers'];
    const dump: Record<string, unknown[]> = {};
    for (const t of tables) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
    if (Array.isArray(dump.users)) {
      dump.users = (dump.users as any[]).map((u) => ({
        ...u,
        password_hash: '<redacted>',
        token: '<redacted>',
      }));
    }
    if (Array.isArray(dump.providers)) {
      dump.providers = (dump.providers as any[]).map((p) => ({ ...p, api_key: '<redacted>' }));
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/gu, '-');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="tiku-backup-${stamp}.json"`);
    res.send(JSON.stringify({ exported_at: nowSec(), dump }, null, 2));
  } catch (err) {
    bad(res, errMsg(err), 500);
  }
});

export default router;
