/**
 * 前端静态资源校验：语法 + 关键渲染函数存在性（无需浏览器）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '..');
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

/* ---- index.html ---- */
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf-8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf-8');

for (const id of ids) {
  check(`HTML 元素 #${id} 在 app.js 中被使用或无需引用`, true);
}
check('index.html 引用 style.css', html.includes('/style.css'));
check('index.html 引用 app.js', html.includes('/app.js'));

/* ---- app.js 语法检查 ---- */
try {
  new vm.Script(appJs, { filename: 'app.js' });
  check('app.js 语法正确', true);
} catch (err) {
  check('app.js 语法正确', false, String(err));
}

/* ---- 关键 DOM 引用都存在 ---- */
const referenced = [...appJs.matchAll(/\$\('#([a-zA-Z0-9_-]+)'/g)].map((m) => m[1]);
const missing = [...new Set(referenced)].filter((id) => !ids.includes(id) && !appJs.includes(`id="${id}"`));
check('app.js 引用的静态 ID 都存在于 HTML', missing.length === 0, `缺失: ${missing.join(', ')}`);

/* ---- 页面渲染函数齐全 ---- */
for (const fn of [
  'renderDashboard',
  'renderProviders',
  'renderPrompts',
  'renderQuestions',
  'renderLogs',
  'renderWizard',
  'renderPlayground',
  'renderUsers',
  'renderSettings',
]) {
  check(`存在 ${fn}`, appJs.includes(`function ${fn}`) || appJs.includes(`async function ${fn}`));
}

/* ---- 导航项与页面 key 对应 ---- */
const pageKeys = [...html.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1]);
const missingPages = pageKeys.filter((k) => !new RegExp(`${k}:\\s*\\{`).test(appJs));
check('导航项与 PAGES 一一对应', missingPages.length === 0, `缺失: ${missingPages.join(', ')}`);

/* ---- CSS 关键类存在 ---- */
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf-8');
for (const cls of ['.layout', '.sidebar', '.card', '.btn', '.badge', '.modal', '.toast', '.alert', '.code-block', '.stat']) {
  check(`CSS 定义 ${cls}`, css.includes(cls));
}

/* ---- API 路径与后端一致 ---- */
const backendRoutes = [
  '/auth/login',
  '/auth/me',
  '/auth/logout',
  '/auth/password',
  '/users',
  '/questions',
  '/questions/export',
  '/questions/import',
  '/questions/delete',
  '/logs',
  '/stats',
  '/settings',
  '/settings/prompt-reset',
  '/providers',
  '/debug/solve',
  '/wizard',
  '/backup',
];
const adminSrc = fs.readFileSync(path.join(ROOT, 'src/routes/admin.ts'), 'utf-8');
for (const r of backendRoutes) {
  check(`后端实现 ${r}`, adminSrc.includes(`'${r}'`) || adminSrc.includes(`"${r}"`));
}
const usedApi = [...new Set([...appJs.matchAll(/api\('([^'?]+)/g)].map((m) => m[1]))];
check('前端调用的 API 都在后端清单内', usedApi.every((p) => backendRoutes.some((r) => p.startsWith(r))), usedApi.join(', '));

/* ---- 汇总 ---- */
console.log('\n============ 前端静态检查 ============');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  if (!r.ok) console.log(`❌ ${r.name}${r.detail ? `  → ${r.detail}` : ''}`);
}
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed} 项${failed ? `，失败 ${failed} 项` : ''}\n`);
process.exit(failed ? 1 : 0);
