# 执行任务

## 任务目标
{{TASK_GOAL}}

## 执行步骤
{{STEPS}}

## 涉及的文件和路径
{{FILES}}

## 重要约束
- 严格按照上述步骤执行，不要偏离方案
- ⚠️ **必须使用指定的分支名** `{{BRANCH}}`，不要自己命名分支
- **开始工作前**，创建并切换到独立分支：`git checkout -b {{BRANCH}}`
- **完成后**，提交所有修改：`git add -A; git commit -m "{{BRANCH}}: {{TASK_GOAL}}"`
- 每完成一个步骤，在 task.md 中标记完成
- 所有操作完成后，创建 walkthrough.md 汇总所有改动
- 执行完成后使用 notify_user 通知用户任务完成
- **完成所有任务后，创建信号文件**：`write_to_file` 创建 `{{SIGNAL_FILE}}`，JSON 格式如下：

```json
{
  "status": "done",
  "brain_id": "<从 artifact 路径中提取你的 conversation-id>",
  "branch": "{{BRANCH}}",
  "files_changed": ["列出你修改的所有文件的相对路径"],
  "summary": "一句话描述完成了什么",
  "skills_used": ["列出你读取和使用的 skill 名称"],
  "errors": []
}
```

> brain_id 获取方式：从你的 artifact 目录路径 `<appDataDir>/brain/<conversation-id>` 中提取 `<conversation-id>` 部分。

> ⚠️ **如果任务失败**，仍然必须创建信号文件，但将 `status` 改为 `"failed"`，并在 `errors` 中详细描述失败原因：
> ```json
> { "status": "failed", "brain_id": "...", "branch": "{{BRANCH}}", "files_changed": [], "summary": "任务失败", "errors": ["失败原因描述"] }
> ```

## 项目上下文
详见 `{{CONTEXT_FILE}}`，请先阅读该文件获取项目背景。
