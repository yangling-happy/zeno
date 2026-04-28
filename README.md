# Zeno

企业级智能对话平台，集成飞书消息接入、多模态大模型能力、长时记忆管理系统。

## 技术栈

- 框架: NestJS
- 语言: TypeScript
- 数据库: PostgreSQL + pgvector
- 缓存: Redis
- ORM: Prisma
- AI 能力: 字节跳动 ARK、Ollama
- 部署: Docker / Docker Compose

## 环境要求

- Node.js >= 20
- pnpm >= 8
- Docker (可选，用于依赖服务部署)

## 快速开始

### 方式一：Docker 完整部署（推荐）

所有服务（后端应用 + 依赖服务）均运行在 Docker 容器中，无需安装任何本地环境。

1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填写飞书、ARK 等必要配置信息
```

2. 启动所有服务

```bash
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

5. 验证服务状态

```bash
docker-compose ps
# 所有服务状态应为 Up (healthy)
```

### 方式二：本地开发模式

适用于需要本地代码热更新的开发场景。

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
# 编辑 .env 文件，填写必要的配置信息
```

4. 数据库迁移

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

## 常用命令

### Docker 部署相关

```bash
# 构建应用镜像（代码修改后需要重新执行）
docker build -t zeno-app .

# 启动所有服务
docker-compose up -d

# 重启指定服务
docker-compose restart [服务名]

# 查看服务状态
docker-compose ps

# 查看服务日志
docker-compose logs -f [服务名]

# 停止所有服务
docker-compose down

# 停止所有服务并删除数据卷（谨慎使用）
docker-compose down -v

# 进入应用容器执行命令
docker exec -it zeno-app bash
```

### 开发相关

```bash
# 开发模式启动
pnpm run start:dev

# 生产构建
pnpm run build

# 生产模式启动
pnpm run start:prod

# 生成 Prisma Client
npx prisma generate

# 创建数据库迁移
npx prisma migrate dev

# 数据库可视化工具
npx prisma studio
```

## 项目结构

```
src/
├── modules/
│   ├── lark/          # 飞书消息接入模块
│   ├── agent/         # 智能代理模块
│   ├── memory/        # 记忆管理模块
│   └── common/        # 公共组件
└── main.ts            # 应用入口
```

## 核心功能

- 飞书长连接消息接入
- 多轮对话上下文管理
- 三层记忆存储架构（Redis/PostgreSQL/pgvector）
- 自动事实提取和向量存储
- 语义检索长期记忆
- 意图识别和任务调度
