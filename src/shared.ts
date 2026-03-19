import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const READ_ENDPOINT_TOOL_NAME = "mcp_aql_read";
export const SYNTHETIC_INTROSPECT_OPERATION = "introspect";
export const DEFAULT_TIMEOUT_MS = 30_000;

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
      const lowerKey = key.toLowerCase();
      const redactKey =
        /(authorization|secret|password)/i.test(lowerKey) ||
        (lowerKey.includes("token") && !lowerKey.endsWith("_env"));

      if (redactKey) {
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

export function firstTextContent(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return "{}";
  }

  const first = content[0] as { text?: unknown };
  return typeof first.text === "string" ? first.text : "{}";
}

export function parseJsonText<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned malformed JSON: ${detail}`);
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS, label = "operation"): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
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
