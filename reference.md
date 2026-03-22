# Commander — 参考文档

> 本文件包含从 SKILL.md 迁移的补充参考内容。Commander 按需通过 `view_file` 读取。

---

## Skill 分配表

根据子 Agent 的任务类型，在 Prompt 中指定推荐使用的 skill。子 Agent 应先读取 skill 的 SKILL.md 再开始工作。

> **Note**: 以下 skill 均为 Antigravity 内置 skill，不属于本项目。此表仅供 Commander 编排时参考。

| 任务类型 | 推荐 Skill | 说明 |
|---|---|---|
| 需求分析/规划 | `@brainstorming` | 把模糊想法变成结构化计划 |
| 架构设计 | `@architecture` | 系统和组件设计方法论 |
| 功能开发 | `@blueprint` | 一句话需求变逐步施工计划 |
| 代码修复/排错 | `@debugging-strategies`, `@bug-hunter` | 系统化排错流程 |
| 安全审计/审查 | `@security-auditor` | 安全检查清单 |
| 代码审查 | `@ask-questions-if-underspecified` | 动手前先问清楚需求 |
| 测试编写 | `@test-driven-development` | TDD 工作流 |
| 文档写作 | `@doc-coauthoring` | 结构化文档协作 |
| 代码提交/PR | `@create-pr` | 规范化 PR 创建 |

**在 Prompt 中添加**（示例）：
```
## 推荐 Skill
开始工作前，请先读取以下 skill 并遵循其工作流：
- `@security-auditor`（路径：~/.gemini/antigravity/skills/security-auditor/SKILL.md）
```

---

## 手写 Prompt 模板参考

如果不使用 `index.js template`（方式 B），参考以下模板手动构建子 Agent 的执行指令（写入 `.commander/{taskId}/prompt.md`）：

```markdown
# 执行任务

## 任务目标
{从方案中提取的目标描述}

## 执行步骤
{从方案中提取的具体步骤，编号列表}

## 涉及的文件和路径
{列出所有相关的文件路径和工作区路径}

## 重要约束
- 严格按照上述步骤执行，不要偏离方案
- **开始工作前**，创建并切换到独立分支：`git checkout -b sub-{taskId}`
- **完成后**，提交所有修改：`git add -A; git commit -m "sub-{taskId}: {任务描述}"`
- 每完成一个步骤，在 task.md 中标记完成
- 所有操作完成后，创建 walkthrough.md 汇总所有改动
- 执行完成后使用 notify_user 通知用户任务完成
- **完成所有任务后，创建信号文件**：`write_to_file` 创建 `{workspace}/.commander/{taskId}/done.json`，JSON 格式如下：

```json
{
  "status": "done",
  "brain_id": "<从 artifact 路径中提取你的 conversation-id>",
  "branch": "sub-{taskId}",
  "files_changed": ["path/to/file1.js", "path/to/file2.js"],
  "summary": "一句话描述完成了什么",
  "skills_used": ["列出你读取和使用的 skill 名称"],
  "errors": []
}
```

> brain_id 获取方式：从你的 artifact 目录路径 `<appDataDir>/brain/<conversation-id>` 中提取 `<conversation-id>` 部分。

> ⚠️ **如果任务失败**，仍然必须创建信号文件，但将 `status` 改为 `"failed"`，并在 `errors` 中详细描述失败原因。这样 Commander 能立即知道失败，而不是等待超时。

## 项目上下文
详见 `{workspace}/.commander/{taskId}/context.md`，请先阅读该文件获取项目背景。
```

---

## 汇报模板

### 单任务汇报

```markdown
## ✅ 任务执行完成

### 执行摘要
{一句话总结}

### 完成的工作
- ✅ {步骤1描述} — 已完成
- ✅ {步骤2描述} — 已完成

### 变更的文件
| 文件 | 操作 | 说明 |
|---|---|---|
| `path/to/file` | 新建/修改/删除 | 简要说明 |

### 验证结果
{测试/验证的结果}

### 需要你关注的事项
{如有异常或需要手动确认的内容}
```

### Map-Reduce 汇报

```markdown
## ✅ Map-Reduce 任务完成

### 子任务执行总览
| # | 子任务 | 状态 | 耗时 |
|---|---|---|---|
| 1 | {任务描述} | ✅ 完成 | ~{N}s |

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

## 交叉审阅详细说明

多阶段工作流（如 Phase 1 审查 → Phase 2 交叉审阅）应使用 **batch-create + 文件共享**，而非 `send` 命令：

```
Phase 1: batch-create Agent A + B → 各自输出 proposal-A.md / proposal-B.md
Phase 2: batch-create 交叉审阅 Agent → prompt 中写明「请阅读 .commander/{taskId}/proposal-X.md」
Phase 3: Commander 读取所有报告 → 综合汇总
```

**为什么不用 `send`？**
- Manager SPA 不暴露会话 ID（无 hash 路由、无 data 属性、无 href）
- `send` 依赖 DOM 文本匹配，目标会话可能被改名或处于 active 状态
- `batch-create` 100% 可靠，文件路径是确定性的 IPC 通道
- 性能差异 < 2 秒（创建 ~5s vs send ~3s）

> 💡 `send` 保留用于**追问同一 Agent**的场景（如要求补充细节），此时目标明确且失败可重试。
