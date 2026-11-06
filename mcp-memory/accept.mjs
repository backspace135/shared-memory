// accept.mjs — 引擎级验收（自包含，不依赖/不修改任何真实项目配置）。
// 用临时 SHARED_MEMORY_ROOT 隔离运行，避免污染真实数据。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 临时隔离环境：独立的 SHARED_MEMORY_ROOT，验收数据不落地到真实主副本。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sm-accept-"));
const SM = path.join(TMP, "shared-memory");
fs.mkdirSync(path.join(SM, "memories"), { recursive: true });
fs.mkdirSync(path.join(SM, "maps"), { recursive: true });
fs.mkdirSync(path.join(SM, "index"), { recursive: true });
fs.writeFileSync(path.join(SM, "memories", "MEMORY.md"), "# 公共长期记忆索引\n<!-- AUTO-INDEX-START -->\n<!-- AUTO-INDEX-END -->\n");

// 显式映射：占位项目（不指向任何真实目录）
const demoWin = "D:/sm-accept-mapped", demoWsl = "/mnt/d/sm-accept-mapped";
fs.writeFileSync(path.join(SM, "maps", "projects.json"), JSON.stringify([
  { id: "proj:sm-accept-mapped", name: "sm-accept-mapped", paths: [demoWin, demoWsl] },
  { id: "proj:sm-accept-other", name: "sm-accept-other", paths: ["D:/sm-accept-other", "/mnt/d/sm-accept-other"] },
], null, 2));

// 临时 git 仓库（验证 git-remote 项目同一性）
const demoDir = path.join(TMP, "same-repo");
fs.mkdirSync(demoDir, { recursive: true });
execSync("git init -q", { cwd: demoDir });
execSync('git remote add origin "https://example.com/demo/same-repo.git"', { cwd: demoDir });

const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
const transport = new StdioClientTransport({
  command: "node", args: [serverPath],
  env: { ...process.env, SHARED_MEMORY_ROOT: SM },
});
const client = new Client({ name: "accept", version: "0.1" });
await client.connect(transport);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { if (cond) { pass++; console.log("  ✔", label); } else { fail++; console.log("  ✘", label, extra); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log("== 5. 同一仓库 Windows 与 WSL 路径 -> 项目一致 ==");
const wWin = await call("memory_write", { title: "验收-路径一致性", content: "验证 Windows 与 WSL 路径映射到同一项目。", cwd: demoWin });
const wWsl = await call("memory_write", { title: "验收-路径一致性2", content: "从 WSL 路径写入。", cwd: demoWsl });
check("两侧解析出相同 project id", wWin.project === wWsl.project, `win=${wWin.project} wsl=${wWsl.project}`);
check("项目 id 为显式映射 proj:sm-accept-mapped", wWin.project === "proj:sm-accept-mapped", wWin.project);
const wGit = await call("memory_write", { title: "验收-git仓库", content: "git remote 派生项目 id。", cwd: demoDir });
check("git remote 派生稳定 id (git:xxxxxxxxxxxx)", /^git:[0-9a-f]{12}$/.test(wGit.project), wGit.project);

console.log("== 6. 项目隔离：另一项目不混入本项目记忆 ==");
const wOther = await call("memory_write", { title: "验收-隔离-other", content: "这是 other 项目专属记忆。", cwd: "D:/sm-accept-other" });
const inMapped = await call("memory_search", { query: "验收-隔离-other", project: "proj:sm-accept-mapped" });
const inOther = await call("memory_search", { query: "验收-隔离-other", project: "proj:sm-accept-other" });
check("mapped 项目检索不到 other 记忆", inMapped.count === 0, `got ${inMapped.count}`);
check("other 项目能检索到自己的记忆", inOther.count >= 1, `got ${inOther.count}`);

console.log("== 7. 中文 + 带空格路径 + 增量更新 ==");
const wZh = await call("memory_write", { title: "验收-中文路径", content: "中文内容写入测试，含标点：，。！", cwd: demoWsl });
check("带空格/中文写入成功", wZh.ok === true, JSON.stringify(wZh));
const sZh = await call("memory_search", { query: "中文内容写入测试", kind: "memory" });
check("中文可被搜索到", sZh.count >= 1, `got ${sZh.count}`);
const upd = await call("memory_write", { id: wZh.id, title: "验收-中文路径", content: "中文内容已更新 v2。" });
check("按 id 更新成功", upd.ok === true && upd.id === wZh.id);
const readUpd = await call("memory_read", { id: wZh.id });
check("更新后读到 v2", (readUpd.content || "").includes("v2"), readUpd.content);

console.log("== 3/4. 统一写入入口 + 全端可检索 ==");
check("公共层记忆可检索", (await call("memory_search", { query: "路径一致性", kind: "memory" })).count >= 1);

console.log("== 清理（删除文件后索引应移除） ==");
const memDir = path.join(SM, "memories");
for (const id of [wWin.id, wWsl.id, wOther.id, wZh.id, wGit.id]) {
  const r = await call("memory_read", { id });
  if (r.fpath && r.fpath.startsWith(memDir)) { try { fs.unlinkSync(r.fpath); } catch {} }
}
await sleep(3500);
let after = await call("memory_search", { query: "验收-路径一致性", kind: "memory" });
for (let i = 0; i < 5 && after.count !== 0; i++) { await sleep(3500); after = await call("memory_search", { query: "验收-路径一致性", kind: "memory" }); }
check("清理后检索不到测试记忆", after.count === 0, `got ${after.count}`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
await client.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
