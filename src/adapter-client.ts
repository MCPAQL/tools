import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connectStdioAdapter(server: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}): Promise<{ client: Client; transport: StdioClientTransport }> {
  const client = new Client({ name: "mcpaql-tools", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: {
      ...process.env,
      ...server.env,
    } as Record<string, string>,
    stderr: "pipe",
  });

  await client.connect(transport);
  return { client, transport };
}
