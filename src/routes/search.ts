import { Router } from 'express';
import { apiAuth } from '../middleware/auth';
import { logRequest, resolve, resolveWithAiOnly, type ResolveOutput } from '../services/resolver';
import { errMsg } from '../utils';
import { settingNumber } from '../config';

const router = Router();

/** 简易滑动窗口限流：每用户每分钟 N 次 */
const buckets = new Map<string, number[]>();

function rateLimited(key: string, limitPerMin: number): boolean {
  if (!limitPerMin || limitPerMin <= 0) return false;
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= limitPerMin) {
    buckets.set(key, arr);
    return true;
  }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}

function params(req: any): { title: string; type: string; options: string } {
  const src = req.method === 'GET' ? req.query : { ...req.query, ...(req.body || {}) };
  const read = (v: unknown): string => {
    if (Array.isArray(v)) return String(v[0] ?? '');
    if (v == null) return '';
    if (typeof v === 'object') return '';
    return String(v);
  };
  return {
    title: read(src.title),
    type: read(src.type) || 'single',
    options: read(src.options),
  };
}

async function handle(req: any, res: any, aiOnly: boolean): Promise<void> {
  const p = params(req);
  const userId = req.apiUser?.id ?? null;
  const key = userId ? `u${userId}` : `ip${req.ip}`;
  const limit = settingNumber('rate_limit_per_min');

  if (rateLimited(key, limit)) {
    logRequest({
      userId,
      title: p.title,
      type: p.type,
      hit: 'none',
      status: 'rate_limited',
      message: '触发限流',
      latencyMs: 0,
      tokens: 0,
    });
    res.status(429).json({ code: 0, msg: `请求过于频繁（每分钟上限 ${limit} 次）` });
    return;
  }

  if (!p.title.trim()) {
    res.json({ code: 0, msg: '缺少 title 参数' });
    return;
  }

  let out: ResolveOutput;
  try {
    out = await (aiOnly
      ? resolveWithAiOnly({ title: p.title, type: p.type, options: p.options, userId })
      : resolve({ title: p.title, type: p.type, options: p.options, userId }));
  } catch (err) {
    out = { code: 0, msg: errMsg(err), hit: 'none', results: [], tokens: 0, latencyMs: 0 };
  }

  logRequest({
    userId,
    title: p.title,
    type: p.type,
    hit: out.hit,
    status: out.code === 1 ? 'ok' : 'error',
    message: out.code === 1 ? '' : out.msg,
    latencyMs: out.latencyMs,
    tokens: out.tokens,
    questionId: out.questionId ?? null,
  });

  if (out.code !== 1) {
    res.json({ code: 0, msg: out.msg });
    return;
  }

  res.json({
    code: 1,
    msg: 'ok',
    data: {
      question: p.title,
      type: p.type,
      hit: out.hit,
      results: out.results,
      latency_ms: out.latencyMs,
      ...(out.model ? { model: out.model } : {}),
    },
  });
}

let logCount = 0;
router.get('/search', apiAuth, (req, res) => void handle(req, res, false).catch((e) => res.status(500).json({ code: 0, msg: errMsg(e) })));
router.post('/search', apiAuth, (req, res) => void handle(req, res, false).catch((e) => res.status(500).json({ code: 0, msg: errMsg(e) })));

/** 仅供管理员在 WebGUI 测试台使用（强制走 AI，不入缓存） */
router.post('/search/ai', apiAuth, (req, res) =>
  void handle(req, res, true).catch((e) => res.status(500).json({ code: 0, msg: errMsg(e) })),
);

export default router;
