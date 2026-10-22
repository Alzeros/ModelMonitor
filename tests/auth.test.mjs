import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthGuard, extractBearer } from '../apps/server/src/auth.mjs';

/** 构造一个最小 req/reply，模拟 Fastify 的 onRequest 钩子 */
function makeReq(url, headers = {}) {
  return { url, headers };
}
function makeReply() {
  const sent = { code: null, body: undefined };
  return {
    reply: {
      code(c) {
        sent.code = c;
        return this;
      },
      send(body) {
        sent.body = body;
        return this;
      },
    },
    sent,
  };
}

/** 构造一个带 token 环境的服务（模块级读取环境变量，需在 import 前设置） */
function guardWithToken(token) {
  process.env.AUTH_TOKEN = token;
  return createAuthGuard();
}

test('未配置 AUTH_TOKEN 时放行全部请求（本地开发）', async () => {
  delete process.env.AUTH_TOKEN;
  const guard = createAuthGuard();
  const { reply, sent } = makeReply();
  await guard(makeReq('/api/settings'), reply);
  assert.equal(sent.code, null, '不应返回 401');
});

test('未授权请求返回 401', async () => {
  const guard = guardWithToken('secret-token');
  const { reply, sent } = makeReply();
  await guard(makeReq('/api/settings'), reply);
  assert.equal(sent.code, 401);
  assert.match(sent.body.error, /未授权/);
});

test('错误令牌返回 401', async () => {
  const guard = guardWithToken('secret-token');
  const { reply, sent } = makeReply();
  await guard(makeReq('/api/settings', { authorization: 'Bearer wrong' }), reply);
  assert.equal(sent.code, 401);
});

test('正确 Bearer 令牌放行', async () => {
  const guard = guardWithToken('secret-token');
  const { reply, sent } = makeReply();
  await guard(makeReq('/api/settings', { authorization: 'Bearer secret-token' }), reply);
  assert.equal(sent.code, null);
});

test('Bearer 前缀大小写不敏感', async () => {
  const guard = guardWithToken('secret-token');
  const { reply, sent } = makeReply();
  await guard(makeReq('/api/settings', { authorization: 'bearer secret-token' }), reply);
  assert.equal(sent.code, null);
});

test('非 Bearer 认证方式（Basic）不被接受', async () => {
  const guard = guardWithToken('secret-token');
  const { reply, sent } = makeReply();
  await guard(makeReq('/api/settings', { authorization: 'Basic dXNlcjpwYXNz' }), reply);
  assert.equal(sent.code, 401);
});

test('静态资源不拦截（前端页面仍可加载）', async () => {
  const guard = guardWithToken('secret-token');
  const { reply, sent } = makeReply();
  await guard(makeReq('/index.html'), reply);
  assert.equal(sent.code, null);
});

test('令牌长度不同直接拒绝（不进入定长比较）', async () => {
  const guard = guardWithToken('secret-token');
  const { reply, sent } = makeReply();
  await guard(makeReq('/api/settings', { authorization: 'Bearer short' }), reply);
  assert.equal(sent.code, 401);
});

test('extractBearer 解析各种输入', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(extractBearer({ headers: { authorization: 'bearer  abc  ' } }), 'abc');
  assert.equal(extractBearer({ headers: {} }), null);
  assert.equal(extractBearer({ headers: { authorization: 'abc' } }), null);
  assert.equal(extractBearer({ headers: { authorization: 'Bearer' } }), null);
});
