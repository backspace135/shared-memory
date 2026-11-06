# shared-memory — 跨 Windows / WSL 的 AI 编码工具统一记忆

一套**最小组件**的 MCP 记忆层，让四个 AI 编码客户端共享同一份长期记忆与可检索历史：

- **WSL · OMP**（oh-my-pi）
- **WSL · OpenCode**
- **Windows · OpenCode**
- **Windows · Claude Code**

## 它解决什么

- 四个客户端都能读取同一份**长期记忆**，并**搜索历史工作记录**。
- 同一个项目，无论从 Windows 路径（`D:/proj/x`）还是 WSL 路径（`/mnt/d/proj/x`）进入，都识别为**同一个项目**。
- 新增长期记忆写入**公共层**，其他客户端的新会话可立即读到。
- 新会话自动获得**精简**的关键规则 + 项目记忆摘要 + 检索入口；详细内容按需查询。
- 每条记忆保留**来源 / 所属项目 / 更新时间 / 作用域**，冲突可追溯，不静默覆盖。

## 架构

单个 **MCP 服务**（Node + better-sqlite3 FTS5）跑在 WSL，对外暴露四个工具：

| 工具 | 作用 |
|---|---|
| `memory_search` | 按关键词 / 项目 / 来源 / 类型搜索，返回稳定 `id` + 摘要 |
| `memory_read` | 按 `id` 读取完整内容 |
| `memory_write` | 新增 / 明确更新公共长期记忆（并发锁 + tmp+rename 原子写 + 变更日志） |
| `memory_status` | 查看接入来源、各来源文档数、索引状态与错误 |

```
┌─────────────┐  stdio   ┌──────────────────────────────┐
│ WSL OMP     │─────────▶│                              │
├─────────────┤  stdio   │   shared-memory MCP server   │   唯一主副本
│ WSL OpenCode│─────────▶│   (Node + SQLite FTS5, WSL)  │──▶ /home/<user>/shared-memory/
├─────────────┤  stdio   │                              │    ├ memories/  公共长期记忆
│ Win OpenCode├──wsl.exe─▶│   memory_search / read /     │    ├ maps/      项目映射
├─────────────┤  stdio   │   write / status             │    └ index/     可重建索引
│ Win Claude  ├──wsl.exe─▶│                              │
└─────────────┘          └──────────────────────────────┘
```

- **单一主副本**放在 WSL Linux 侧，避免维护两份会漂移的副本；Windows 客户端经 `wsl.exe` 桥接调用同一进程。
- **索引是纯衍生品**，由服务单进程管理（避免 Windows 与 WSL 并发直写同一 SQLite），可从源数据完整重建。
- **历史会话**（OMP / Claude 的 jsonl）只索引**用户消息文本**作为可检索背景，不把聊天记录当成当前指令。

## 安装（四端）

前提：WSL2 发行版内有 `node`（≥18）与 `git`。把本仓库放到 WSL 侧（建议 `~/shared-memory`），然后：

```bash
cd ~/shared-memory/mcp-memory
npm install            # 安装 @modelcontextprotocol/sdk 与 better-sqlite3
node server.js --reindex
```

**1) OMP（WSL）** — 编辑 `~/.omp/agent/mcp.json`，在 `mcpServers` 加：
```json
"shared-memory": { "type": "stdio", "command": "/usr/bin/node", "args": ["/home/<user>/shared-memory/mcp-memory/server.js"] }
```
可选启动注入：把 `mcp-memory/omp-extension-example.ts` 复制到 `~/.omp/agent/extensions/`。

**2) OpenCode（WSL）** — 编辑 `~/.config/opencode/opencode.json`，在 `mcp.servers` 加：
```json
"shared-memory": { "type": "local", "command": ["/usr/bin/node", "/home/<user>/shared-memory/mcp-memory/server.js"], "enabled": true }
```

**3) OpenCode（Windows）** — 编辑 `%USERPROFILE%\.config\opencode\opencode.json`，在 `mcp.servers` 加（经 wsl.exe 桥接）：
```json
"shared-memory": { "type": "local", "command": ["C:/Windows/System32/wsl.exe", "-d", "Ubuntu", "-e", "/usr/bin/node", "/home/<user>/shared-memory/mcp-memory/server.js"], "enabled": true }
```

**4) Claude Code（Windows）** — 在 `%USERPROFILE%\.claude.json` 的 `mcpServers` 加同上的 wsl.exe 桥接；并可选在 `settings.json` 加 `SessionStart` 钩子调用 `mcp-memory/snapshot.mjs` 注入精简快照。

> 提示：把 README 中的 `<user>` 换成你的用户名。公共主副本位置也可用环境变量 `SHARED_MEMORY_ROOT` 覆盖。

## 日常使用

模型在会话里直接调用四个工具即可（无需手动跑命令）：先 `memory_search "关键词"` 拿到 `id`，再 `memory_read id` 取全文；确证的长期结论用 `memory_write` 写入；`memory_status` 随时看来源与索引状态。

命令行维护：
```bash
bin/memctl status    # 来源 / 文档数 / 最近索引
bin/memctl reindex   # 增量重建索引
bin/memctl doctor    # 自检：脚本、目录、四端配置
bin/memctl test      # MCP 冒烟测试（search → write → read）
```

## 项目识别规则

1. **优先 git remote**：规范化（去 `.git`、`git@host:path` 与 `https://host/path` 统一、小写）后哈希为 `git:xxxxxxxxxxxx`。同一仓库在 Windows 与 WSL 下算出同一 id，天然打通；worktree 共享项目记忆。
2. **无 remote**：查 `maps/projects.json` 显式映射（同时写 Windows 与 `/mnt/...` 两种路径）。**不按文件夹名猜测合并**；未命中且无 remote 的目录归入 `global`。

示例见 `maps/projects.example.json`（把占位路径换成你自己的，并保存为 `maps/projects.json`——该文件含本地路径，已被 `.gitignore` 排除）。

## 安全边界

- 检索范围仅限已配置来源（共享记忆、Claude 长期记忆、OMP / Claude 历史），OpenCode 内部数据库不索引（避免跨 9P 并发写损坏）。
- 不上传任何记忆到第三方；真实记忆、索引、变更日志、你的私有项目路径**全部本地保留**，本仓库只含代码与文档。
- 公共记忆写入带并发锁 + 原子更新 + 变更日志；索引可重建。

## 验收

`mcp-memory/accept.mjs` 是自包含的引擎级验收（在临时隔离 `SHARED_MEMORY_ROOT` 中运行，不触碰真实数据）：

```bash
cd mcp-memory && node accept.mjs
```

覆盖：Windows/WSL 路径项目一致性、git-remote 派生 id、项目隔离、中文与带空格路径、按 id 增量更新、统一写入入口、删除后索引同步。
