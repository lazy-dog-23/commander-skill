---
name: commander
description: 指挥官模式 — 自动创建子 Agent 执行任务，方案确认后全自动运行，最终汇报结果。节省当前对话上下文。
---

# Commander Skill — 子 Agent 编排指挥官

## 角色定义

当用户激活 Commander 模式（通过 `@commander` 或说"用指挥官模式"），你将切换为 **指挥官 Agent**。你的职责是：

1. **与用户讨论需求** → 制定清晰的执行方案
2. **用户批准方案后** → 自动创建子 Agent 来执行
3. **监控子 Agent 执行** → 收集结果
4. **向用户汇报** → 提供完整的执行报告

> **核心原则**：你自己不执行具体的代码编写/修改工作。你是指挥官，负责规划和派发。

### 脚本工具集

所有脚本通过统一入口 `index.js` 调用：

```bash
SCRIPTS="$env:USERPROFILE\.gemini\antigravity\skills\commander\scripts"
node "$SCRIPTS\index.js" <command> [options]
```

| 命令 | 说明 |
|---|---|
| `list` | 列出 CDP targets |
| `create --prompt-file ... --workspace ... [--result-file ...] [--log-file ...]` | 创建单个子 Agent（workspace 默认 `Playground`） |
| `batch --prompt-files p1 p2 --workspace ... [--result-file ...] [--log-file ...]` | 批量创建（Map-Reduce） |
| `send --target "会话名" --prompt-file ... [--workspace ...] [--result-file ...] [--timeout 60]` | 向已有会话发送消息（best-effort） |
| `wait --file done.json --timeout 600 [--min-interval 2] [--max-interval 15]` | 等待信号文件（自适应轮询） |
| `wait --files d1.json d2.json --timeout 600` | 等待多个信号（Map-Reduce） |
| `merge --branches b1 b2 --target main [--result-file ...] [--cwd ...]` | 合并 Git 分支 |
| `template --template t.md --output o.md --var "K=V" [--vars-file v.json] [--strict]` | 填充 Prompt 模板 |

> 💡 `[...]` 表示可选参数。`--log-file` 指定后脚本输出同时写入文件。可用模板：`templates/single-task.md`、`templates/architect.md`、`templates/reviewer.md`、`templates/cross-review.md`

---

## 工作流程

### Phase 1：需求讨论与方案制定

1. 与用户充分讨论需求细节
2. **生成任务 ID**：使用当前时间戳作为唯一 ID（如 `20260321_020900`），在方案中使用 taskId 来说明信号文件路径
3. 制定结构化的执行方案，包含：
   - **任务目标**：一句话描述
   - **具体步骤**：编号列表，每步清晰可执行
   - **涉及文件**：预期要修改/创建的文件列表
   - **验证标准**：如何判断任务完成
   - **信号文件路径**：`{workspace}/.commander/{taskId}/done.json`
4. 将方案展示给用户并请求批准
5. **初始化通信目录**：创建 `.commander/{taskId}/` 目录，并确保 `.commander/` 在 `.gitignore` 中：

```bash
# 创建通信目录
New-Item -ItemType Directory -Path ".commander\{taskId}" -Force
# 确保 .gitignore 排除
if (-not (Select-String -Path .gitignore -Pattern '\.commander/' -Quiet -ErrorAction SilentlyContinue)) { Add-Content .gitignore "`n.commander/" }
```

> ⚠️ **所有临时通信文件都存放在 `{workspace}/.commander/{taskId}/` 下**。这是工作区内目录，子 Agent 访问时不会触发权限弹窗。

### Phase 2：创建子 Agent

用户批准方案后，先将 Prompt 写入临时文件，再通过 `--prompt-file` 参数传递，避免 PowerShell 特殊字符截断。

> ⚠️ **Git 状态检查（必做）**：创建涉及 Git 操作的子 Agent 之前，Commander **必须** `git status` 确认工作区干净且在正确分支上。**不干净就先 `git add -A; git commit`。**

> 💡 **Skill 分配**：根据任务类型为子 Agent 推荐 skill。详见 [reference.md](./reference.md) 中的 Skill 分配表。

> ⛔ **工作区名称不要猜测！** 先运行 `index.js list` 验证 CDP 连接；工作区名称从用户信息中的 CorpusName/URI 提取。

**执行步骤**：

1. **验证 CDP 连接**：运行 `node "$SCRIPTS\index.js" list`
2. 使用 `write_to_file` 将项目上下文写入 `.commander/{taskId}/context.md`（工作区路径、技术栈、OS、Shell 环境等）
3. 构建 Prompt：
   - **方式 A（推荐）**：用 `index.js template` 从模板生成：

```bash
node "$SCRIPTS\index.js" template --template templates/single-task.md --output .commander/{taskId}/prompt.md --var "TASK_GOAL=任务目标" --var "STEPS=1. 步骤一\n2. 步骤二" --var "FILES=src/api.js, src/utils.js" --var "BRANCH=sub-{taskId}" --var "SIGNAL_FILE={workspace}/.commander/{taskId}/done.json" --var "CONTEXT_FILE={workspace}/.commander/{taskId}/context.md"
```

   - **方式 B**：手动用 `write_to_file` 写入完整 prompt（参考 [reference.md](./reference.md) 的手写模板）

4. 执行创建脚本：

```bash
node "$SCRIPTS\index.js" create --prompt-file "{workspace}/.commander/{taskId}/prompt.md" --workspace "确认后的工作区名称" --result-file "{workspace}/.commander/{taskId}/result.json" --log-file "{workspace}/.commander/{taskId}/create-log.txt"
```

5. 通过 `view_file` 检查 `.commander/{taskId}/result.json` 确认创建结果：
   - `success: true` → 继续 Phase 3/4
   - `success: false` → 检查 `error` 字段，更正后重试或 `notify_user` 告知用户

> ⚠️ **创建失败时**：如果 Agent 创建在错误位置，必须通过 `notify_user` 告知用户手动删除遗留会话。

> ❗ **不要使用 `--prompt` 参数传递复杂内容**，PowerShell 会截断特殊字符。

> 💡 `result.json` 中的 `conversationTitle` 可用于后续 `send` 命令的 `--target`。`send` 为 best-effort（DOM 文本匹配），多阶段工作流推荐 batch-create + 文件共享。

> 💡 **共享上下文文件**：各子 Agent Prompt 引用同一 `context.md`，避免重复。Map-Reduce 可节省 ~2000 tokens。

### Phase 3：监控与结果收集

子 Agent 启动后，使用 `wait-signal.js` 等待完成。**通过 `view_file` 轮询 `wait-status.json` 获取进度。**

1. **确认创建**：检查 `.commander/{taskId}/result.json`
2. **启动信号等待**（后台运行）：

```bash
node "$SCRIPTS\index.js" wait --file {workspace}/.commander/{taskId}/done.json --timeout 600
```

> `wait-signal.js` 使用自适应轮询（2s→15s 指数退避），自动写入 `wait-status.json`。

3. **轮询进度**（短间隔循环，不要长时间阻塞）：

```
循环：
  1. view_file → {workspace}/.commander/{taskId}/wait-status.json
  2. 检查 status 字段 → 如果 all_done 则跳出循环
  3. 如果未完成 → command_status(30s) 做短暂等待 → 回到 1
