import { env } from './env';
import { getDb } from './db';
import { nowSec } from './utils';

/** settings 表读写（带内存缓存） */
const cache = new Map<string, string>();

export function getSetting(key: string): string | undefined {
  if (cache.has(key)) return cache.get(key);
  const row = getDb().prepare(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string } | undefined;
  if (row) cache.set(key, row.value);
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    )
    .run(key, value, nowSec());
  cache.set(key, value);
}

export function getNumber(key: string, def: number): number {
  const v = getSetting(key);
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

export function getBool(key: string, def: boolean): boolean {
  const v = getSetting(key);
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

/** 所有可配置项的默认值（同时也是 WebGUI 设置页的字段表） */
export const DEFAULTS = {
  // 答题行为
  fuzzy_threshold: 0.9,
  enable_fuzzy: 1,
  enable_cache: 1,
  enable_ai: 1,
  ai_retry: 1,
  // 限流（每分钟每用户；0 = 不限）
  rate_limit_per_min: 60,
  // 日志保留天数（0 = 永久）
  log_retention_days: 30,
} as const;

export type SettingsKey = keyof typeof DEFAULTS;

export function defaultOf(key: SettingsKey): number {
  return DEFAULTS[key];
}

export function settingNumber(key: SettingsKey): number {
  return getNumber(key, DEFAULTS[key]);
}

export function settingBool(key: SettingsKey): boolean {
  return getBool(key, DEFAULTS[key] === 1);
}

/** 站点基础地址（用于生成 AnswererWrapper），可被设置覆盖 */
export function publicBaseUrl(): string {
  const v = getSetting('public_base_url');
  if (v) return v.replace(/\/+$/, '');
  return '';
}

/** 运行时 AI 配置汇总：providers 表优先，其次 settings，最后 env */
export interface RuntimeAiConfig {
  source: 'provider' | 'settings' | 'env';
  providerId?: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  api_type: 'responses' | 'chat_completions';
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  proxy: string;
  extra_headers: Record<string, string>;
}

import type { ProviderRow } from './db';

export function listProviders(): ProviderRow[] {
  return getDb()
    .prepare(`SELECT * FROM providers ORDER BY enabled DESC, priority DESC, id ASC`)
    .all() as ProviderRow[];
}

function parseHeaders(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
      return out;
    }
  } catch {
    /* 忽略非法 JSON */
  }
  return {};
}

export function rowToConfig(row: ProviderRow): RuntimeAiConfig {
  return {
    source: 'provider',
    providerId: row.id,
    name: row.name,
    base_url: row.base_url,
    api_key: row.api_key,
    model: row.model,
    api_type: row.api_type === 'responses' ? 'responses' : 'chat_completions',
    temperature: row.temperature,
    max_tokens: row.max_tokens,
    timeout_ms: row.timeout_ms,
    proxy: row.proxy,
    extra_headers: parseHeaders(row.extra_headers),
  };
}

/** 按优先级返回所有可用 AI 配置（用于故障切换） */
export function runtimeAiConfigs(): RuntimeAiConfig[] {
  const out: RuntimeAiConfig[] = [];
  for (const row of listProviders()) {
    if (row.enabled && row.base_url && row.model) out.push(rowToConfig(row));
  }

  // settings 表中的单套配置
  const sBase = getSetting('ai_base_url') || env.AI_BASE_URL;
  const sKey = getSetting('ai_api_key') || env.AI_API_KEY;
  const sModel = getSetting('ai_model') || env.AI_MODEL;
  if (sBase && sModel) {
    out.push({
      source: 'settings',
      name: getSetting('ai_name') || '默认配置',
      base_url: sBase,
      api_key: sKey,
      model: sModel,
      api_type: ((getSetting('ai_api_type') || env.AI_API_TYPE) === 'responses'
        ? 'responses'
        : 'chat_completions') as RuntimeAiConfig['api_type'],
      temperature: getNumber('ai_temperature', env.AI_TEMPERATURE),
      max_tokens: Math.round(getNumber('ai_max_tokens', env.AI_MAX_TOKENS)),
      timeout_ms: Math.round(getNumber('ai_timeout_ms', env.AI_TIMEOUT_MS)),
      proxy: getSetting('ai_proxy') || env.AI_PROXY,
      extra_headers: parseHeaders(getSetting('ai_extra_headers') || ''),
    });
  }
  return out;
}

export function primaryAiConfig(): RuntimeAiConfig | null {
  return runtimeAiConfigs()[0] ?? null;
}

/** 清空缓存（导入/批量写设置后调用） */
export function clearSettingCache(): void {
  cache.clear();
}
