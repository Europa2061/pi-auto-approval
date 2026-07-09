import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function truncateInline(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function resolvePathForCwd(pathValue: string, cwd: string): string {
  return normalize(isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue));
}

export function isPathWithin(pathValue: string, root: string): boolean {
  const resolvedPath = resolveExistingPathForBoundary(pathValue, root);
  const resolvedRoot = resolveExistingPathForBoundary(root, root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function resolveExistingPathForBoundary(pathValue: string, cwd: string): string {
  const resolvedPath = resolvePathForCwd(pathValue, cwd);
  if (existsSync(resolvedPath)) {
    return normalize(realpathSync(resolvedPath));
  }

  let current = resolvedPath;
  const tail: string[] = [];
  while (true) {
    if (existsSync(current)) {
      return normalize(resolve(realpathSync(current), ...tail.reverse()));
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolvedPath;
    }
    tail.push(current.slice(parent.length).replace(/^[/\\]/, ""));
    current = parent;
  }
}
