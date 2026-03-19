import { parseArgs } from "./shared.js";
import { runDifferentialValidation } from "./differential.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bundlePath = args.bundle;
  const command = args.command;

  if (!bundlePath || !command) {
    throw new Error(
      "Usage: mcpaql-diff --bundle <discovery-bundle.json> --command <command> [--schema <adapter-schema.json>] [--args '<json-array>'] [--cwd <dir>]",
    );
  }

  const report = await runDifferentialValidation({
    bundlePath,
    expectedSchemaPath: args.schema,
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
