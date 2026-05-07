# 运行单元测试

在项目根执行：

```bash
pnpm run test
```

若只跑某一文件，使用 Jest 的路径过滤（示例）：

```bash
pnpm exec jest src/modules/agent/agent.service.spec.ts --no-cache
```

修改了 mock 或异步逻辑后，可加 `--detectOpenHandles` 排查句柄泄漏。
