# OCS AI 题库后端

自托管的 **AI 题库后端**，给 [OCS 网课助手](https://github.com/ocsjs/ocsjs)（userscript）用：
OCS 通过 `AnswererWrapper` 把每道题发过来，后端先查本地题库（精确 → 模糊），未命中才调 LLM，
AI 的答案会自动沉淀进题库，下次同类题直接走缓存。

自带完整 WebGUI：AI 配置 / 提示词 / 题库管理 / 用户管理 / 日志统计 / 在线测试 / 一键导出接入配置。

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-170%20checks-brightgreen)](./scripts/verify.ts)

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
    "model": "gpt-4o-mini"
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

---

## 二、OCS 接入

**接入向导**页会按当前账号和访问地址自动生成，形如：

```json
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
    "token": "你的搜题Token"
  },
  "handler": "return (res) => { try { if (res && typeof res === 'string') res = JSON.parse(res); } catch (e) { return [String(res), undefined]; } if (res && res.code === 1 && res.data && Array.isArray(res.data.results) && res.data.results.length) return res.data.results; return [(res && res.msg) || '未找到答案', undefined]; }"
}
```

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

---

## 三、答题流水线

1. **精确命中**：`title` 归一化（去题号、标点、空白）后与题库比对（题型相同）。
2. **模糊命中**：Dice 相似度（`string-similarity`，与 OCS 同款算法）≥ 阈值（默认 `0.9`，可在系统设置里调）。
   命中后会**按本次选项顺序重新映射**：把入库时记录的选项文本映射回当前的 A/B/C 序号，
   所以同一道题选项顺序变了也不会答错。
3. **AI 答题**：按题型套用提示词，要求模型严格输出 JSON：
   - single → `{"answer":"B"}`、multiple → `{"answer":"ABD"}`、judgement → `{"answer":"对"}`
   - completion → `{"answer":["空1","空2"]}`、unknown → `{"answer":"答案文本"}`
4. 服务端把字母映射回选项原文，返回「文本 + 字母」两条结果，同时把题目/选项/答案/模型/命中数入库。
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
| 接入向导 | 选账号 → 生成完整 AnswererWrapper JSON，一键复制/下载，附 `@connect` 与步骤说明 |
| 在线测试 | 与 OCS 完全同构的请求测试，「全流程」或「仅 AI」两种模式，直接看到 results 结构 |
| 用户管理 | 建用户、改密、改角色、停用、重置搜题 Token（自动复制）、删除 |
| 系统设置 | 模糊阈值、限流、缓存/AI 开关、对外地址、改密、脱敏备份下载 |

鉴权：用户名 + 密码登录 → **httpOnly Cookie 会话**（DB 存储、可撤销，密码 scrypt 加盐）。
搜题接口用每用户独立 Token，日志按 Token 归属到用户。

---

## 五、配置项（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8060` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/tiku.db` | SQLite 路径 |
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
| 冒烟测试 | 35 项：纯函数 + mock LLM 全流水线 |
| 后端端到端 | 37 项：登录/改密/登出、提供商增删改测、设置、提示词、用户 CRUD、题库 CRUD/导入导出、日志统计、接入向导 handler 实测 |
| 前端静态检查 | 70 项：app.js 语法、DOM ID 引用、页面函数、导航映射、API 路径与后端一致性 |
| 浏览器渲染 | 28 项：无头 Chrome 真实登录、逐个页面渲染无异常、测试台真实请求、弹窗交互（截图存 `data/shot/`） |

---

## 八、部署提示

- 单进程即可：`node_modules/.bin/tsx src/index.ts`（或 `npm start`），数据都在 `data/tiku.db`（WAL 模式）。
- 长期运行建议用 PM2 / systemd / NSSM 托管，并把 `data/` 目录纳入备份。
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
