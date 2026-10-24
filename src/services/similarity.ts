/**
 * 与 OCS 官方脚本一致的答案/题目归一化与匹配语义。
 * 参考：ocs 脚本 defaultAnswerWrapperHandler → resolveAnswer / splitAnswer / removeRedundant
 */

/** OCS 使用的多答案分隔符（注意包含空格与中英文标点） */
export const SEPARATORS = ['===', '#', '---', '###', '|', ';', '；'] as const;

/** 题型联合 */
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'unknown';

export function normalizeType(raw: unknown): QuestionType {
  const t = String(raw ?? '').trim().toLowerCase();
  if (t === 'single' || t === 'multiple' || t === 'judgement' || t === 'completion') return t;
  // 兼容中文题型
  if (t === '单选' || t === '单选题') return 'single';
  if (t === '多选' || t === '多选题') return 'multiple';
  if (t === '判断' || t === '判断题') return 'judgement';
  if (t === '填空' || t === '填空题') return 'completion';
  return 'unknown';
}

/**
 * 移除题目中的冗余部分：题号前缀、括号内分值、选项标记等。
 * 目的：同一道题在不同平台出现时能归一化到相同 key。
 */
export function removeRedundant(text: string): string {
  return String(text ?? '')
    .replace(/^\s*[（(【\[]?\s*(第\s*)?\d+\s*(题|小题)?\s*[)）】\]]?\s*[.、．:：]?\s*/u, '')
    .replace(/【[^】]{0,10}】/gu, '')
    .replace(/[（(]\s*\d+(\.\d+)?\s*分\s*[)）]/gu, '')
    .replace(/^\s*[A-Za-z][.、．:：)）]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 题目归一化：去掉所有空白与标点，仅保留文字与数字，便于模糊比较 */
export function normalizeTitle(text: string): string {
  return removeRedundant(text)
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/[，。！？；：“”‘’（）《》、·…—]/gu, '')
    .trim();
}

/** 选项归一化：剥离 "A." "A、" "(A)" 前缀 */
export function normalizeOption(text: string): string {
  return String(text ?? '')
    .replace(/^\s*[（(]?\s*[A-Za-z]\s*[)）.、．:：]\s*/u, '')
    .replace(/^\s*\d+\s*[.、．:：)）]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 选项列表（OCS 传入的 options 为 \n 拼接的 innerText） */
export function splitOptions(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 选项文本 → 字母（0 → A） */
export function letterOf(index: number): string {
  return String.fromCharCode(65 + index);
}

/** 纯字母判定：全部为 A-Z 且不重复（OCS 的 resolvePlainAnswer 也会做排序判断） */
export function isLetterAnswer(answer: string): boolean {
  const s = String(answer ?? '').replace(/[\s,，、]/gu, '').toUpperCase();
  if (!s || s.length > 8) return false;
  if (!/^[A-Z]+$/u.test(s)) return false;
  const chars = s.split('');
  return new Set(chars).size === chars.length;
}

/** 把字母答案拆成数组 ["A","B"] */
export function splitLetters(letters: string): string[] {
  return String(letters ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/gu, '')
    .split('');
}

/** 选项文本 → 字母集合：优先精确匹配归一化文本，其次包含匹配 */
export function isLetterToken(text: string): boolean {
  return /^[A-Za-z]{1,8}$/u.test(String(text ?? '').trim());
}

export function lettersFromTexts(options: string[], texts: string[]): string[] {
  const normOpts = options.map(normalizeOption);
  const out = new Set<string>();
  let exactHits = 0;
  for (const raw of texts) {
    const t = normalizeOption(raw);
    if (!t) continue;
    let idx = normOpts.indexOf(t);
    if (idx === -1) {
      idx = normOpts.findIndex((o) => o && (o === t || o.includes(t) || t.includes(o)));
    }
    if (idx >= 0) {
      exactHits++;
      out.add(letterOf(idx));
    }
  }
  // 全部未命中且原文是字母串 → 视为字母答案（如选项文本为 "B.2" 时模型回 "B"）
  if (exactHits === 0 && texts.length === 1 && isLetterToken(texts[0])) {
    return String(texts[0]).trim().toUpperCase().split('');
  }
  return [...out].sort();
}

/** 字母集合 → 选项原文文本 */
export function textsFromLetters(options: string[], letters: string[]): string[] {
  const out: string[] = [];
  for (const L of letters) {
    const idx = L.charCodeAt(0) - 65;
    if (idx >= 0 && idx < options.length) out.push(options[idx]);
  }
  return out;
}

/**
 * 多答案拆分（对齐 OCS splitAnswer 的前缀语义）：
 * 1. 若整体是 JSON 数组字符串 → 直接解析
 * 2. 否则按分隔符拆分（取命中的第一个分隔符）
 */
export function splitAnswer(answer: string): string[] {
  const raw = String(answer ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      /* 落回分隔符逻辑 */
    }
  }
  for (const sep of SEPARATORS) {
    if (raw.includes(sep)) {
      return raw
        .split(sep)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [raw];
}

/** 判断型答案 → "对" / "错" */
export function normalizeJudgement(answer: string): '对' | '错' | '' {
  const t = String(answer ?? '').trim().toLowerCase();
  if (!t) return '';
  if (/^(对|正确|是|√|v|true|t|yes|y|1)$/u.test(t)) return '对';
  if (/^(错|错误|否|×|x|false|f|no|n|0)$/u.test(t)) return '错';
  if (t.includes('正确') || t.includes('对')) return '对';
  if (t.includes('错误') || t.includes('错')) return '错';
  return '';
}
