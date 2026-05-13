<div align="center">

# Zeno

基于 IM 的办公协同智能助手，集成飞书消息接入、意图路由、文档/白板动作执行和对话记忆能力。

**English** · [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="https://skillicons.dev/icons?i=nestjs,typescript,postgresql,redis,docker" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/飞书-3387FF?style=flat-square&logo=&logoColor=white" />
  <img src="https://img.shields.io/badge/ARK-4253E8?style=flat-square" />
  <img src="https://img.shields.io/badge/Ollama-FF6B35?style=flat-square&logo=ollama&logoColor=white" />
</p>

</div>

---

<details>
<summary><kbd>目录</kbd></summary>

- [核心功能](#-核心功能)
- [快速开始](#-快速开始)
- [架构设计](#-架构设计)
- [贡献指南](#-贡献指南)
- [许可证](#-许可证)

</details>

---

## 核心功能

### IM 消息接入与异步处理

- 基于飞书长连接接收 IM 消息
- 消息入队后异步消费，降低模型调用和文档写入对主流程的阻塞
- 支持排队确认、失败重试和重复消息去重

### 意图路由与场景回复

支持将用户请求路由到任务规划、文档处理、画板/演示、多端同步、总结交付、身份问答、安全拒答、意图澄清和闲聊等场景。

| 意图类型       | 说明           |
| -------------- | -------------- |
| SCENE_PLAN     | 任务理解与规划 |
| SCENE_DOC      | 文档/白板编辑  |
| SCENE_PRESENT  | 画板/演示      |
| SCENE_SYNC     | 多端协同同步   |
| SCENE_DELIVERY | 总结与交付     |
| AGENT_IDENTITY | 身份查询       |
| SAFE_REFUSAL   | 安全拒答       |
| CLARIFY        | 意图模糊需追问 |
| CHITCHAT       | 基础闲聊       |

### 对话上下文与事实存储

```
用户输入
    │
    ▼
┌─────────────────┐
│   Redis Cache   │ ← 最近对话
└────────┬────────┘
         ▼
┌─────────────────┐
│  PostgreSQL     │ ← 对话历史与事实片段
└────────┬────────┘
         ▼
┌─────────────────┐
│ Ollama Embedding│ ← 为提取出的事实生成向量
└─────────────────┘
```

### 数据模型

- **ConversationHistory**: 对话历史记录（userId, role, content, metadata）
- **FactSnippet**: 提取的事实片段（userId, content, category, embedding）
- **UserSession**: 用户会话状态（sessionData, lastActive）

### 飞书办公对象操作

- 飞书 SDK 长连接消息接入
- 云文档创建与追加
- 画板创建与 Markdown 内容写入
- 演示文稿创建

### 稳定性与可观测性

- AI 调用超时与重试处理
- 队列重试和 worker 并发控制
- OpenTelemetry 链路追踪

---

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 8
- Docker（可选，用于依赖服务部署）

### 方式一：Docker 完整部署（推荐）

所有服务运行在 Docker 容器中，无需本地环境配置。

1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填写飞书、ARK 等配置信息
```

2. 构建并启动服务

```bash
docker-compose build
docker-compose up -d
```

3. 执行数据库迁移

```bash
docker exec -it zeno-app npx prisma migrate dev --name init
```

4. 下载 Ollama 向量模型

```bash
docker exec -it zeno-ollama ollama run nomic-embed-text
```

### 方式二：Docker 开发模式（热重载）

```bash
docker-compose build
docker-compose up
```

### 方式三：本地开发

1. 安装依赖

```bash
pnpm install
```

2. 启动依赖服务

```bash
docker-compose up -d redis postgres ollama
```

3. 配置环境变量

```bash
cp .env.example .env
```

4. 执行迁移

```bash
npx prisma migrate dev --name init
```

5. 启动开发服务

```bash
pnpm run start:dev
```

## 服务端口

| 服务       | 端口  | 说明                   |
| ---------- | ----- | ---------------------- |
| 主应用     | 3000  | API 服务               |
| Redis      | 6379  | 缓存和即时上下文存储   |
| PostgreSQL | 5432  | 关系型数据库和向量存储 |
| Ollama     | 11434 | 向量生成服务           |

## 架构设计

```
src/
├── modules/
│   ├── lark/          # 飞书 IM 与办公对象操作
│   ├── agent/         # 意图路由与 Agent 流程
│   ├── memory/        # 最近上下文与事实存储
│   ├── queue/         # 异步消息队列与 worker
│   ├── ai/            # 模型调用封装
│   └── common/        # 公共组件
└── main.ts            # 应用入口
```

## 环境变量

| 变量名           | 说明                  | 必填 |
| ---------------- | --------------------- | ---- |
| LARK_APP_ID      | 飞书应用 ID           | 是   |
| LARK_APP_SECRET  | 飞书应用密钥          | 是   |
| LARK_WEBHOOK_URL | 飞书 Webhook 地址     | 是   |
| ARK_API_KEY      | 字节跳动 ARK API 密钥 | 是   |
| ARK_BASE_URL     | ARK API 端点          | 是   |
| DATABASE_URL     | PostgreSQL 连接字符串 | 是   |
| REDIS_HOST       | Redis 主机地址        | 是   |
| REDIS_PORT       | Redis 端口            | 是   |
| OLLAMA_BASE_URL  | Ollama 服务地址       | 是   |

## 技术栈

| 类别     | 技术                            |
| -------- | ------------------------------- |
| 框架     | NestJS                          |
| 语言     | TypeScript                      |
| 存储     | PostgreSQL、Redis               |
| ORM      | Prisma                          |
| AI 能力  | 字节跳动 ARK、Ollama Embeddings |
| 队列     | BullMQ                          |
| 可观测性 | OpenTelemetry、Jaeger           |
| 部署     | Docker / Docker Compose         |

---

## 贡献指南

欢迎提交 Issue 和 Pull Request！

---

## 许可证

ISC
