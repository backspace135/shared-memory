import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * shared-memory-inject — 在每个新 OMP 会话启动时注入精简共享记忆快照。
 * 快照由 shared-memory/mcp-memory/snapshot.mjs 生成：
 *   关键规则 + 全局/本项目记忆摘要 + memory_search/memory_read/memory_write 检索入口。
 * 详细内容不入注入，模型按需调用 shared-memory MCP 工具查询。
 *
 * 安装：把本文件复制到 ~/.omp/agent/extensions/ 即可（OMP 自动发现该目录）。
 */

const HOME = homedir();
const SM = process.env.SHARED_MEMORY_ROOT || join(HOME, "shared-memory");
const SNAPSHOT = join(SM, "mcp-memory", "snapshot.mjs");
const NODE = process.env.SHARED_MEMORY_NODE || "/usr/bin/node";

function runSnapshot(cwd: string): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(NODE, [SNAPSHOT, cwd], { env: process.env });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(""); }, 8000);
    child.stdout?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr?.on("data", () => {});
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const cwd = (ctx as { cwd?: string }).cwd || process.cwd();
      const snap = await runSnapshot(cwd);
      if (!snap) return;
      pi.sendMessage(
        { customType: "shared-memory-snapshot", content: snap, display: false },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    } catch {
      /* 注入失败不阻塞会话 */
    }
  });
}
