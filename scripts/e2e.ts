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
let lastLlmRequest: { prompt: string; imageCount: number } | null = null;

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
    const content = parsed.messages?.[1]?.content;
    const prompt: string =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : '';
    const imageCount = Array.isArray(content) ? content.filter((c: any) => c?.type === 'image_url').length : 0;
    lastLlmRequest = { prompt, imageCount };
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
  // OCS 题库卡片的「连接检测」：HEAD /search?t=... 不带 token，必须能探活成功
  const probeHead = await fetch(`${BASE}/search?t=${Date.now()}`, { method: 'HEAD' });
  check('探活 HEAD /search 不鉴权', probeHead.status >= 200 && probeHead.status < 300, String(probeHead.status));
  const probeGet = await fetch(`${BASE}/search?t=${Date.now()}`);
  const probeGetJson: any = await probeGet.json().catch(() => ({}));
  check('探活 GET /search 返回 200', probeGet.status === 200 && probeGetJson.data?.probe === true, JSON.stringify(probeGetJson).slice(0, 120));
  const probeTitle = await fetch(`${BASE}/search?title=${encodeURIComponent('无 token 搜题')}`);
  check('带题目的搜题仍需 token（401）', probeTitle.status === 401, String(probeTitle.status));
  const probePost = await call('/search', { method: 'POST', body: {} });
  check('POST 搜题无 token 仍 401', probePost.status === 401, String(probePost.status));

  const s1 = await call(`/search?token=${encodeURIComponent(newToken)}&title=${encodeURIComponent('1+1=?')}&type=single&options=${encodeURIComponent('A.1\nB.2\nC.3')}`);
  check('搜题 AI 命中', s1.json.code === 1 && s1.json.data.hit === 'ai', JSON.stringify(s1.json).slice(0, 250));
  const s2 = await call(`/search?token=${encodeURIComponent(newToken)}&title=${encodeURIComponent('1+1=?')}&type=single&options=${encodeURIComponent('A.1\nB.2\nC.3')}`);
  check('重复搜题命中缓存', s2.json.data?.hit === 'cache', JSON.stringify(s2.json).slice(0, 200));

  /* ---- 图片题（OCS 图片优化） ---- */
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const imgBody = {
    title: '图片题A：[图片1]',
    type: 'single',
    options: 'A.[图片1]\nB.略',
    suggestion_title: '图片题A：[图片1]',
    suggestion_options: 'A.[图片1]\nB.略',
    images: [PNG],
    token: newToken,
  };
  const imgSearch = await call('/search', { method: 'POST', body: imgBody });
  check('图片题走 AI', imgSearch.json.code === 1 && imgSearch.json.data?.hit === 'ai', JSON.stringify(imgSearch.json).slice(0, 250));
  check('图片以多模态 part 发送', lastLlmRequest?.imageCount === 1, JSON.stringify(lastLlmRequest).slice(0, 200));
  check('图片题提示词带 [图片1] 占位', Boolean(lastLlmRequest?.prompt.includes('[图片1]')), (lastLlmRequest?.prompt ?? '').slice(0, 200));
  const imgSearch2 = await call('/search', { method: 'POST', body: imgBody });
  check('图片题不复用缓存', imgSearch2.json.data?.hit === 'ai', JSON.stringify(imgSearch2.json).slice(0, 200));
  const imgStored = await call(`/api/questions?keyword=${encodeURIComponent('图片题A')}`);
  check('图片题不入题库', imgStored.json.data?.total === 0, JSON.stringify(imgStored.json).slice(0, 150));
  const badImg = await call('/search', {
    method: 'POST',
    body: { ...imgBody, images: ['undefined', 'not-an-image'], title: '图片题B：[图片1]' },
  });
  check('非法 images 被过滤', badImg.json.code === 1 && badImg.json.data?.hit === 'ai' && !badImg.json.data?.images, JSON.stringify(badImg.json).slice(0, 200));

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
  check('备份脱敏（POST）', backup.ok && backupText.includes('<redacted>'));
  const backupGet = await fetch(`${BASE}/api/backup`, { method: 'GET', headers: { cookie } });
  const backupGetText = await backupGet.text();
  check('备份脱敏（GET 下载兼容）', backupGet.ok && backupGetText.includes('<redacted>'));

  /* ---- 统计/日志 ---- */
  const stats = await call('/api/stats');
  check('统计数据', stats.json.data.totals.requests >= 2 && stats.json.data.hourly.length === 24, JSON.stringify(stats.json.data.totals).slice(0, 200));
  const logs = await call('/api/logs?page=1&page_size=10');
  check('日志列表', logs.json.data.total >= 2 && logs.json.data.logs[0].username === uname, JSON.stringify(logs.json.data.logs[0] ?? {}).slice(0, 200));

  /* ---- 接入向导 ---- */
  const wz = await call(`/api/wizard?token=${encodeURIComponent(newToken)}&base_url=${encodeURIComponent(BASE)}`);
  const wrapperList = wz.json.data.answerer_wrapper;
  check(
    '向导生成 wrapper 为数组（OCS 题库配置只接受 [{...}]）',
    Array.isArray(wrapperList) && wrapperList.length === 1,
    JSON.stringify(wrapperList).slice(0, 200),
  );
  check('向导输出 JSON 可直接粘贴到 OCS', Array.isArray(JSON.parse(wz.json.data.json)));
  const wrapper = wrapperList[0] ?? {};
  check('向导生成 wrapper', wrapper.type === 'GM_xmlhttpRequest' && wrapper.url === `${BASE}/search`, JSON.stringify(wrapper).slice(0, 200));
  check('向导 data 使用占位符', wrapper.data.title === '${title}' && wrapper.data.token === newToken);
  check('向导声明图片题支持（OCS 不再提示“暂不支持图片、公式”）', (() => {
    if (String(wrapper.method || 'get').toLowerCase() !== 'post') return false;
    const placeholders = ['${images}', '${suggestion_title}', '${suggestion_options}'];
    return Object.values(wrapper.data || {}).some((v: any) => {
      if (typeof v === 'string') return placeholders.some((p) => v.includes(p));
      return Boolean(
        v &&
          typeof v === 'object' &&
          typeof v.handler === 'string' &&
          /(^|[^\w$])(images|suggestion_title|suggestion_options)(?![\w$])/.test(v.handler),
      );
    });
  })());
  check(
    '向导图片字段在无图时为空',
    (() => {
      try {
        const images = new Function(wrapper.data.images.handler)()({});
        const title = new Function(wrapper.data.suggestion_title.handler)()({ title: 'T' });
        const opts = new Function(wrapper.data.suggestion_options.handler)()({ options: 'A\nB' });
        return Array.isArray(images) && images.length === 0 && title === 'T' && opts === 'A\nB';
      } catch (e) {
        check('向导图片字段在无图时为空', false, String(e));
        return false;
      }
    })(),
  );
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

  /* ---- 普通用户权限边界（方案 B：只读权限全收，仅接入向导 + 自助账号操作） ---- */
  const adminCookie = cookie;
  const userLogin = await call('/api/auth/login', { method: 'POST', body: { username: uname, password: 'pass123456' } });
  check('普通用户登录', userLogin.json.code === 1 && userLogin.json.data.user.role === 'user');

  const userMe = await call('/api/auth/me');
  check('普通用户 /auth/me 返回 API 状态', typeof userMe.json.data?.ai_configured === 'boolean', JSON.stringify(userMe.json).slice(0, 150));

  for (const [name, path] of [
    ['题库列表', '/api/questions?page=1&page_size=5'],
    ['题库导出', '/api/questions/export?format=json'],
    ['调用日志', '/api/logs?page=1'],
    ['统计数据', '/api/stats'],
    ['系统设置', '/api/settings'],
    ['AI 提供商', '/api/providers'],
    ['用户列表', '/api/users'],
  ] as [string, string][]) {
    const r = await call(path);
    check(`普通用户禁止访问${name} → 403`, r.status === 403, String(r.status));
  }

  const userWriteQ = await call('/api/questions', {
    method: 'POST',
    body: { title: '越权录入', type: 'single', options: 'A.1\nB.2', answer: '1', answer_letter: 'A' },
  });
  check('普通用户禁止写入题库 → 403', userWriteQ.status === 403);
  const userDelQ = await call(`/api/questions/${qid}`, { method: 'DELETE' });
  check('普通用户禁止删除题库 → 403', userDelQ.status === 403);
  const userDebug = await call('/api/debug/solve', { method: 'POST', body: { title: '越权测试', use_cache: false } });
  check('普通用户禁止使用在线测试台 → 403', userDebug.status === 403, String(userDebug.status));

  /* ---- 普通用户自助接入：强制使用自身账号与服务地址 ---- */
  const userWz = await call('/api/wizard?token=fake_other_token&base_url=http://evil.example.com');
  check('普通用户向导仅返回自身 Token', userWz.json.code === 1 && userWz.json.data.token === newToken, JSON.stringify(userWz.json).slice(0, 200));
  check(
    '普通用户向导忽略外部 base_url',
    userWz.json.data?.base_url === BASE && !userWz.json.data?.json.includes('evil.example.com'),
    String(userWz.json.data?.base_url),
  );
  check('普通用户向导返回 is_admin=false', userWz.json.data?.is_admin === false);

  /* ---- 普通用户自助重置 Token ---- */
  const selfReset = await call('/api/auth/token', { method: 'POST' });
  check('普通用户自助重置 Token', selfReset.json.code === 1 && selfReset.json.data.token !== newToken);
  const selfToken = selfReset.json.data.token;
  const oldTokenDead = await call(`/search?title=old&type=single&token=${encodeURIComponent(newToken)}`);
  check('旧 Token 重置后失效 → 401', oldTokenDead.status === 401, String(oldTokenDead.status));
  const newTokenAlive = await call(`/search?title=${encodeURIComponent('自助重置后的搜题')}&type=single&options=${encodeURIComponent('A.1\nB.2')}&token=${encodeURIComponent(selfToken)}`);
  check('新 Token 可正常搜题', newTokenAlive.json.code === 1, JSON.stringify(newTokenAlive.json).slice(0, 200));
  const wzAfterReset = await call('/api/wizard');
  check('重置后向导使用新 Token', wzAfterReset.json.data?.token === selfToken);

  /* ---- 普通用户自助改密 ---- */
  const selfPw = await call('/api/auth/password', { method: 'POST', body: { old_password: 'pass123456', new_password: 'newpass123' } });
  check('普通用户自助修改密码', selfPw.json.code === 1, JSON.stringify(selfPw.json).slice(0, 150));
  await call('/api/auth/logout', { method: 'POST' });
  const relogin = await call('/api/auth/login', { method: 'POST', body: { username: uname, password: 'newpass123' } });
  check('新密码可登录', relogin.json.code === 1, JSON.stringify(relogin.json).slice(0, 150));
  await call('/api/auth/logout', { method: 'POST' });
  cookie = adminCookie;

  /* ---- 管理员创号支持首次登录强制改密 ---- */
  const mcName = 'e2e_mc_' + Date.now().toString().slice(-5);
  const mcUser = await call('/api/users', {
    method: 'POST',
    body: { username: mcName, password: 'pass123456', role: 'user', must_change_password: true },
  });
  check('创号支持首次登录强制改密', mcUser.json.data?.user?.must_change_password === 1, JSON.stringify(mcUser.json).slice(0, 150));
  const mcId = mcUser.json.data?.user?.id;
  const mcOff = await call(`/api/users/${mcId}`, { method: 'PATCH', body: { must_change_password: false } });
  check('可取消强制改密', mcOff.json.data?.user?.must_change_password === 0, JSON.stringify(mcOff.json).slice(0, 150));
  await call(`/api/users/${mcId}`, { method: 'DELETE' });

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
