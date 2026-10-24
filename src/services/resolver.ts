import { getDb, type QuestionRow } from '../db';
import { primaryAiConfig, runtimeAiConfigs, settingBool, settingNumber, type RuntimeAiConfig } from '../config';
import { callLlm } from './llm';
import { buildUserPrompt, systemPrompt } from './prompt';
import { bestMatch, mapAnswerToOptions, type ResolvedAnswer } from './match';
import {
  lettersFromTexts,
  normalizeJudgement,
  normalizeTitle,
  normalizeType,
  splitAnswer,
  splitOptions,
  textsFromLetters,
  type QuestionType,
} from './similarity';
import { errMsg, nowSec } from '../utils';

/** OCS 结果项：[题目, 答案, extra_data?] */
export type ResultItem = [string, string, Record<string, unknown>?];

export type HitKind = 'cache' | 'fuzzy' | 'ai' | 'none';

export interface ResolveInput {
  title: string;
  type: string;
  options: string;
  userId: number | null;
}

export interface ResolveOutput {
  code: 0 | 1;
  msg: string;
  hit: HitKind;
  results: ResultItem[];
  questionId?: number;
  tokens: number;
  latencyMs: number;
  model?: string;
}

/** 解析 LLM 返回的 JSON */
interface ParsedLlmAnswer {
  answer: string;
  letter: string;
  texts: string[];
}

function stripCodeFence(text: string): string {
  const t = text.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  return m ? m[1].trim() : t;
}

