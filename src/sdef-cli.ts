/**
 * CLI for interrogating macOS applications via their .sdef scripting dictionaries.
 *
 * Usage:
 *   npx tsx src/sdef-cli.ts --sdef /path/to/App.sdef --out <directory>
 *   npx tsx src/sdef-cli.ts --app Mail --out <directory>
 *
 * When --app is used, the .sdef is located automatically from /Applications/<App>.app.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { access } from "node:fs/promises";
import path from "node:path";

import { parseSdefFile, sdefToOperations } from "./sdef-parser.js";
import { parseArgs, writeJsonFile } from "./shared.js";
import type { DiscoveryBundle } from "./types.js";

/**
 * Resolve the .sdef file path from an application name.
 */
function resolveSdefPath(appName: string): string {
  // Common locations for .sdef files
  const candidates = [
    `/Applications/${appName}.app/Contents/Resources/${appName}.sdef`,
    `/System/Applications/${appName}.app/Contents/Resources/${appName}.sdef`,
    `/Applications/${appName}.app/Contents/Resources/Scripting Definitions/${appName}.sdef`,
  ];

  // For multi-word app names, also try without spaces
  const normalized = appName.replace(/\s+/g, "");
  if (normalized !== appName) {
    candidates.push(
      `/Applications/${normalized}.app/Contents/Resources/${normalized}.sdef`,
      `/System/Applications/${normalized}.app/Contents/Resources/${normalized}.sdef`,
    );
  }

  return candidates[0]; // Return primary candidate; actual existence checked later
}

async function findSdefPath(appName: string): Promise<string> {
  const candidates = [
    `/Applications/${appName}.app/Contents/Resources/${appName}.sdef`,
    `/System/Applications/${appName}.app/Contents/Resources/${appName}.sdef`,
    `/Applications/${appName}.app/Contents/Resources/Scripting Definitions/${appName}.sdef`,
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Could not find .sdef for application '${appName}'. Tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n\nUse --sdef to specify the path directly.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out;
  const sdefPath = args.sdef;
  const appName = args.app;

  if (!outDir) {
    throw new Error(
      "Usage: mcpaql-sdef-interrogate --sdef <path.sdef> --out <directory>\n" +
      "       mcpaql-sdef-interrogate --app <AppName> --out <directory>",
    );
  }

  if (!sdefPath && !appName) {
    throw new Error("Either --sdef <path> or --app <name> is required.");
  }

  const resolvedPath = sdefPath ?? (await findSdefPath(appName!));
  const sdef = await parseSdefFile(resolvedPath);
  const { operations, warnings } = sdefToOperations(sdef);

  const bundle: DiscoveryBundle = {
    schema_version: "1.0.0-draft",
    source: {
      name: sdef.application || appName || path.basename(resolvedPath, ".sdef"),
      server_url: `native-applescript://${sdef.application || appName}`,
      transport: "streamable_http" as any, // Override for native transport in bundle metadata
      captured_at: new Date().toISOString(),
      server: {
        name: sdef.application || appName,
        version: "native",
      },
      auth: {
        type: "none",
      },
      capture_config_redacted: {
        sdef_path: resolvedPath,
        transport: "native-applescript",
      },
    },
    raw_capture: {
      tools: [], // No MCP tools for native apps
      sdef_suites: sdef.suites.map((s) => ({
        name: s.name,
        command_count: s.commands.length,
        class_count: s.classes.length,
        enumeration_count: s.enumerations.length,
      })),
    },
    normalized_bundle: {
      operations,
      warnings,
    },
  };

  // Persist bundle
  await writeJsonFile(path.join(outDir, "discovery-bundle.json"), bundle);
  await writeJsonFile(path.join(outDir, "warnings.json"), warnings);
  await writeJsonFile(path.join(outDir, "sdef-parsed.json"), sdef);
  await writeJsonFile(path.join(outDir, "capture-metadata.json"), {
    schema_version: bundle.schema_version,
    source: bundle.source,
    operation_count: operations.length,
    warning_count: warnings.length,
    sdef_path: resolvedPath,
    suites: sdef.suites.map((s) => s.name),
  });

  console.log(
    JSON.stringify(
      {
        out_dir: outDir,
        sdef_path: resolvedPath,
        application: sdef.application,
        suite_count: sdef.suites.length,
        operation_count: operations.length,
        warning_count: warnings.length,
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
