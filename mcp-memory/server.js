#!/usr/bin/env node
/**
 * shared-memory-mcp — 跨 Windows/WSL 四端 AI 编码客户端的统一记忆 MCP 服务。
 *
 * 单一主副本默认：<home>/shared-memory/（WSL Linux 侧；可用 SHARED_MEMORY_ROOT 覆盖）
 *   memories/   公共长期记忆（markdown + YAML frontmatter，唯一权威内容）
 *   maps/       项目映射（git remote 规范化 + 显式无 remote 目录映射）
 *   index/      SQLite FTS5 索引（纯衍生，可由源数据完整重建）
 *
 * 提供四个工具：memory_search / memory_read / memory_write / memory_status
 * 索引由本服务单进程管理，避免 Windows 与 WSL 并发直写同一数据库。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const HOME = os.homedir();
const SM_ROOT = process.env.SHARED_MEMORY_ROOT || path.join(HOME, "shared-memory");
const MEM_DIR = path.join(SM_ROOT, "memories");
const MAP_DIR = path.join(SM_ROOT, "maps");
const INDEX_DIR = path.join(SM_ROOT, "index");
const DB_PATH = path.join(INDEX_DIR, "memory.db");
const CHANGELOG = path.join(INDEX_DIR, "changelog.jsonl");

for (const d of [MEM_DIR, MAP_DIR, INDEX_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------------------
// 检索源（只读接入；不修改任何工具的原始数据）
// kind: markdown | omp_session | claude_transcript
// ---------------------------------------------------------------------------
function wslHome() { return HOME; }
function winHomeWsl() {
  // WSL 侧访问 Windows 用户目录（Claude Code 的会话记录）。
  // 用 WIN_USER 指定你的 Windows 用户名；不设则尝试自动探测 /mnt/c/Users 下的非公共目录。
  const u = process.env.WIN_USER || detectWinUser();
  return `/mnt/c/Users/${u}`;
}
function detectWinUser() {
  try {
    const skip = new Set(["Public", "Default", "Default User", "All Users", "AppData", "Application Data"]);
    const dirs = fs.readdirSync("/mnt/c/Users", { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !skip.has(d.name)).map(d => d.name);
    // 优先选择含 .claude 目录的用户（本系统真正对接的那个）
    const withClaude = dirs.filter(n => { try { return fs.existsSync(`/mnt/c/Users/${n}/.claude`); } catch { return false; } });
    return withClaude[0] || dirs[0] || "user";
  } catch { return "user"; }
}
const WIN_USER = process.env.WIN_USER || detectWinUser();
const SOURCES = [
  { id: "shared-memories", kind: "markdown", path: MEM_DIR, scope: "shared", enabled: true },
  { id: "claude-memory", kind: "markdown", path: path.join(winHomeWsl(), `.claude/projects/C--Users-${WIN_USER}/memory`), scope: "user", enabled: true },
  { id: "omp-sessions", kind: "omp_session", path: path.join(wslHome(), ".omp/agent/sessions"), scope: "history", enabled: true },
  { id: "claude-transcripts", kind: "claude_transcript", path: path.join(winHomeWsl(), ".claude/projects"), scope: "history", enabled: true },
];

// ---------------------------------------------------------------------------
// 项目识别：规范化 git remote + 显式映射（不按文件夹名合并）
// ---------------------------------------------------------------------------
function normalizeRemote(url) {
  if (!url) return null;
  let u = url.trim();
  u = u.replace(/\.git$/, "");
  // scp-like: git@host:path -> host/path
  const scp = u.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`.replace(/\/+/g, "/").toLowerCase();
  u = u.replace(/^[a-z]+:\/\//i, "");
  u = u.replace(/^[\w.-]+@/, "");
  return u.replace(/\/+/g, "/").toLowerCase();
}
function projectIdFromRemote(remote) {
  const n = normalizeRemote(remote);
  if (!n) return null;
  return "git:" + crypto.createHash("sha1").update(n).digest("hex").slice(0, 12);
}
function loadExplicitMap() {
  // maps/projects.json: [{ "id": "...", "paths": ["D:/project/x", "/mnt/d/project/x", ...] }]
  const f = path.join(MAP_DIR, "projects.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
}
function canonicalDir(p) {
  if (!p) return null;
  let s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  // 统一 Windows 与 /mnt 写法：D:/x 与 /mnt/d/x 视为同一键
  const m = s.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) s = `${m[1].toUpperCase()}:/${m[2]}`;
  const w = s.match(/^([a-zA-Z]):\/(.*)$/);
  if (w) s = `${w[1].toUpperCase()}:/${w[2]}`;
  return s;
}
function resolveProject(cwd) {
  const c = canonicalDir(cwd);
  if (!c) return { id: "global", name: "global", via: "none" };
  // 1) git remote（向上找 .git）
  try {
    const remote = execSync(`git -C "${cwd}" config --get remote.origin.url`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const id = projectIdFromRemote(remote);
    if (id) return { id, name: normalizeRemote(remote), via: "git-remote" };
  } catch {}
  // 2) 显式映射
  for (const e of loadExplicitMap()) {
    const paths = (e.paths || []).map(canonicalDir);
    if (paths.some(p => c === p || c.startsWith(p + "/"))) return { id: e.id, name: e.name || e.id, via: "explicit-map" };
  }
  // 3) 无 remote 且无映射：不猜测，归入 global（并记录待映射）
  return { id: "global", name: "global", via: "unmapped", hint: c };
}

// ---------------------------------------------------------------------------
// SQLite 索引（FTS5）。单进程管理；可从源数据完整重建。
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,          -- 稳定 ID：kind:source:hash
  kind TEXT NOT NULL,           -- memory | history
  source TEXT NOT NULL,         -- 来源 source id
  project TEXT NOT NULL,        -- 项目 id 或 global
  scope TEXT NOT NULL,          -- shared | user | project | history
  title TEXT,
  updated TEXT,                 -- ISO 时间（记忆）或会话时间
  fpath TEXT,                   -- 源文件路径（读取用）
  content TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, content, content='docs', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TABLE IF NOT EXISTS file_state ( fpath TEXT PRIMARY KEY, mtime INTEGER, size INTEGER );
CREATE TABLE IF NOT EXISTS meta ( k TEXT PRIMARY KEY, v TEXT );
`);

const insDoc = db.prepare(`INSERT INTO docs (id,kind,source,project,scope,title,updated,fpath,content)
  VALUES (@id,@kind,@source,@project,@scope,@title,@updated,@fpath,@content)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated=excluded.updated, content=excluded.content, fpath=excluded.fpath, project=excluded.project, scope=excluded.scope, kind=excluded.kind, source=excluded.source`);
const delDoc = db.prepare(`DELETE FROM docs WHERE id=?`);
const getState = db.prepare(`SELECT mtime,size FROM file_state WHERE fpath=?`);
const setState = db.prepare(`INSERT INTO file_state (fpath,mtime,size) VALUES (?,?,?) ON CONFLICT(fpath) DO UPDATE SET mtime=excluded.mtime,size=excluded.size`);
const allIndexedPaths = db.prepare(`SELECT fpath FROM file_state WHERE fpath LIKE ?`);

function hashId(...parts) { return crypto.createHash("sha1").update(parts.join("")).digest("hex").slice(0, 16); }

// ---------------------------------------------------------------------------
// 解析与索引
// ---------------------------------------------------------------------------
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { fm, body: text.slice(m[0].length) };
}

function indexMarkdownFile(src, fpath, stat) {
  const text = fs.readFileSync(fpath, "utf8");
  if (path.basename(fpath) === "MEMORY.md") { setState.run(fpath, stat.mtimeMs, stat.size); return; } // 索引文件本身不作为记忆
  const { fm, body } = parseFrontmatter(text);
  const id = fm.id || `${src.id}:${hashId(fpath)}`;
  const project = fm.project || "global";
  const scope = fm.scope || src.scope || "shared";
  const title = fm.description || (body.match(/^#\s+(.+)$/m) || [])[1] || path.basename(fpath, ".md");
  const updated = fm.updated || new Date(stat.mtimeMs).toISOString();
  insDoc.run({ id, kind: "memory", source: fm.source || src.id, project, scope, title, updated, fpath, content: body.slice(0, 20000) });
  setState.run(fpath, stat.mtimeMs, stat.size);
}

function* walk(dir, exts) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(fp, exts);
    else if (exts.includes(path.extname(e.name).toLowerCase())) yield fp;
  }
}

function indexOmpSession(src, fpath, stat) {
  // OMP 会话 jsonl：type:"message" + message.role:"user"（content 为 [{type:text,text}]）
  let lines;
  try { lines = fs.readFileSync(fpath, "utf8").split(/\r?\n/); } catch { return; }
  const sessId = path.basename(fpath, ".jsonl");
  const updated = new Date(stat.mtimeMs).toISOString();
  // 从 session 行读取真实 cwd 以解析项目
  let cwd = null;
  for (const line of lines) {
    if (!line.includes('"session"')) continue;
    try { const o = JSON.parse(line); if (o.type === "session" && o.cwd) { cwd = o.cwd; break; } } catch {}
  }
  const project = cwd ? resolveProject(cwd).id : "global";
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj.message && typeof obj.message === "object" ? obj.message : null;
    const isUser = (obj.type === "message" && msg && msg.role === "user") || obj.role === "user";
    if (!isUser) continue;
    let txt = "";
    const c = (msg && msg.content) ?? obj.content;
    if (typeof c === "string") txt = c;
    else if (Array.isArray(c)) txt = c.map(p => (typeof p === "string" ? p : (p && p.text) || "")).join(" ");
    txt = (txt || "").trim();
    if (txt.length < 4) continue;
    if (txt.startsWith("<") && txt.includes("system-reminder")) continue; // 跳过注入
    const ts = (msg && msg.timestamp) || obj.timestamp;
    const when = typeof ts === "number" ? new Date(ts).toISOString() : (typeof ts === "string" ? ts : updated);
    const id = `hist:omp:${sessId}:${n}`;
    insDoc.run({ id, kind: "history", source: src.id, project, scope: "history", title: txt.slice(0, 80), updated: when, fpath, content: txt.slice(0, 4000) });
    n++;
  }
  setState.run(fpath, stat.mtimeMs, stat.size);
}

function indexClaudeTranscript(src, fpath, stat) {
  let lines;
  try { lines = fs.readFileSync(fpath, "utf8").split(/\r?\n/); } catch { return; }
  const projDir = path.basename(path.dirname(fpath)); // 如 C--Users-<user>-Desktop-xxx
  const sessId = path.basename(fpath, ".jsonl");
  const updated = new Date(stat.mtimeMs).toISOString();
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "user") continue;
    const msg = obj.message || {};
    let txt = "";
    const c = msg.content;
    if (typeof c === "string") txt = c;
    else if (Array.isArray(c)) txt = c.map(p => (p && p.type === "text" ? p.text : "")).join(" ");
    txt = (txt || "").trim();
    if (txt.length < 4) continue;
    if (obj.isMeta) continue;
    const id = `hist:claude:${sessId}:${n}`;
    insDoc.run({ id, kind: "history", source: src.id, project: "global", scope: "history", title: txt.slice(0, 80), updated, fpath, content: txt.slice(0, 4000) });
    n++;
  }
  setState.run(fpath, stat.mtimeMs, stat.size);
}

function reindex() {
  const stats = { scanned: 0, indexed: 0, skipped: 0, removed: 0, errors: [] };
  const seen = new Set();
  const tx = db.transaction(() => {
    for (const src of SOURCES) {
      if (!src.enabled) continue;
      if (!fs.existsSync(src.path)) { stats.errors.push(`missing:${src.id}:${src.path}`); continue; }
      const exts = src.kind === "markdown" ? [".md"] : [".jsonl"];
      for (const fpath of walk(src.path, exts)) {
        stats.scanned++;
        seen.add(fpath);
        let st; try { st = fs.statSync(fpath); } catch { continue; }
        const prev = getState.get(fpath);
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) { stats.skipped++; continue; }
        try {
          if (src.kind === "markdown") indexMarkdownFile(src, fpath, st);
          else if (src.kind === "omp_session") indexOmpSession(src, fpath, st);
          else if (src.kind === "claude_transcript") indexClaudeTranscript(src, fpath, st);
          stats.indexed++;
        } catch (e) { stats.errors.push(`${fpath}:${e.message}`); }
      }
      // 清理已删除文件（该来源下曾索引、本次未再见到的路径）
      for (const row of allIndexedPaths.all(src.path + "%")) {
        if (!seen.has(row.fpath)) {
          db.prepare(`DELETE FROM docs WHERE fpath=?`).run(row.fpath);
          db.prepare(`DELETE FROM file_state WHERE fpath=?`).run(row.fpath);
          stats.removed++;
        }
      }
    }
    db.prepare(`INSERT INTO meta (k,v) VALUES ('last_reindex', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(new Date().toISOString());
  });
  tx();
  return stats;
}

// 记忆索引区块自动维护（四端共享 MEMORY.md）
function refreshMemoryIndex() {
  const memFile = path.join(MEM_DIR, "MEMORY.md");
  let rows;
  try { rows = db.prepare(`SELECT id,title,project,scope,updated FROM docs WHERE kind='memory' AND source='shared-memories' ORDER BY updated DESC`).all(); } catch { return; }
  let text; try { text = fs.readFileSync(memFile, "utf8"); } catch { return; }
  const list = rows.map(r => `- [${r.title}](${r.id}) — ${r.project} / ${r.scope} / ${String(r.updated).slice(0, 10)}`).join("\n") || "（空）";
  const next = text.replace(/<!-- AUTO-INDEX-START -->[\s\S]*?<!-- AUTO-INDEX-END -->/,
    `<!-- AUTO-INDEX-START -->\n${list}\n<!-- AUTO-INDEX-END -->`);
  if (next !== text) { const tmp = memFile + ".tmp"; fs.writeFileSync(tmp, next); fs.renameSync(tmp, memFile); }
}

// ---------------------------------------------------------------------------
// 并发安全的原子写入（锁文件 + tmp+rename + 变更日志）
// ---------------------------------------------------------------------------
const LOCK = path.join(INDEX_DIR, ".write.lock");
function acquireLock() {
  for (let i = 0; i < 50; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  throw new Error("无法获取写入锁（另一进程正在写入）");
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch {} }
function logChange(entry) {
  try { fs.appendFileSync(CHANGELOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}

// ---------------------------------------------------------------------------
// MCP 工具
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "shared-memory", version: "1.0.0" });

server.registerTool("memory_search", {
  title: "搜索共享记忆",
  description: "按关键词、项目、来源搜索四端共享的长期记忆与历史工作记录。返回稳定 id 列表，配合 memory_read 取全文。",
  inputSchema: {
    query: z.string().describe("搜索关键词（支持 FTS5 语法，中文按字符匹配）"),
    project: z.string().optional().describe("限定项目 id（如 git:xxxxxxxxxxxx）或 global"),
    source: z.string().optional().describe("限定来源：shared-memories | claude-memory | omp-sessions | claude-transcripts"),
    kind: z.enum(["memory", "history"]).optional().describe("限定记忆或历史"),
    limit: z.number().optional().default(20),
  },
}, async ({ query, project, source, kind, limit }) => {
  reindexIncremental();
  const conds = ["docs_fts MATCH ?"]; const args = [ftsEscape(query)];
  let join = "JOIN docs ON docs.rowid = docs_fts.rowid";
  if (project) { conds.push("docs.project = ?"); args.push(project); }
  if (source) { conds.push("docs.source = ?"); args.push(source); }
  if (kind) { conds.push("docs.kind = ?"); args.push(kind); }
  args.push(Math.min(limit || 20, 100));
  const sql = `SELECT docs.id, docs.kind, docs.source, docs.project, docs.scope, docs.title, docs.updated,
    snippet(docs_fts, 1, '[', ']', '…', 24) AS snip
    FROM docs_fts ${join} WHERE ${conds.join(" AND ")}
    ORDER BY rank LIMIT ?`;
  let rows;
  try { rows = db.prepare(sql).all(...args); }
  catch (e) { return { content: [{ type: "text", text: `搜索出错：${e.message}\n提示：关键词含特殊字符时已自动转义，可尝试更短的词。` }] }; }
  // 去重（保留来源）：同一标题+项目的历史命中合并展示
  const out = rows.map(r => ({ id: r.id, kind: r.kind, source: r.source, project: r.project, scope: r.scope, updated: r.updated, title: r.title, snippet: r.snip }));
  return { content: [{ type: "text", text: JSON.stringify({ count: out.length, results: out }, null, 2) }] };
});

server.registerTool("memory_read", {
  title: "读取记忆全文",
  description: "根据 memory_search 返回的稳定 id 读取完整内容。",
  inputSchema: { id: z.string().describe("memory_search 返回的 id") },
}, async ({ id }) => {
  reindexIncremental();
  const row = db.prepare(`SELECT * FROM docs WHERE id=?`).get(id);
  if (!row) return { content: [{ type: "text", text: `未找到 id：${id}（可能源文件已变动，请先 memory_search）` }] };
  return { content: [{ type: "text", text: JSON.stringify({ id: row.id, kind: row.kind, source: row.source, project: row.project, scope: row.scope, title: row.title, updated: row.updated, fpath: row.fpath, content: row.content }, null, 2) }] };
});

server.registerTool("memory_write", {
  title: "写入公共长期记忆",
  description: "新增或明确更新一条公共长期记忆（写入四端共享主副本，带 frontmatter、并发锁、原子更新与变更日志）。",
  inputSchema: {
    title: z.string().describe("一句话标题/描述"),
    content: z.string().describe("记忆正文（markdown）"),
    project: z.string().optional().describe("所属项目 id 或 global；留空则按 cwd 解析"),
    scope: z.enum(["shared", "user", "project"]).optional().default("shared"),
    id: z.string().optional().describe("更新已有记忆时传其 id；新增留空"),
    cwd: z.string().optional().describe("当前工作目录（用于自动解析项目）"),
  },
}, async ({ title, content, project, scope, id, cwd }) => {
  acquireLock();
  try {
    const proj = project || (cwd ? resolveProject(cwd).id : "global");
    let memId = id;
    let fpath;
    if (memId) {
      const existing = db.prepare(`SELECT fpath FROM docs WHERE id=?`).get(memId);
      fpath = existing?.fpath && existing.fpath.startsWith(MEM_DIR) ? existing.fpath : path.join(MEM_DIR, safeFile(memId) + ".md");
    } else {
      memId = "mem:" + hashId(title, content, Date.now());
      fpath = path.join(MEM_DIR, safeFile(memId) + ".md");
    }
    const now = new Date().toISOString();
    const fm = ["---", `id: ${memId}`, `project: ${proj}`, `scope: ${scope || "shared"}`, `updated: ${now}`, `source: shared-memories`, "---", "", `# ${title}`, "", content, ""].join("\n");
    const tmp = fpath + ".tmp";
    fs.writeFileSync(tmp, fm, "utf8");
    fs.renameSync(tmp, fpath); // 原子更新
    const st = fs.statSync(fpath);
    indexMarkdownFile({ id: "shared-memories", scope: "shared" }, fpath, st);
    refreshMemoryIndex();
    logChange({ op: id ? "update" : "create", id: memId, project: proj, scope, fpath });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: memId, project: proj, scope, updated: now, fpath }, null, 2) }] };
  } finally { releaseLock(); }
});

server.registerTool("memory_status", {
  title: "记忆接入状态",
  description: "查看接入的记忆来源、各来源文档数、最近索引时间与错误。",
  inputSchema: {},
}, async () => {
  const s = reindexIncremental();
  const perSource = db.prepare(`SELECT source, kind, COUNT(*) n FROM docs GROUP BY source, kind ORDER BY source`).all();
  const last = db.prepare(`SELECT v FROM meta WHERE k='last_reindex'`).get()?.v || null;
  const total = db.prepare(`SELECT COUNT(*) n FROM docs`).get().n;
  return { content: [{ type: "text", text: JSON.stringify({
    root: SM_ROOT, db: DB_PATH, total_docs: total, last_reindex: last,
    sources: SOURCES.map(x => ({ id: x.id, kind: x.kind, scope: x.scope, path: x.path, exists: fs.existsSync(x.path) })),
    counts: perSource, last_scan: s,
  }, null, 2) }] };
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------
function safeFile(id) { return id.replace(/[^A-Za-z0-9._-]+/g, "_"); }
function ftsEscape(q) {
  // 简单转义：把 FTS5 特殊字符当普通词；中文按连续子串匹配用引号短语
  const t = q.trim();
  if (!t) return '""';
  // 若含中文，按短语精确匹配效果更好
  return `"${t.replace(/"/g, '""')}"`;
}
let lastScan = 0;
function reindexIncremental() {
  const now = Date.now();
  if (now - lastScan < 3000) return { scanned: 0, indexed: 0, skipped: 0, removed: 0, errors: [], throttled: true };
  lastScan = now;
  try { return reindex(); } catch (e) { return { error: e.message, errors: [e.message] }; }
}

// ---------------------------------------------------------------------------
async function main() {
  if (process.argv.includes("--reindex")) {
    const s = reindex();
    refreshMemoryIndex();
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  reindex();
  refreshMemoryIndex();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("shared-memory-mcp ready on stdio");
}
main().catch(e => { console.error(e); process.exit(1); });
