import express from 'express';
import path from 'node:path';
import type { Server } from 'node:http';
import { env } from './env';
import { ensureAdmin, getDb } from './db';
import searchRouter from './routes/search';
import adminRouter, { buildAnswererWrapper } from './routes/admin';
import { PING_PROMPT } from './services/prompt';
import { errMsg } from './utils';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

/** 简单访问日志 */
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/assets')) return;
    const ms = Date.now() - started;
    // eslint-disable-next-line no-console
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

/** 健康检查 */
app.get('/health', (_req, res) => {
  res.json({ code: 1, msg: 'ok', uptime: Math.round(process.uptime()), time: Date.now() });
});

/** 搜题接口（OCS 调用） */
app.use(searchRouter);

/** 管理面板 API */
app.use('/api', adminRouter);
app.use('/api', (_req, res) => {
  res.status(404).json({ code: 0, msg: '接口不存在' });
});

/** WebGUI 静态资源 */
const publicDir = path.resolve(__dirname, '..', 'public');
app.use(
  express.static(publicDir, {
    index: 'index.html',
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('cache-control', 'no-cache');
    },
  }),
);

/** SPA 兜底 */
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/search') || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) next(err);
  });
});

/** 统一错误处理 */
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status && Number.isFinite(err.status) ? err.status : 500;
  // eslint-disable-next-line no-console
  console.error('[error]', errMsg(err));
  if (res.headersSent) return;
  res.status(status).json({ code: 0, msg: errMsg(err) });
});

function start(): Server {
  getDb();
  ensureAdmin(getDb());
  const server = app.listen(env.PORT, env.HOST, () => {
    console.log(`\nOCS AI 题库后端已启动`);
    console.log(`  监听地址 : http://${env.HOST}:${env.PORT}`);
    console.log(`  搜题接口 : GET|POST /search`);
    console.log(`  管理面板 : http://127.0.0.1:${env.PORT}/`);
    console.log(`  数据库   : ${env.DB_PATH}\n`);
  });
  return server;
}

if (require.main === module) start();

export { app, start, PING_PROMPT, buildAnswererWrapper };
