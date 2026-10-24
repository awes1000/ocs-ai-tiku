/**
 * 极简 CDP 驱动：用无头 Chrome 真实渲染 WebGUI，抓取各页面运行时错误与渲染结果。
 * 前置：服务已运行在 BASE（默认 http://127.0.0.1:8061），Chrome 路径已存在。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8060';
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'test-admin-pass';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'shot');
const CHROME = process.env.CHROME_PATH || defaultChromePath();
const PORT = 9333;

/** 按平台挑选默认浏览器路径（可用 CHROME_PATH 覆盖） */
function defaultChromePath(): string {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

async function waitFor(fn: () => Promise<any>, timeoutMs = 15000, interval = 250): Promise<any> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw lastErr ?? new Error('timeout');
}

class CDP {
  ws!: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  events: any[] = [];

  async connect(url: string) {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', (e) => reject(e), { once: true });
    });
    this.ws.addEventListener('message', (ev: any) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expr: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }

  async goto(url: string) {
    await this.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1200));
  }

  async screenshot(file: string, fullPage = true) {
    const metrics = await this.send('Page.getLayoutMetrics');
    const height = fullPage ? Math.min(4000, Math.ceil(metrics.cssContentSize.height)) : 900;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(shot.data, 'base64'));
    await this.send('Emulation.clearDeviceMetricsOverride');
  }

  consoleErrors(): string[] {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => String(e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || ''))
      .filter(Boolean);
  }

  clearEvents() {
    this.events = [];
  }
}

