# ModelMonitor

本地个人使用的模型输出效率监控网站。通过 OpenAI 兼容接口（`/v1/chat/completions`）自定义添加模型，平台按间隔主动发送流式测试请求，测量：

- **输出速度 tokens/s**（纯生成速度，不含首字等待；优先取官方 `usage`，缺失时按分块数估算并标记）
- **首字时间 TTFT**（请求发出到收到第一个输出分块）
- **总耗时**、输出 token 数
- 错误分类：超时 / 认证失败 / 限流 / 服务端错误 / 网络错误 / 模型不存在等

## 技术栈

- 前端：React 19 + TypeScript + Vite + Tailwind CSS + shadcn/ui + Recharts
- 后端：Node.js (ESM) + Fastify + better-sqlite3，原生定时器调度
- 存储：SQLite 单文件 `data/monitor.db`（providers / models / probe_results 三张表；API Key 本地明文保存，勿提交/外传）

## 快速开始

```bash
npm install        # 根目录安装全部工作区依赖

npm run dev        # 开发模式：Fastify(3000) + Vite(5173，/api 已代理)

npm run build      # 构建前端到 apps/web/dist
npm start          # 生产模式：单进程托管前端 + API + 定时探测，访问 http://127.0.0.1:3000
```

## 环境变量（可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址（局域网访问改 `0.0.0.0`，注意无鉴权风险） |
| `DATA_DIR` | `<repo>/data` | SQLite 数据目录 |

## 项目结构

```
apps/server   Fastify 后端：模型CRUD、SSE 探测引擎、调度器、指标聚合
apps/web      React 前端：仪表盘 / 模型管理 / 探测记录
data/         SQLite 数据库（运行时生成，已 gitignore）
docs/specs    设计文档
```

## 使用说明

1. 「模型管理」→「添加供应商」：填名称、Base URL（如 `https://api.example.com/v1`）、API Key 与探测参数（间隔 / max_tokens / 超时），「测试连接」会请求 `{base_url}/models` 验证连通性
2. 在供应商卡片下「添加模型」：手动输入模型 ID，或「获取列表」勾选批量添加
3. 按供应商的间隔（默认 30 分钟）自动探测其下所有启用的模型：**同一供应商内按顺序串行探测**，相邻请求保持「模型间隔」（默认 5s，可配 0–60s），避免并发互相干扰；手动「立即探测」同样排队串行；供应商/模型均可单独停用
4. 「仪表盘」查看各模型最新速度与趋势图（1h/6h/24h/7d），每 30 秒自动刷新
5. 「探测记录」查看全部原始明细，支持按模型/状态/时间过滤

## 速度口径

- `tps = 输出 token 数 / (流结束时刻 - 首token时刻)`：纯生成速度
- 服务未返回 `usage.completion_tokens` 时按 SSE 分块数估算（记录标记「估算」）
- 部分服务不支持 `stream_options: include_usage`，后端遇到 400 会自动去掉该参数重试
