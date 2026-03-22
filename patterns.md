# Commander — 高级编排模式

> 本文件包含 Map-Reduce、Architect、Agent 间讨论等高级模式的详细流程。
> 基础工作流请参见 [SKILL.md](./SKILL.md)。

---

## Map-Reduce 模式

当任务可以拆分为多个**互不依赖**的子任务时，使用 Map-Reduce 模式并行执行。

### 适用场景

- 前端 + 后端 + 测试 分别开发
- 多个模块的独立重构
- 批量文件处理（每个子 Agent 处理一部分）
- 多语言翻译、多页面开发等

### Map 阶段（拆分与分发）

1. **分析依赖并预检文件归属**：

   > ⚠️ **文件去重是 Map-Reduce 的必要前提。** 拆分任务时，为每个子任务列出预计修改的文件清单，确保**没有文件同时被两个子任务修改**。如果有重叠（如两个子任务都需修改 `settings.py`），必须把该文件的修改归到其中一个子任务中，或将公共文件的修改拆为独立子任务。
2. **为每个子任务创建 prompt 文件**：

```bash
# 写入多个 prompt 文件
write_to_file → .commander/{taskId}/prompt-1.md  # 如：前端组件
write_to_file → .commander/{taskId}/prompt-2.md  # 如：后端 API
write_to_file → .commander/{taskId}/prompt-3.md  # 如：单元测试
```

3. **批量创建子 Agent**（`batch` 子命令：一次 CDP 连接创建所有 Agent，~8s 完成）：

```bash
node "$SCRIPTS\index.js" batch --prompt-files {workspace}/.commander/{taskId}/prompt-1.md {workspace}/.commander/{taskId}/prompt-2.md {workspace}/.commander/{taskId}/prompt-3.md --workspace "项目名" --result-file {workspace}/.commander/{taskId}/batch-result.json --log-file {workspace}/.commander/{taskId}/create-log.txt
```

> 💡 `batch` 子命令复用同一 CDP 连接，比逐个创建快 40%+。一个 tool call 即可创建所有子 Agent。

> ⚠️ 如果 batch 中某个 Agent 创建后无法导航回 Manager，剩余 Agent 将被标记为 `aborted_no_nav_button`。Commander 应检查 `batch-result.json` 中各 Agent 的 `error` 字段，对失败的 Agent 使用单独 `create` 重试。

4. **确认所有子 Agent 已创建**：检查所有 result JSON 文件

### Reduce 阶段（等待与合并）

1. **启动监听**：每个子 Agent 的 Prompt 中指定不同编号的信号文件和分支名

```bash
node "$SCRIPTS\index.js" wait --files {workspace}/.commander/{taskId}/done-1.json {workspace}/.commander/{taskId}/done-2.json {workspace}/.commander/{taskId}/done-3.json --timeout 600
```

2. **读取进度**：`view_file` 读 `.commander/{taskId}/wait-status.json`，看到 `all_done` 后继续
3. **合并 Git 分支**：

```bash
node "$SCRIPTS\index.js" merge --branches sub-{taskId}-1 sub-{taskId}-2 sub-{taskId}-3 --target main --result-file {workspace}/.commander/{taskId}/merge.json
```

脚本自动处理冲突检测。如有冲突 → `notify_user` 通知用户。

4. **汇总报告**：从各信号 JSON 的 `summary` + `files_changed` + merge 结果直接生成报告
5. **清理**：`Remove-Item .commander\{taskId} -Recurse -Force -ErrorAction SilentlyContinue`

### 文件冲突处理

> 💡 Git 分支隔离已大幅降低冲突风险。如果 `git merge` 产生冲突，Commander 应使用 `notify_user` 通知用户手动解决，并在汇报中列出冲突文件。

### Map-Reduce 汇报模板

```markdown
## ✅ Map-Reduce 任务完成

### 子任务执行总览
| # | 子任务 | 状态 | 耗时 |
|---|---|---|---|
| 1 | {任务描述} | ✅ 完成 | ~{N}s |
| 2 | {任务描述} | ✅ 完成 | ~{N}s |
| 3 | {任务描述} | ✅ 完成 | ~{N}s |

### 合并结果
{整体变更摘要}

### 变更文件汇总
| 文件 | 子任务# | 操作 |
|---|---|---|
| `path/to/file` | 1 | 新建 |

### 需要你关注的事项
{文件冲突、异常、需手动确认的内容}
```

---

## Architect 模式（设计优先）

复杂项目先由 Architect Agent 设计架构，再由 Worker Agent 分模块实现。

### 流程

```
Phase A: Commander 创建 Architect Agent → 输出架构文档
Phase B: Commander 读取架构 → 按模块拆分 → 创建 Worker Agent（Map-Reduce）
Phase C: 等待全部完成 → 合并 → 汇报
```

### Phase A：架构设计

