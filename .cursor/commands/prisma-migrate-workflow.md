# Prisma 与数据库变更流程

1. 编辑 `prisma/schema.prisma` 后本地执行 `pnpm exec prisma validate` 与 `pnpm exec prisma generate`。
2. 若使用 migrate 工作流：`pnpm exec prisma migrate dev`（迁移名语义化）；生产环境以团队规范为准。
3. 全局检索 `ConversationHistory`、`FactSnippet`、`UserSession` 与 `PrismaClient` 使用处，更新类型与查询字段。
4. 若有数据回填或破坏性变更，在说明中写清单步脚本与回滚。
