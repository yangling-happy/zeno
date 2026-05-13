<div align="center">

# Zeno

IM-based office collaboration intelligent assistant integrating Feishu messaging, intent routing, document/whiteboard actions, and conversation memory.

**English** · [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="https://skillicons.dev/icons?i=nestjs,typescript,postgresql,redis,docker" />
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Feishu-3387FF?style=flat-square&logo=&logoColor=white" />
  <img src="https://img.shields.io/badge/ARK-4253E8?style=flat-square" />
  <img src="https://img.shields.io/badge/Ollama-FF6B35?style=flat-square&logo=ollama&logoColor=white" />
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

### IM Message Access & Async Processing

- Receive Feishu IM messages through long connection
- Push incoming messages into BullMQ for async consumption
- Send queued acknowledgment, retry failed jobs, and avoid duplicate processing

### Intent Routing & Scene Reply

Route user requests into planning, documentation, whiteboard/presentation, sync, delivery, identity, safety, clarification, and chitchat scenes.

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

### Conversation Context & Fact Persistence

```
User Input
    │
    ▼
┌─────────────────┐
│   Redis Cache   │ ← Recent conversations
└────────┬────────┘
         ▼
┌─────────────────┐
│  PostgreSQL     │ ← Conversation history & fact snippets
└────────┬────────┘
         ▼
┌─────────────────┐
│ Ollama Embedding│ ← Generate embeddings for extracted facts
└─────────────────┘
```

### Data Models

- **ConversationHistory**: Conversation records (userId, role, content, metadata)
- **FactSnippet**: Extracted facts (userId, content, category, embedding)
- **UserSession**: User session state (sessionData, lastActive)

### Feishu Workspace Actions

- Long connection messaging via Feishu SDK
- Document creation and append
- Whiteboard creation and markdown-to-node writing
- Presentation creation

### Stability & Observability

- AI timeout and retry handling
- Queue retry and worker concurrency control
- OpenTelemetry tracing support

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
│   ├── lark/          # Feishu IM and workspace actions
│   ├── agent/         # Intent routing and agent loop
│   ├── memory/        # Recent context and fact persistence
│   ├── queue/         # Async message queue and worker
│   ├── ai/            # Model invocation wrapper
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

| Category      | Technologies                     |
| ------------- | -------------------------------- |
| Framework     | NestJS                           |
| Language      | TypeScript                       |
| Storage       | PostgreSQL, Redis                |
| ORM           | Prisma                           |
| AI            | ByteDance ARK, Ollama Embeddings |
| Queue         | BullMQ                           |
| Observability | OpenTelemetry, Jaeger            |
| Deployment    | Docker / Docker Compose          |

---

## Contributing

Contributions, issues, and feature requests are welcome!

---

## License

ISC
