---
name: agent-loop-enhancement
overview: 在不改动飞书主入口和现有对外调用方式的前提下，为 Zeno 增加显式多步 Agent Loop，让请求在一次 run 内支持“决策 -> 动作规划 -> 观察结果 -> 继续决策/结束”的闭环。
todos:
  - id: inspect-graph-contracts
    content: 确认 agent graph state 与 AgentRunResult 的最小可扩展字段，保持 run() 和 Lark 主链路兼容
    status: pending
  - id: design-loop-nodes
    content: 设计 planner / observation / loop_guard 三类节点及 continue/finish/clarify 条件边
    status: pending
  - id: preserve-lark-behavior
    content: 标记并保护文档追加短路、DOC_CREATE 分段回复、userContextMap 写回等现有行为
    status: pending
  - id: plan-tests
    content: 补充 loop 终止、maxSteps、clarify 降级与 Lark 兼容性测试
    status: pending
isProject: false
---

# 显式多步 Agent Loop 改造计划

## 目标

在保持 `AgentService.run()`、`ActionInstruction` 和飞书消息主链路兼容的前提下，把当前单次路由图升级为可显式迭代的多步 Loop，增强 Agent 感，同时不破坏现有文档追加短路、异步队列处理和最终回复逻辑。

## 当前现状

当前请求链路为：飞书消息入队 -> `LarkService.handleQueuedMessage()` -> `AgentService.run()` -> 单次 `graph.invoke()` -> 返回单个 `ActionInstruction` -> `LarkActionExecutorService.execute()`。

现有状态图在 [`f:\zeno\src\modules\agent\agent-graph.service.ts`](f:\zeno\src\modules\agent\agent-graph.service.ts) 中是线性分支：

```173:235:f:\zeno\src\modules\agent\agent-graph.service.ts
      .addNode('clarify_node', async (state) => {
        // ...
      })
      .addNode('general_chat', async (state) => {
        // ...
      })
      .addEdge(START, 'normalize_input')
      .addEdge('normalize_input', 'intent_classifier')
      .addConditionalEdges('intent_classifier', (state) => state.route, {
        plan: 'planner_node',
        sync: 'sync_node',
        doc: 'doc_node',
        present: 'present_node',
        chat: 'general_chat',
        clarify: 'clarify_node',
        end: END,
      })
      .addEdge('planner_node', END)
      .addEdge('sync_node', END)
      .addEdge('doc_node', END)
      .addEdge('present_node', END)
      .addEdge('clarify_node', END)
      .addEdge('general_chat', END);
```

因此它更像“单步场景路由”，而不是“可反复规划和收敛的 Agent Loop”。

## 改造思路

### 1. 保持外部契约不变

保留以下接口与调用方式：

- [`f:\zeno\src\modules\agent\agent.service.ts`](f:\zeno\src\modules\agent\agent.service.ts) 的 `run(input: AgentRunInput): Promise<AgentRunResult>`
- [`f:\zeno\src\modules\agent\agent.types.ts`](f:\zeno\src\modules\agent\agent.types.ts) 中现有 `ActionInstruction` 联合类型
- [`f:\zeno\src\modules\lark\lark.service.ts`](f:\zeno\src\modules\lark\lark.service.ts) 中现有 “拿到 `AgentRunResult` 后执行飞书动作” 的主链路

这样飞书侧无需整体重写，只在 Agent 内部增强 Loop 能力。

### 2. 在图内引入显式步骤状态

扩展 [`f:\zeno\src\modules\agent\agent-graph.service.ts`](f:\zeno\src\modules\agent\agent-graph.service.ts) 的 Graph state，新增最小必要字段：

- `stepCount`: 当前循环步数
- `maxSteps`: 最大步数
- `shouldContinue`: 是否继续下一步
- `observation`: 当前步骤的结果摘要
- `pendingAction`: 当前规划出的候选动作

第一版不做“图内真实执行飞书 API”，而是在图内完成“决策/重规划”的 loop，把最终可执行动作仍收敛为一个 `ActionInstruction` 返回给 Lark 层执行。

### 3. 把节点改成“分类 -> 规划 -> 观察 -> 决定是否继续”

在 [`f:\zeno\src\modules\agent\agent-graph.service.ts`](f:\zeno\src\modules\agent\agent-graph.service.ts) 中新增/重构节点：

