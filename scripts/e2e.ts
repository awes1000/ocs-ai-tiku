/**
 * WebGUI 端到端流程测试：需先启动服务。
 * 用法：先 npm start（或用 verify.ts 自动拉起实例），再
 *   BASE=http://127.0.0.1:8060 ADMIN_PASSWORD=<管理员密码> npm run test:e2e
 * 覆盖：登录/改密/登出、提供商增删改测、设置、提示词、用户 CRUD、
 *      题库 CRUD/导入导出、日志统计、接入向导、测试台。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const PASS = process.env.ADMIN_PASSWORD || 'test-admin-pass';

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

let cookie = '';

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const init: RequestInit = {
    method: opts.method || 'GET',
    headers: {} as Record<string, string>,
  };
  if (cookie) (init.headers as Record<string, string>).cookie = cookie;
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, init);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const prompt: string = parsed.messages?.[1]?.content ?? '';
    let answer: unknown = 'B';
    if (prompt.includes('多选题')) answer = 'AB';
    else if (prompt.includes('判断题')) answer = '对';
    else if (prompt.includes('填空题')) answer = ['北京', '上海'];
    else if (prompt.includes('连通性')) answer = 'ok';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ answer }) } }],
        usage: { total_tokens: 33 },
        model: parsed.model,
      }),
    );
  });
});

async function main() {
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;

  /* ---- 登录 ---- */
  const bad = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  check('错误密码被拒', bad.status === 401);

  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PASS } });
  check('管理员登录', login.json.code === 1, JSON.stringify(login.json).slice(0, 120));

  const me = await call('/api/auth/me');
  check('/auth/me 返回管理员', me.json.data?.user?.role === 'admin');

  /* ---- AI 提供商 ---- */
  const prov = await call('/api/providers', {
    method: 'POST',
    body: {
      name: 'E2E Mock',
      base_url: llmUrl,
      api_key: 'sk-e2e',
      model: 'mock-1',
      api_type: 'chat_completions',
      temperature: 0.1,
      max_tokens: 512,
      timeout_ms: 10000,
      enabled: true,
      priority: 5,
    },
  });
  check('新增提供商', prov.json.code === 1, JSON.stringify(prov.json).slice(0, 200));
  const pid = prov.json.data?.provider?.id;

  const provList = await call('/api/providers');
  check('提供商列表脱敏 key', provList.json.data.providers[0].api_key.includes('****'), provList.json.data.providers[0].api_key);

  const test = await call(`/api/providers/test?id=${pid}`, { method: 'POST' });
  check('提供商测试连接成功', test.json.data?.ok === true, JSON.stringify(test.json).slice(0, 200));

  /* ---- 设置 ---- */
  const saveSettings = await call('/api/settings', {
    method: 'PUT',
    body: { settings: { fuzzy_threshold: '0.85', rate_limit_per_min: '120', public_base_url: BASE } },
  });
  check('保存系统设置', saveSettings.json.code === 1, JSON.stringify(saveSettings.json).slice(0, 150));

  const readSettings = await call('/api/settings');
  check('设置已持久化', readSettings.json.data.settings.fuzzy_threshold === '0.85');
  check('提示词模板返回 5 类', Object.keys(readSettings.json.data.templates).length === 5);

  /* ---- 提示词保存/重置 ---- */
  const saveTpl = await call('/api/settings', {
    method: 'PUT',
    body: { settings: { prompt_single: '自定义：{{title}}\n{{options_block}}' } },
  });
  check('保存提示词模板', saveTpl.json.code === 1);
  const resetTpl = await call('/api/settings/prompt-reset', { method: 'POST', body: { type: 'single' } });
  check('重置提示词模板', resetTpl.json.code === 1);

  /* ---- 用户管理 ---- */
  const uname = 'e2e_user_' + Date.now().toString().slice(-5);
  const newUser = await call('/api/users', {
    method: 'POST',
    body: { username: uname, password: 'pass123456', role: 'user', note: 'e2e' },
  });
  check('创建用户', newUser.json.code === 1, JSON.stringify(newUser.json).slice(0, 150));
  const uid = newUser.json.data?.user?.id;
  const userToken = newUser.json.data?.user?.token;

  const dupUser = await call('/api/users', { method: 'POST', body: { username: uname, password: 'pass123456' } });
  check('重名用户被拒', dupUser.json.code === 0);

  const patchUser = await call(`/api/users/${uid}`, { method: 'PATCH', body: { note: 'changed', regenerate_token: true } });
  check('重置用户 Token', patchUser.json.code === 1 && patchUser.json.data.user.token !== userToken);
  const newToken = patchUser.json.data.user.token;

  const disable = await call(`/api/users/${uid}`, { method: 'PATCH', body: { status: 'disabled' } });
  check('停用用户', disable.json.data.user.status === 'disabled');
  const blocked = await call(`/search?title=t&type=single&token=${newToken}`);
  check('停用用户搜题被拒 403', blocked.status === 403, String(blocked.status));
  await call(`/api/users/${uid}`, { method: 'PATCH', body: { status: 'active' } });

  /* ---- 搜题（真实接口） ---- */
  const s1 = await call(`/search?token=${encodeURIComponent(newToken)}&title=${encodeURIComponent('1+1=?')}&type=single&options=${encodeURIComponent('A.1\nB.2\nC.3')}`);
  check('搜题 AI 命中', s1.json.code === 1 && s1.json.data.hit === 'ai', JSON.stringify(s1.json).slice(0, 250));
  const s2 = await call(`/search?token=${encodeURIComponent(newToken)}&title=${encodeURIComponent('1+1=?')}&type=single&options=${encodeURIComponent('A.1\nB.2\nC.3')}`);
  check('重复搜题命中缓存', s2.json.data?.hit === 'cache', JSON.stringify(s2.json).slice(0, 200));

  /* ---- 题库管理 ---- */
  const qs = await call('/api/questions?page=1&page_size=10');
  check('题库列表', qs.json.code === 1 && qs.json.data.total >= 1, JSON.stringify(qs.json).slice(0, 150));
  const qid = qs.json.data.questions[0].id;

  const manual = await call('/api/questions', {
    method: 'POST',
    body: { title: '手动录入的题目', type: 'single', options: 'A.甲\nB.乙', answer: '乙', answer_letter: 'B' },
  });
  check('手动新增题目', manual.json.code === 1, JSON.stringify(manual.json).slice(0, 150));

  const edit = await call(`/api/questions/${qid}`, { method: 'PATCH', body: { answer: '2', answer_letter: 'B' } });
  check('编辑题目', edit.json.code === 1);

  const importData = await call('/api/questions/import', {
    method: 'POST',
    body: {
      data: JSON.stringify([{ title: '导入题一', type: 'judgement', answer: '对' }]),
      overwrite: true,
    },
  });
  check('JSON 导入', importData.json.data?.imported === 1, JSON.stringify(importData.json).slice(0, 150));

  const csv = 'title,type,options,answer,answer_letter\n"CSV导入题","single","A.甲\nB.乙","乙","B"\n';
  const importCsv = await call('/api/questions/import', { method: 'POST', body: { data: csv, overwrite: true } });
  check('CSV 导入', importCsv.json.data?.imported === 1, JSON.stringify(importCsv.json).slice(0, 200));

  /* ---- 导出/备份 ---- */
  const expJson = await fetch(`${BASE}/api/questions/export?format=json`, { headers: { cookie } });
  const expJsonBody: any = await expJson.json();
  check('导出 JSON', expJson.ok && Array.isArray(expJsonBody.questions));
  const expCsv = await fetch(`${BASE}/api/questions/export?format=csv`, { headers: { cookie } });
  const csvBytes = new Uint8Array(await expCsv.arrayBuffer());
  check('导出 CSV 带 BOM', csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, String(csvBytes[0]));

  const backup = await fetch(`${BASE}/api/backup`, { method: 'POST', headers: { cookie } });
  const backupText = await backup.text();
  check('备份脱敏', backup.ok && backupText.includes('<redacted>'));

  /* ---- 统计/日志 ---- */
  const stats = await call('/api/stats');
  check('统计数据', stats.json.data.totals.requests >= 2 && stats.json.data.hourly.length === 24, JSON.stringify(stats.json.data.totals).slice(0, 200));
  const logs = await call('/api/logs?page=1&page_size=10');
  check('日志列表', logs.json.data.total >= 2 && logs.json.data.logs[0].username === uname, JSON.stringify(logs.json.data.logs[0] ?? {}).slice(0, 200));

  /* ---- 接入向导 ---- */
  const wz = await call(`/api/wizard?token=${encodeURIComponent(newToken)}&base_url=${encodeURIComponent(BASE)}`);
  const wrapper = wz.json.data.answerer_wrapper;
  check('向导生成 wrapper', wrapper.type === 'GM_xmlhttpRequest' && wrapper.url === `${BASE}/search`, JSON.stringify(wrapper).slice(0, 200));
  check('向导 data 使用占位符', wrapper.data.title === '${title}' && wrapper.data.token === newToken);
  check('向导 handler 可用', (() => {
    try {
      // 模拟 OCS 的 new Function 执行
      const fn = new Function(wrapper.handler)();
      const r1 = fn({ code: 1, data: { results: [['q', 'a']] } });
      const r2 = fn({ code: 0, msg: '未找到' });
      return Array.isArray(r1) && r1.length === 1 && r2[0] === '未找到' && r2[1] === undefined;
    } catch (e) {
      check('向导 handler 可用', false, String(e));
      return false;
    }
  })());

  /* ---- 测试台 ---- */
  const debugCache = await call('/api/debug/solve', {
    method: 'POST',
    body: { title: '1+1=?', type: 'single', options: 'A.1\nB.2\nC.3', use_cache: true },
  });
  check('测试台全流程模式', debugCache.json.data.code === 1, JSON.stringify(debugCache.json).slice(0, 200));
  const debugAi = await call('/api/debug/solve', {
    method: 'POST',
    body: { title: '全新的题目X', type: 'single', options: 'A.甲\nB.乙', use_cache: false },
  });
  check('测试台仅 AI 模式', debugAi.json.data.hit === 'ai', JSON.stringify(debugAi.json).slice(0, 200));

  /* ---- 改密 & 登出 ---- */
  const chpw = await call('/api/auth/password', { method: 'POST', body: { old_password: PASS, new_password: PASS } });
  check('修改密码（同值）', chpw.json.code === 1, JSON.stringify(chpw.json).slice(0, 150));

  const delUser = await call(`/api/users/${uid}`, { method: 'DELETE' });
  check('删除用户', delUser.json.code === 1);

  const logout = await call('/api/auth/logout', { method: 'POST' });
  check('登出', logout.json.code === 1);
  const afterLogout = await call('/api/auth/me');
  check('登出后会话失效', afterLogout.status === 401);

  console.log('\n============ WebGUI 端到端结果 ============');
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `  → ${r.detail ?? ''}`}`);
  }
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed} 项${failed ? `，失败 ${failed} 项` : ''}\n`);
  llm.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(1);
});
