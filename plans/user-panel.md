# 普通用户面板（仅接入向导与账号分发）— 实现方案

## Context

当前系统中，管理员创建的普通用户（`role = 'user'`）登录 WebGUI 后仍能看到「总览」「题库管理（含全库导出）」「调用日志」「在线测试」等管理页面，且对应后端接口未限制仅管理员访问；同时普通用户缺少独立的密码修改与 Token 重置入口（原改密入口位于管理员专属的「系统设置」页）。

本次改造目标：
1. **不开放注册**，账号仅由管理员在后台创建与分发；
2. **普通用户面板仅可见**：题库接入向导、顶栏 API 状态、自己的账号自助操作（修改密码、重置搜题 Token）；
3. **服务地址锁定**：普通用户的接入向导固定使用管理员设置的对外服务地址（不展示服务地址输入框，后端对非管理员忽略 `base_url` 参数）；
4. **管理员创号与分发增强**：支持勾选「首次登录强制修改密码」，并提供一键复制账号分发信息；
5. **不进行用户计费**，仅作账号与配置分发。

## Approach

### 1. 后端接口与权限收紧（`src/routes/admin.ts`）

- **收紧为仅管理员可调用（`requireAuth, requireAdmin`）**：
  - `GET /api/questions`、`GET /api/questions/export`
  - `GET /api/logs`
  - `GET /api/stats`
  - `GET /api/settings`
  - `POST /api/debug/solve`
- **保留/增强普通用户可用接口（`requireAuth`）**：
  - `GET /api/auth/me`：返回当前用户信息的同时附带 `ai_configured: runtimeAiConfigs().length > 0`，供普通用户顶栏展示 API 状态。
  - `POST /api/auth/password`：修改当前登录用户密码（并将 `must_change_password` 置为 `0`）。
  - `POST /api/auth/token`（**新增**）：重置当前登录用户自己的搜题 Token（`randomToken(24)`），返回更新后的 `user` 与新 `token`。
  - `GET /api/wizard`：
    - 管理员（`role === 'admin'`）：支持通过 `?token=` 指定任意用户、通过 `?base_url=` 临时指定服务地址；
    - 普通用户（`role === 'user'`）：强制使用 `req.user` 自身 Token，且忽略 `req.query.base_url`，固定使用 `getSetting('public_base_url') || fallback`，并在响应中附带 `ai_configured`。
- **管理员创号与编辑增强（`POST /api/users`、`PATCH /api/users/:id`）**：
  - `POST /api/users` 支持 `must_change_password` 字段（布尔或 0/1）；
  - `PATCH /api/users/:id` 支持更新 `must_change_password` 字段。

### 2. 前端用户面板与管理员分发交互（`public/index.html`、`public/app.js`）

- **侧边栏导航权限（`public/index.html` & `public/app.js`）**：
  - 将 `dashboard`、`questions`、`logs`、`playground` 导航项全部标记为 `.admin-only`，普通用户仅保留 `wizard`（接入向导）一项；
  - `showApp()` 与 `navigate()` 中对非管理员强制限定在 `wizard` 页；
  - `loadCommon()` 中非管理员不再请求 `/api/stats`、`/api/settings`、`/api/providers`，直接根据 `/api/auth/me` 或 `/api/wizard` 返回的 `ai_configured` 更新顶栏 `#ai-status`（显示 `API 正常` / `未配置 AI`）。
- **接入向导与普通用户面板（`renderWizard`）**：
  - **管理员**：保留「使用者账号」下拉选择与「服务地址」输入框；
  - **普通用户**：
    - 不展示「使用者账号」下拉与「服务地址」输入框，仅只读展示当前用户名、当前服务地址；
    - 展示 OCS `AnswererWrapper` 配置一键复制、下载 JSON 及接入步骤说明；
    - 提供**「账号与安全」卡片**：展示当前搜题 Token（支持一键复制、自助重置 Token 并自动刷新配置）以及「修改登录密码」弹窗按钮。
- **管理员用户管理页（`renderUsers`）**：
  - 新建用户弹窗增加「首次登录强制修改密码」复选框（默认勾选）；
  - 新建成功后展示/一键复制**分发信息**（含面板登录地址、用户名、初始密码、搜题 Token），列表操作列也支持一键复制用户的接入分发信息；
  - 编辑用户弹窗支持勾选「下次登录强制修改密码」。

## Files to modify

- `src/routes/admin.ts` — 接口权限收紧（补齐 `requireAdmin`）、新增 `POST /api/auth/token`、锁定普通用户 `/api/wizard` 的 `base_url`、支持 `must_change_password`
- `public/index.html` — 为 `dashboard`、`questions`、`logs`、`playground` 导航项添加 `admin-only` 类
- `public/app.js` — 普通用户单页接入向导面板、自助改密/重置 Token、管理员创号强制改密与一键复制分发信息
- `scripts/ui-check.ts` — `backendRoutes` 补充 `/auth/token`
- `scripts/e2e.ts` — 更新普通用户权限边界测试、测试自助重置 Token 与强制改密参数
- `scripts/ui-browser.ts` — 增加普通用户视角无头浏览器渲染与交互检查

## Reuse

- `src/middleware/auth.ts`：`requireAuth`、`requireAdmin`
- `src/routes/admin.ts`：`buildAnswererWrapper`、`publicUser`
- `src/utils.ts`：`randomToken`、`hashPassword`、`verifyPassword`
- `public/app.js`：`openModal`、`confirmDialog`、`copyText`、`#force-password` 首次登录改密流程

## Steps

- [x] 1. 修改 `src/routes/admin.ts`：为管理接口补齐 `requireAdmin`，新增 `POST /api/auth/token`，在 `/api/auth/me` 与 `/api/wizard` 返回 `ai_configured`，对非管理员锁定 `/api/wizard` 的 `base_url` 与 `token`，并在 `POST /api/users` 和 `PATCH /api/users/:id` 支持 `must_change_password`。
- [x] 2. 修改 `public/index.html` 与 `public/app.js`：收紧普通用户可见导航，实现普通用户专属接入向导面板（锁定服务地址、展示 API 状态、自助重置 Token 与修改密码），并在管理员「用户管理」中支持勾选「首次登录强制修改密码」与一键复制分发信息。
- [x] 3. 更新 `scripts/ui-check.ts`、`scripts/e2e.ts`、`scripts/ui-browser.ts`：同步路由清单，覆盖普通用户 403 边界、自助重置 Token、锁定 `base_url` 及普通用户浏览器 UI 渲染测试。
- [x] 4. 运行 `npm run typecheck` 与 `npm run verify` 完成全量验证并按约定提交 git。

## Verification

1. `npm run typecheck` 通过 TypeScript 严格模式检查。
2. `npm run verify` 全套通过：
   - `smoke`：核心流水线与鉴权冒烟；
   - `e2e`：管理员创号（含 `must_change_password`）、普通用户登录、普通用户访问管理接口返回 403、普通用户 `/api/wizard` 忽略外部 `base_url` 与 `token`、普通用户自助重置 Token 与修改密码；
   - `ui-check`：前后端路由与 DOM 静态检查；
   - `ui-browser`：管理员与普通用户双视角无头浏览器真实渲染无报错。