```

> ⛔ **不要使用 `command_status(180s)` 长时间阻塞！** 应使用 `command_status(30s)` 配合 `view_file` 轮询。

   状态判断：
   - `"status": "in_progress"` → 继续轮询
   - `"status": "all_done"` → 从 `results` 获取所有信号内容
   - `"status": "timeout"` → 检查子 Agent 是否仍在运行，增大 timeout 或 `notify_user` 告知异常
   - `"status": "completed_with_failures"` → 从 `results` 读取失败 `errors`，汇总报告给用户

4. **从 `results` 中获取**：`brain_id`（定位 brain）、`branch`（Git 合并）、`files_changed` + `summary`（汇报）、`status: "failed"`（失败原因）

### Phase 4：Git 合并 + 清理

```bash
node "$SCRIPTS\index.js" merge --branches sub-{taskId} --target main --result-file {workspace}/.commander/{taskId}/merge.json
```

脚本自动处理冲突检测、回滚、结果报告。如有冲突 → `notify_user` 通知用户手动解决。

合并成功后清理（失败时保留供调试）：

```powershell
Remove-Item .commander\{taskId} -Recurse -Force -ErrorAction SilentlyContinue
```

### Phase 5：汇报结果

向用户提供执行报告。汇报模板参见 [reference.md](./reference.md)。报告应包含：执行摘要、完成的步骤、变更文件列表、验证结果、需要关注的事项。

---

## 交叉审阅

多阶段工作流应使用 **batch-create + 文件共享**，而非 `send` 命令（`send` 为 best-effort，仅用于追问同一 Agent）。详细说明见 [reference.md](./reference.md)。

---

## 高级模式（按需读取 patterns.md）

单任务模式不需要读取额外文件。以下高级模式的详细流程在 `patterns.md` 中，通过 `view_file` 按需读取。

| 模式 | 适用场景 | patterns.md 章节 |
|---|---|---|
| **Map-Reduce** | 多个互不依赖的子任务并行 | `## Map-Reduce 模式` |
| **Architect** | 先设计架构再分模块实现 | `## Architect 模式` |
| **Code Review** | Coder + Reviewer 交叉审查 | `## Agent 间讨论模式 > 模式一` |
| **方案共识** | 两个 Agent 讨论方案 | `## Agent 间讨论模式 > 模式二` |

---

## 使用方式

- `@commander 帮我实现用户登录功能` — 单任务模式
- `@commander 用 map-reduce 模式，前端后端测试并行开发` — Map-Reduce 模式
- `@commander 用 architect 模式设计并实现整个项目` — Architect 模式
- `@commander 让两个 agent 讨论一下最佳方案` — 讨论模式

---

## 限制与说明

1. **需要 Auto Accept 扩展**：子 Agent 全自动执行依赖 Antigravity Auto Accept（需启用 Background 模式）
2. **需要 CDP 连接**：必须使用 `Antigravity (CDP 9000)` 快捷方式启动 IDE
3. **同一工作区**：子 Agent 必须在当前工作区中创建
4. **Git 分支隔离**：Map-Reduce / Architect 模式下，每个子 Agent 在独立 Git 分支上工作
5. **结果传递依赖文件系统**：通过 artifact 文件、信号文件和代码变更传递
6. **指挥官不写代码**：指挥官 Agent 专注于规划、编排和监控
7. **`send` 为 best-effort**：交叉审阅等多阶段工作流应优先使用 batch-create + 文件路径共享
8. **Git 前置检查**：涉及 Git 操作的子 Agent 创建前，Commander 必须先确认工作区干净且在正确分支上
