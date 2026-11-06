import { Router } from 'express';
import { apiAuth, extractApiToken } from '../middleware/auth';
import { logRequest, normalizeImages, resolve, resolveWithAiOnly, type ResolveOutput } from '../services/resolver';
import { errMsg } from '../utils';
import { settingNumber } from '../config';

const router = Router();

/** 简易滑动窗口限流：每用户每分钟 N 次 */
const buckets = new Map<string, number[]>();

function rateLimited(key: string, limitPerMin: number): boolean {
  if (!limitPerMin || limitPerMin <= 0) return false;
  const now = Date.now();
  if (buckets.size > 2000) {
    for (const [k, ts] of buckets) {
      const valid = ts.filter((t) => now - t < 60_000);
      if (valid.length === 0) buckets.delete(k);
      else buckets.set(k, valid);
    }
  }
  const prev = buckets.get(key);
  const arr = prev ? prev.filter((t) => now - t < 60_000) : [];
  if (arr.length >= limitPerMin) {
    buckets.set(key, arr);
    return true;
  }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}

interface SearchParams {
  title: string;
  type: string;
  options: string;
  suggestionTitle: string;
  suggestionOptions: string;
  images: string[];
}

function params(req: any): SearchParams {
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
    // OCS「图片题优化」：题干/选项里的图片被替换为 [图片N] 占位，原图放在 images 里
    suggestionTitle: read(src.suggestion_title),
    suggestionOptions: read(src.suggestion_options),
    images: normalizeImages(src.images),
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
    const input = {
      title: p.title,
      type: p.type,
      options: p.options,
      suggestionTitle: p.suggestionTitle,
      suggestionOptions: p.suggestionOptions,
      images: p.images,
      userId,
    };
    out = await (aiOnly ? resolveWithAiOnly(input) : resolve(input));
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
      ...(out.images ? { images: out.images } : {}),
    },
  });
}

/* ------------------------------------------------------------------ */
/* OCS 题库卡片的「连接检测」探活                                        */
/*   OCS 发的是 HEAD /search?t=<时间戳>（HEAD 回 405/501 时退回 GET），       */
/*   且**不带** token；走鉴权就会回 401，面板上直接显示「连接失败（401）」。  */
/*   这里只对「未带 token 且未带题目」的探活请求回 200，真正的搜题请求         */
/*   （带 title）仍然必须带有效 token。                                     */
/* ------------------------------------------------------------------ */
function isProbe(req: any): boolean {
  if (extractApiToken(req)) return false;
  const title = req.method === 'GET' ? req.query?.title : req.body?.title;
  return !String(Array.isArray(title) ? title[0] : (title ?? '')).trim();
}

router.head('/search', (_req, res) => {
  // 探活：不鉴权、不记日志、不消耗限流额度；no-store 避免 CDN（Cloudflare 等）缓存
  res.setHeader('cache-control', 'no-store');
  res.status(204).end();
});

router.get('/search', (req, res, next) => {
  if (!isProbe(req)) return next();
  res.setHeader('cache-control', 'no-store');
  res.json({ code: 1, msg: 'ok', data: { service: 'ocs-tiku', probe: true } });
});

router.get('/search', apiAuth, (req, res) => void handle(req, res, false).catch((e) => res.status(500).json({ code: 0, msg: errMsg(e) })));
router.post('/search', apiAuth, (req, res) => void handle(req, res, false).catch((e) => res.status(500).json({ code: 0, msg: errMsg(e) })));

/** 仅供管理员在 WebGUI 测试台使用（强制走 AI，不入缓存） */
router.post('/search/ai', apiAuth, (req, res) =>
  void handle(req, res, true).catch((e) => res.status(500).json({ code: 0, msg: errMsg(e) })),
);

export default router;
