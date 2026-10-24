/**
 * 冒烟测试脚本：node --import tsx scripts/smoke.ts
 * 覆盖：归一化、答案映射、LLM 解析、resolver 流水线（mock LLM 提供商）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DB_PATH = process.env.DB_PATH || 'data/smoke.db';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
process.env.PORT = process.env.PORT || '8099';
process.env.ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS || 'false';

/* ---------------- 1. 纯函数单测 ---------------- */
import {
  normalizeTitle,
  splitAnswer,
  splitOptions,
  lettersFromTexts,
  isLetterAnswer,
  normalizeJudgement,
  normalizeOption,
} from '../src/services/similarity';
import { interpretLlmAnswer } from '../src/services/resolver';
import { mapAnswerToOptions, similarity } from '../src/services/match';
import { normalizeOption as nopt } from '../src/services/similarity';

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  results.push({ name, ok: cond, detail });
}

check('normalizeTitle 去空白标点', normalizeTitle(' 1. 中国梦 是什么？ ') === '中国梦是什么', normalizeTitle(' 1. 中国梦 是什么？ '));
check('normalizeOption 剥离 A. 前缀', normalizeOption('A. 选项内容') === '选项内容', normalizeOption('A. 选项内容'));
check('splitAnswer JSON 数组', JSON.stringify(splitAnswer('["甲","乙"]')) === '["甲","乙"]');
check('splitAnswer 分隔符 #', JSON.stringify(splitAnswer('甲#乙#丙')) === '["甲","乙","丙"]');
check('splitOptions 按行拆分', splitOptions('A.1\nB.2\nC.3').length === 3);
check('lettersFromTexts 文本映射', lettersFromTexts(['苹果', '香蕉', '橘子'], ['橘子', '苹果']).join('') === 'AC');
check('isLetterAnswer 合法', isLetterAnswer('ABD'));
check('isLetterAnswer 非法(重复)', !isLetterAnswer('AAB'));
check('normalizeJudgement true→对', normalizeJudgement('true') === '对');

const single = interpretLlmAnswer('single', '{"answer":"B"}', ['甲', '乙', '丙']);
check('LLM single 字母→文本', single.letter === 'B' && single.answer === '乙', JSON.stringify(single));

const multi = interpretLlmAnswer('multiple', '```json\n{"answer":"AC"}\n```', ['甲', '乙', '丙']);
check('LLM multiple 带代码围栏', multi.letter === 'AC' && multi.answer === '甲#丙', JSON.stringify(multi));

const judge = interpretLlmAnswer('judgement', '{"answer":"正确"}', []);
check('LLM judgement 归一', judge.answer === '对', JSON.stringify(judge));

const comp = interpretLlmAnswer('completion', '{"answer":["甲","乙"]}', []);
check('LLM completion 数组', comp.answer === '甲#乙', JSON.stringify(comp));

const map = mapAnswerToOptions('single', '香蕉', 'B', ['苹果', '香蕉', '橘子'], ['橘子', '香蕉', '苹果']);
check('选项乱序后重定位字母', map.letter === 'B', JSON.stringify(map));

const sim = similarity('中国梦是什么', '中国梦 是什么？');
check('相似度=1（忽略标点空白）', sim === 1, String(sim));

