<div align="center">

# Zeno

Enterprise-grade intelligent dialogue platform integrating Feishu messaging, multi-modal LLM capabilities, and long-term memory management.

**English** · [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="https://skillicons.dev/icons?i=nestjs,typescript,postgresql,redis,docker" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Feishu-3387FF?style=flat-square&logo=&logoColor=white" />
  <img src="https://img.shields.io/badge/ARK-4253E8?style=flat-square" />
  <img src="https://img.shields.io/badge/Ollama-FF6B35?style=flat-square&logo=ollama&logoColor=white" />
  <img src="https://img.shields.io/badge/pgvector-336791?style=flat-square" />
</p>

</div>

---

<details>
<summary><kbd>Table of contents</kbd></summary>

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Architecture](#-architecture)
- [Contributing](#-contributing)
- [License](#-license)

</details>

---

## Features

### Intent Recognition & Skill System

Accurate intent classification with 9 skill categories covering task planning, documentation, whiteboard collaboration, presentation, cross-device sync, delivery, identity queries, safety responses, and clarification.

| Intent         | Description                    |
| -------------- | ------------------------------ |
| SCENE_PLAN     | Task understanding & planning  |
| SCENE_DOC      | Document/whiteboard editing    |
| SCENE_PRESENT  | Whiteboard/presentation        |
| SCENE_SYNC     | Cross-device synchronization   |
| SCENE_DELIVERY | Summary & delivery             |
| AGENT_IDENTITY | Identity queries               |
| SAFE_REFUSAL   | Safety responses               |
| CLARIFY        | Ambiguous intent clarification |
| CHITCHAT       | Casual conversation            |

### Three-tier Memory Architecture

```
User Input
    │
    ▼
┌─────────────────┐
│   Redis Cache   │ ← Immediate context (recent conversations)
└────────┬────────┘
         ▼
┌─────────────────┐
│  PostgreSQL     │ ← Long-term history (structured storage)
└────────┬────────┘
         ▼
┌─────────────────┐
│   pgvector      │ ← Vector search (semantic fact retrieval)
└─────────────────┘
```

### Data Models

- **ConversationHistory**: Conversation records (userId, role, content, metadata)
- **FactSnippet**: Extracted facts (userId, content, category, embedding)
- **UserSession**: User session state (sessionData, lastActive)

### Feishu Integration

- Long connection messaging via Feishu SDK
- Document, whiteboard, and presentation creation
- Rich media support

---

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 8
- Docker (optional, for dependency services)

### Method 1: Docker Full Deployment (Recommended)

All services run in Docker containers without local environment setup.

1. Configure environment variables

```bash
cp .env.example .env
# Edit .env with Feishu, ARK credentials
```

2. Build and start services

```bash
docker-compose build
docker-compose up -d
```

3. Run database migrations

```bash
docker exec -it zeno-app npx prisma migrate dev --name init
```

4. Download Ollama embedding model

```bash
docker exec -it zeno-ollama ollama run nomic-embed-text
```

### Method 2: Docker Dev Mode (Hot Reload)

```bash
docker-compose build
docker-compose up
```

### Method 3: Local Development

1. Install dependencies

```bash
pnpm install
```

2. Start dependency services

```bash
docker-compose up -d redis postgres ollama
```

3. Configure environment variables

```bash
cp .env.example .env
```

4. Run migrations

```bash
npx prisma migrate dev --name init
```

5. Start dev server

```bash
pnpm run start:dev
```

## Service Ports

| Service    | Port  | Description                 |
| ---------- | ----- | --------------------------- |
| Main App   | 3000  | API service                 |
| Redis      | 6379  | Cache & immediate context   |
| PostgreSQL | 5432  | Relational & vector storage |
| Ollama     | 11434 | Vector embedding service    |

## Architecture

```
src/
├── modules/
│   ├── lark/          # Feishu messaging module
│   ├── agent/         # Intelligent agent module
│   ├── memory/        # Memory management module
│   └── common/        # Shared utilities
└── main.ts            # Application entry
```

## Environment Variables

| Variable         | Description                  | Required |
| ---------------- | ---------------------------- | -------- |
| LARK_APP_ID      | Feishu application ID        | Yes      |
| LARK_APP_SECRET  | Feishu application secret    | Yes      |
| LARK_WEBHOOK_URL | Feishu webhook URL           | Yes      |
| ARK_API_KEY      | ByteDance ARK API key        | Yes      |
| ARK_BASE_URL     | ARK API endpoint             | Yes      |
| DATABASE_URL     | PostgreSQL connection string | Yes      |
| REDIS_HOST       | Redis host                   | Yes      |
| REDIS_PORT       | Redis port                   | Yes      |
| OLLAMA_BASE_URL  | Ollama service address       | Yes      |

## Tech Stack

| Category   | Technologies            |
| ---------- | ----------------------- |
| Framework  | NestJS                  |
| Language   | TypeScript              |
| Database   | PostgreSQL + pgvector   |
| Cache      | Redis                   |
| ORM        | Prisma                  |
| AI         | ByteDance ARK, Ollama   |
| Deployment | Docker / Docker Compose |

---

## Contributing

Contributions, issues, and feature requests are welcome!

---

## License

ISC
