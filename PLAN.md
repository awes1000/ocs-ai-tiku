# OCS AI 题库后端 — 技术方案

## Context

为 OCS 网课助手（userscript）实现一个自托管题库后端：OCS 通过 `AnswererWrapper` 题库配置调用本后端，后端调用 AI（LLM）生成答案并返回；AI 答案自动沉淀为本地题库（模糊匹配复用）；提供完整 WebGUI 控制面板（AI 配置 / 题库管理 / 用户管理 / 日志统计 / 一键导出 AnswererWrapper 配置）。

## 技术可行性调查结论（已核实 OCS 4.x 源码）

### OCS → 题库的调用契约

- `defaultAnswerWrapperHandler(wrappers, env)` 中 `env = { title, type, options }`（`packages/scripts/src/projects/cx.ts:1898`）：
  - `title`：单道题标题文本（每题一次请求）
  - `type`：`single | multiple | judgement | completion | unknown`
  - `options`：选项 innerText 以 `\n` 拼接（可能含 "A." 前缀）；completion 时为空串
- 请求：`get`/`post`，`data` 中 `${title}` `${type}` `${options}` 占位符替换；`contentType` 默认 `json`
- 响应：`handler` 字符串（`new Function`）解析，返回 `[q,a]` / `[[q,a],...]` / `[msg,undefined]` / `undefined`；第三元素 `extra_data`：
  - `extra_data.ai === true` → 结果面板显示 "AI" 蓝色标签
  - `extra_data.cache === true` → 显示 "题库缓存" 标签
  - `extra_data.tags` → 自定义标签
- 超时：core 默认 60s，脚本设置默认 120s（可调 10–180s）→ **LLM 调用须控制在 ~40s 内**
- 跨域：`type:"GM_xmlhttpRequest"` 走油猴扩展通道，无视 CORS/混合内容；域名需加 `@connect` 或用全域名通用版

### 答案格式要求（决定后端返回格式）

| 题型 | OCS 匹配逻辑 | 后端返回策略 |
|---|---|---|
| single | 归一化精确匹配 → 相似度>0.6 → 纯字母兜底 | 选项原文文本 + 字母两条 result |
| multiple | 每 result 按分隔符拆分后逐项匹配；字母串兜底 | 选项文本 `#` 连接 + 字母串 "ABD" |
| judgement | 关键词比对（对/正确/√/true vs 错/错误/×/false） | 直接返回 "对"/"错" |
| completion | 拆分后数量须等于空数；单空合并全部 | 各空答案 `#` 连接 |

- 分隔符：`=== # --- ### | ; ；`；`splitAnswer` 优先 `JSON.parse` → answer 可为 JSON 数组字符串
- 纯字母判定：A-Z、≤8 字符、递增不重复
- 答案/选项的 "A." "A、" 前缀会被 `removeRedundant` 剥离后归一化比对

## Approach

**技术栈**（与 OCS 生态一致）：Node.js ≥18 + TypeScript（tsx 运行）+ Express + better-sqlite3 + 原生 JS SPA WebGUI（无构建步骤）。单进程：`npm i && npm start`。

### 项目结构

```
tiku/
├─ package.json / tsconfig.json / .env.example
├─ src/
│  ├─ index.ts                # 入口：Express app、静态托管 WebGUI
│  ├─ db.ts                   # better-sqlite3 初始化 + 建表迁移
│  ├─ config.ts               # 全局设置读写（DB 内 settings 表 + env 兜底）
│  ├─ middleware/auth.ts      # WebGUI session 鉴权 + search API token 鉴权
│  ├─ routes/search.ts        # OCS 搜题接口（GET/POST）
│  ├─ routes/admin.ts         # WebGUI 后端 API：auth/users/questions/logs/stats/settings/llm-config/export
│  ├─ services/resolver.ts    # 答题流水线：规范化→精确→模糊→LLM→入库→格式化
│  ├─ services/llm.ts         # OpenAI 协议适配：responses / chat_completions 两种 api_type
│  ├─ services/prompt.ts      # 分题型提示词模板（可后台编辑）
│  ├─ services/similarity.ts  # 归一化 + Dice 相似度（string-similarity 包）
│  └─ utils.ts
├─ public/                    # WebGUI 单页应用（index.html/app.js/style.css）
└─ data/tiku.db               # SQLite
```

### 搜题接口契约

`GET|POST /search`，参数 `title`、`type`、`options`、`token`（也可 `Authorization: Bearer`）：

```json
{ "code": 1, "msg": "ok",
  "data": { "question": "中国梦是什么？",
            "results": [ ["题", "选项文本", {"ai":true}],
                         ["题", "B", {"ai":true}] ] } }
```

- 未命中/失败：`{code:0, msg:"原因"}` → handler 返回 `[msg, undefined]`
- 缓存命中：results 附 `{cache:true}` 标签
- 对应 AnswererWrapper handler：
  `return (res)=> res.code===1 && res.data.results.length ? res.data.results : [res.msg||'未找到答案', undefined]`

### 答题流水线（resolver.ts）

