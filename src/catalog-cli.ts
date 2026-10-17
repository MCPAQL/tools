import { readFile } from "node:fs/promises";

import { importToolCatalog } from "./catalog-import.js";
import { loadConfig, persistBundle } from "./interrogate.js";
import { parseArgs } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config;
  const catalogPath = args.catalog;
  const outDir = args.out;

  if (!configPath || !catalogPath || !outDir) {
    throw new Error(
      "Usage: mcpaql-import-catalog --config <server-config.json> --catalog <tools.json> --out <directory> [--server-name <name>] [--server-version <version>]",
    );
  }

  const config = await loadConfig(configPath);
  const bundle = importToolCatalog({
    config,
    catalogText: await readFile(catalogPath, "utf8"),
    catalogPath,
    server: args["server-name"] || args["server-version"]
      ? { name: args["server-name"], version: args["server-version"] }
      : undefined,
  });
  await persistBundle(bundle, outDir);

  console.log(
    JSON.stringify(
      {
        out_dir: outDir,
        tool_count: bundle.normalized_bundle.operations.length,
        warning_count: bundle.normalized_bundle.warnings.length,
        footprint: bundle.raw_capture.footprint,
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
