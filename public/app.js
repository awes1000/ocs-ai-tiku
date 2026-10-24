/* eslint-disable no-console */
'use strict';

/* ============================ 工具 ============================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  user: null,
  page: 'dashboard',
  settings: {},
  providers: [],
  templates: {},
  defaultsTemplates: {},
  stats: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(sec) {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return String(v);
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', headers: {}, ...opts };
  if (init.body !== undefined && typeof init.body !== 'string') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch('/api' + path, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { code: 0, msg: `HTTP ${res.status}` };
  }
  if (res.status === 401 && path !== '/auth/login') {
    showLogin();
    throw new Error(json.msg || '登录已过期');
  }
  if (json.code !== 1) throw new Error(json.msg || `请求失败(${res.status})`);
  return json.data;
}

/* ============================ 模态框 ============================ */

function openModal(title, bodyHtml, footHtml = '', { wide = false } = {}) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-foot').innerHTML = footHtml;
  $('#modal-foot').classList.toggle('hidden', !footHtml);
  $('.modal-card', modal).classList.toggle('wide', wide);
  modal.classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    openModal(
      title,
      `<p class="muted" style="line-height:1.7">${esc(text)}</p>`,
      `<button class="btn" id="cd-no">取消</button><button class="btn danger" id="cd-yes">确定</button>`,
    );
    $('#cd-no').onclick = () => {
      closeModal();
      resolve(false);
    };
    $('#cd-yes').onclick = () => {
      closeModal();
      resolve(true);
    };
  });
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

/* ============================ 登录 ============================ */

function showLogin() {
  state.user = null;
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  setTimeout(() => $('#login-username').focus(), 60);
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  const u = state.user;
  $('#user-name').textContent = u.username;
  $('#user-role').textContent = u.role === 'admin' ? '管理员' : '普通用户';
  $('#user-avatar').textContent = u.username.slice(0, 1).toUpperCase();
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', u.role !== 'admin'));
  if (u.must_change_password) {
    $('#force-password').classList.remove('hidden');
    $('#fp-old').value = '';
    $('#fp-new').value = '';
    $('#fp-new2').value = '';
  }
  navigate(state.page || 'dashboard');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const errBox = $('#login-error');
  errBox.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: { username: $('#login-username').value.trim(), password: $('#login-password').value },
    });
    state.user = data.user;
    $('#login-password').value = '';
    showApp();
    await loadCommon();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  showLogin();
});

