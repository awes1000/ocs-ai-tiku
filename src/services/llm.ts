import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { RuntimeAiConfig } from '../config';
import { errMsg } from '../utils';

export interface LlmResult {
  raw: string;
  tokens: number;
  model: string;
  latencyMs: number;
}

export interface LlmCallOptions {
  config: RuntimeAiConfig;
  systemPrompt: string;
  userPrompt: string;
  /** 要求模型输出 JSON 对象 */
  jsonMode?: boolean;
  /** 覆盖配置的超时 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const proxyAgents = new Map<string, Dispatcher>();
const directAgent = new Agent({
  connect: { timeout: 15_000 },
  headersTimeout: 120_000,
  bodyTimeout: 120_000,
});

function dispatcherFor(proxy?: string): Dispatcher {
  if (!proxy) return directAgent;
  const cached = proxyAgents.get(proxy);
  if (cached) return cached;
  const agent = new ProxyAgent({ uri: proxy, requestTls: { rejectUnauthorized: false } });
  proxyAgents.set(proxy, agent);
  return agent;
}

/** 规范化 base_url：去掉尾部 /，并补全 /v1 */
export function normalizeBaseUrl(base: string): string {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return b;
  if (/\/(v\d+[a-z]*|openai|compatible-mode\/v\d+)$/iu.test(b)) return b;
  // 常见网关已带版本号，避免重复补 /v1
  if (/\/v\d+/u.test(b)) return b;
  return `${b}/v1`;
}

function joinHeaders(config: RuntimeAiConfig, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...config.extra_headers,
    ...(extra || {}),
  };
  if (config.api_key) headers.authorization = `Bearer ${config.api_key}`;
  return headers;
}

