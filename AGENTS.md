# AGENTS.md

本文件是本仓库的协作约定，**所有人和所有 AI Agent 都必须遵守**。

---

## 一、Git 强制约定（最重要）

**每一次更改代码 / 文档 / 配置后，都必须立即提交到 git。**
不允许把多个不相关的改动攒在一起，也不允许「改完不提交」就结束一轮工作。

### 每次更改的操作顺序

```bash
git status                     # 确认改动范围
git diff                       # 自查改动内容
npm run typecheck              # 有 TS 改动时必须先通过
npm run verify                 # 有逻辑/前端改动时必须先通过
git add -A
git commit -m "<type>(<scope>): <简述>"
```

### 提交信息规范

采用 Conventional Commits：

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

示例：

- `feat(search): 支持 completion 题型多空答案`
- `fix(resolver): 修复选项乱序后字母未重排`
- `docs(readme): 补充 @connect 说明`
- `chore: 初始化项目`

### 硬性要求

1. **一次改动 = 一次提交**，提交信息必须能说明"改了什么、为什么"。
2. 提交前必须保证工作区可运行（`npm run typecheck` 通过；涉及逻辑时 `npm run verify` 通过）。
3. **禁止提交**：`.env`、`data/`（数据库与截图）、`node_modules/`、`dist/`、密钥与 Token。
   `.gitignore` 已覆盖，若发现清单外敏感文件请先补 `.gitignore`。
4. **禁止** `git commit --amend` 已推送的历史、禁止 `git push --force` 到共享分支（除非明确要求）。
5. 批量改动（如新增一个页面）可以一次提交，但必须是一个内聚的功能点。
6. 任何"顺手"的无关修改必须单独提交，不能混进主改动。
7. 如果中途发现改错了：用一次新的 `fix` 提交修正，不要重写历史。

---

## 二、项目速览

OCS 网课助手的自托管 AI 题库后端：OCS 通过 `AnswererWrapper` 调 `GET|POST /search`，
后端按「精确命中 → 模糊命中 → LLM 生成并入库」流水线返回答案，附带 WebGUI 管理面板。

```
src/index.ts              Express 入口、静态资源、SPA 兜底、错误处理
src/env.ts                .env 解析（唯一的 env 读取处）
src/db.ts                 better-sqlite3 建表/迁移/初始 admin
src/config.ts             settings 读写 + AI 配置汇总（providers → settings → env）
src/utils.ts              哈希、随机 token、时间等通用工具
src/middleware/auth.ts    搜题 token 鉴权 + WebGUI session 鉴权
src/routes/search.ts      OCS 搜题接口（限流、日志）
src/routes/admin.ts       WebGUI 全部管理 API + AnswererWrapper 生成
src/services/similarity.ts 归一化、分隔符、字母/文本互转（对齐 OCS 语义）
src/services/match.ts     Dice 相似度 + 选项重排映射
src/services/llm.ts       OpenAI responses / chat_completions 双协议
src/services/prompt.ts    分题型提示词模板（settings 可覆盖）
src/services/resolver.ts  答题主流水线 + in-flight 合并 + 入库
public/                   WebGUI（无构建，原生 JS SPA）
scripts/                  测试脚本
```

## 三、开发约定

- **TypeScript**：`strict` 开启，禁止随手 `any`（外部响应可 `any` 但需就近收窄）。
- **不要引入构建步骤**：前端保持原生 JS，单文件 `app.js`。
- **答案格式不能随意改**：`results` 的文本/字母双条、多选 `#` 连接、判断 `对/错`、
  填空 `#` 连接，都必须与 OCS 的匹配逻辑保持一致（见 README「答案格式」）。
- **新增题目字段**：在 `src/db.ts` 的 `migrate()` 里用 `addColumnIfMissing` 补列，不要直接改 `CREATE TABLE` 后假设旧库会更新。
- **新增 settings 项**：加到 `src/config.ts` 的 `DEFAULTS`，并在 WebGUI 设置页暴露。
- **新增 API**：同时更新 `public/app.js` 调用方与 `scripts/ui-check.ts` 的 `backendRoutes` 清单。
- **调试脚本**：临时脚本不要留在仓库（本轮结束前删除），正式验证脚本放在 `scripts/` 并接入 `verify.ts`。

## 四、验证要求

| 改动类型 | 必须运行 |
|---|---|
| 纯 TS 类型/小改 | `npm run typecheck` |
| 后端逻辑 / 数据库 / 接口 | `npm run typecheck` + `npm run smoke` |
| 前端页面 / 交互 | `npm run test:ui` + `npm run test:browser` |
| 发布前 / 大功能 | `npm run verify`（冒烟 + 后端 e2e + 前端静态 + 无头浏览器） |

测试脚本均使用临时数据库与 mock LLM，**不会消耗真实 token**；`verify` 结束会自动清理临时文件。

## 五、安全红线

- 密码使用 scrypt 加盐哈希；会话 token 在 DB 里只存 SHA-256。
- 搜题 token 泄露 → 走「重置 Token」流程。
- 日志/备份/列表接口中的 API Key 必须脱敏。
- 不得在提交中包含任何真实 API Key、密码、Token。
