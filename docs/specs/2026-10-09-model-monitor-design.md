# ModelMonitor 设计文档

- 日期：2026-10-09
- 状态：已确认（方案A：单进程全栈）
- 类型：新项目，从零搭建

## 1. 背景与目标

构建一个本地个人使用的模型监控网站，重点监控 OpenAI 兼容模型服务的**输出效率**：

- 核心指标：输出速度 tokens/s、首字时间 TTFT（Time To First Token）、总耗时
- 通过表单自定义添加 OpenAI 兼容接入点（Base URL + API Key + Model ID）
- 平台按配置间隔主动发送测试请求采集指标，数据存本地 SQLite

### 非目标（当前版本不做）

- 被动代理真实流量
- 多用户 / 登录鉴权（本地个人工具）
- 通知告警（后续可加）
- 稳定性/可用性巡检、能力测试（用户选择仅速度指标）

## 2. 架构（方案A：单进程全栈）

```
ModelMonitor/
├── package.json              # npm workspaces 根
├── data/                     # SQLite 数据库目录（运行时生成）
│   └── monitor.db
├── apps/
│   ├── server/               # Fastify 后端 + 调度器 + 探测引擎
│   │   ├── src/
│   │   │   ├── index.mjs     # 入口：启动 Fastify、初始化 DB、恢复调度
│   │   │   ├── db.mjs        # better-sqlite3 初始化与建表
│   │   │   ├── routes/       # models / probes / settings 路由
│   │   │   ├── prober.mjs    # 探测引擎（SSE 解析、计时、错误分类）
│   │   │   └── scheduler.mjs # node-cron 按模型间隔调度
│   │   └── package.json
│   └── web/                  # React + TS + Vite + Tailwind + shadcn/ui
│       └── src/
│           ├── pages/        # Dashboard / Models / Records
│           ├── components/   # 卡片、图表、表单等
│           └── lib/api.ts    # 后端 API 客户端
```

- 开发：`npm run dev` 并行起 Vite（5173，代理 `/api`）与 Fastify（3000）
- 生产：Vite 构建产物由 Fastify 静态托管，`npm start` 单进程运行（含调度器）
- 无鉴权，仅监听本地；API Key 明文存储于本地 SQLite（个人工具定位）

## 3. 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18、TypeScript、Vite、Tailwind CSS、shadcn/ui、Recharts |
| 后端 | Node.js（ESM）、Fastify、@fastify/static、better-sqlite3、原生 setTimeout/setInterval 定时调度 |
| 存储 | SQLite 单文件 `data/monitor.db` |

## 4. 核心探测逻辑

向 `{base_url}/chat/completions` 发起 `stream: true` 的 POST：

1. **计时**
   - `t0`：请求发出
   - `t1`：收到第一个含 `delta` 的 SSE chunk → `TTFT = t1 - t0`
   - `t2`：流结束（`[DONE]` 或连接关闭）→ `total = t2 - t0`
2. **token 数取法**
   - 请求带 `stream_options: {"include_usage": true}`，优先取最终 chunk 的 `usage.completion_tokens`
   - 服务不支持时（无 usage 返回）降级为 chunk 计数估算，结果标记 `estimated`
3. **速度口径**
   - `tps = completion_tokens / (t2 - t1)`（纯生成速度，不含 TTFT，为主指标）
   - 另存整体均值 `tokens / total` 供参考
4. **错误分类**：`timeout`（AbortController，可配超时）、`auth`(401/403)、`rate_limit`(429)、`server`(5xx)、`network`（连接失败）、`stream_aborted`（流中断）、`parse`（SSE 异常）、`invalid_model`（404/模型不存在）
5. **探测参数**（每模型可配）：测试 prompt、`max_tokens`（默认 256）、超时 ms（默认 60000）

## 5. 数据模型（SQLite）

```sql
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,          -- 如 https://api.example.com/v1
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT 'Say "hello" and nothing else.',
  max_tokens INTEGER NOT NULL DEFAULT 256,
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  status TEXT NOT NULL,            -- ok | error
  ttft_ms INTEGER,                 -- error 时为 NULL
  total_ms INTEGER,
  completion_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  tps REAL,
  avg_tps REAL,                    -- tokens / total（含 TTFT）
  prompt_tokens INTEGER,
  error_type TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_model_time ON probe_results(model_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## 6. API 设计（均挂 `/api`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/models` | 列表 / 新增 |
| GET/PUT/DELETE | `/api/models/:id` | 详情 / 更新 / 删除（级联删记录） |
| POST | `/api/models/:id/probe` | 手动立即探测一次（"测试连接"复用） |
| POST | `/api/probe-test` | 用临时配置探测一次（不落库），供新增模型前"测试连接" |
| GET | `/api/models/:id/summary?range=1h\|6h\|24h\|7d` | 最新值 + 区间 avg/P95（成功记录） |
| GET | `/api/probes?model_id=&status=&range=&limit=` | 原始记录，时间倒序分页 |
| GET/PUT | `/api/settings` | 全局默认间隔等（保留扩展） |

## 7. 调度器

- 服务启动时为所有 `enabled=1` 的模型按 `interval_minutes` 用原生 `setInterval` 独立调度（比 cron 对齐更精确）
- 首次注册延迟随机 jitter（0~30s）错峰；同一模型探测中则跳过本轮（防重叠）
- 模型增删改后动态重载调度；进程重启自动恢复

## 8. 前端页面

1. **仪表盘**：模型卡片墙（状态点、最新 TPS/TTFT/总耗时、上次探测时间、区间均值），TPS 趋势折线图 + TTFT 趋势折线图（多模型叠加，1h/6h/24h/7d 切换），深浅色主题
2. **模型管理**：OpenAI 兼容接入表单（名称/Base URL/API Key/Model ID/间隔/探测参数），"测试连接"按钮，启用开关，编辑/删除
3. **探测记录**：原始数据表，按模型/状态/时间范围过滤，失败原因列，手动"立即探测"按钮

## 9. 里程碑

1. 脚手架：npm workspaces + 前后端项目 + SQLite 建表
2. 后端：模型 CRUD + 探测引擎 + 手动探测接口
3. 后端：调度器 + 聚合查询接口
4. 前端：模型管理页 → 仪表盘 → 记录页
5. 生产构建脚本（单命令启动）+ README

## 10. 默认取值约定

- API Key 本地明文存储；不加密、不脱敏返回（本地工具）
- 探测默认并发 = 1（逐模型串行），jitter ≤ 30s
- 区间聚合采用 SQLite 时间过滤 + JS 计算分位数（数据量小，无需扩展）
