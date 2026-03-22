# 🎯 Commander Skill

**Multi-Agent orchestration for [Gemini Code Assist](https://cloud.google.com/products/gemini/code-assist) / Antigravity**

Spawn, coordinate, and merge sub-agents — all from a single conversation.

> Gemini Code Assist doesn't have a native sub-agent API. Commander fills that gap by automating the Agent Manager UI via [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/), enabling you to orchestrate multiple agents from one "commander" session.

---

## ✨ Features

- **One-command agent creation** — `@commander implement user login` spawns a sub-agent automatically
- **Parallel execution** — Map-Reduce mode runs multiple agents simultaneously on independent tasks
- **Git branch isolation** — each sub-agent works on its own branch, Commander merges at the end
- **Signal-based coordination** — sub-agents report completion via JSON signal files (supports success/failure)
- **Adaptive polling** — exponential backoff (2s → 15s) reduces unnecessary file checks
- **Template system** — pre-built prompt templates for common patterns
- **Cross-review** — agents can review each other's work through file-based IPC

## 🏗️ Architecture

```
Commander (you)
  │
  ├── Phase 1: Discuss requirements → create execution plan
  ├── Phase 2: Create sub-agents via CDP
  │     ├── Agent A (branch: sub-xxx-1)
  │     ├── Agent B (branch: sub-xxx-2)
  │     └── Agent C (branch: sub-xxx-3)
  ├── Phase 3: Monitor via signal files (adaptive polling)
  ├── Phase 4: Git merge all branches
  └── Phase 5: Report results to user
```

## 📦 What's Inside

```
commander-skill/
├── SKILL.md              # Core instructions (injected as system prompt)
├── reference.md           # Supplementary reference (loaded on demand)
├── patterns.md            # Advanced patterns: Map-Reduce, Architect, Cross-Review
└── scripts/
    ├── index.js           # Unified CLI entry point
    ├── cdp-utils.js       # CDP WebSocket utilities
    ├── create-agent.js    # Create single or batch agents
    ├── send-to-agent.js   # Send messages to existing conversations
    ├── wait-signal.js     # Wait for signal files (adaptive polling)
    ├── merge-branches.js  # Merge Git branches with conflict detection
    ├── fill-template.js   # Template variable substitution
    └── templates/
        ├── single-task.md   # Standard task prompt
        ├── architect.md     # Architecture design prompt
        ├── reviewer.md      # Code review prompt
        └── cross-review.md  # Cross-review prompt
```

## 🚀 Installation

### Prerequisites

- **Gemini Code Assist** (Antigravity) with Agent Manager
- **Node.js** ≥ 16 (uses only built-in modules, no `npm install` needed)
- **CDP enabled**: Launch IDE with `--remote-debugging-port=9000`
- **Auto Accept extension**: Enable "Background" mode for fully autonomous sub-agents

### Setup

1. Clone this repo into your Antigravity skills directory:

```bash
# Windows
git clone https://github.com/lazy-dog-23/commander-skill.git "%USERPROFILE%\.gemini\antigravity\skills\commander"

# macOS / Linux
git clone https://github.com/lazy-dog-23/commander-skill.git ~/.gemini/antigravity/skills/commander
```

2. That's it! The skill is loaded automatically when you mention `@commander` in a conversation.

## 💡 Usage

### Single Task
```
@commander help me implement user authentication
```

### Map-Reduce (Parallel)
```
@commander use map-reduce mode: frontend, backend, and tests in parallel
```

### Architect Mode
```
@commander use architect mode to design and implement the entire project
```

### Discussion Mode
```
@commander have two agents discuss the best approach
```

## 🔧 CLI Tools

All scripts are accessed through `index.js`:

```bash
SCRIPTS="$SKILL_DIR/scripts"
node "$SCRIPTS/index.js" <command> [options]
```

| Command | Description |
|---|---|
| `list` | List CDP targets |
| `create` | Create a single sub-agent |
| `batch` | Create multiple sub-agents (Map-Reduce) |
| `send` | Send message to existing conversation (best-effort) |
| `wait` | Wait for signal files (adaptive polling) |
| `merge` | Merge Git branches with conflict detection |
| `template` | Fill prompt templates with variables |

## 📊 Orchestration Modes

| Mode | Use Case | Agents |
|---|---|---|
| **Single Task** | One focused task | 1 |
| **Map-Reduce** | Independent parallel tasks | N (parallel) |
| **Architect** | Design first, then implement | 1 architect + N workers |
| **Code Review** | Coder + Reviewer cycle | 2 (sequential) |
| **Consensus** | Two agents discuss → best solution | 2 + 2 reviewers |

## ⚠️ Limitations

- **CDP dependency**: Relies on Chrome DevTools Protocol to automate the Agent Manager UI. If the UI structure changes, scripts may need updating
- **Windows-focused**: Primary development and testing on Windows (PowerShell). Unix support is possible but untested
- **Best-effort `send`**: Sending messages to existing conversations relies on DOM text matching and may fail
- **One workspace**: All sub-agents must be created in the same workspace

## 🤝 Contributing

Issues and PRs welcome! The main areas for improvement:

- Cross-platform support (macOS/Linux)
- More robust CDP selectors
- Additional orchestration patterns
- Performance optimizations

## 📄 License

[MIT](LICENSE)