async function doFetch(
  url: string,
  body: unknown,
  config: RuntimeAiConfig,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
  externalSignal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`LLM 请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: joinHeaders(config, extraHeaders),
      body: JSON.stringify(body),
      dispatcher: dispatcherFor(config.proxy),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

/** 从 OpenAI 兼容响应里抽取文本与 usage */
function extractChatCompletions(json: any): { text: string; tokens: number } {
  const choice = json?.choices?.[0];
  const content =
    choice?.message?.content ??
    choice?.text ??
    (Array.isArray(choice?.message?.content)
      ? choice.message.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
      : '');
  const tokens = Number(json?.usage?.total_tokens ?? 0) || 0;
  return { text: String(content ?? ''), tokens };
}

/** responses API（/v1/responses）的文本抽取 */
function extractResponses(json: any): { text: string; tokens: number } {
  let text = '';
  if (typeof json?.output_text === 'string' && json.output_text) {
    text = json.output_text;
  } else if (Array.isArray(json?.output)) {
    const parts: string[] = [];
    for (const item of json.output) {
      if (typeof item?.content === 'string') parts.push(item.content);
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c === 'string') parts.push(c);
          else if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
    }
    text = parts.join('');
  }
  const tokens = Number(json?.usage?.total_tokens ?? json?.usage?.output_tokens ?? 0) || 0;
  return { text: text.trim(), tokens };
}

function errorMessage(status: number, text: string): string {
  let detail = text.slice(0, 500);
  try {
    const j = JSON.parse(text);
    detail = j?.error?.message || j?.message || detail;
  } catch {
    /* 保持原文 */
  }
  return `HTTP ${status}: ${detail}`;
}

/** 根据 api_type 构造请求体 */
function buildBody(opts: LlmCallOptions, stream: boolean): Record<string, unknown> {
  const { config, systemPrompt, userPrompt } = opts;
  if (config.api_type === 'responses') {
    return {
      model: config.model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: config.temperature,
      max_output_tokens: config.max_tokens,
      ...(opts.jsonMode ? { text: { format: { type: 'json_object' } } } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }
  return {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    stream: stream || undefined,
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

function endpointOf(config: RuntimeAiConfig): string {
  const base = normalizeBaseUrl(config.base_url);
  return config.api_type === 'responses' ? `${base}/responses` : `${base}/chat/completions`;
}

function extract(json: any, apiType: string): { text: string; tokens: number } {
  return apiType === 'responses' ? extractResponses(json) : extractChatCompletions(json);
}

/**
 * 调用一次 LLM（非流式）。JSON 模式不兼容时自动回退为纯文本模式。
 */
export async function callLlm(opts: LlmCallOptions): Promise<LlmResult> {
  const { config } = opts;
  const timeoutMs = opts.timeoutMs ?? config.timeout_ms ?? 35_000;
  const url = endpointOf(config);
  const started = Date.now();

  const attempt = async (jsonMode: boolean): Promise<{ text: string; tokens: number }> => {
    const body = buildBody({ ...opts, jsonMode }, false);
    const res = await doFetch(url, body, config, timeoutMs, undefined, opts.signal);
    if (res.status < 200 || res.status >= 300) {
      const err: any = new Error(errorMessage(res.status, res.text));
      err.status = res.status;
      err.body = res.text;
      throw err;
    }
    let json: any;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new Error(`LLM 响应不是合法 JSON：${res.text.slice(0, 300)}`);
    }
    const parsed = extract(json, config.api_type);
    if (!parsed.text) {
      // 流式回退（部分网关非流式返回空）
      throw Object.assign(new Error('LLM 返回空内容'), { empty: true });
    }
    return parsed;
  };

  let parsed: { text: string; tokens: number };
  try {
    parsed = await attempt(Boolean(opts.jsonMode));
  } catch (err) {
    const msg = errMsg(err);
    const canRetryPlain =
      opts.jsonMode &&
      /response_format|json_object|json mode|400|422|unsupported|unknown field|invalid_request/iu.test(msg);
    if (!canRetryPlain) throw err;
    parsed = await attempt(false);
  }

  return {
    raw: parsed.text,
    tokens: parsed.tokens,
    model: config.model,
    latencyMs: Date.now() - started,
  };
}

/**
 * 流式调用：边收边回调（用于 WebGUI 在线测试台的"打字机"效果）。
 * 返回完整文本。
 */
export async function callLlmStream(
  opts: LlmCallOptions,
  onDelta: (chunk: string) => void,
): Promise<LlmResult> {
  const { config } = opts;
  const timeoutMs = opts.timeoutMs ?? config.timeout_ms ?? 35_000;
  const url = endpointOf(config);
  const started = Date.now();
  const body = buildBody({ ...opts, jsonMode: opts.jsonMode }, true);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`LLM 请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let text = '';
  let tokens = 0;
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: joinHeaders(config),
      body: JSON.stringify(body),
      dispatcher: dispatcherFor(config.proxy),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errorMessage(res.status, errText));
    }
    if (!res.body) throw new Error('LLM 响应没有内容流');

    const decoder = new TextDecoder();
    let buffer = '';
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        if (config.api_type === 'responses') {
          if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
            text += json.delta;
            onDelta(json.delta);
          }
          if (json.type === 'response.completed' && json.response?.usage?.total_tokens) {
            tokens = Number(json.response.usage.total_tokens) || tokens;
          }
        } else {
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta(delta);
          }
          if (json?.usage?.total_tokens) tokens = Number(json.usage.total_tokens) || tokens;
        }
      } catch {
        /* 忽略心跳等非 JSON 行 */
      }
    };

    for await (const chunk of res.body as any) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  return { raw: text, tokens, model: config.model, latencyMs: Date.now() - started };
}

/** 测试连接：发一条最小请求，返回耗时与模型回显 */
export async function testConnection(config: RuntimeAiConfig): Promise<{
  ok: boolean;
  message: string;
  latencyMs: number;
  model: string;
  tokens: number;
  preview: string;
}> {
  const started = Date.now();
  try {
    const res = await callLlm({
      config,
      systemPrompt: '你是连通性测试助手，只输出 JSON。',
      userPrompt: '请只输出 JSON：{"answer":"ok"}',
      jsonMode: true,
      timeoutMs: Math.min(config.timeout_ms || 35_000, 30_000),
    });
    return {
      ok: true,
      message: '连接成功',
      latencyMs: res.latencyMs,
      model: res.model,
      tokens: res.tokens,
      preview: res.raw.slice(0, 300),
    };
  } catch (err) {
    return {
      ok: false,
      message: errMsg(err),
      latencyMs: Date.now() - started,
      model: config.model,
      tokens: 0,
      preview: '',
    };
  }
}
