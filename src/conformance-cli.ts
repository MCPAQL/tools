import { parseArgs } from "./shared.js";
import { runConformanceValidation } from "./conformance.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  const schemaRoot = args["schema-root"];

  if (!command || !schemaRoot) {
    throw new Error("Usage: mcpaql-conformance --command <command> --schema-root <spec/schemas> [--args '<json-array>'] [--cwd <dir>]");
  }

  const report = await runConformanceValidation({
    schemaRoot,
    server: {
      command,
      args: args.args ? (JSON.parse(args.args) as string[]) : undefined,
      cwd: args.cwd,
    },
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