$('#fp-submit').addEventListener('click', async () => {
  const oldPw = $('#fp-old').value;
  const newPw = $('#fp-new').value;
  const newPw2 = $('#fp-new2').value;
  const errBox = $('#fp-error');
  errBox.classList.add('hidden');
  if (newPw.length < 6) {
    errBox.textContent = '新密码至少 6 位';
    errBox.classList.remove('hidden');
    return;
  }
  if (newPw !== newPw2) {
    errBox.textContent = '两次输入的新密码不一致';
    errBox.classList.remove('hidden');
    return;
  }
  try {
    await api('/auth/password', { method: 'POST', body: { old_password: oldPw, new_password: newPw } });
    state.user.must_change_password = 0;
    $('#force-password').classList.add('hidden');
    toast('密码已更新');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

/* ============================ 导航 ============================ */

const PAGES = {
  dashboard: { title: '总览', render: renderDashboard },
  providers: { title: 'AI 配置', render: renderProviders },
  prompts: { title: '提示词模板', render: renderPrompts },
  questions: { title: '题库管理', render: renderQuestions },
  logs: { title: '调用日志', render: renderLogs },
  wizard: { title: '接入向导', render: renderWizard },
  playground: { title: '在线测试', render: renderPlayground },
  users: { title: '用户管理', render: renderUsers },
  settings: { title: '系统设置', render: renderSettings },
};

function navigate(page) {
  if (!PAGES[page]) page = 'dashboard';
  state.page = page;
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $('#page-title').textContent = PAGES[page].title;
  $('#content').innerHTML = '<div class="empty">加载中…</div>';
  PAGES[page]
    .render()
    .catch((err) => {
      $('#content').innerHTML = `<div class="alert error">加载失败：${esc(err.message)}</div>`;
    });
}

$('#nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  navigate(item.dataset.page);
});

$('#refresh-btn').addEventListener('click', () => navigate(state.page));

async function loadCommon() {
  try {
    const [stats, settingsData, providers] = await Promise.all([
      api('/stats'),
      api('/settings'),
      api('/providers'),
    ]);
    state.stats = stats;
    state.settings = settingsData.settings;
    state.templates = settingsData.templates;
    state.defaultsTemplates = settingsData.defaults_templates;
    state.answerShapes = settingsData.answer_shapes;
    state.providers = providers.providers;
    const badge = $('#ai-status');
    badge.textContent = stats.ai_configured ? `AI 已就绪 · ${stats.totals.questions} 题` : '未配置 AI';
    badge.className = `badge ${stats.ai_configured ? 'ok' : 'err'}`;
  } catch (err) {
    console.warn('加载公共数据失败', err);
  }
}

/* ============================ 总览 ============================ */

async function renderDashboard() {
  const stats = await api('/stats');
  state.stats = stats;
  const t = stats.totals;
  const hitRate = t.hit_rate;
  const hitMap = t.hit_map || {};

  const hourly = stats.hourly || [];
  const maxVal = Math.max(1, ...hourly.map((h) => h.total));
  const W = 720;
  const H = 170;
  const pad = 6;
  const bw = hourly.length ? (W - pad * 2) / hourly.length : 10;
  const bars = hourly
    .map((h, i) => {
      const totalH = (h.total / maxVal) * (H - 22);
      const cacheH = (h.cache / maxVal) * (H - 22);
      const x = pad + i * bw;
      const w = Math.max(2, bw - 2.5);
      return `
        <g>
          <rect x="${x}" y="${H - 20 - totalH}" width="${w}" height="${Math.max(1, totalH)}" rx="2" fill="rgba(79,124,255,.35)"></rect>
          <rect x="${x}" y="${H - 20 - cacheH}" width="${w}" height="${Math.max(0, cacheH)}" rx="2" fill="#34c38f"></rect>
          <title>${h.hour} 共 ${h.total} 次（缓存 ${h.cache} / AI ${h.ai}）</title>
        </g>`;
    })
    .join('');

  $('#content').innerHTML = `
    <div class="grid-stats">
      <div class="stat">
        <div class="label">题库总量</div>
        <div class="value">${fmtNum(t.questions)}</div>
        <div class="sub">已沉淀题目数</div>
      </div>
      <div class="stat">
        <div class="label">24 小时请求</div>
        <div class="value">${fmtNum(t.requests_24h)}</div>
        <div class="sub">累计 ${fmtNum(t.requests)} 次</div>
      </div>
      <div class="stat">
        <div class="label">缓存命中率</div>
        <div class="value">${hitRate}%</div>
        <div class="sub">缓存 ${hitMap.cache || 0} · 模糊 ${hitMap.fuzzy || 0} · AI ${hitMap.ai || 0}</div>
      </div>
      <div class="stat">
        <div class="label">24h Token 消耗</div>
        <div class="value">${fmtNum(t.tokens_24h)}</div>
        <div class="sub">累计 ${fmtNum(t.tokens)}</div>
      </div>
      <div class="stat">
        <div class="label">平均响应</div>
        <div class="value">${t.avg_latency_ms}<span style="font-size:13px;color:var(--text-dim)"> ms</span></div>
        <div class="sub">近 24 小时</div>
      </div>
      <div class="stat">
        <div class="label">用户数</div>
        <div class="value">${t.users}</div>
        <div class="sub">${stats.ai_configured ? 'AI 已配置' : '⚠ 未配置 AI'}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>近 24 小时请求分布</h3>
        <span class="muted small">每小时聚合</span>
      </div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>
      <div class="chart-legend">
        <span><i style="background:rgba(79,124,255,.5)"></i>全部请求</span>
        <span><i style="background:#34c38f"></i>缓存命中</span>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
      <div class="card">
        <div class="card-head"><h3>命中类型分布</h3></div>
        ${Object.entries({ cache: '题库缓存', fuzzy: '模糊匹配', ai: 'AI 生成', none: '未命中/失败' })
          .map(([k, label]) => {
            const v = hitMap[k] || 0;
            const pct = t.requests ? Math.round((v / t.requests) * 100) : 0;
            return `<div style="margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
                <span>${label}</span><span class="muted">${v} · ${pct}%</span>
              </div>
              <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${k === 'cache' ? '#34c38f' : k === 'fuzzy' ? '#50a5f1' : k === 'ai' ? '#4f7cff' : '#f46a6a'}"></div>
              </div>
            </div>`;
          })
          .join('')}
      </div>
      <div class="card">
        <div class="card-head"><h3>24 小时活跃用户</h3></div>
        ${
          (stats.top_users || []).length
            ? `<table><thead><tr><th>用户</th><th style="text-align:right">请求数</th></tr></thead><tbody>
                ${stats.top_users
                  .map((u) => `<tr><td>${esc(u.username)}</td><td style="text-align:right">${u.c}</td></tr>`)
                  .join('')}
              </tbody></table>`
            : '<div class="empty">暂无数据</div>'
        }
      </div>
    </div>

    ${
      stats.ai_configured
        ? ''
        : `<div class="alert info">还没有配置 AI 提供商。<a href="#" id="go-ai">前往配置 →</a></div>`
    }
  `;
  const goAi = $('#go-ai');
  if (goAi) {
    goAi.onclick = (e) => {
      e.preventDefault();
      navigate('providers');
    };
  }
}

/* ============================ AI 配置 ============================ */

function providerFormHtml(p = {}) {
  return `
    <div class="field-row">
      <label class="field"><span>名称</span><input id="p-name" value="${esc(p.name || '')}" placeholder="例如 OpenAI / 硅基流动" /></label>
      <label class="field"><span>优先级（大者优先）</span><input id="p-priority" type="number" value="${p.priority ?? 0}" /></label>
    </div>
    <label class="field"><span>Base URL</span><input id="p-base" value="${esc(p.base_url || '')}" placeholder="https://api.openai.com/v1" /></label>
    <label class="field"><span>API Key${p.has_key ? '（留空则保持不变）' : ''}</span><input id="p-key" type="password" placeholder="${p.has_key ? p.api_key : 'sk-...'}" autocomplete="new-password" /></label>
    <div class="field-row">
      <label class="field"><span>模型</span><input id="p-model" value="${esc(p.model || '')}" placeholder="gpt-4o-mini" /></label>
      <label class="field"><span>协议</span>
        <select id="p-type">
          <option value="chat_completions" ${p.api_type !== 'responses' ? 'selected' : ''}>chat_completions（兼容性最好）</option>
          <option value="responses" ${p.api_type === 'responses' ? 'selected' : ''}>responses（OpenAI 新版）</option>
        </select>
      </label>
    </div>
    <div class="field-row">
      <label class="field"><span>Temperature</span><input id="p-temp" type="number" step="0.1" min="0" max="2" value="${p.temperature ?? 0.1}" /></label>
      <label class="field"><span>Max Tokens</span><input id="p-max" type="number" value="${p.max_tokens ?? 1024}" /></label>
      <label class="field"><span>超时(ms)</span><input id="p-timeout" type="number" value="${p.timeout_ms ?? 35000}" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>代理（可选）</span><input id="p-proxy" value="${esc(p.proxy || '')}" placeholder="http://127.0.0.1:7890" /></label>
      <label class="field"><span>启用</span>
        <select id="p-enabled">
          <option value="1" ${p.enabled !== 0 ? 'selected' : ''}>启用</option>
          <option value="0" ${p.enabled === 0 ? 'selected' : ''}>停用</option>
        </select>
      </label>
    </div>
    <label class="field"><span>额外请求头（JSON，可选）</span>
      <textarea id="p-headers" class="code" rows="2" placeholder='{"X-Title":"tiku"}'>${esc(p.extra_headers || '')}</textarea>
    </label>
  `;
}

function readProviderForm() {
  const body = {
    name: $('#p-name').value.trim(),
    priority: Number($('#p-priority').value) || 0,
    base_url: $('#p-base').value.trim(),
    model: $('#p-model').value.trim(),
    api_type: $('#p-type').value,
    temperature: Number($('#p-temp').value),
    max_tokens: Number($('#p-max').value),
    timeout_ms: Number($('#p-timeout').value),
    proxy: $('#p-proxy').value.trim(),
    enabled: $('#p-enabled').value === '1',
    extra_headers: $('#p-headers').value.trim(),
  };
  const key = $('#p-key').value.trim();
  if (key) body.api_key = key;
  return body;
}

async function renderProviders() {
  const data = await api('/providers');
  state.providers = data.providers;
  const list = data.providers;

  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>AI 提供商（按优先级故障切换）</h3>
        <button class="btn primary small" id="add-provider">+ 添加提供商</button>
      </div>
      ${
        list.length
          ? list
              .map(
                (p) => `
        <div class="provider-card ${p.enabled ? '' : 'disabled'}">
          <div class="provider-top">
            <span class="provider-name">${esc(p.name)}</span>
            <span class="badge ${p.enabled ? 'ok' : 'gray'}">${p.enabled ? '启用' : '停用'}</span>
            <span class="badge gray">优先级 ${p.priority}</span>
            <span class="badge">${p.api_type === 'responses' ? 'responses' : 'chat_completions'}</span>
            <span class="spacer"></span>
            <button class="btn small" data-test="${p.id}">测试连接</button>
            <button class="btn small" data-edit="${p.id}">编辑</button>
            <button class="btn small danger" data-del="${p.id}">删除</button>
          </div>
          <div class="kv">
            <span class="k">Base URL</span><span class="v">${esc(p.base_url)}</span>
            <span class="k">模型</span><span class="v">${esc(p.model)}</span>
            <span class="k">API Key</span><span class="v">${esc(p.api_key || '—')}</span>
            <span class="k">参数</span><span class="v">temp=${p.temperature} · max_tokens=${p.max_tokens} · timeout=${p.timeout_ms}ms${p.proxy ? ` · proxy=${esc(p.proxy)}` : ''}</span>
          </div>
        </div>`,
              )
              .join('')
          : '<div class="empty">还没有配置 AI 提供商，点击右上角添加</div>'
      }
    </div>
    <div class="alert info">
      <b>说明：</b>请求会按「优先级从高到低」依次尝试，某个提供商返回 401/403/404 时自动切换下一个；同一题目的并发请求会自动合并，避免重复消耗 token。
    </div>
  `;

  $('#add-provider').onclick = () => {
    openModal(
      '添加 AI 提供商',
      providerFormHtml(),
      `<button class="btn" id="cancel">取消</button><button class="btn" id="test-new">测试连接</button><button class="btn primary" id="save">保存</button>`,
    );
    $('#cancel').onclick = closeModal;
    $('#test-new').onclick = async () => {
      const btn = $('#test-new');
      btn.disabled = true;
      btn.textContent = '测试中…';
      try {
        const r = await api('/providers/test', { method: 'POST', body: readProviderForm() });
        toast(r.ok ? `连接成功 · ${r.latencyMs}ms` : `失败：${r.message}`, r.ok ? 'ok' : 'err');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '测试连接';
      }
    };
    $('#save').onclick = async () => {
      try {
        await api('/providers', { method: 'POST', body: readProviderForm() });
        closeModal();
        toast('已添加');
        await loadCommon();
        renderProviders();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  };

  $$('[data-edit]').forEach((btn) => {
    btn.onclick = () => {
      const p = list.find((x) => x.id === Number(btn.dataset.edit));
      openModal(
        `编辑：${p.name}`,
        providerFormHtml(p),
        `<button class="btn" id="cancel">取消</button><button class="btn" id="test-one">测试连接</button><button class="btn primary" id="save">保存</button>`,
      );
      $('#cancel').onclick = closeModal;
      $('#test-one').onclick = async () => {
        const b = $('#test-one');
        b.disabled = true;
        b.textContent = '测试中…';
        try {
          const r = await api(`/providers/test?id=${p.id}`, { method: 'POST' });
          toast(r.ok ? `连接成功 · ${r.latencyMs}ms（${r.model}）` : `失败：${r.message}`, r.ok ? 'ok' : 'err');
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          b.disabled = false;
          b.textContent = '测试连接';
        }
      };
      $('#save').onclick = async () => {
        try {
          await api(`/providers/${p.id}`, { method: 'PATCH', body: readProviderForm() });
          closeModal();
          toast('已保存');
          await loadCommon();
          renderProviders();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    };
  });

  $$('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      const p = list.find((x) => x.id === Number(btn.dataset.del));
      if (!(await confirmDialog('删除提供商', `确定删除「${p.name}」？此操作不可撤销。`))) return;
      try {
        await api(`/providers/${p.id}`, { method: 'DELETE' });
        toast('已删除');
        await loadCommon();
        renderProviders();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });

  $$('[data-test]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.test;
      btn.disabled = true;
      btn.textContent = '测试中…';
      try {
        const r = await api(`/providers/test?id=${id}`, { method: 'POST' });
        if (r.ok) toast(`连接成功 · ${r.latencyMs}ms · ${r.tokens} tokens`, 'ok');
        else toast(`失败：${r.message}`, 'err');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = '测试连接';
      }
    };
  });
}

/* ============================ 提示词 ============================ */

const TYPE_LABELS = {
  single: '单选题',
  multiple: '多选题',
  judgement: '判断题',
  completion: '填空题',
  unknown: '未知题型',
};

async function renderPrompts() {
  const data = await api('/settings');
  state.templates = data.templates;
  state.defaultsTemplates = data.defaults_templates;
  state.answerShapes = data.answer_shapes;
  const isAdmin = state.user.role === 'admin';
  const types = ['single', 'multiple', 'judgement', 'completion', 'unknown'];

  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>提示词模板</h3>
        <span class="muted small">支持变量 {{title}} / {{options_block}} / {{options}} / {{type}}</span>
      </div>
      <div class="tabs" id="prompt-tabs">
        ${types.map((t, i) => `<div class="tab ${i === 0 ? 'active' : ''}" data-type="${t}">${TYPE_LABELS[t]}</div>`).join('')}
      </div>
      <div id="prompt-editor"></div>
    </div>
    <div class="alert info">
      输出格式约定：${types.map((t) => `<code>${TYPE_LABELS[t]} → ${esc(JSON.stringify(state.answerShapes?.[t] || ''))}</code>`).join(' · ')}
      <br />修改后立即生效（新请求使用新模板）。
    </div>
  `;

  const renderEditor = (type) => {
    $('#prompt-editor').innerHTML = `
      <label class="field"><span>${TYPE_LABELS[type]}模板</span>
        <textarea id="tpl-editor" class="code" rows="16" ${isAdmin ? '' : 'readonly'}>${esc(state.templates[type] || '')}</textarea>
      </label>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn small" id="tpl-default">恢复默认</button>
        ${isAdmin ? '<button class="btn primary small" id="tpl-save">保存模板</button>' : ''}
      </div>
    `;
    $('#tpl-default').onclick = () => {
      $('#tpl-editor').value = state.defaultsTemplates[type] || '';
      toast('已填入默认模板，记得保存');
    };
    const save = $('#tpl-save');
    if (save) {
      save.onclick = async () => {
        try {
          const v = $('#tpl-editor').value;
          await api('/settings', {
            method: 'PUT',
            body: { settings: { [`prompt_${type}`]: v === state.defaultsTemplates[type] ? '' : v } },
          });
          state.templates[type] = v;
          toast('模板已保存');
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    }
  };
  renderEditor('single');
  $('#prompt-tabs').onclick = (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('.tab', $('#prompt-tabs')).forEach((t) => t.classList.toggle('active', t === tab));
    renderEditor(tab.dataset.type);
  };
}

/* ============================ 题库管理 ============================ */

const qState = { page: 1, pageSize: 20, keyword: '', type: '', source: '' };

async function renderQuestions() {
  const params = new URLSearchParams({
    page: String(qState.page),
    page_size: String(qState.pageSize),
    keyword: qState.keyword,
    type: qState.type,
    source: qState.source,
  });
  const data = await api('/questions?' + params.toString());
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));

  $('#content').innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="q-keyword" placeholder="搜索题目 / 答案" value="${esc(qState.keyword)}" style="min-width:220px" />
        <select id="q-type">
          <option value="">全部题型</option>
          ${Object.entries(TYPE_LABELS)
            .filter(([k]) => k !== 'unknown')
            .map(([k, v]) => `<option value="${k}" ${qState.type === k ? 'selected' : ''}>${v}</option>`)
            .join('')}
        </select>
        <select id="q-source">
          <option value="">全部来源</option>
          <option value="ai" ${qState.source === 'ai' ? 'selected' : ''}>AI 生成</option>
          <option value="manual" ${qState.source === 'manual' ? 'selected' : ''}>手动录入</option>
          <option value="import" ${qState.source === 'import' ? 'selected' : ''}>批量导入</option>
        </select>
        <button class="btn small" id="q-search">搜索</button>
        <span class="spacer"></span>
        <button class="btn small" id="q-add">+ 新增</button>
        <button class="btn small" id="q-import">导入</button>
        <button class="btn small" id="q-export-json">导出 JSON</button>
        <button class="btn small" id="q-export-csv">导出 CSV</button>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:36px"><input type="checkbox" id="q-all" style="width:auto" /></th>
              <th>题目</th>
              <th style="width:70px">题型</th>
              <th style="width:180px">答案</th>
              <th style="width:60px">命中</th>
              <th style="width:90px">来源</th>
              <th style="width:140px">更新时间</th>
              <th style="width:120px"></th>
            </tr>
          </thead>
          <tbody>
            ${
              data.questions.length
                ? data.questions
                    .map(
                      (q) => `
              <tr>
                <td><input type="checkbox" class="q-check" value="${q.id}" style="width:auto" /></td>
                <td title="${esc(q.title)}">${esc(q.title.length > 80 ? q.title.slice(0, 80) + '…' : q.title)}</td>
                <td><span class="badge gray">${TYPE_LABELS[q.type] || q.type}</span></td>
                <td>
                  <div style="max-height:52px;overflow:hidden;font-size:12.5px">${esc(q.answer || '—')}</div>
                  ${q.answer_letter ? `<span class="badge">${esc(q.answer_letter)}</span>` : ''}
                </td>
                <td>${q.hits}</td>
                <td><span class="badge ${q.source === 'ai' ? '' : 'gray'}">${q.source === 'ai' ? 'AI' : q.source === 'manual' ? '手动' : '导入'}</span></td>
                <td class="small muted">${fmtTime(q.updated_at)}</td>
                <td class="actions">
                  <button class="btn small" data-qedit="${q.id}">编辑</button>
                  <button class="btn small danger" data-qdel="${q.id}">删除</button>
                </td>
              </tr>`,
                    )
                    .join('')
                : '<tr><td colspan="8"><div class="empty">没有匹配的题目</div></td></tr>'
            }
          </tbody>
        </table>
      </div>

      <div class="pager">
        <span>共 ${data.total} 条 · 第 ${data.page}/${totalPages} 页</span>
        <button class="btn small" id="q-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn small" id="q-next" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button>
        <button class="btn small danger" id="q-del-selected">删除所选</button>
      </div>
    </div>
  `;

  const reload = () => renderQuestions();
  $('#q-search').onclick = () => {
    qState.keyword = $('#q-keyword').value.trim();
    qState.type = $('#q-type').value;
    qState.source = $('#q-source').value;
    qState.page = 1;
    reload();
  };
  $('#q-keyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#q-search').click();
  });
  $('#q-prev').onclick = () => {
    qState.page = Math.max(1, qState.page - 1);
    reload();
  };
  $('#q-next').onclick = () => {
    qState.page = Math.min(totalPages, qState.page + 1);
    reload();
  };
  $('#q-all').onchange = (e) => $$('.q-check').forEach((c) => (c.checked = e.target.checked));

  $('#q-del-selected').onclick = async () => {
    const ids = $$('.q-check')
      .filter((c) => c.checked)
      .map((c) => Number(c.value));
    if (!ids.length) return toast('请先选择题目', 'err');
    if (!(await confirmDialog('批量删除', `确定删除选中的 ${ids.length} 条题目？`))) return;
    try {
      await api('/questions/delete', { method: 'POST', body: { ids } });
      toast(`已删除 ${ids.length} 条`);
      reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $$('[data-qedit]').forEach((btn) => {
    btn.onclick = () => {
      const q = data.questions.find((x) => x.id === Number(btn.dataset.qedit));
      openModal(
        '编辑题目',
        `
        <label class="field"><span>题目</span><textarea id="eq-title" rows="3">${esc(q.title)}</textarea></label>
        <div class="field-row">
          <label class="field"><span>题型</span>
            <select id="eq-type">
              ${Object.entries(TYPE_LABELS)
                .filter(([k]) => k !== 'unknown')
                .map(([k, v]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${v}</option>`)
                .join('')}
            </select>
          </label>
          <label class="field"><span>命中的答案字母</span><input id="eq-letter" value="${esc(q.answer_letter || '')}" placeholder="如 B / ABD" /></label>
        </div>
        <label class="field"><span>选项（每行一个）</span><textarea id="eq-options" class="code" rows="4">${esc(q.options || '')}</textarea></label>
        <label class="field"><span>答案（多选用 # 连接）</span><textarea id="eq-answer" rows="3">${esc(q.answer || '')}</textarea></label>
        <div class="muted small">模型：${esc(q.model || '—')} · 命中 ${q.hits} 次 · 创建于 ${fmtTime(q.created_at)}</div>
        `,
        `<button class="btn" id="cancel">取消</button><button class="btn primary" id="save">保存</button>`,
      );
      $('#cancel').onclick = closeModal;
      $('#save').onclick = async () => {
        try {
          await api(`/questions/${q.id}`, {
            method: 'PATCH',
            body: {
              title: $('#eq-title').value,
              type: $('#eq-type').value,
              options: $('#eq-options').value,
              answer: $('#eq-answer').value,
              answer_letter: $('#eq-letter').value,
            },
          });
          closeModal();
          toast('已保存');
          reload();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    };
  });

  $$('[data-qdel]').forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog('删除题目', '确定删除该题目？'))) return;
      try {
        await api(`/questions/${btn.dataset.qdel}`, { method: 'DELETE' });
        toast('已删除');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });

  $('#q-add').onclick = () => {
    openModal(
      '新增题目',
      `
      <label class="field"><span>题目</span><textarea id="nq-title" rows="3"></textarea></label>
      <div class="field-row">
        <label class="field"><span>题型</span>
          <select id="nq-type">
            ${Object.entries(TYPE_LABELS)
              .filter(([k]) => k !== 'unknown')
              .map(([k, v]) => `<option value="${k}">${v}</option>`)
              .join('')}
          </select>
        </label>
        <label class="field"><span>答案字母</span><input id="nq-letter" placeholder="如 B / ABD" /></label>
      </div>
      <label class="field"><span>选项（每行一个，单选题必填）</span><textarea id="nq-options" class="code" rows="4"></textarea></label>
      <label class="field"><span>答案（多选题用 # 连接）</span><textarea id="nq-answer" rows="3"></textarea></label>
      `,
      `<button class="btn" id="cancel">取消</button><button class="btn primary" id="save">保存</button>`,
    );
    $('#cancel').onclick = closeModal;
    $('#save').onclick = async () => {
      try {
        await api('/questions', {
          method: 'POST',
          body: {
            title: $('#nq-title').value,
            type: $('#nq-type').value,
            options: $('#nq-options').value,
            answer: $('#nq-answer').value,
            answer_letter: $('#nq-letter').value,
          },
        });
        closeModal();
        toast('已新增');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  };

  $('#q-import').onclick = () => {
    openModal(
      '导入题库',
      `
      <p class="muted small" style="line-height:1.7">
        支持三种格式：<br />
        1. JSON 数组：<code>[{"title":"题目","type":"single","options":"A.1\\nB.2","answer":"2","answer_letter":"B"}]</code><br />
        2. 对象：<code>{"questions":[...]}</code><br />
        3. CSV（首行表头：title,type,options,answer,answer_letter）
      </p>
      <label class="field"><span>粘贴内容</span><textarea id="imp-data" class="code" rows="10" placeholder="粘贴 JSON 或 CSV…"></textarea></label>
      <label class="field" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="imp-overwrite" style="width:auto" checked />
        <span style="margin:0">覆盖同题（题目+题型相同）</span>
      </label>
      <input type="file" id="imp-file" accept=".json,.csv,.txt" style="display:none" />
      <button class="btn small" id="imp-pick">选择文件…</button>
      `,
      `<button class="btn" id="cancel">取消</button><button class="btn primary" id="save">开始导入</button>`,
    );
    $('#cancel').onclick = closeModal;
    $('#imp-pick').onclick = () => $('#imp-file').click();
    $('#imp-file').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('#imp-data').value = reader.result;
      };
      reader.readAsText(file, 'utf-8');
    };
    $('#save').onclick = async () => {
      const raw = $('#imp-data').value.trim();
      if (!raw) return toast('请粘贴或选择文件', 'err');
      try {
        const r = await api('/questions/import', {
          method: 'POST',
          body: { data: raw, overwrite: $('#imp-overwrite').checked },
        });
        closeModal();
        toast(`导入完成：成功 ${r.imported} 条，跳过 ${r.skipped} 条`);
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  };

  $('#q-export-json').onclick = () => window.open('/api/questions/export?format=json', '_blank');
  $('#q-export-csv').onclick = () => window.open('/api/questions/export?format=csv', '_blank');
}

/* ============================ 日志 ============================ */

const logState = { page: 1, pageSize: 30, hit: '', keyword: '' };

async function renderLogs() {
  const usersData = state.user.role === 'admin' ? await api('/users') : { users: [state.user] };
  const params = new URLSearchParams({
    page: String(logState.page),
    page_size: String(logState.pageSize),
    hit: logState.hit,
    keyword: logState.keyword,
  });
  if (logState.userId) params.set('user_id', String(logState.userId));
  const data = await api('/logs?' + params.toString());
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
  const HIT_LABEL = { cache: '题库缓存', fuzzy: '模糊匹配', ai: 'AI', none: '未命中' };
  const HIT_CLASS = { cache: 'ok', fuzzy: '', ai: '', none: 'err' };

  $('#content').innerHTML = `
    <div class="card">
      <div class="toolbar">
        <input id="lg-keyword" placeholder="搜索题目" value="${esc(logState.keyword)}" />
        <select id="lg-hit">
          <option value="">全部命中类型</option>
          ${Object.entries(HIT_LABEL).map(([k, v]) => `<option value="${k}" ${logState.hit === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <select id="lg-user">
          <option value="">全部用户</option>
          ${usersData.users.map((u) => `<option value="${u.id}" ${logState.userId === u.id ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}
        </select>
        <button class="btn small" id="lg-search">筛选</button>
        <span class="spacer"></span>
        ${state.user.role === 'admin' ? '<button class="btn small danger" id="lg-clear">清空旧日志</button>' : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:140px">时间</th><th style="width:100px">用户</th><th>题目</th>
            <th style="width:70px">题型</th><th style="width:90px">命中</th><th style="width:70px">耗时</th>
            <th style="width:70px">Token</th><th>信息</th>
          </tr></thead>
          <tbody>
            ${
              data.logs.length
                ? data.logs
                    .map(
                      (l) => `<tr>
                <td class="small muted">${fmtTime(l.created_at)}</td>
                <td class="small">${esc(l.username || '匿名')}</td>
                <td title="${esc(l.title)}">${esc(l.title.length > 60 ? l.title.slice(0, 60) + '…' : l.title)}</td>
                <td class="small">${TYPE_LABELS[l.type] || esc(l.type)}</td>
                <td><span class="badge ${HIT_CLASS[l.hit] || 'gray'}">${HIT_LABEL[l.hit] || l.hit}</span></td>
                <td class="small">${l.latency_ms}ms</td>
                <td class="small">${l.tokens || 0}</td>
                <td class="small muted" title="${esc(l.message || '')}">${esc((l.message || '').slice(0, 50))}</td>
              </tr>`,
                    )
                    .join('')
                : '<tr><td colspan="8"><div class="empty">暂无日志</div></td></tr>'
            }
          </tbody>
        </table>
      </div>
      <div class="pager">
        <span>共 ${data.total} 条 · 第 ${data.page}/${totalPages} 页</span>
        <button class="btn small" id="lg-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn small" id="lg-next" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    </div>
  `;

  $('#lg-search').onclick = () => {
    logState.keyword = $('#lg-keyword').value.trim();
    logState.hit = $('#lg-hit').value;
    logState.userId = Number($('#lg-user').value) || undefined;
    logState.page = 1;
    renderLogs();
  };
  $('#lg-prev').onclick = () => {
    logState.page = Math.max(1, logState.page - 1);
    renderLogs();
  };
  $('#lg-next').onclick = () => {
    logState.page = Math.min(totalPages, logState.page + 1);
    renderLogs();
  };
  const clearBtn = $('#lg-clear');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!(await confirmDialog('清空日志', '将删除 30 天前的日志记录，确定继续？'))) return;
      try {
        const r = await api('/logs?older_than_days=30', { method: 'DELETE' });
        toast(`已删除 ${r.deleted} 条`);
        renderLogs();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }
}

/* ============================ 接入向导 ============================ */

async function renderWizard() {
  const isAdmin = state.user.role === 'admin';
  const usersData = isAdmin ? await api('/users') : { users: [state.user] };
  const baseGuess = window.location.origin;

  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>生成 OCS 题库配置</h3></div>
      <div class="field-row">
        <label class="field"><span>使用者账号</span>
          <select id="wz-user">
            ${usersData.users
              .filter((u) => u.status === 'active')
              .map((u) => `<option value="${esc(u.token)}" ${u.id === state.user.id ? 'selected' : ''}>${esc(u.username)}</option>`)
              .join('')}
          </select>
        </label>
        <label class="field"><span>服务地址（脚本访问用）</span>
          <input id="wz-base" value="${esc(state.settings.public_base_url || baseGuess)}" />
        </label>
      </div>
      <div class="alert info small">
        若 OCS 脚本与后端不在同一台机器的域名下，请把「服务地址」改成脚本能访问到的地址（局域网 IP、公网域名等）。
        使用 <code>GM_xmlhttpRequest</code> 可无视 CORS 与混合内容限制。
      </div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
        <button class="btn primary" id="wz-gen">生成配置</button>
        <button class="btn" id="wz-copy">复制 JSON</button>
        <button class="btn" id="wz-download">下载 JSON</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>AnswererWrapper 配置</h3><span class="muted small">粘贴到 OCS「题库配置」中</span></div>
      <div class="code-block" id="wz-out">点击「生成配置」</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>使用步骤</h3></div>
      <ol style="line-height:2;font-size:13px;padding-left:20px;margin:0">
        <li>打开 OCS 网课助手 →「通用」→「题库配置」，把上面的 JSON 粘贴进去保存。</li>
        <li>若使用全域名通用版脚本，无需修改 <code>@connect</code>；否则需要在脚本头部加上：
          <div class="code-block" id="wz-connect" style="margin-top:6px">// @connect *</div>
        </li>
        <li>在脚本设置里把「题库请求超时」调到 <b>60 秒以上</b>（AI 答题较慢）。</li>
        <li>在「在线测试」页先用同样的题目验证一次，确认返回格式正确。</li>
        <li>答题面板中，AI 生成的答案会显示 <b>AI</b> 蓝色标签，命中题库缓存会显示 <b>题库缓存</b> 标签。</li>
      </ol>
    </div>
  `;

  const gen = async () => {
    const token = $('#wz-user').value;
    const base = $('#wz-base').value.trim();
    try {
      const data = await api(`/wizard?token=${encodeURIComponent(token)}&base_url=${encodeURIComponent(base)}`);
      state.wizard = data;
      $('#wz-out').textContent = data.json;
      $('#wz-connect').textContent = data.connect_hint;
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#wz-gen').onclick = gen;
  $('#wz-copy').onclick = () => {
    if (!state.wizard) return toast('请先生成配置', 'err');
    copyText(state.wizard.json).then(() => toast('已复制到剪贴板'));
  };
  $('#wz-download').onclick = () => {
    if (!state.wizard) return toast('请先生成配置', 'err');
    const blob = new Blob([state.wizard.json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'answerer-wrapper.json';
    a.click();
  };
  await gen();
}

/* ============================ 在线测试台 ============================ */

async function renderPlayground() {
  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>在线搜题测试</h3><span class="muted small">与 OCS 调用完全同构</span></div>
      <div class="field-row">
        <label class="field"><span>题型</span>
          <select id="pg-type">
            ${Object.entries(TYPE_LABELS)
              .filter(([k]) => k !== 'unknown')
              .map(([k, v]) => `<option value="${k}">${v}</option>`)
              .join('')}
          </select>
        </label>
        <label class="field"><span>模式</span>
          <select id="pg-mode">
            <option value="cache">全流程（题库优先，未命中走 AI 并入库）</option>
            <option value="ai">仅 AI（不入库，用于对比效果）</option>
          </select>
        </label>
      </div>
      <label class="field"><span>题目</span><input id="pg-title" placeholder="例如：1+1=?" /></label>
      <label class="field"><span>选项（每行一个，判断题/填空题留空）</span><textarea id="pg-options" class="code" rows="4" placeholder="A.1&#10;B.2&#10;C.3"></textarea></label>
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="pg-send">发送请求</button>
        <button class="btn" id="pg-clear">清空结果</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>响应</h3><span class="muted small" id="pg-meta"></span></div>
      <div id="pg-result"><div class="empty">还没有发送请求</div></div>
    </div>
  `;

  $('#pg-clear').onclick = () => {
    $('#pg-result').innerHTML = '<div class="empty">还没有发送请求</div>';
    $('#pg-meta').textContent = '';
  };

  $('#pg-send').onclick = async () => {
    const btn = $('#pg-send');
    const title = $('#pg-title').value.trim();
    if (!title) return toast('请输入题目', 'err');
    btn.disabled = true;
    btn.textContent = '请求中…';
    const started = Date.now();
    try {
      const out = await api('/debug/solve', {
        method: 'POST',
        body: {
          title,
          type: $('#pg-type').value,
          options: $('#pg-options').value,
          use_cache: $('#pg-mode').value === 'cache',
        },
      });
      const elapsed = Date.now() - started;
      const HIT_LABEL = { cache: '题库缓存', fuzzy: '模糊匹配', ai: 'AI 生成', none: '未命中' };
      $('#pg-meta').textContent = `${out.latencyMs}ms · 命中：${HIT_LABEL[out.hit] || out.hit} · ${out.tokens || 0} tokens${out.model ? ' · ' + out.model : ''}`;
      $('#pg-result').innerHTML = `
        ${
          out.code === 1
            ? out.results
                .map(
                  (r, i) => `<div class="result-item">
            <div class="muted small">result[${i}]</div>
            <div><b>题目：</b>${esc(r[0])}</div>
            <div><b>答案：</b><span style="color:var(--success)">${esc(r[1])}</span></div>
            <div class="muted small">extra_data：${esc(JSON.stringify(r[2] || {}))}</div>
          </div>`,
                )
                .join('')
            : `<div class="alert error">未拿到答案：${esc(out.msg)}</div>`
        }
        <div class="muted small" style="margin-top:10px">原始响应：</div>
        <div class="code-block" style="max-height:220px">${esc(JSON.stringify({ code: out.code, msg: out.msg, data: { results: out.results } }, null, 2))}</div>
      `;
    } catch (err) {
      $('#pg-result').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      $('#pg-meta').textContent = `${Date.now() - started}ms`;
    } finally {
      btn.disabled = false;
      btn.textContent = '发送请求';
    }
  };
}

/* ============================ 用户管理 ============================ */

async function renderUsers() {
  if (state.user.role !== 'admin') {
    $('#content').innerHTML = '<div class="alert error">需要管理员权限</div>';
    return;
  }
  const data = await api('/users');

  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>用户列表</h3>
        <button class="btn primary small" id="u-add">+ 新建用户</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>用户名</th><th style="width:80px">角色</th><th style="width:80px">状态</th>
            <th>搜题 Token</th><th style="width:150px">最后登录</th><th style="width:180px"></th>
          </tr></thead>
          <tbody>
            ${data.users
              .map(
                (u) => `<tr>
              <td>${u.id}</td>
              <td><b>${esc(u.username)}</b>${u.note ? `<div class="muted small">${esc(u.note)}</div>` : ''}</td>
              <td><span class="badge ${u.role === 'admin' ? '' : 'gray'}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
              <td><span class="badge ${u.status === 'active' ? 'ok' : 'err'}">${u.status === 'active' ? '正常' : '停用'}</span></td>
              <td>
                <span class="mono small" style="word-break:break-all">${esc(u.token)}</span>
                <button class="btn small" data-copy-token="${esc(u.token)}" style="margin-left:6px">复制</button>
              </td>
              <td class="small muted">${u.last_login_at ? fmtTime(u.last_login_at) : '从未登录'}</td>
              <td class="actions">
                <button class="btn small" data-u-edit="${u.id}">编辑</button>
                <button class="btn small" data-u-token="${u.id}">重置Token</button>
                <button class="btn small danger" data-u-del="${u.id}">删除</button>
              </td>
            </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="alert info small">
      搜题 Token 用于 OCS 脚本调用 <code>/search</code> 接口，泄露后请立即点「重置Token」并更新脚本里的题库配置。
    </div>
  `;

  const reload = () => renderUsers();

  $$('[data-copy-token]').forEach((btn) => {
    btn.onclick = () => copyText(btn.dataset.copyToken).then(() => toast('Token 已复制'));
  });

  $('#u-add').onclick = () => {
    openModal(
      '新建用户',
      `
      <label class="field"><span>用户名</span><input id="nu-name" placeholder="2-32 位字母/数字/下划线" /></label>
      <label class="field"><span>初始密码</span><input id="nu-pass" type="text" placeholder="至少 6 位" /></label>
      <div class="field-row">
        <label class="field"><span>角色</span>
          <select id="nu-role"><option value="user">普通用户</option><option value="admin">管理员</option></select>
        </label>
        <label class="field"><span>备注</span><input id="nu-note" /></label>
      </div>
      `,
      `<button class="btn" id="cancel">取消</button><button class="btn primary" id="save">创建</button>`,
    );
    $('#cancel').onclick = closeModal;
    $('#save').onclick = async () => {
      try {
        await api('/users', {
          method: 'POST',
          body: {
            username: $('#nu-name').value.trim(),
            password: $('#nu-pass').value,
            role: $('#nu-role').value,
            note: $('#nu-note').value,
          },
        });
        closeModal();
        toast('用户已创建');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  };

  $$('[data-u-edit]').forEach((btn) => {
    btn.onclick = () => {
      const u = data.users.find((x) => x.id === Number(btn.dataset.uEdit));
      openModal(
        `编辑用户：${u.username}`,
        `
        <label class="field"><span>新密码（留空则不修改）</span><input id="eu-pass" type="text" /></label>
        <div class="field-row">
          <label class="field"><span>角色</span>
            <select id="eu-role">
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>普通用户</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理员</option>
            </select>
          </label>
          <label class="field"><span>状态</span>
            <select id="eu-status">
              <option value="active" ${u.status === 'active' ? 'selected' : ''}>正常</option>
              <option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>停用</option>
            </select>
          </label>
        </div>
        <label class="field"><span>备注</span><input id="eu-note" value="${esc(u.note || '')}" /></label>
        <div class="muted small">创建于 ${fmtTime(u.created_at)}</div>
        `,
        `<button class="btn" id="cancel">取消</button><button class="btn primary" id="save">保存</button>`,
      );
      $('#cancel').onclick = closeModal;
      $('#save').onclick = async () => {
        const body = { role: $('#eu-role').value, status: $('#eu-status').value, note: $('#eu-note').value };
        if ($('#eu-pass').value) body.password = $('#eu-pass').value;
        try {
          await api(`/users/${u.id}`, { method: 'PATCH', body });
          closeModal();
          toast('已保存');
          reload();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    };
  });

  $$('[data-u-token]').forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog('重置 Token', '重置后旧 Token 立即失效，需要更新脚本配置。确定继续？'))) return;
      try {
        const r = await api(`/users/${btn.dataset.uToken}`, { method: 'PATCH', body: { regenerate_token: true } });
        await copyText(r.user.token);
        toast('新 Token 已生成并复制');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });

  $$('[data-u-del]').forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog('删除用户', '确定删除该用户？该用户的登录会话会被清除。'))) return;
      try {
        await api(`/users/${btn.dataset.uDel}`, { method: 'DELETE' });
        toast('已删除');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  });
}

/* ============================ 系统设置 ============================ */

async function renderSettings() {
  if (state.user.role !== 'admin') {
    $('#content').innerHTML = '<div class="alert error">需要管理员权限</div>';
    return;
  }
  const data = await api('/settings');
  state.settings = data.settings;
  const s = data.settings;

  $('#content').innerHTML = `
    <div class="card">
      <div class="card-head"><h3>答题行为</h3></div>
      <div class="field-row">
        <label class="field"><span>模糊匹配阈值（0.5 ~ 1，越小越宽松）</span>
          <input id="st-fuzzy" type="number" step="0.01" min="0.5" max="1" value="${esc(s.fuzzy_threshold)}" />
        </label>
        <label class="field"><span>每分钟请求上限（0 = 不限）</span>
          <input id="st-rate" type="number" min="0" value="${esc(s.rate_limit_per_min)}" />
        </label>
      </div>
      <div class="field-row">
        <label class="field"><span>题库缓存</span>
          <select id="st-cache"><option value="1" ${s.enable_cache === '1' ? 'selected' : ''}>开启</option><option value="0" ${s.enable_cache === '0' ? 'selected' : ''}>关闭</option></select>
        </label>
        <label class="field"><span>模糊匹配</span>
          <select id="st-fuzzymode"><option value="1" ${s.enable_fuzzy === '1' ? 'selected' : ''}>开启</option><option value="0" ${s.enable_fuzzy === '0' ? 'selected' : ''}>关闭</option></select>
        </label>
        <label class="field"><span>AI 答题</span>
          <select id="st-ai"><option value="1" ${s.enable_ai === '1' ? 'selected' : ''}>开启</option><option value="0" ${s.enable_ai === '0' ? 'selected' : ''}>关闭</option></select>
        </label>
        <label class="field"><span>AI 失败重试</span>
          <select id="st-retry"><option value="1" ${s.ai_retry === '1' ? 'selected' : ''}>开启</option><option value="0" ${s.ai_retry === '0' ? 'selected' : ''}>关闭</option></select>
        </label>
      </div>
      <label class="field"><span>对外服务地址（用于生成 AnswererWrapper）</span>
        <input id="st-base" value="${esc(s.public_base_url || '')}" placeholder="留空则使用当前访问地址" />
      </label>
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="st-save">保存设置</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>修改我的密码</h3></div>
      <div class="field-row">
        <label class="field"><span>原密码</span><input id="st-oldpw" type="password" /></label>
        <label class="field"><span>新密码</span><input id="st-newpw" type="password" /></label>
      </div>
      <button class="btn" id="st-chpw">更新密码</button>
    </div>

    <div class="card">
      <div class="card-head"><h3>数据维护</h3></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" id="st-backup">下载备份（脱敏）</button>
        <button class="btn danger" id="st-clearlogs">清空全部日志</button>
      </div>
      <div class="alert info small" style="margin-top:14px">
        备份包含题库、设置、日志与用户表结构，但会隐去密码哈希、Token 与 API Key。
      </div>
    </div>
  `;

  $('#st-save').onclick = async () => {
    try {
      await api('/settings', {
        method: 'PUT',
        body: {
          settings: {
            fuzzy_threshold: $('#st-fuzzy').value,
            rate_limit_per_min: $('#st-rate').value,
            enable_cache: $('#st-cache').value,
            enable_fuzzy: $('#st-fuzzymode').value,
            enable_ai: $('#st-ai').value,
            ai_retry: $('#st-retry').value,
            public_base_url: $('#st-base').value.trim(),
          },
        },
      });
      toast('设置已保存');
      await loadCommon();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#st-chpw').onclick = async () => {
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { old_password: $('#st-oldpw').value, new_password: $('#st-newpw').value },
      });
      toast('密码已更新');
      $('#st-oldpw').value = '';
      $('#st-newpw').value = '';
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#st-backup').onclick = () => window.open('/api/backup', '_blank');
  $('#st-clearlogs').onclick = async () => {
    if (!(await confirmDialog('清空日志', '将删除全部调用日志，确定继续？'))) return;
    try {
      const r = await api('/logs', { method: 'DELETE' });
      toast(`已删除 ${r.deleted} 条日志`);
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

/* ============================ 启动 ============================ */

(async function boot() {
  try {
    const data = await api('/auth/me');
    state.user = data.user;
    showApp();
    await loadCommon();
  } catch {
    showLogin();
  }
})();
