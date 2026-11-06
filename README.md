# OCS AI 题库后端

自托管的 **AI 题库后端**，给 [OCS 网课助手](https://github.com/ocsjs/ocsjs)（userscript）用：
OCS 通过 `AnswererWrapper` 把每道题发过来，后端先查本地题库（精确 → 模糊），未命中才调 LLM，
AI 的答案会自动沉淀进题库，下次同类题直接走缓存。

自带完整 WebGUI：AI 配置 / 提示词 / 题库管理 / 用户管理 / 日志统计 / 在线测试 / 一键导出接入配置。

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Arch](https://img.shields.io/badge/arch-x64%20%7C%20arm64-blue)](#八部署提示)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-178%20checks-brightgreen)](./scripts/verify.ts)

```
OCS 脚本 ──POST /search──▶ 后端 ──▶ 题库命中？ ──是──▶ 直接返回（cache/fuzzy 标签）
                                    └─否──▶ LLM ──▶ 入库 ──▶ 返回（ai 标签）
```

---

## 快速开始

```bash
# 1. 安装依赖（Node.js ≥ 20.18）
npm install

# 2. 配置（可选，也可先启动再在 WebGUI 里配）
copy .env.example .env

# 3. 启动
npm start
```

首次启动会在控制台打印初始管理员账号与搜题 Token：

```
================================================================
  已创建初始管理员账号（请登录后立即修改密码）
  用户名: admin
  密码  : xxxxxxxxx
  搜题Token: xxxxxxxxxxxxxxxxxxxxx
  控制台: http://127.0.0.1:8060/
================================================================
```

打开 `http://127.0.0.1:8060/` → 登录 → **AI 配置** 里添加一个提供商（填 Base URL / API Key / 模型）→
**接入向导** 复制 JSON → 粘到 OCS 题库配置里即可。

> 想直接指定账号密码：在 `.env` 里设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`。

---

## 一、接口契约

### `GET | POST /search`

| 参数 | 说明 |
|---|---|
| `title` | 题目文本（必填） |
| `type` | `single` / `multiple` / `judgement` / `completion` / `unknown` |
| `options` | 选项，`\n` 分隔（填空题留空） |
| `suggestion_title` | 图片题优化：题干（图片地址被替换成 `[图片1]` 占位） |
| `suggestion_options` | 图片题优化：选项（同上） |
| `images` | 图片题优化：图片数组（OCS 传 base64 data URL，也接受 http(s) 地址） |
| `token` | 用户搜题 Token，也可用 `Authorization: Bearer <token>` |

成功响应：

```json
{
  "code": 1,
  "msg": "ok",
  "data": {
    "question": "中国梦是什么？",
    "type": "single",
    "hit": "ai",                       // cache | fuzzy | ai
    "results": [
      ["中国梦是什么？", "实现中华民族伟大复兴", { "ai": true }],
      ["中国梦是什么？", "B", { "ai": true }]
    ],
    "latency_ms": 1820,
    "model": "gpt-4o-mini",
    "images": 2                       // 仅图片题：本次带了几张图（图片题不缓存）
  }
}
```

失败响应：`{ "code": 0, "msg": "原因" }`

> `extra_data.ai === true` → OCS 结果面板显示蓝色 **AI** 标签；
> `extra_data.cache === true` → 显示 **题库缓存** 标签（模糊命中额外带 `fuzzy: 0.93` 表示相似度）。

### 答案格式（对齐 OCS 匹配逻辑）

| 题型 | 返回内容 |
|---|---|
| single | 第 1 条 = 选项原文，第 2 条 = 答案字母（`B`） |
| multiple | 第 1 条 = 选项原文用 `#` 连接，第 2 条 = 字母串（`ABD`） |
| judgement | `对` / `错` |
| completion | 各空答案用 `#` 连接（空数 = 下划线数量） |

其他接口：

- `POST /search/ai` — 同 `/search` 但强制走 AI（不入缓存），WebGUI 测试台用
- `GET /health` — 健康检查

### 探活（OCS 面板的「连接检测」）

OCS 题库卡片上的状态徽标不是真的搜题，而是 `HEAD /search?t=<时间戳>`（HEAD 返回 405/501 时退回 GET），**不带 token**。
后端对这类「没带 token 且没带题目」的探活请求直接回 `204` / `200`（`{code:1,data:{probe:true}}`，带 `cache-control: no-store`），
所以面板会显示「连接成功」，不会出现「连接失败（401）」。

> 带 `title` 的请求（真正搜题）仍然必须带有效 token，无 token 一律 401。
> 如果面板探活成功、但搜题日志里都是 401，那是 token 不对（例如在 WebGUI「重置 Token」后还在用旧配置）——
> 重新在「接入向导」生成配置即可。

### 图片题 / 公式题（OCS「图片题优化」）

OCS 开启「图片题优化」后，会把题干/选项里的图片转成 base64，并把题干中的图片地址替换成
`[图片1]`、`[图片2]` 这样的占位，额外提交三个字段：`images` / `suggestion_title` / `suggestion_options`
（见 [OCS API 文档](https://docs.ocsjs.com/docs/other/api)）。

本后端的处理：

1. `images` 走多模态消息直接发给模型（`chat_completions` 用 `image_url`，`responses` 用 `input_image`）；
2. 题干/选项优先用 `suggestion_title` / `suggestion_options`（带 `[图片N]` 占位），提示词会附加「先读图再作答」；
3. 最多取 8 张图、单张 ≤ 3M 字符、总量 ≤ 6M 字符；`undefined` / 非图片地址自动丢弃；
4. **图片题跳过题库缓存，答案也不入库**（同题干不同图会互相污染）；
5. 模型/网关不支持多模态时，自动降级为纯文本再试一次（此时模型只能看到 `[图片N]` 占位）。

> 「接入向导」生成的配置已声明这三个字段（`handler` 形式，无图时回退为空/原值），
> 所以 OCS 不会再提示「当前题库配置暂不支持图片、公式等题目处理」。

---

## 二、OCS 接入

**接入向导**页会按当前账号和访问地址自动生成。注意 OCS 的「题库配置」**必须是 JSON 数组**，所以生成结果是 `[{...}]`：

```json
[
  {
    "name": "OCS AI 题库（admin）",
    "type": "GM_xmlhttpRequest",
    "method": "post",
    "url": "http://127.0.0.1:8060/search",
    "contentType": "json",
    "headers": { "Content-Type": "application/json" },
    "data": {
      "title": "${title}",
      "type": "${type}",
      "options": "${options}",
      "token": "你的搜题Token",
      "suggestion_title": { "handler": "return (env) => env.suggestion_title || env.title" },
      "suggestion_options": { "handler": "return (env) => env.suggestion_options !== undefined ? env.suggestion_options : env.options" },
      "images": { "handler": "return (env) => env.images || []" }
    },
    "handler": "return (res) => { try { if (res && typeof res === 'string') res = JSON.parse(res); } catch (e) { return [String(res), undefined]; } if (res && res.code === 1 && res.data && Array.isArray(res.data.results) && res.data.results.length) return res.data.results; return [(res && res.msg) || '未找到答案', undefined]; }"
  }
]
```

> 一定要保留外层的 `[ ]`。OCS 解析粘贴内容是 `awsResult.push(...JSON.parse(文本))`，
> 如果粘单个 `{...}` 对象，会报 `Spread syntax requires ...iterable[Symbol.iterator] to be a function`（「解析失败」弹窗）。

要点：

1. `type: "GM_xmlhttpRequest"` 走油猴通道，**无视 CORS 与 HTTPS/HTTP 混合内容**，不用给后端配证书。
2. 如果不是「全域名通用版」脚本，需要在脚本头部加 `@connect`：
   ```js
   // @connect 你的域名或IP
   // @connect *
   ```
3. OCS 默认题库超时 60s（脚本设置里可调到 180s），后端 AI 调用默认 35s 超时 + 1 次重试，
   整体压在默认超时内；网络较慢时建议把脚本超时调到 **90s 以上**。
4. 脚本与后端不在同一台机器时，把「服务地址」改成脚本能访问的地址（局域网 IP / 公网域名）。
5. `data` 里的 `suggestion_title` / `suggestion_options` / `images` 用 `handler` 形式：
   OCS 开启「图片题优化」时会把图片 base64 与 `[图片N]` 占位的题干一并提交；
   未开启时这些 handler 分别回退为 `env.title` / `env.options` / `[]`，不会把 `undefined` 当字符串发出去。
   只要配置里有这三个字段，OCS 就不会再提示「当前题库配置暂不支持图片、公式等题目处理」。
6. **套了 Cloudflare / Nginx 反代时**：
   - 探活是 `HEAD /search`，CDN 需允许 HEAD（Cloudflare 默认允许）；后端已给探活响应加 `no-store`，不会被缓存；
   - 真正搜题都是 `POST`，默认也不会被 CDN 缓存；
   - 若开了 **Cloudflare Access / 托管 Challenge / WAF 拦截**，`GM_xmlhttpRequest` 会拿到 `401/403`
     （页面上报的 401 也可能来自它们，而不是后端），需要在 CF 侧对该域名放行（Access 跳过策略 / 关闭 challenge），
     而不是改后端。
   - 反向代理不要改写或缓存 `/search`；如果只代理了页面却漏了 `/search` 路径，也会得到非后端返回的 4xx。

---

## 三、答题流水线

1. **精确命中**：`title` 归一化（去题号、标点、空白）后与题库比对（题型相同）。
2. **模糊命中**：Dice 相似度（`string-similarity`，与 OCS 同款算法）≥ 阈值（默认 `0.9`，可在系统设置里调）。
   命中后会**按本次选项顺序重新映射**：把入库时记录的选项文本映射回当前的 A/B/C 序号，
   所以同一道题选项顺序变了也不会答错。
3. **AI 答题**：按题型套用提示词，要求模型严格输出 JSON：
   - single → `{"answer":"B"}`、multiple → `{"answer":"ABD"}`、judgement → `{"answer":"对"}`
   - completion → `{"answer":["空1","空2"]}`、unknown → `{"answer":"答案文本"}`
   - 图片题（OCS 图片优化）→ 图片作为多模态 part 一起发给模型，提示词里 `[图片N]` 与图片顺序一一对应
4. 服务端把字母映射回选项原文，返回「文本 + 字母」两条结果，同时把题目/选项/答案/模型/命中数入库。
   **图片题不入库、也不读缓存**（答案依赖具体图片）。
5. **并发合并**：同一道题的并发请求共享一次 AI 调用，不会重复烧 token。
6. **故障切换**：多套 AI 提供商按优先级依次尝试，401/403/404 自动换下一个。

---

## 四、WebGUI 功能

| 页面 | 功能 |
|---|---|
| 总览 | 题库量、24h 请求、缓存命中率、Token 消耗、平均耗时、24h 分布图、命中类型占比 |
| AI 配置 | 多提供商（base_url / key / model / responses·chat_completions / 温度 / max_tokens / 超时 / 代理 / 额外 header / 优先级），支持「测试连接」 |
| 提示词 | 分题型模板编辑（单选/多选/判断/填空/未知），支持 `{{title}}` `{{options_block}}` 等变量，可一键恢复默认 |
| 题库管理 | 搜索、筛选、编辑、单条/批量删除、JSON/CSV 导入导出 |
| 调用日志 | 按用户 / 命中类型 / 题目关键字筛选，清空旧日志 |
| 接入向导 | 管理员：选账号 → 生成完整 AnswererWrapper JSON；普通用户：只看自己的配置 |
| 在线测试 | 与 OCS 完全同构的请求测试，「全流程」或「仅 AI」两种模式，直接看到 results 结构 |
| 用户管理 | 建用户（可勾选首次登录强制改密）、改密、改角色、停用、重置搜题 Token、一键复制分发信息 |
| 系统设置 | 模糊阈值、限流、缓存/AI 开关、对外地址、改密、脱敏备份下载 |

### 账号体系：不开放注册，只做分发

- **只有管理员能建号**，面板无注册入口；新建用户后可一键复制「登录地址 + 用户名 + 初始密码 + 搜题 Token」发给对方。
- **普通用户登录后只有「接入向导」一个页面**：顶栏显示 API 状态，页面展示自己的搜题 Token 与
  已生成的 OCS 题库配置（一键复制 / 下载），以及「修改登录密码」「重置 Token」两个自助操作。
  服务地址由管理员在「系统设置」里统一配置，普通用户无权修改。
- 总览 / AI 配置 / 提示词 / 题库管理 / 调用日志 / 在线测试 / 用户管理 / 系统设置 全部仅管理员可见、
  仅管理员可调用（普通用户直接请求会得到 403）。
- **不做计费**：只做账号与配置分发，调用日志只用于排障。

鉴权：用户名 + 密码登录 → **httpOnly Cookie 会话**（DB 存储、可撤销，密码 scrypt 加盐）。
搜题接口用每用户独立 Token，日志按 Token 归属到用户。

---

## 五、配置项（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8060` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/tiku.db` | SQLite 路径 |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | 反向代理信任策略（`true` 全部信任 / `false` 不信任） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / 随机 | 首次启动创建的管理员；密码为空则随机生成并打印 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 空 | AI 兜底配置（WebGUI 里配置优先） |
| `AI_API_TYPE` | `chat_completions` | `responses` 或 `chat_completions` |
| `AI_TEMPERATURE` / `AI_MAX_TOKENS` / `AI_TIMEOUT_MS` | 0.1 / 1024 / 35000 | 生成参数与超时 |
| `AI_PROXY` | 空 | HTTP 代理，如 `http://127.0.0.1:7890` |
| `ALLOW_ANONYMOUS` | `false` | 是否允许不带 token 搜题 |

---

## 六、数据库结构

| 表 | 说明 |
|---|---|
| `users` | 用户、角色、搜题 token、scrypt 密码哈希、状态 |
| `questions` | 题目、归一化题目、题型、选项快照、答案（原文 + 字母）、来源、模型、命中次数 |
| `requests` | 调用日志：用户、题目、命中类型、状态、耗时、token 数 |
| `providers` | 多套 AI 提供商配置（含优先级、启用开关） |
| `settings` | key/value 全局设置 + 提示词模板 |
| `sessions` | WebGUI 会话（只存 token 的 SHA-256） |

---

## 七、常用命令

```bash
npm start         # 启动服务
npm run dev       # 带热重载
npm run typecheck # TS 类型检查
npm run smoke     # 冒烟测试（内置 mock LLM，35 项断言，不消耗真实 token）
npm run verify    # 一键回归：冒烟 + 后端端到端 + 前端静态检查 + 无头浏览器渲染
```

`npm run smoke` 会起一个假的 OpenAI 兼容服务，验证：
归一化/答案映射/LLM 解析 → AI 首次命中 → 二次缓存 → 措辞变化模糊命中 → 多选/判断/填空 →
HTTP 鉴权、登录会话、统计、接入向导、题库接口。

`npm run verify` 会启动一个临时实例（临时数据库，跑完自动清理）并依次执行：

| 阶段 | 内容 |
|---|---|
| 冒烟测试 | 40 项：纯函数 + mock LLM 全流水线 |
| 后端端到端 | 75 项：登录/改密/登出、提供商增删改测、设置、提示词、用户 CRUD、普通用户权限边界、自助重置 Token / 改密、题库 CRUD/导入导出、日志统计、接入向导 handler 实测 |
| 前端静态检查 | 81 项：app.js 语法、DOM ID 引用、页面函数、导航映射、普通用户导航权限、API 路径与后端一致性 |
| 浏览器渲染 | 39 项：无头 Chrome 真实登录（管理员 + 普通用户双视角）、逐个页面渲染无异常、测试台真实请求、弹窗与自助改密交互（截图存 `data/shot/`） |

---

## 八、部署提示

### 1. 原生运行（x64 / ARM64）

- 单进程即可：`node_modules/.bin/tsx src/index.ts`（或 `npm start`），数据都在 `data/tiku.db`（WAL 模式）。
- **多架构兼容（x64 / ARM64）**：`better-sqlite3` 在主流 Linux/macOS/Windows 的 x64 与 ARM64（如树莓派、Apple Silicon、Oracle ARM、NAS）下会自动拉取预编译二进制；若在特殊发行版或新 Node ABI 下回退源码编译，请确保系统已安装 `python3`、`make`、`g++`（Debian/Ubuntu：`apt install -y python3 make g++`）。
- 长期运行建议用 PM2 / systemd / NSSM 托管，服务已内置 `SIGINT` / `SIGTERM` 优雅停机与 WAL 落盘。

### 2. Docker / Docker Compose 部署（支持 `linux/amd64` 与 `linux/arm64`）

```bash
# 一键构建并后台启动（数据持久化在 ./data）
docker compose up -d --build

# 查看首次启动生成的初始管理员密码与 Token
docker compose logs -f

# 多架构镜像构建示例（Buildx）
docker buildx build --platform linux/amd64,linux/arm64 -t ocs-tiku:latest .
```

### 3. 安全与反代建议

- 公网部署请务必：修改初始密码、给每个使用者单独建账号、按需调低 `rate_limit_per_min`。
- 因为脚本走 `GM_xmlhttpRequest`，后端**不必**配 HTTPS；但如果想让普通浏览器直连，建议在 Nginx/Caddy 后面加 TLS。

---

## 九、开发与协作

### 提交规范

本项目使用 git 管理，**每次更改后都要提交**（一次内聚改动 = 一次提交），提交信息遵循 Conventional Commits：

```
<type>(<scope>): <简述>
```

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 重构（不改行为） |
| `perf` | 性能优化 |
| `docs` | 文档 |
| `test` | 测试脚本 |
| `chore` | 依赖、构建、配置 |
| `style` | 格式、样式（无逻辑改动） |

示例：`feat(search): 支持 completion 题型多空答案`、`fix(resolver): 修复选项乱序后字母未重排`。

提交前请保证能跑通：`npm run typecheck`，涉及逻辑或前端改动时再跑 `npm run verify`。
**不要把** `.env`、`data/`（数据库与截图）、`node_modules/`、`dist/` 以及任何密钥提交进仓库。

### 代码约定

- **Node 版本**：≥ 20.18（`undici@7` / `better-sqlite3@12` 的 engines 约束），CI 跑 20 / 22 / 24。
- **不加构建步骤**：前端保持原生 JS，单文件 `public/app.js`。
- **答案格式不能随意改**：文本 + 字母双条、多选 `#` 连接、判断 `对/错`、填空 `#` 连接，
  必须与 OCS 的匹配逻辑保持一致（见上文「答案格式」）。
- **新增题目字段**：在 `src/db.ts` 的 `migrate()` 用 `addColumnIfMissing` 补列，不要只改 `CREATE TABLE` 就假设旧库会更新。
- **新增设置项**：加到 `src/config.ts` 的 `DEFAULTS`，并在 WebGUI 设置页暴露。
- **新增 API**：同时更新 `public/app.js` 调用方与 `scripts/ui-check.ts` 的 `backendRoutes` 清单。
- **新增测试脚本**：从 `scripts/test-env.ts` 取临时数据库/端口/管理员密码，不要在脚本里写死密码。

### 改动类型与必跑测试

| 改动类型 | 建议运行 |
|---|---|
| 纯 TS 类型 / 小改 | `npm run typecheck` |
| 后端逻辑 / 数据库 / 接口 | `npm run typecheck` + `npm run smoke` |
| 前端页面 / 交互 | `npm run test:ui` + `npm run test:browser` |
| 发版前 / 大功能 | `npm run verify` |

测试脚本使用临时数据库与 mock LLM，**不会消耗真实 token**，`verify` 结束会自动清理临时文件。

### 安全

- 密码使用 scrypt 加盐哈希；会话 token 在 DB 里只存 SHA-256。
- 列表 / 日志 / 备份接口中的 API Key 一律脱敏。
- 搜题 token 泄露请走「重置 Token」流程，并同步更新脚本配置。

---

## 十、许可证

[MIT](./LICENSE) © 2025 awes1000

> 本项目仅供学习与技术研究使用。请遵守所在平台的服务条款与学术诚信要求，使用者自行承担使用风险。
