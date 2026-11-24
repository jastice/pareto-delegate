import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRecord,
  type FrontierFile,
  type OverridesFile,
  type QuotaFile,
  type RolesFile,
} from "./types.ts";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  benchmarks: resolve(SKILL_DIR, "benchmarks.json"),
  frontier: resolve(SKILL_DIR, "frontier.json"),
  roles: resolve(SKILL_DIR, "roles.json"),
  rolesLocal: resolve(SKILL_DIR, "roles.local.json"),
  overrides: resolve(SKILL_DIR, "overrides.json"),
  overridesLocal: resolve(SKILL_DIR, "overrides.local.json"),
  quota: resolve(SKILL_DIR, "quota.json"),
  quotaLocal: resolve(SKILL_DIR, "quota.local.json"),
  outcomes: resolve(SKILL_DIR, "outcomes.jsonl"),
  routesTable: resolve(SKILL_DIR, "routes.md"),
} as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readOptionalJson(path: string): unknown {
  return existsSync(path) ? readJson(path) : undefined;
}

/** Recursive merge: objects merge key-wise, everything else (arrays, scalars) replaces. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function loadFrontier(path: string = PATHS.frontier): FrontierFile {
  const raw = readJson(path);
  if (!isRecord(raw) || raw["schema_version"] !== 2) {
    throw new Error(
      `${path} is not a schema_version 2 frontier. Run: bun run scripts/sync-benchmarks.ts --offline`,
    );
  }
  return raw as unknown as FrontierFile;
}

export function loadRoles(): RolesFile {
  return deepMerge(readJson(PATHS.roles) as RolesFile, readOptionalJson(PATHS.rolesLocal));
}

/** Tracked + local overrides; local keys deep-merge over tracked keys. */
export function loadOverrides(): OverridesFile {
  const base = (readOptionalJson(PATHS.overrides) ?? { schema_version: 2 }) as OverridesFile;
  return deepMerge(base, readOptionalJson(PATHS.overridesLocal));
}

/** quota.local.json wins wholesale when present. */
export function loadQuota(): QuotaFile {
  const local = readOptionalJson(PATHS.quotaLocal);
  if (local !== undefined) return local as QuotaFile;
  const base = readOptionalJson(PATHS.quota);
  return (base ?? { schema_version: 1, updated_at: "", providers: {} }) as QuotaFile;
}
