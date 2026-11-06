// 一次性 MCP stdio 客户端：依次调用 status / search / write / search / read，打印结果。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("./server.js", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1")],
  env: { ...process.env },
});
const client = new Client({ name: "smoke", version: "0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map(t => t.name).join(", "));

const status = await client.callTool({ name: "memory_status", arguments: {} });
console.log("\n== STATUS ==\n" + status.content[0].text.slice(0, 1200));

const s1 = await client.callTool({ name: "memory_search", arguments: { query: "WSL", limit: 5 } });
console.log("\n== SEARCH 'WSL' ==\n" + s1.content[0].text.slice(0, 1200));

const w = await client.callTool({ name: "memory_write", arguments: { title: "记忆系统联调测试", content: "这是四端记忆打通的联调测试记忆，无敏感信息。", scope: "shared" } });
console.log("\n== WRITE ==\n" + w.content[0].text);
const wid = JSON.parse(w.content[0].text).id;

const s2 = await client.callTool({ name: "memory_search", arguments: { query: "联调测试", kind: "memory", limit: 5 } });
console.log("\n== SEARCH '联调测试' ==\n" + s2.content[0].text.slice(0, 800));

const r = await client.callTool({ name: "memory_read", arguments: { id: wid } });
console.log("\n== READ back ==\n" + r.content[0].text.slice(0, 600));

await client.close();
process.exit(0);
