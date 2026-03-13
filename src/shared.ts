import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function normalizeSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function deepRedact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepRedact(entry)) as T;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/(token|authorization|secret|password)/i.test(key)) {
        output[key] = "<redacted>";
        continue;
      }

      output[key] = deepRedact(entry);
    }

    return output as T;
  }

  if (typeof value === "string" && /^gh[opus]_/i.test(value)) {
    return "<redacted>" as T;
  }

  return value;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseArgs(argv: string[]): Record<string, string> {
  const output: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      output[key] = "true";
      continue;
    }

    output[key] = value;
    index += 1;
  }

  return output;
}
