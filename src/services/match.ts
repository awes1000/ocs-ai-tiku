import * as ss from 'string-similarity';
import {
  lettersFromTexts,
  normalizeOption,
  normalizeTitle,
  splitAnswer,
  splitLetters,
  splitOptions,
  textsFromLetters,
} from './similarity';
import type { QuestionType } from './similarity';

/** Dice 系数相似度（与 OCS 使用的 string-similarity 同款算法） */
export function similarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return ss.compareTwoStrings(x, y);
}

/** 在一组候选题里找最佳匹配 */
export interface Candidate {
  question: { id: number; title: string; title_norm: string; type: string; options: string; answer: string; answer_letter: string };
  score: number;
}

export function bestMatch(target: string, candidates: { id: number; title: string; title_norm: string; type: string; options: string; answer: string; answer_letter: string }[]): Candidate | null {
  const norm = normalizeTitle(target);
  if (!norm) return null;
  let best: Candidate | null = null;
  for (const q of candidates) {
    const score = q.title_norm === norm ? 1 : ss.compareTwoStrings(norm, q.title_norm || normalizeTitle(q.title));
    if (!best || score > best.score) best = { question: q, score };
  }
  return best;
}

/**
 * 把存储的答案映射到本次请求的选项顺序。
 * 存储时：answer 为选项原文（multiple 用 # 连接）/ 字母串 / 判断"对错" / 填空文本。
 */
export interface ResolvedAnswer {
  /** 选项原文（multiple 用 # 连接），无选项时为空 */
  text: string;
  /** 字母串，如 "ABD"；无选项时为空 */
  letter: string;
}

export function mapAnswerToOptions(
  type: QuestionType,
  storedAnswer: string,
  storedLetter: string,
  storedOptions: string[],
  currentOptions: string[],
): ResolvedAnswer {
  const options = currentOptions.length ? currentOptions : storedOptions;
  if (type === 'completion' || type === 'judgement' || type === 'unknown') {
    return { text: storedAnswer, letter: '' };
  }
  if (options.length === 0) {
    return { text: storedAnswer, letter: storedLetter };
  }

  let letters: string[] = [];
  if (storedLetter && /^[A-Z]+$/u.test(storedLetter)) {
    letters = splitLetters(storedLetter);
  } else if (storedAnswer) {
    const parts = splitAnswer(storedAnswer);
    letters = lettersFromTexts(storedOptions.length ? storedOptions : options, parts);
    if (letters.length === 0) letters = lettersFromTexts(options, parts);
  }

  // 当前选项顺序可能与入库时不同 → 用文本重新定位
  const storedTexts = textsFromLetters(storedOptions.length ? storedOptions : options, letters);
  const relocated =
    currentOptions.length && storedOptions.length && currentOptions.join('\u0001') !== storedOptions.join('\u0001')
      ? lettersFromTexts(currentOptions, storedTexts.map(normalizeOption))
      : letters;

  const finalLetters = (relocated.length ? relocated : letters).sort();
  const finalTexts = textsFromLetters(options, finalLetters);
  return {
    text: finalTexts.length ? finalTexts.join('#') : storedAnswer,
    letter: finalLetters.join(''),
  };
}
