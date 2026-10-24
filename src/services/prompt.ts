import { getSetting } from '../config';
import type { QuestionType } from './similarity';

/** 统一的系统提示词 */
const SYSTEM = `你是一个严谨的网课答题助手。你只输出最终的正确答案，不做任何解释。
必须严格按要求输出 JSON，且只能输出 JSON 对象本身，不要加代码块、不要加任何前后缀说明。`;

const JSON_SHAPE: Record<QuestionType, string> = {
  single: '{"answer":"B"}',
  multiple: '{"answer":"ABD"}',
  judgement: '{"answer":"对"}',
  completion: '{"answer":["第一个空的答案","第二个空的答案"]}',
  unknown: '{"answer":"直接答案文本"}',
};

const RULES: Record<QuestionType, string> = {
  single: `这是单选题：有且只有一个正确答案。
从选项中选择唯一正确的选项，answer 填选项字母（大写，如 "B"）。
若题目给出选项但你不确定，也必须给出最可能的唯一选项。`,
  multiple: `这是多选题：可能有多个正确答案（也可能只有一个）。
answer 填所有正确选项的字母，按字母升序直接拼接，不加空格、不加逗号（如 "ABD"）。`,
  judgement: `这是判断题：只回答 "对" 或 "错"。
按常识与学科知识判断命题真假，answer 只能是 "对" 或 "错" 其中之一。`,
  completion: `这是填空题：可能有多个空。
answer 必须是字符串数组，数组长度等于空的数量，顺序与空的出现顺序一致。
每项只填应填入的答案内容本身，不要带题干、不要带"第X空"之类的说明。
题干中若出现 ____ 类的下划线或括号提示，按其出现顺序对应数组元素。`,
  unknown: `题目题型未知：请直接给出最终答案文本。
若有选项，answer 填正确选项的字母；若无选项，answer 填答案文本。`,
};

export type PromptTemplates = Record<QuestionType, string>;

/** 默认模板（可在 WebGUI 编辑，存 settings） */
export function defaultTemplate(type: QuestionType): string {
  return [
    SYSTEM,
    '',
    RULES[type],
    '',
    '题目：{{title}}',
    '{{options_block}}',
    '',
    `输出格式（严格 JSON）：${JSON_SHAPE[type]}`,
  ].join('\n');
}

export function getTemplate(type: QuestionType): string {
  const custom = getSetting(`prompt_${type}`);
  return custom && custom.trim() ? custom : defaultTemplate(type);
}

export function getAllTemplates(): PromptTemplates {
  return {
    single: getTemplate('single'),
    multiple: getTemplate('multiple'),
    judgement: getTemplate('judgement'),
    completion: getTemplate('completion'),
    unknown: getTemplate('unknown'),
  };
}

export function systemPrompt(): string {
  return getSetting('prompt_system') || SYSTEM;
}

export const ANSWER_SHAPES = JSON_SHAPE;
export const TYPE_RULES = RULES;

/** 渲染用户提示词 */
export function buildUserPrompt(opts: {
  type: QuestionType;
  title: string;
  options: string[];
  extraInstruction?: string;
}): string {
  const { type, title, options } = opts;
  const optionsBlock = options.length
    ? ['选项：', ...options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)].join('\n')
    : '（本题没有给出选项）';
  const tpl = getTemplate(type);
  const rendered = tpl
    .replace(/\{\{\s*title\s*\}\}/gu, title)
    .replace(/\{\{\s*options_block\s*\}\}/gu, optionsBlock)
    .replace(/\{\{\s*options\s*\}\}/gu, options.join('\n'))
    .replace(/\{\{\s*type\s*\}\}/gu, type);
  return opts.extraInstruction ? `${rendered}\n\n补充要求：${opts.extraInstruction}` : rendered;
}

/** 测试连接用的最小提示词 */
export const PING_PROMPT = '请只输出 JSON：{"answer":"ok"}';
