import { readFile } from "node:fs/promises";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    void handle(line);
  }
});

const observation = {
  caption: "Synthetic MCP observation",
  objects: [],
  activities: [],
  tags: [],
  ocr: [],
  category: "photo",
  evidence: [{ id: "mcp", kind: "visual", text: "Synthetic MCP fixture" }],
  date: null,
  location: null,
  event: null,
};

async function handle(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "synthetic-zai-mcp", version: "0.1.5" },
    } })}\n`);
    return;
  }
  if (request.method === "tools/call") {
    const source = request.params?.arguments?.image_source || request.params?.arguments?.video_source;
    if (process.env.MCP_TEST_MODE === "timeout") {
      await new Promise(() => {});
      return;
    }
    if (process.env.MCP_TEST_MODE === "failure") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "synthetic MCP failure" }] } })}\n`);
      return;
    }
    try {
      const bytes = await readFile(source);
      if (!bytes.length) throw Error("empty fixture");
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: JSON.stringify(observation) }) }] } })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } })}\n`);
    }
  }
}