1. 规范化 title（去冗余前缀/标点/空白）；
2. **精确命中**题库（规范化 title + type 相同）→ 直接返回；
3. **模糊匹配**：归一化 title 的 Dice 相似度 ≥ 阈值（默认 0.9，后台可调）→ 命中后按当前 options 重排：把存储的选项文本映射到本次选项序号，重新推导字母，返回 `文本 + 字母` 双 result；
4. **LLM 调用**：分题型提示词，要求严格 JSON 输出：
   - single → `{"answer":"B"}`；multiple → `{"answer":"ABD"}`；judgement → `{"answer":"对"}`；completion → `{"answer":["空1","空2"]}`；unknown → 自由文本
   - `type` 缺省且有 options → 按 single 处理
5. 服务端把字母映射回 options 原文（按行序 A=第1行，兼容有无字母前缀），返回 `[[q,选项文本#..,{ai:true}],[q,"AB",{ai:true}]]`；
6. 答案与题目快照入库（question/options/answer/letter/model/来源/命中数）；
7. 相同规范化题目的并发请求合并（in-flight coalescing），避免重复烧 token；
8. LLM 超时 35s + 单次重试，整体压在 OCS 默认超时内；失败返回 `{code:0,msg}` 不阻塞 OCS 流程。

### LLM 接入（llm.ts）

- 配置项：`base_url`、`api_key`、`model`、`api_type`（`responses` | `chat_completions`）、`temperature`、`max_tokens`、超时、代理
- 支持多套提供商配置 + 优先级/故障切换（备选）
- 优先 `response_format: json_object`（不兼容时回退纯文本解析 JSON）

### 数据库表（SQLite）

- `users`：id, username, password_hash(scrypt), role(admin/user), token, status, created_at
- `questions`：id, title, title_norm, type, options, answer, answer_letter, source(ai/manual/import), model, hits, created_at, updated_at
- `requests`：id, user_id, title, type, hit(cache/fuzzy/ai/none), latency_ms, tokens, status, created_at
- `settings`：key/value（AI 配置、阈值、限流、提示词模板等）
- `sessions`：token, user_id, expires_at

### WebGUI（public/ 原生 SPA）

页面：登录 → Dashboard（总量/命中率/token 消耗/近 24h 曲线）｜AI 提供商配置（含"测试连接"）｜提示词模板编辑｜题库管理（搜索/查看/编辑/删除/导入 JSON·CSV/导出）｜用户管理（admin 建用户、重置密码、重新生成 token、停用）｜调用日志（按用户/命中类型筛选）｜接入向导（选用户 → 生成完整 AnswererWrapper JSON 一键复制 + @connect 说明）｜系统设置（模糊阈值、限流、缓存开关）｜在线搜题测试台。

- WebGUI 鉴权：用户名密码登录 → httpOnly cookie session（DB 存储可撤销）；scrypt 哈希
- 搜题 API 鉴权：每用户一个 token，`?token=` 或 Bearer，请求日志归属用户
- 初始管理员：首次启动自动生成并在控制台打印（或 env 指定），登录后强制改密

### 部署备注

- 默认端口 `0.0.0.0:8060`（env `PORT` 可改）
- 若部署在公网，脚本页面为 HTTPS，须给后端配 HTTPS 或依赖 `GM_xmlhttpRequest`（生成的配置默认 `type:"GM_xmlhttpRequest"`，规避 CORS/混合内容）
- README 附 AnswererWrapper 配置示例与 `@connect` 说明

## Files to modify

全部新建（`tiku/` 为空目录）：

- `package.json`、`tsconfig.json`、`.env.example`、`README.md`
- `src/index.ts`、`src/db.ts`、`src/config.ts`、`src/utils.ts`
- `src/middleware/auth.ts`
- `src/routes/search.ts`、`src/routes/admin.ts`
- `src/services/resolver.ts`、`src/services/llm.ts`、`src/services/prompt.ts`、`src/services/similarity.ts`
- `public/index.html`、`public/app.js`、`public/style.css`

## Reuse

- OCS 官方答案匹配语义已核对：分隔符集合、`resolvePlainAnswer`、归一化规则直接移植到 `similarity.ts`（复用 `string-similarity` npm 包，与 OCS 同款）
- 生成的 AnswererWrapper 直接套用官方模板（见上）

## Steps

- [ ] 初始化 Node+TS 工程，装 express/better-sqlite3/string-similarity/tsx 等依赖
- [ ] db.ts：建表 + 迁移 + 初始 admin
- [ ] similarity.ts：归一化 + Dice 相似度 + options 字母映射
- [ ] llm.ts：OpenAI responses/chat_completions 双协议 + 超时 + JSON 解析容错
- [ ] prompt.ts：分题型模板（settings 可覆盖）
- [ ] resolver.ts：流水线 + in-flight 合并 + 入库
- [ ] routes/search.ts：GET/POST，token 鉴权，契约响应
- [ ] middleware/auth.ts + routes/admin.ts：登录/session、用户 CRUD、题库 CRUD、日志、统计、设置、接入向导数据、导入导出
- [ ] WebGUI SPA 全部页面
- [ ] README + .env.example + AnswererWrapper 示例

## Verification

1. `npm start` 后 curl：`GET /search?title=1+2=?&type=single&options=A.1\nB.2\nC.3&token=...` 校验 `{code:1,data.results}` 结构
2. 重复请求验证缓存命中（响应 `{cache:true}`、日志 hit=cache）
3. 改题面轻微措辞验证模糊命中
4. OCS 题库配置粘贴生成的 AnswererWrapper，用脚本"在线搜题"面板实测四种题型
5. WebGUI：登录、改 AI 配置、测试连接、题库编辑、建用户、导出一键配置