function extractJsonObject(text: string): any | null {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    /* 尝试截取第一个 { 到最后一个 } */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** 把模型输出规范化成字母/文本 */
export function interpretLlmAnswer(
  type: QuestionType,
  raw: string,
  options: string[],
): ParsedLlmAnswer {
  const json = extractJsonObject(raw);
  let answerValue: unknown = json?.answer ?? json?.answers ?? json?.result ?? json?.data ?? null;

  // 填空：允许数组或分隔符字符串
  if (type === 'completion') {
    let texts: string[] = [];
    if (Array.isArray(answerValue)) texts = answerValue.map((v) => String(v).trim()).filter(Boolean);
    else if (typeof answerValue === 'string') texts = splitAnswer(answerValue);
    if (texts.length === 0) {
      // 无 JSON 时按行/分隔符兜底
      const plain = stripCodeFence(raw);
      texts = splitAnswer(plain);
    }
    const answer = texts.join('#');
    return { answer, letter: '', texts };
  }

  // 判断：统一成 对/错
  if (type === 'judgement') {
    const rawText = typeof answerValue === 'string' ? answerValue : String(answerValue ?? '');
    const judged = normalizeJudgement(rawText) || normalizeJudgement(stripCodeFence(raw));
    return { answer: judged || rawText.trim(), letter: '', texts: judged ? [judged] : [] };
  }

  // 有选项：优先字母
  let letters: string[] = [];
  let answerText = '';
  if (typeof answerValue === 'string') {
    answerText = answerValue.trim();
  } else if (Array.isArray(answerValue)) {
    answerText = answerValue.map((v) => String(v)).join('#');
  } else if (answerValue != null) {
    answerText = String(answerValue);
  }

  if (options.length > 0) {
    const parts = splitAnswer(answerText);
    const compactLetters = answerText.replace(/[\s,，、]/gu, '');
    // 1) 纯字母
    if (parts.length > 0 && parts.every((p) => /^[A-Za-z]$/u.test(p))) {
      letters = parts.map((p) => p.toUpperCase());
    } else if (/^[A-Za-z]{1,8}$/u.test(compactLetters)) {
      letters = compactLetters.toUpperCase().split('');
    } else {
      // 2) 文本匹配选项
      letters = lettersFromTexts(options, parts.length ? parts : [answerText]);
    }
    if (type === 'single' && letters.length > 1) letters = letters.slice(0, 1);
    letters = [...new Set(letters)].sort();
    const texts = textsFromLetters(options, letters);
    if (letters.length === 0) {
      // 3) 完全识别不出选项 → 原样返回文本，交给 OCS 相似度兜底
      return { answer: answerText, letter: '', texts: [] };
    }
    return { answer: texts.join('#'), letter: letters.join(''), texts };
  }

  return { answer: answerText, letter: '', texts: answerText ? [answerText] : [] };
}

/** 从库里按 id 取题 */
function getQuestion(id: number): QuestionRow | undefined {
  return getDb().prepare(`SELECT * FROM questions WHERE id=?`).get(id) as QuestionRow | undefined;
}

function listByNorm(norm: string, type: string): QuestionRow[] {
  return getDb()
    .prepare(`SELECT * FROM questions WHERE title_norm=? AND type=? ORDER BY updated_at DESC LIMIT 5`)
    .all(norm, type) as QuestionRow[];
}

/** 模糊候选集：按首字符/长度粗筛，避免全表扫描过大 */
function fuzzyCandidates(norm: string, type: string, limit = 3000): QuestionRow[] {
  const db = getDb();
  const prefix = norm.slice(0, 1);
  const rows = db
    .prepare(
      `SELECT * FROM questions
       WHERE type=? AND title_norm LIKE ? 
       ORDER BY hits DESC, updated_at DESC LIMIT ?`,
    )
    .all(type, `${prefix}%`, limit) as QuestionRow[];
  if (rows.length > 0) return rows;
  return db
    .prepare(`SELECT * FROM questions WHERE type=? ORDER BY hits DESC, updated_at DESC LIMIT ?`)
    .all(type, Math.min(limit, 1000)) as QuestionRow[];
}

function toResolved(type: QuestionType, parsed: ParsedLlmAnswer): ResolvedAnswer {
  return { text: parsed.answer, letter: parsed.letter };
}

/** 组装 OCS results（带额外标签） */
export function formatResults(
  title: string,
  type: QuestionType,
  resolved: ResolvedAnswer,
  extra: Record<string, unknown>,
): ResultItem[] {
  const results: ResultItem[] = [];
  if (type === 'single' || type === 'multiple') {
    if (resolved.text) results.push([title, resolved.text, { ...extra }]);
    if (resolved.letter && resolved.letter !== resolved.text) results.push([title, resolved.letter, { ...extra }]);
  } else {
    if (resolved.text) results.push([title, resolved.text, { ...extra }]);
    if (resolved.letter && resolved.letter !== resolved.text) results.push([title, resolved.letter, { ...extra }]);
  }
  return results;
}

/** 把 AI 结果入库（同题同 type 覆盖更新） */
export function upsertQuestion(params: {
  title: string;
  type: string;
  options: string[];
  answer: string;
  letter: string;
  model: string;
  source?: string;
  userId?: number | null;
}): number {
  const db = getDb();
  const norm = normalizeTitle(params.title);
  const now = nowSec();
  const optionsText = params.options.join('\n');
  const existing = db.prepare(`SELECT id FROM questions WHERE title_norm=? AND type=?`).get(norm, params.type) as
    | { id: number }
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE questions SET title=?, options=?, answer=?, answer_letter=?, model=?, source=?, updated_at=?, user_id=COALESCE(user_id,?)
       WHERE id=?`,
    ).run(
      params.title,
      optionsText,
      params.answer,
      params.letter,
      params.model || '',
      params.source || 'ai',
      now,
      params.userId ?? null,
      existing.id,
    );
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO questions (title, title_norm, type, options, answer, answer_letter, source, model, hits, user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`,
    )
    .run(
      params.title,
      norm,
      params.type,
      optionsText,
      params.answer,
      params.letter,
      params.source || 'ai',
      params.model || '',
      params.userId ?? null,
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

function bumpHits(id: number): void {
  getDb().prepare(`UPDATE questions SET hits=hits+1, updated_at=? WHERE id=?`).run(nowSec(), id);
}

/** 记录请求日志 */
export function logRequest(params: {
  userId: number | null;
  title: string;
  type: string;
  hit: HitKind;
  status: string;
  message: string;
  latencyMs: number;
  tokens: number;
  questionId?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO requests (user_id, title, type, hit, status, message, latency_ms, tokens, question_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      params.userId,
      params.title.slice(0, 500),
      params.type,
      params.hit,
      params.status,
      params.message.slice(0, 500),
      params.latencyMs,
      params.tokens,
      params.questionId ?? null,
      nowSec(),
    );
}

/* ------------------------------------------------------------------ */
/* in-flight 合并：相同规范化题目并发请求共享一次 AI 调用              */
/* ------------------------------------------------------------------ */
const inFlight = new Map<string, Promise<{ parsed: ParsedLlmAnswer; model: string; tokens: number }>>();

async function askLlm(
  type: QuestionType,
  title: string,
  options: string[],
  configs: RuntimeAiConfig[],
): Promise<{ parsed: ParsedLlmAnswer; model: string; tokens: number }> {
  const key = `${type}\u0001${normalizeTitle(title)}\u0001${options.join('\u0001')}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const userPrompt = buildUserPrompt({ type, title, options });
    const sys = systemPrompt();
    const retry = settingBool('ai_retry') ? 1 : 0;
    let lastErr: unknown = null;
    let totalTokens = 0;

    for (const config of configs) {
      for (let attempt = 0; attempt <= retry; attempt++) {
        try {
          const res = await callLlm({ config, systemPrompt: sys, userPrompt, jsonMode: true });
          totalTokens += res.tokens;
          const parsed = interpretLlmAnswer(type, res.raw, options);
          if (!parsed.answer) throw new Error('模型返回了空答案');
          return { parsed, model: res.model, tokens: totalTokens };
        } catch (err) {
          lastErr = err;
          const msg = errMsg(err);
          // 401/403/404 → 换下一个提供商
          if (/HTTP (401|403|404)/u.test(msg)) break;
        }
      }
    }
    throw lastErr ?? new Error('没有可用的 AI 配置');
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

/**
 * 答题主流程：精确 → 模糊 → AI。
 */
export async function resolve(input: ResolveInput): Promise<ResolveOutput> {
  const started = Date.now();
  const title = String(input.title ?? '').trim();
  const type = normalizeType(input.type);
  const options = splitOptions(input.options);
  const effectiveType: QuestionType = type === 'unknown' && options.length > 0 ? 'single' : type;
  const latency = () => Date.now() - started;

  if (!title) {
    return { code: 0, msg: '题目为空', hit: 'none', results: [], tokens: 0, latencyMs: latency() };
  }

  const norm = normalizeTitle(title);
  const enableCache = settingBool('enable_cache');
  const enableFuzzy = settingBool('enable_fuzzy');

  // 1) 精确命中
  if (enableCache) {
    const rows = listByNorm(norm, effectiveType);
    const row = rows[0];
    if (row) {
      const storedOptions = splitOptions(row.options);
      const resolved = mapAnswerToOptions(
        effectiveType,
        row.answer,
        row.answer_letter,
        storedOptions,
        options,
      );
      const results = formatResults(title, effectiveType, resolved, { cache: true });
      if (results.length) {
        bumpHits(row.id);
        return {
          code: 1,
          msg: 'ok',
          hit: 'cache',
          results,
          questionId: row.id,
          tokens: 0,
          latencyMs: latency(),
        };
      }
    }
  }

  // 2) 模糊命中
  if (enableCache && enableFuzzy) {
    const threshold = settingNumber('fuzzy_threshold');
    const candidates = fuzzyCandidates(norm, effectiveType);
    const match = bestMatch(title, candidates);
    if (match && match.score >= threshold) {
      const row = match.question as QuestionRow;
      const storedOptions = splitOptions(row.options);
      const resolved = mapAnswerToOptions(effectiveType, row.answer, row.answer_letter, storedOptions, options);
      const results = formatResults(title, effectiveType, resolved, { cache: true, fuzzy: Number(match.score.toFixed(3)) });
      if (results.length) {
        bumpHits(row.id);
        return {
          code: 1,
          msg: 'ok',
          hit: 'fuzzy',
          results,
          questionId: row.id,
          tokens: 0,
          latencyMs: latency(),
        };
      }
    }
  }

  // 3) AI
  if (!settingBool('enable_ai')) {
    return { code: 0, msg: '未命中题库，且 AI 答题已关闭', hit: 'none', results: [], tokens: 0, latencyMs: latency() };
  }

  const configs = runtimeAiConfigs();
  if (configs.length === 0) {
    return { code: 0, msg: '未配置 AI 提供商', hit: 'none', results: [], tokens: 0, latencyMs: latency() };
  }

  try {
    const ai = await askLlm(effectiveType, title, options, configs);
    let resolved = toResolved(effectiveType, ai.parsed);
    const results = formatResults(title, effectiveType, resolved, { ai: true });
    if (!results.length) {
      return {
        code: 0,
        msg: 'AI 未能给出可用答案',
        hit: 'none',
        results: [],
        tokens: ai.tokens,
        latencyMs: latency(),
        model: ai.model,
      };
    }
    const questionId = upsertQuestion({
      title,
      type: effectiveType,
      options,
      answer: resolved.text,
      letter: resolved.letter,
      model: ai.model,
      source: 'ai',
      userId: input.userId,
    });
    return {
      code: 1,
      msg: 'ok',
      hit: 'ai',
      results,
      questionId,
      tokens: ai.tokens,
      latencyMs: latency(),
      model: ai.model,
    };
  } catch (err) {
    return {
      code: 0,
      msg: `AI 答题失败：${errMsg(err)}`,
      hit: 'none',
      results: [],
      tokens: 0,
      latencyMs: latency(),
    };
  }
}

/** 供 WebGUI 测试台使用：跳过缓存，强制走 AI */
export async function resolveWithAiOnly(input: ResolveInput): Promise<ResolveOutput> {
  const started = Date.now();
  const title = String(input.title ?? '').trim();
  const type0 = normalizeType(input.type);
  const options = splitOptions(input.options);
  const type: QuestionType = type0 === 'unknown' && options.length > 0 ? 'single' : type0;
  if (!title) return { code: 0, msg: '题目为空', hit: 'none', results: [], tokens: 0, latencyMs: 0 };
  const configs = runtimeAiConfigs();
  if (!configs.length) return { code: 0, msg: '未配置 AI 提供商', hit: 'none', results: [], tokens: 0, latencyMs: 0 };
  const config = primaryAiConfig()!;
  try {
    const res = await callLlm({
      config,
      systemPrompt: systemPrompt(),
      userPrompt: buildUserPrompt({ type, title, options }),
      jsonMode: true,
    });
    const parsed = interpretLlmAnswer(type, res.raw, options);
    const resolved = toResolved(type, parsed);
    return {
      code: parsed.answer ? 1 : 0,
      msg: parsed.answer ? 'ok' : '模型未返回答案',
      hit: 'ai',
      results: formatResults(title, type, resolved, { ai: true }),
      tokens: res.tokens,
      latencyMs: Date.now() - started,
      model: res.model,
    };
  } catch (err) {
    return {
      code: 0,
      msg: errMsg(err),
      hit: 'none',
      results: [],
      tokens: 0,
      latencyMs: Date.now() - started,
    };
  }
}

export { getQuestion };