- `normalize_input`
- `intent_classifier`
- `planner_node`: 生成本轮动作和回复意图
- `observation_node`: 根据当前动作和上下文判断是否已足够收敛
- `loop_guard_node`: 判断继续下一步还是结束

其中 `loop_guard_node` 通过条件边：

- `continue` -> 回到 `planner_node` 或 `intent_classifier`
- `finish` -> `END`
- `clarify` -> `clarify_node`

第一期建议限制为最多 `2~3` 步，防止图内循环失控。

### 4. 让多步 loop 聚焦在“更像 Agent 的决策闭环”，不提前改飞书执行器

保持 [`f:\zeno\src\modules\lark\lark-action-executor.service.ts`](f:\zeno\src\modules\lark\lark-action-executor.service.ts) 不承担多步执行职责；它仍只处理最终返回的单个 `ActionInstruction`。

这样可以避免一次改动同时触碰：

- 图内循环
- 飞书多次动作执行
- 多条中间回复
- 队列 ACK / 最终回复分支

把复杂度控制在“Agent 内多步决策，Lark 层单步执行”这一边界内。

### 5. 为最终结果补充可选的步骤信息，但不破坏当前消费者

在 [`f:\zeno\src\modules\agent\agent.types.ts`](f:\zeno\src\modules\agent\agent.types.ts) 中给 `AgentRunResult` 增加可选字段，例如：

- `steps?: string[]`
- 或 `loopSummary?: { stepCount: number; terminatedBy: 'finish' | 'max_steps' | 'clarify' }`

Lark 层可以先忽略这些字段，但它们能帮助后续增强 trace、日志和调试能力。

### 6. 保住现有特殊路径

改造时显式保护以下行为：

- [`f:\zeno\src\modules\lark\lark.service.ts`](f:\zeno\src\modules\lark\lark.service.ts) 中“延续上一份文档直接追加”的短路逻辑不进多步 loop
- `LARK_DOC_CREATE` 现有“排队确认 + 最终文档链接回复”的分段行为不变
- `userContextMap` 对 `lastDocId` / `lastWhiteboardId` 的写回逻辑不变
- `SessionService` 仍只记录用户输入和最终助手回复，不把中间 loop 文案写入用户会话

## 需要修改的核心文件

- [`f:\zeno\src\modules\agent\agent-graph.service.ts`](f:\zeno\src\modules\agent\agent-graph.service.ts)
  - 扩展状态定义
  - 增加 loop 相关节点和回边
  - 增加最大步数控制
- [`f:\zeno\src\modules\agent\agent.service.ts`](f:\zeno\src\modules\agent\agent.service.ts)
  - 初始化 loop 状态
  - 处理新增的 graph 输出字段
  - 维持现有 `run()` 结果兼容
- [`f:\zeno\src\modules\agent\agent.types.ts`](f:\zeno\src\modules\agent\agent.types.ts)
  - 为 loop 增加最小必要类型
  - 给 `AgentRunResult` 增加可选调试/步骤字段
- [`f:\zeno\src\modules\agent\tool\agent-tool.service.ts`](f:\zeno\src\modules\agent\tool\agent-tool.service.ts)
  - 保证规划阶段的动作生成可重复调用且结果稳定
- [`f:\zeno\src\modules\agent\agent.service.spec.ts`](f:\zeno\src\modules\agent\agent.service.spec.ts)
  - 补充 loop 终止、最大步数、澄清降级等测试
- [`f:\zeno\src\modules\agent\tool\agent-tool.service.spec.ts`](f:\zeno\src\modules\agent\tool\agent-tool.service.spec.ts)
  - 视改动补充规划重复调用与稳定性边界测试

## 测试计划

优先补以下测试：

- 单次请求在 2 步内结束，并返回最终动作
- 达到 `maxSteps` 后安全结束，不死循环
- 低置信度或中途不确定时转入 `CLARIFY`
- 文档追加短路路径仍绕过 Agent Loop
- 最终返回的 `ActionInstruction` 对现有 Lark 执行链保持兼容

## 结果预期

完成后，项目的 Agent 主链路会从“单步场景分流”升级为“有限步数的显式决策闭环”：

- 执行路径更像 Agent，而不是单次分类器
- 步数、终止原因和 trace 更可解释
- 不需要同时重写飞书执行层，改动范围可控
- 为后续加入预算约束、人工确认和更强观察能力留出结构位置
