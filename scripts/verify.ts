/**
 * 一键回归：起一个全新实例（临时 DB）→ smoke → e2e → UI 静态 → 浏览器渲染 → 清理
 * 用法：npm run verify
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.VERIFY_PORT || '8077';
const ADMIN_PASS = 'verify-pass-123';
const DB = path.join(ROOT, 'data', 'verify.db');
const NODE = process.execPath;
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** 清理临时数据库（含 WAL/SHM） */
function rmSqlite(base: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = base + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}

const summary: { name: string; ok: boolean; out?: string }[] = [];
const PROFILE = path.join(ROOT, 'data', 'shot', 'profile');
const SMOKE_DB = path.join(ROOT, 'data', 'verify-smoke.db');

function rmDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function run(script: string, extraEnv: Record<string, string> = {}, args: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(NODE, [TSX, script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

function waitServer(url: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve(true);
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function main() {
  // 清理旧数据库与浏览器配置
  rmSqlite(DB);
  rmSqlite(SMOKE_DB);
  rmDir(PROFILE);

  // 1. smoke（自带 mock LLM，使用独立 DB）
  const smoke = await run('scripts/smoke.ts', { DB_PATH: SMOKE_DB, PORT: '8098' });
  const smokeLine = smoke.out.match(/共 \d+ 项，通过 \d+ 项[^\n]*/)?.[0] || '';
  summary.push({ name: '冒烟测试（35 项断言 + mock LLM）', ok: smoke.code === 0, out: smokeLine });

  // 2. 启动服务
  let server: ChildProcess | null = null;
  try {
    server = spawn(NODE, [TSX, 'src/index.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT,
        DB_PATH: DB,
        ADMIN_PASSWORD: ADMIN_PASS,
        ADMIN_USERNAME: 'admin',
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout?.on('data', (d) => (serverLog += d));
    server.stderr?.on('data', (d) => (serverLog += d));

    const up = await waitServer(`http://127.0.0.1:${PORT}/health`);
    summary.push({ name: '服务启动', ok: up, out: up ? '' : serverLog.slice(0, 300) });
    if (!up) throw new Error('服务未能启动');

    // 3. 后端 e2e
    const e2e = await run('scripts/e2e.ts', {
      BASE: `http://127.0.0.1:${PORT}`,
      ADMIN_PASSWORD: ADMIN_PASS,
    });
    const e2eLine = e2e.out.match(/共 \d+ 项，通过 \d+ 项[^\n]*/)?.[0] || '';
    const e2eFail = e2e.out.split('\n').filter((l) => l.includes('❌')).join(' ');
    summary.push({ name: 'WebGUI 后端端到端', ok: e2e.code === 0, out: e2eFail || e2eLine });

    // 4. 前端静态检查
    const ui = await run('scripts/ui-check.ts');
    const uiLine = ui.out.match(/共 \d+ 项，通过 \d+ 项[^\n]*/)?.[0] || '';
    summary.push({ name: '前端静态检查', ok: ui.code === 0, out: uiLine });

    // 5. 浏览器渲染（无头 Chrome/Edge）
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ];
    const chrome = process.env.CHROME_PATH || chromePaths.find((p) => fs.existsSync(p));
    if (chrome) {
      const br = await run('scripts/ui-browser.ts', {
        BASE: `http://127.0.0.1:${PORT}`,
        ADMIN_PASSWORD: ADMIN_PASS,
        CHROME_PATH: chrome,
      });
      const brLine = br.out.match(/共 \d+ 项，通过 \d+ 项[^\n]*/)?.[0] || '';
      const brFail = br.out.split('\n').filter((l) => l.includes('❌')).join(' ');
      summary.push({ name: '浏览器渲染（无头 Chrome）', ok: br.code === 0, out: brFail || brLine });
    } else {
      summary.push({ name: '浏览器渲染', ok: true, out: '跳过：未找到 Chrome/Edge' });
    }
  } finally {
    server?.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSqlite(DB);
    rmSqlite(SMOKE_DB);
    rmDir(PROFILE);
  }

  console.log('\n================= 回归汇总 =================');
  let failed = 0;
  for (const s of summary) {
    if (!s.ok) failed++;
    console.log(`${s.ok ? '✅' : '❌'} ${s.name}${s.out ? `  ·  ${s.out}` : ''}`);
  }
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('回归失败：', e);
  process.exit(1);
});
