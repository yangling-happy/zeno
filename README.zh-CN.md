<div align="center">

# Zeno

企业级智能对话平台，集成飞书消息接入、多模态大模型能力、长时记忆管理系统。

**English** · [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="https://skillicons.dev/icons?i=nestjs,typescript,postgresql,redis,docker" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/飞书-3387FF?style=flat-square&logo=&logoColor=white" />
  <img src="https://img.shields.io/badge/ARK-4253E8?style=flat-square" />
  <img src="https://img.shields.io/badge/Ollama-FF6B35?style=flat-square&logo=ollama&logoColor=white" />
  <img src="https://img.shields.io/badge/pgvector-336791?style=flat-square" />
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

### 意图识别与技能系统

精准的意图分类，覆盖任务规划、文档编辑、画板协作、演示汇报、多端协同、总结交付、身份查询、安全拒答、意图澄清等 9 大类别。

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

### 三层记忆架构

```
用户输入
    │
    ▼
┌─────────────────┐
│   Redis Cache   │ ← 即时上下文（最近对话）
└────────┬────────┘
         ▼
┌─────────────────┐
│  PostgreSQL     │ ← 长期历史（结构化存储）
└────────┬────────┘
         ▼
┌─────────────────┐
│   pgvector      │ ← 向量检索（语义搜索事实）
└─────────────────┘
```

### 数据模型

- **ConversationHistory**: 对话历史记录（userId, role, content, metadata）
- **FactSnippet**: 提取的事实片段（userId, content, category, embedding）
- **UserSession**: 用户会话状态（sessionData, lastActive）

### 飞书集成

- 飞书 SDK 长连接消息接入
- 文档、画板、演示文稿创建
- 富媒体支持

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
│   ├── lark/          # 飞书消息接入模块
│   ├── agent/         # 智能代理模块
│   ├── memory/        # 记忆管理模块
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

| 类别    | 技术                    |
| ------- | ----------------------- |
| 框架    | NestJS                  |
| 语言    | TypeScript              |
| 数据库  | PostgreSQL + pgvector   |
| 缓存    | Redis                   |
| ORM     | Prisma                  |
| AI 能力 | 字节跳动 ARK、Ollama    |
| 部署    | Docker / Docker Compose |

---

## 贡献指南

欢迎提交 Issue 和 Pull Request！

---

## 许可证

ISC
