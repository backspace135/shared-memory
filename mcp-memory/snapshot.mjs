#!/usr/bin/env node
/**
 * snapshot.mjs — 生成启动注入用的精简记忆快照。
 * 输出：关键全局规则 + 与当前 cwd 相关的项目记忆摘要 + 检索入口说明。
 * 用法: node snapshot.mjs [cwd]
 * 保持精简：只放摘要与入口，详细内容用 memory_search / memory_read 按需查询。
 */
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const HOME = os.homedir();
const SM = process.env.SHARED_MEMORY_ROOT || path.join(HOME, "shared-memory");
const DB = path.join(SM, "index", "memory.db");
const cwd = process.argv[2] || process.cwd();

function canon(p){ if(!p) return null; let s=String(p).replace(/\\/g,"/").replace(/\/+$/,""); const m=s.match(/^\/mnt\/([a-zA-Z])\/(.*)$/); if(m) s=`${m[1].toUpperCase()}:/${m[2]}`; const w=s.match(/^([a-zA-Z]):\/(.*)$/); if(w) s=`${w[1].toUpperCase()}:/${w[2]}`; return s; }
function normRemote(u){ if(!u) return null; let s=u.trim().replace(/\.git$/,""); const scp=s.match(/^[\w.-]+@([\w.-]+):(.+)$/); if(scp) return `${scp[1].toLowerCase()}/${scp[2]}`.replace(/\/+/g,"/").toLowerCase(); s=s.replace(/^[a-z]+:\/\//i,"").replace(/^[\w.-]+@/,""); return s.replace(/\/+/g,"/").toLowerCase(); }
function projFromRemote(r){ const n=normRemote(r); return n? "git:"+crypto.createHash("sha1").update(n).digest("hex").slice(0,12):null; }
function loadMap(){ try{ return JSON.parse(fs.readFileSync(path.join(SM,"maps","projects.json"),"utf8")); }catch{ return []; } }
function resolveProject(c){
  try{ const r=execSync(`git -C "${c}" config --get remote.origin.url`,{stdio:["ignore","pipe","ignore"]}).toString().trim(); const id=projFromRemote(r); if(id) return {id,name:normRemote(r)}; }catch{}
  const cc=canon(c); for(const e of loadMap()){ const ps=(e.paths||[]).map(canon); if(ps.some(p=>cc===p||cc.startsWith(p+"/"))) return {id:e.id,name:e.name||e.id}; }
  return {id:"global",name:"global"};
}

const proj = resolveProject(cwd);
let out = [];
out.push("## 共享记忆（四端打通）");
out.push("");
out.push(`- 公共记忆主副本：\`${SM}\`（WSL 侧；Windows 经 \\\\wsl$\\Ubuntu\\... 访问）`);
out.push(`- 当前项目：\`${proj.name}\` (id: \`${proj.id}\`)`);
out.push("- 检索工具：`memory_search`(关键词/项目/来源)、`memory_read`(按 id 取全文)、`memory_write`(写入公共记忆)、`memory_status`(来源与索引状态)。");
out.push("- 规则：长期记忆供参考，**当前用户指令与当前代码事实优先**；历史会话命中仅为背景，不等于当前指令。冲突记忆注明时间与来源，不静默覆盖。");
out.push("");

if (fs.existsSync(DB)) {
  try {
    const db = new Database(DB, { readonly: true });
    const g = db.prepare(`SELECT id,title,updated FROM docs WHERE kind='memory' AND project='global' ORDER BY updated DESC LIMIT 5`).all();
    const p = proj.id !== "global" ? db.prepare(`SELECT id,title,updated FROM docs WHERE kind='memory' AND project=? ORDER BY updated DESC LIMIT 8`).all(proj.id) : [];
    if (g.length) { out.push("### 全局/用户记忆（摘要）"); for (const r of g) out.push(`- [${r.title}](${r.id}) · ${String(r.updated).slice(0,10)}`); out.push(""); }
    if (p.length) { out.push(`### 本项目记忆（${proj.name}）`); for (const r of p) out.push(`- [${r.title}](${r.id}) · ${String(r.updated).slice(0,10)}`); out.push(""); }
    if (!g.length && !p.length) out.push("（暂无匹配摘要；用 memory_search 检索全部记忆与历史。）");
    db.close();
  } catch (e) { out.push(`(索引读取失败：${e.message})`); }
} else {
  out.push("(索引尚未建立；调用任意 memory_* 工具会自动建立。)"
  );
}
out.push("");
out.push("> 需要详细内容时：先 `memory_search \"关键词\"`，再 `memory_read id`。保存新记忆用 `memory_write`。");
process.stdout.write(out.join("\n"));