/* ---------------- 2. mock LLM 提供商 ---------------- */
const llmServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const prompt: string = parsed.messages?.[1]?.content ?? '';
    let answer: unknown = 'B';
    if (prompt.includes('多选题')) answer = 'AB';
    else if (prompt.includes('判断题')) answer = '对';
    else if (prompt.includes('填空题')) answer = ['第一个空', '第二个空'];
    const payload = {
      choices: [{ message: { content: JSON.stringify({ answer }) } }],
      usage: { total_tokens: 42 },
      model: parsed.model,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
  const llmPort = (llmServer.address() as AddressInfo).port;

  // 数据库需在 mock 启动后再初始化
  const { getDb, ensureAdmin } = await import('../src/db');
  const { setSetting } = await import('../src/config');
  const db = getDb();
  db.exec('DELETE FROM questions; DELETE FROM requests; DELETE FROM providers;');
  ensureAdmin(db);
  setSetting('ai_base_url', '');
  setSetting('ai_api_key', '');
  setSetting('ai_model', '');

  db.prepare(
    `INSERT INTO providers (name, base_url, api_key, model, api_type, temperature, max_tokens, timeout_ms, proxy, enabled, priority, extra_headers, created_at, updated_at)
     VALUES ('mock', ?, 'sk-test', 'mock-model', 'chat_completions', 0.1, 512, 10000, '', 1, 10, '', 0, 0)`,
  ).run(`http://127.0.0.1:${llmPort}/v1`);

  const { resolve } = await import('../src/services/resolver');

  // 第一次：AI 生成
  const r1 = await resolve({ title: '1+1=?', type: 'single', options: 'A.1\nB.2\nC.3', userId: null });
  check('AI 首次命中', r1.code === 1 && r1.hit === 'ai', JSON.stringify(r1));
  check('AI 返回文本+字母两条', r1.results.length === 2 && nopt(r1.results[0][1]) === '2' && r1.results[1][1] === 'B', JSON.stringify(r1.results));

  // 第二次：精确缓存
  const r2 = await resolve({ title: '1+1=?', type: 'single', options: 'A.1\nB.2\nC.3', userId: null });
  check('二次请求命中缓存', r2.hit === 'cache', JSON.stringify(r2));
  check('缓存带 cache 标签', (r2.results[0][2] as any)?.cache === true, JSON.stringify(r2.results));

  // 第三次：措辞/选项顺序变化 → 模糊 + 重排
  const r3 = await resolve({ title: '1+1=？', type: 'single', options: 'A.3\nB.2\nC.1', userId: null });
  check('轻微措辞变化命中模糊', r3.hit === 'cache' || r3.hit === 'fuzzy', JSON.stringify(r3));
  check('选项乱序后答案仍为 2/B', nopt(r3.results[0][1]) === '2' && r3.results[1][1] === 'B', JSON.stringify(r3.results));

  // 多选
  const r4 = await resolve({ title: '以下属于水果的是', type: 'multiple', options: '苹果\n香蕉\n猪肉', userId: null });
  check('多选 AI 命中', r4.code === 1 && r4.hit === 'ai', JSON.stringify(r4));
  check('多选答案为 苹果#香蕉 + AB', r4.results[0][1] === '苹果#香蕉' && r4.results[1][1] === 'AB', JSON.stringify(r4.results));

  // 判断
  const r5 = await resolve({ title: '地球是圆的', type: 'judgement', options: '', userId: null });
  check('判断返回 对', r5.results[0][1] === '对', JSON.stringify(r5.results));

  // 填空
  const r6 = await resolve({ title: '中国的首都是____，最大的城市是____', type: 'completion', options: '', userId: null });
  check('填空两空 # 连接', String(r5 && r6.results[0][1]).split('#').length === 2, JSON.stringify(r6.results));

  check('请求已入库', (db.prepare('SELECT COUNT(*) c FROM questions').get() as any).c >= 4);
  check('直接调用 resolver 不写请求日志', (db.prepare('SELECT COUNT(*) c FROM requests').get() as any).c === 0);

  /* ---------------- 3. HTTP 端到端 ---------------- */
  const { app, start } = await import('../src/index');
  void app;
  start();
  await new Promise((r) => setTimeout(r, 500));

  const base = `http://127.0.0.1:${process.env.PORT}`;
  const token = (db.prepare(`SELECT token FROM users WHERE role='admin'`).get() as any).token;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any, headers: res.headers };
  };

  const hit = await post('/search', {
    title: '1+1=?',
    type: 'single',
    options: 'A.1\nB.2\nC.3',
    token,
  });
  check('POST /search code=1', hit.json.code === 1 && Array.isArray(hit.json.data.results), JSON.stringify(hit.json).slice(0, 200));

  const noToken = await post('/search', { title: 'x', type: 'single' });
  check('POST /search 无 token → 401', noToken.status === 401);
  check('接口请求写入日志', (db.prepare('SELECT COUNT(*) c FROM requests').get() as any).c >= 1);

  const login = await post('/api/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD });
  check('登录成功', login.json.code === 1, JSON.stringify(login.json));
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  const meJson: any = await me.json();
  check('会话有效', meJson.code === 1 && meJson.data.user.username === 'admin');

  const stats = await fetch(`${base}/api/stats`, { headers: { cookie } });
  const statsJson: any = await stats.json();
  check('统计接口可用', statsJson.code === 1 && statsJson.data.totals.requests > 0, JSON.stringify(statsJson).slice(0, 200));

  const wizard = await fetch(`${base}/api/wizard`, { headers: { cookie } });
  const wizardJson: any = await wizard.json();
  check('接入向导生成 AnswererWrapper', wizardJson.code === 1 && wizardJson.data.answerer_wrapper.type === 'GM_xmlhttpRequest', JSON.stringify(wizardJson).slice(0, 200));

  const questions = await fetch(`${base}/api/questions?page=1&page_size=5`, { headers: { cookie } });
  const qJson: any = await questions.json();
  check('题库列表接口', qJson.code === 1 && qJson.data.total > 0);

  /* ---------------- 汇总 ---------------- */
  console.log('\n================ 冒烟测试结果 ================');
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `  →  ${r.detail ?? ''}`}`);
  }
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed} 项${failed ? `，失败 ${failed} 项` : ''}\n`);
  llmServer.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试异常：', err);
  process.exit(1);
});
