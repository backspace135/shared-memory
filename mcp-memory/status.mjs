// status.mjs — 打印共享记忆索引状态（供 memctl status 调用）
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
const SM = process.env.SHARED_MEMORY_ROOT || path.join(os.homedir(), "shared-memory");
const db = new Database(path.join(SM, "index", "memory.db"), { readonly: true });
const t = db.prepare("SELECT COUNT(*) n FROM docs").get().n;
const last = db.prepare("SELECT v FROM meta WHERE k='last_reindex'").get()?.v || "-";
const per = db.prepare("SELECT source,kind,COUNT(*) n FROM docs GROUP BY source,kind ORDER BY source").all();
console.log("总文档:", t, "  最近索引:", last);
per.forEach(r => console.log("  -", r.source, "/", r.kind, "=", r.n));
db.close();
