# 代码审查

以下是另一个 Agent 完成的代码，请审查并提供修改建议。

## 变更摘要
{{CHANGE_SUMMARY}}

## 审查要点
- 代码质量和可维护性
- 潜在的 Bug
- 性能问题
- 是否符合项目规范

## 输出格式
审查结果应按以下格式输出到 `{{REVIEW_RESULT_FILE}}`：

### 严重问题（Critical）
### 中等问题（Major）
### 轻微问题（Minor）
### 优点
### 总评
- 整体评估：通过 / 有条件通过 / 不通过
- 质量评分：1-10

## 重要约束
- 将审查结果输出到 `{{REVIEW_RESULT_FILE}}`
- **完成后创建信号文件** `{{SIGNAL_FILE}}`，JSON 格式如下：

```json
{
  "status": "done",
  "brain_id": "<从 artifact 路径中提取你的 conversation-id>",
  "branch": "",
  "files_changed": [],
  "summary": "一句话描述审查结论",
  "skills_used": ["列出你读取和使用的 skill 名称"],
  "errors": []
}
```

> 💡 Reviewer 不需要创建/切换分支，`branch` 字段留空。

## 项目上下文
详见 `{{CONTEXT_FILE}}`，请先阅读该文件获取项目背景。

> ⚠️ **如果任务失败**，仍然必须创建信号文件，但将 `status` 改为 `"failed"`，并在 `errors` 中描述原因。
