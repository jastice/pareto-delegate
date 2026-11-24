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
  frontierLocal: resolve(SKILL_DIR, "frontier.local.json"),
  benchmarksLocal: resolve(SKILL_DIR, "benchmarks.local.json"),
  epochLocal: resolve(SKILL_DIR, "epoch.local.json"),
  aaKeyLocal: resolve(SKILL_DIR, "aa-api-key.local"),
  roles: resolve(SKILL_DIR, "roles.json"),
  rolesLocal: resolve(SKILL_DIR, "roles.local.json"),
  overrides: resolve(SKILL_DIR, "overrides.json"),
  overridesLocal: resolve(SKILL_DIR, "overrides.local.json"),
  quota: resolve(SKILL_DIR, "quota.json"),
  quotaLocal: resolve(SKILL_DIR, "quota.local.json"),
  outcomes: resolve(SKILL_DIR, "outcomes.jsonl"),
  routesTable: resolve(SKILL_DIR, "routes.md"),
  routesTableLocal: resolve(SKILL_DIR, "routes.local.md"),
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

/** AA API key: env first, then the gitignored aa-api-key.local file. */
export function aaApiKey(): string | undefined {
  const env = (process.env["ARTIFICIAL_ANALYSIS_API_KEY"] ?? process.env["AA_API_KEY"])?.trim();
  if (env) return env;
  if (!existsSync(PATHS.aaKeyLocal)) return undefined;
  const key = readFileSync(PATHS.aaKeyLocal, "utf8").trim();
  return key.length > 0 ? key : undefined;
}

/** frontier.local.json (built from local API/Epoch data) wins over the tracked mirror frontier. */
export function loadFrontier(
  path: string = existsSync(PATHS.frontierLocal) ? PATHS.frontierLocal : PATHS.frontier,
): FrontierFile {
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

/** Count logged outcomes per "provider:model|role" from outcomes.jsonl (for exploration novelty). */
export function loadObservationCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(PATHS.outcomes)) return counts;
  for (const line of readFileSync(PATHS.outcomes, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec: unknown = JSON.parse(line);
      if (!isRecord(rec)) continue;
      const id = rec["entry_id"];
      const role = rec["role"];
      if (typeof id !== "string" || typeof role !== "string") continue;
      const key = `${id.split(":").slice(0, 2).join(":")}|${role}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // ignore malformed lines
    }
  }
  return counts;
}
