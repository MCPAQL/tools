// Test fixtures for the parity runner's stdio upstream support. One file serves both arms:
// `upstream` behaves like a small stateful stdio MCP server; `adapter` wraps the same
// behavior in MCP-AQL endpoints and envelopes, as a generated adapter would.
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// The harness launches the adapter as `node <file>` with no arguments.
const role = process.argv[2] ?? "adapter";
const sessions = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(name, args, progress) {
  switch (name) {
    case "open_session": {
      const session_id = randomUUID();
      sessions.add(session_id);
      return { session_id };
    }
    case "close_session":
      return { closed: sessions.delete(args.session_id) };
    case "describe_session":
      if (!sessions.has(args.session_id)) throw new Error(`unknown session ${args.session_id}`);
      return { session_id: args.session_id, label: "fixture", flag: process.env.PARITY_FIXTURE_FLAG ?? null };
    case "slow":
      // Runs for args.ms milliseconds, reporting progress every 100ms when args.progress is set.
      for (let elapsed = 100; elapsed <= args.ms; elapsed += 100) {
        await sleep(100);
        if (args.progress) await progress(elapsed);
      }
      return { done: true };
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const server = new Server({ name: `parity-fixture-${role}`, version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (role === "adapter" ? ["mcp_aql_read", "mcp_aql_create"] : ["open_session", "close_session", "describe_session", "slow"])
    .map((name) => ({ name, inputSchema: { type: "object" } })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const progressToken = request.params._meta?.progressToken;
  const progress = async (value) => {
    if (progressToken !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: value } });
    }
  };
  const args = request.params.arguments ?? {};
  const [name, params] = role === "adapter" ? [args.operation, args.params ?? {}] : [request.params.name, args];
  let value;
  let failure;
  try {
    value = await run(name, params, progress);
  } catch (error) {
    failure = error.message;
  }
  if (role === "adapter") {
    const envelope = failure === undefined
      ? { success: true, data: { content: [{ type: "text", text: JSON.stringify(value) }], structured_content: value } }
      : { success: true, data: { is_error: true, content: [{ type: "text", text: failure }] } };
    return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
  }
  return failure === undefined
    ? { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }
    : { isError: true, content: [{ type: "text", text: failure }] };
});

await server.connect(new StdioServerTransport());
