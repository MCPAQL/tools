import { parseArgs } from "./shared.js";
import { interrogateServer, loadConfig, persistBundle } from "./interrogate.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config;
  const outDir = args.out;

  if (!configPath || !outDir) {
    throw new Error("Usage: mcpaql-interrogate --config <server-config.json> --out <directory>");
  }

  const config = await loadConfig(configPath);
  const bundle = await interrogateServer(config);
  await persistBundle(bundle, outDir);

  console.log(
    JSON.stringify(
      {
        out_dir: outDir,
        tool_count: bundle.normalized_bundle.operations.length,
        warning_count: bundle.normalized_bundle.warnings.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
