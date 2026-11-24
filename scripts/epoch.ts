/**
 * Epoch AI Benchmarking Hub ingestion (https://epoch.ai/benchmarks, CC-BY; external benchmarks keep
 * their original licences, so the cache stays local: epoch.local.json).
 *
 * Zero dependencies: a minimal ZIP central-directory reader (stored + deflate) and an RFC 4180 CSV
 * parser. Only the benchmarks named in EPOCH_BENCHMARKS (+ roles.json epoch_benchmarks) are kept.
 */
import { inflateRawSync } from "node:zlib";
import {
  isEffortLevel,
  type EffortLevel,
  type EpochBenchmarkSpec,
  type EpochFile,
  type EpochRow,
} from "./types.ts";

export const EPOCH_ZIP_URL = "https://epoch.ai/data/benchmark_data.zip";
export const EPOCH_ATTRIBUTION =
  "Epoch AI, 'Capabilities & benchmarking', https://epoch.ai/benchmarks (CC-BY 4.0; external benchmarks retain their original licences).";

export const EPOCH_BENCHMARKS: Readonly<Record<string, EpochBenchmarkSpec>> = {
  cursorbench: {
    file: "cursorbench_external.csv",
    score_column: "Score",
    cost_column: "Cost per task",
    tokens_column: "Tokens per task",
    steps_column: "Steps per task",
  },
  apex_agents: { file: "apex_agents_external.csv", score_column: "Pass@1 score" },
  terminalbench: { file: "terminalbench_external.csv", score_column: "Accuracy mean" },
  scicode: { file: "scicode_external.csv", score_column: "Score" },
  frontiercode: { file: "frontiercode_external.csv", score_column: "Main score" },
  gpqa: { file: "gpqa_diamond.csv", score_column: "Best score (across scorers)" },
  eci: {
    file: "epoch_capabilities_index/eci_scores.csv",
    score_column: "eci",
    model_column: "Model",
    display_names: true,
  },
};

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

export function readZip(buf: Buffer): Map<string, Buffer> {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP file (no end-of-central-directory record).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((v) => v.trim().length > 0))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.replace(/^﻿/, ""), r[i] ?? ""])));
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[._\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const EFFORT_ALIASES: Readonly<Record<string, EffortLevel>> = {
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  max: "max",
};

/** "claude-opus-5-5_high" -> {base: "claude-opus-5-5", effort: "high"}; "_unknown"/none -> null. */
export function parseModelVersion(id: string): { base: string; effort: EffortLevel | null } {
  const idx = id.lastIndexOf("_");
  if (idx < 0) return { base: slugify(id), effort: null };
  const suffix = id.slice(idx + 1).toLowerCase();
  const effort = EFFORT_ALIASES[suffix] ?? (isEffortLevel(suffix) ? suffix : null);
  return { base: slugify(id.slice(0, idx)), effort };
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function extractRows(csvText: string, spec: EpochBenchmarkSpec): EpochRow[] {
  // Keep the best score per (base, effort); measurements travel with the chosen row.
  const best = new Map<string, EpochRow>();
  for (const r of parseCsv(csvText)) {
    const id = r[spec.model_column ?? "Model version"] ?? "";
    const score = num(r[spec.score_column]);
    if (!id || score === undefined) continue;
    const { base, effort } = spec.display_names ? { base: slugify(id), effort: null } : parseModelVersion(id);
    if (!base) continue;
    const cost = spec.cost_column ? num(r[spec.cost_column]) : undefined;
    const tokens = spec.tokens_column ? num(r[spec.tokens_column]) : undefined;
    const steps = spec.steps_column ? num(r[spec.steps_column]) : undefined;
    const row: EpochRow = {
      base,
      effort,
      score,
      ...(cost !== undefined ? { cost } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(steps !== undefined ? { steps } : {}),
    };
    const key = `${base}|${effort ?? ""}`;
    const prev = best.get(key);
    if (!prev || row.score > prev.score) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => a.base.localeCompare(b.base) || (a.effort ?? "").localeCompare(b.effort ?? ""));
}

export function parseEpochZip(
  zip: Buffer,
  specs: Readonly<Record<string, EpochBenchmarkSpec>>,
): EpochFile {
  const files = readZip(zip);
  const benchmarks: Record<string, EpochRow[]> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const entry = files.get(spec.file);
    if (!entry) {
      console.warn(`Epoch: ${spec.file} not found in archive; skipping '${name}'.`);
      continue;
    }
    benchmarks[name] = extractRows(entry.toString("utf8"), spec);
  }
  return {
    fetched_at: new Date().toISOString(),
    source_url: EPOCH_ZIP_URL,
    attribution: EPOCH_ATTRIBUTION,
    benchmarks,
  };
}

export async function fetchEpoch(
  specs: Readonly<Record<string, EpochBenchmarkSpec>>,
): Promise<EpochFile> {
  const resp = await fetch(EPOCH_ZIP_URL);
  if (!resp.ok) throw new Error(`Epoch download failed with HTTP ${resp.status}.`);
  return parseEpochZip(Buffer.from(await resp.arrayBuffer()), specs);
}
