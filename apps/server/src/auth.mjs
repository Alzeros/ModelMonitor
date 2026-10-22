import crypto from 'node:crypto';

/**
 * 访问令牌认证。
 *
 * 设计取舍：单一 Bearer Token + 环境变量，而非用户名密码。
 * - 无需会话与 CSRF 防护，令牌不落库（内存中仅做比对）
 * - 令牌可随时轮换：改环境变量重启即可
 * - 校验用 timingSafeEqual，避免时序侧信道
 *
 * 认证范围覆盖全部 /api/* ：探测记录与仪表盘同样会暴露供应商清单、
 * 上游域名与耗时信息，因此不区分「只读公开」。
 */

/** 从环境变量读取令牌；为空表示未启用认证 */
export function getAuthToken() {
  const t = process.env.AUTH_TOKEN;
  return typeof t === 'string' && t.trim() ? t.trim() : '';
}

/** 定长比较，避免时序侧信道；长度不同直接返回 false */
function safeEqual(a, string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(string);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** 从 Authorization 头取出 Bearer 令牌 */
export function extractBearer(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Fastify 预处理器：拦截未授权的 /api 请求。
 *
 * 未配置 AUTH_TOKEN 时不拦截（保持本地开发开箱即用），
 * 但调用方应通过 assertAuthConfigured() 在启动阶段给出明确提示。
 */
export function createAuthGuard() {
  const token = getAuthToken();
  return async function authGuard(req, reply) {
    if (!token) return; // 未启用认证：放行（本地开发）
    if (!req.url?.startsWith('/api')) return; // 静态资源不拦截

    const provided = extractBearer(req);
    if (provided && safeEqual(provided, token)) return;

    return reply.code(401).send({ error: '未授权：请提供有效的访问令牌' });
  };
}

/**
 * 启动期检查：配置了认证但监听非回环地址时给出醒目提示。
 * 令牌本身绝不打日志。
 */
export function assertAuthConfigured(host) {
  const token = getAuthToken();
  if (!token) {
    console.warn(
      '[server] ⚠ 未设置 AUTH_TOKEN —— 全部 /api 接口无需认证即可访问。' +
        '仅建议用于本地开发；公网部署前必须设置该环境变量。'
    );
    return false;
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback) {
    console.log('[server] 已启用 AUTH_TOKEN 认证');
  }
  return true;
}