async function main() {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      '--user-data-dir=' + path.join(OUT_DIR, 'profile'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const version: any = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return r.ok ? r.json() : null;
    }, 20000);
    check('Chrome 调试端口就绪', Boolean(version.Browser), version.Browser);

    const target: any = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list: any = await r.json();
      return list.find((t: any) => t.type === 'page');
    });
    const cdp = new CDP();
    await cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    /* ---------- 登录页 ---------- */
    await cdp.goto(BASE + '/');
    const loginVisible = await cdp.eval(`!document.querySelector('#login-view').classList.contains('hidden')`);
    check('未登录时展示登录页', loginVisible === true);
    await cdp.screenshot('01-login.png', false);
    check('登录页无 JS 异常', cdp.consoleErrors().length === 0, cdp.consoleErrors().join(' | '));
    cdp.clearEvents();

    /* ---------- 登录 ---------- */
    await cdp.eval(`(() => {
      document.querySelector('#login-username').value = ${JSON.stringify(USER)};
      document.querySelector('#login-password').value = ${JSON.stringify(PASS)};
      document.querySelector('#login-form').dispatchEvent(new Event('submit', { cancelable: true }));
      return true;
    })()`);
    await waitFor(() => cdp.eval(`!document.querySelector('#app-view').classList.contains('hidden')`), 10000);
    check('登录后进入主界面', true);
    await new Promise((r) => setTimeout(r, 900));

    const sidebarNav = await cdp.eval(`[...document.querySelectorAll('.nav-item')].map(n => n.dataset.page)`);
    check('侧边栏导航渲染', Array.isArray(sidebarNav) && sidebarNav.length >= 7, JSON.stringify(sidebarNav));

    /* ---------- 逐页渲染 ---------- */
    const pages: [string, string, string][] = [
      ['dashboard', '02-dashboard.png', '.grid-stats'],
      ['providers', '03-providers.png', '#add-provider'],
      ['prompts', '04-prompts.png', '#tpl-editor'],
      ['questions', '05-questions.png', '#q-search'],
      ['logs', '06-logs.png', '#lg-search'],
      ['wizard', '07-wizard.png', '#wz-out'],
      ['playground', '08-playground.png', '#pg-send'],
      ['users', '09-users.png', '#u-add'],
      ['settings', '10-settings.png', '#st-save'],
    ];

    for (const [page, file, selector] of pages) {
      cdp.clearEvents();
      await cdp.eval(`document.querySelector('.nav-item[data-page="${page}"]').click()`);
      const ok = await waitFor(
        async () => cdp.eval(`Boolean(document.querySelector('${selector}'))`),
        12000,
      ).catch(() => false);
      await new Promise((r) => setTimeout(r, 700));
      const errs = cdp.consoleErrors();
      const hasErrorAlert = await cdp.eval(`Boolean(document.querySelector('#content .alert.error'))`);
      const bodyText = await cdp.eval(`document.querySelector('#content').innerText.slice(0, 120)`);
      check(`页面 ${page} 渲染成功`, ok === true && !hasErrorAlert, bodyText);
      check(`页面 ${page} 无 JS 异常`, errs.length === 0, errs.join(' | '));
      await cdp.screenshot(file);
    }

    /* ---------- 交互：在线测试台真实请求 ---------- */
    await cdp.eval(`document.querySelector('.nav-item[data-page="playground"]').click()`);
    await waitFor(() => cdp.eval(`Boolean(document.querySelector('#pg-title'))`), 8000);
    await cdp.eval(`(() => {
      document.querySelector('#pg-title').value = 'UI 测试题目：中国的首都是哪里？';
      document.querySelector('#pg-options').value = 'A.北京\\nB.上海\\nC.广州';
      document.querySelector('#pg-send').click();
      return true;
    })()`);
    const hasResult = await waitFor(
      async () => cdp.eval(`document.querySelector('#pg-result').innerText.includes('result[') || document.querySelector('#pg-result').innerText.includes('未拿到答案')`),
      20000,
    ).catch(() => false);
    const resultText = await cdp.eval(`document.querySelector('#pg-result').innerText.slice(0, 300)`);
    check('在线测试台返回结果', hasResult === true, resultText);
    await cdp.screenshot('11-playground-result.png');

    /* ---------- 交互：题库新增 + 搜索 ---------- */
    await cdp.eval(`document.querySelector('.nav-item[data-page="questions"]').click()`);
    await waitFor(() => cdp.eval(`Boolean(document.querySelector('#q-add'))`), 8000);
    await cdp.eval(`document.querySelector('#q-add').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const modalOpen = await cdp.eval(`!document.querySelector('#modal').classList.contains('hidden')`);
    check('新增题目弹窗打开', modalOpen === true);
    await cdp.screenshot('12-question-modal.png', false);
    await cdp.eval(`(() => {
      document.querySelector('#nq-title').value = 'UI 手动新增的题目';
      document.querySelector('#nq-options').value = 'A.选项一\\nB.选项二';
      document.querySelector('#nq-answer').value = '选项二';
      document.querySelector('#nq-letter').value = 'B';
      document.querySelector('#save').click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));
    const qFound = await cdp.eval(`document.body.innerText.includes('UI 手动新增的题目')`);
    check('新增题目出现在列表', qFound === true);

    /* ---------- 交互：接入向导已自动生成 ---------- */
    await cdp.eval(`document.querySelector('.nav-item[data-page="wizard"]').click()`);
    await waitFor(() => cdp.eval(`document.querySelector('#wz-out').innerText.includes('GM_xmlhttpRequest')`), 10000);
    const wizardText = await cdp.eval(`document.querySelector('#wz-out').innerText.slice(0, 200)`);
    check('接入向导自动生成配置', wizardText.includes('/search'), wizardText.replace(/\n/g, ' ').slice(0, 120));

    /* ---------- 交互：AI 提供商弹窗 ---------- */
    await cdp.eval(`document.querySelector('.nav-item[data-page="providers"]').click()`);
    await waitFor(() => cdp.eval(`Boolean(document.querySelector('#add-provider'))`), 8000);
    await cdp.eval(`document.querySelector('#add-provider').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('AI 配置弹窗打开', (await cdp.eval(`!!document.querySelector('#p-base')`)) === true);
    await cdp.screenshot('13-provider-modal.png', false);
    await cdp.eval(`document.querySelector('#modal-close').click()`);

    console.log('\n============ 浏览器渲染检查 ============');
    let failed = 0;
    for (const r of results) {
      if (!r.ok) failed++;
      console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `  → ${String(r.detail ?? '').slice(0, 200)}`}`);
    }
    console.log(`\n共 ${results.length} 项，通过 ${results.length - failed} 项${failed ? `，失败 ${failed} 项` : ''}`);
    console.log(`截图目录：${OUT_DIR}\n`);
    cdp.ws.close();
    process.exitCode = failed ? 1 : 0;
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error('浏览器检查异常：', e);
  process.exit(1);
});
