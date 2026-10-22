import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { db } from './db.mjs';
import { registerRoutes } from './routes.mjs';
import { reloadScheduler, stopScheduler } from './scheduler.mjs';
import { assertAuthConfigured, createAuthGuard } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../web/dist');

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

// 认证守卫：拦截未授权的 /api 请求。必须在路由注册之前挂载。
app.addHook('onRequest', createAuthGuard());

if (fs.existsSync(distDir)) {
  await app.register(fastifyStatic, {
    root: distDir,
    // wildcard=true：请求时实时解析文件。false 会在启动时为每个文件注册固定路由，
    // 前端重建后新哈希文件无路由 → 落到兜底返回 index.html → MIME 报错
    wildcard: true,
    cacheControl: false, // 关闭插件默认头，用下方 setHeaders 的策略
    setHeaders: (res, pathname) => {
      if (pathname.endsWith('.html')) {
        // HTML 必须每次重验证，避免缓存旧页引用已被新构建替换的资源
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/[\\/]assets[\\/]/.test(pathname)) {
        // 带内容哈希的资源可永久缓存
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not found' }));
}

await registerRoutes(app);

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST ?? '127.0.0.1';
assertAuthConfigured(host);
await app.listen({ port, host });
console.log(`[server] API ready at http://${host}:${port}`);
if (fs.existsSync(distDir)) {
  console.log(`[server] serving web dist: ${distDir}`);
} else {
  console.log('[server] web dist not found, dev mode: use Vite (5173) with /api proxy');
}

reloadScheduler();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopScheduler();
  try {
    await app.close();
  } catch {}
  try {
    db.close();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