1. Commander 构建 Architect Prompt（使用模板 `templates/architect.md`，通过 `index.js template` 填充变量，写入 `.commander/{taskId}/prompt-arch.md`）：

```bash
node "$SCRIPTS\index.js" template --template templates/architect.md --output .commander/{taskId}/prompt-arch.md --var "REQUIREMENTS=用户需求描述" --var "ARCHITECTURE_FILE={workspace}/.commander/{taskId}/architecture.md" --var "BRANCH=sub-{taskId}-arch" --var "SIGNAL_FILE={workspace}/.commander/{taskId}/done-arch.json" --var "CONTEXT_FILE={workspace}/.commander/{taskId}/context.md"
```

> 💡 模板变量说明请参考 `templates/architect.md`。

2. 创建 Architect Agent → 监听信号 → 读取架构文档
3. Commander 解析架构 → 识别可并行模块 → 进入 Map-Reduce 阶段

### Phase B-C：按 Map-Reduce 模式执行

- 每个 Worker 的 Prompt 中注入 Architect 的**接口约定**
- 确保 Worker 按约定实现，避免模块间不兼容

---

## Agent 间讨论模式

通过 **batch-create + 文件路径共享** 实现 Agent 之间的交叉评审和讨论。

> ⚠️ `send-to-agent.js` 为 best-effort 操作（依赖 DOM 文本匹配），推荐优先使用 batch-create。详见 SKILL.md「交叉审阅推荐模式」。

### send 脚本（仅用于追问同一 Agent）

```bash
node "$SCRIPTS\index.js" send --target "会话名称" --workspace "工作区" --prompt-file "{workspace}/.commander/{taskId}/review.md" --result-file "{workspace}/.commander/{taskId}/send-result.json"
```

### 模式一：Code Review

```
1. Commander 创建 Agent-Coder → 写代码 → 信号文件通知完成
2. Commander 读取 Coder 产出（walkthrough.md）→ 构建 Review Prompt
3. Commander 创建 Agent-Reviewer → 审查代码 → 信号文件通知完成
4. Commander 读取审查意见 → 构建修改指令 Prompt
5. Commander 向 Agent-Coder 发送修改指令（send-to-agent.js），指令中要求完成后创建新信号文件 `{workspace}/.commander/{taskId}/done-fix.json`
   > ⚠️ `send` 为 best-effort。如果发送失败，改用 batch-create 新建 Agent 并在 prompt 中指定修改指令 + Coder 原有的工作区文件路径。
6. Commander 监听 `.commander/{taskId}/done-fix.json` → Agent-Coder 修改完成
7. Commander 读取最终结果 → 汇报
```

Review Prompt 模板：

> 💡 推荐使用 `templates/reviewer.md` 模板（通过 `index.js template` 填充），以下为手写参考。

```markdown
# 代码审查

以下是另一个 Agent 完成的代码，请审查并提供修改建议：

## 变更摘要
{从 Coder 的 walkthrough.md 中提取}

## 审查要点
- 代码质量和可维护性
- 潜在的 Bug
- 性能问题
- 是否符合项目规范

## 输出格式
### 严重问题（Critical）
### 中等问题（Major）
### 轻微问题（Minor）
### 优点
### 总评
- 整体评估：通过 / 有条件通过 / 不通过
- 质量评分：1-10

## 重要约束
- 将审查结果输出到 `{workspace}/.commander/{taskId}/review-result.md`
- 完成后创建信号文件 `{workspace}/.commander/{taskId}/done-review.json`（JSON 格式同 Phase 3）
```

### 模式二：方案共识

> ⛔ **每个 Phase 都是强制步骤，不得跳过。** 如果用户要求"让两个 Agent 讨论/交流"，必须完整执行所有 Phase。

```
Phase 1：创建 Agent-A 和 Agent-B → 各自生成方案
   - Agent-A 写入 .commander/{taskId}/proposal-A.md → 信号 done-A.json
   - Agent-B 写入 .commander/{taskId}/proposal-B.md → 信号 done-B.json
   - wait-signal.js 等待两个信号

⛔ Phase 2：交叉审阅（必须执行，不得跳过）— 使用 batch-create
   - Commander 用 batch-create 创建两个新审阅 Agent：
     · 审阅 Agent C 的 prompt 中写明「请阅读 .commander/{taskId}/proposal-B.md 并审阅」
     · 审阅 Agent D 的 prompt 中写明「请阅读 .commander/{taskId}/proposal-A.md 并审阅」
   - 各审阅 Agent 输出 review-A.md / review-B.md → 信号 done-review-A/B.json
   - wait-signal.js 等待两个审阅信号

Phase 3：Commander 读取双方审阅意见 → 合并最终方案
Phase 4：Commander 创建 Agent-Executor → 执行最终方案
```

> ⚠️ **跳过 Phase 2 = 任务失败。** 用户要求"交流"的核心就是 Phase 2 的交叉审阅。如果只做了 Phase 1 就直接汇总，等于没有执行交流。
