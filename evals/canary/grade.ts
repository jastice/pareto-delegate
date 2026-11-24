import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EFFORT_LEVELS,
  QUOTA_STATES,
  RUNGS,
  TASK_CATEGORIES,
  VERIFIABILITY_LEVELS,
} from "../../scripts/types.ts";

const CANARY_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(CANARY_DIR, "../..");
const WORK_DIR = resolve(CANARY_DIR, "work");

export interface TaskGrade {
  readonly arm: string;
  readonly taskId: string;
  readonly passed: boolean;
  readonly score: number;
  readonly maxScore: number;
  readonly detail: string;
}

async function gradeT1(arm: string, dir: string): Promise<TaskGrade> {
  try {
    const raw = await readFile(resolve(dir, "output.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const typesSrc = await readFile(resolve(ROOT_DIR, "scripts/types.ts"), "utf8");
    const expectedInterfaces = [...typesSrc.matchAll(/^export interface (\w+)/gm)]
      .map((m) => m[1] ?? "")
      .filter(Boolean)
      .sort();

    const expectedArrays: Record<string, readonly string[]> = {
      RUNGS,
      QUOTA_STATES,
      VERIFIABILITY_LEVELS,
      TASK_CATEGORIES,
      EFFORT_LEVELS,
    };

    let score = 0;
    const issues: string[] = [];

    const constsObj = (parsed["consts"] ?? parsed) as Record<string, unknown>;
    for (const [k, expected] of Object.entries(expectedArrays)) {
      const actual = constsObj[k];
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        score += 1;
      } else {
        issues.push(`mismatch:${k}`);
      }
    }

    const actualIfaces = parsed["interfaces"];
    if (JSON.stringify(actualIfaces) === JSON.stringify(expectedInterfaces)) {
      score += 1;
    } else {
      issues.push("mismatch:interfaces");
    }

    return {
      arm,
      taskId: "t1-r0-scout",
      passed: score === 6,
      score,
      maxScore: 6,
      detail: issues.length === 0 ? "6/6 exact match" : issues.join(", "),
    };
  } catch (err) {
    return {
      arm,
      taskId: "t1-r0-scout",
      passed: false,
      score: 0,
      maxScore: 6,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function gradeT2(arm: string, dir: string): Promise<TaskGrade> {
  const testPath = resolve(dir, "rate-limiter.test.ts");
  const baseImplPath = resolve(CANARY_DIR, "tasks/t2-r1-strict-tests/rate-limiter.ts");

  let testCode: string;
  try {
    testCode = await readFile(testPath, "utf8");
  } catch {
    return {
      arm,
      taskId: "t2-r1-strict-tests",
      passed: false,
      score: 0,
      maxScore: 5,
      detail: "missing rate-limiter.test.ts",
    };
  }

  const baseImpl = await readFile(baseImplPath, "utf8");
  const runSuite = async (implSource: string): Promise<boolean> => {
    const tmp = await mkdtemp(resolve(tmpdir(), "pd-t2-"));
    try {
      await writeFile(resolve(tmp, "rate-limiter.ts"), implSource, "utf8");
      await writeFile(resolve(tmp, "rate-limiter.test.ts"), testCode, "utf8");
      const res = spawnSync("node", ["--test", "rate-limiter.test.ts"], {
        cwd: tmp,
        timeout: 10000,
        encoding: "utf8",
      });
      return res.status === 0;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };

  const baselinePasses = await runSuite(baseImpl);
  if (!baselinePasses) {
    return {
      arm,
      taskId: "t2-r1-strict-tests",
      passed: false,
      score: 0,
      maxScore: 5,
      detail: "generated tests fail against valid reference impl",
    };
  }

  const mutants: ReadonlyArray<readonly [string, string]> = [
    [
      "no-burst-cap",
      baseImpl.replace(
        "Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond)",
        "this.tokens + elapsedSec * this.refillPerSecond",
      ),
    ],
    [
      "allow-nonpositive-cost",
      baseImpl.replace(
        "if (!Number.isFinite(cost) || cost <= 0)",
        "if (!Number.isFinite(cost))",
      ),
    ],
    [
      "wrong-retry-rounding",
      baseImpl.replace(
        "Math.ceil((deficit / this.refillPerSecond) * 1000)",
        "Math.floor((deficit / this.refillPerSecond) * 1000) - 10",
      ),
    ],
    [
      "reset-misses-timestamp",
      baseImpl.replace("this.lastRefillMs = this.nowMs();", "/* stale ts */"),
    ],
  ];

  let killed = 0;
  const survived: string[] = [];
  for (const [label, mutated] of mutants) {
    const mutantPassed = await runSuite(mutated);
    if (!mutantPassed) {
      killed += 1;
    } else {
      survived.push(label);
    }
  }

  const score = 1 + killed;
  return {
    arm,
    taskId: "t2-r1-strict-tests",
    passed: killed >= 3,
    score,
    maxScore: 5,
    detail: `baseline=pass, killed ${killed}/4 mutants${survived.length ? ` (survived: ${survived.join(",")})` : ""}`,
  };
}

async function gradeT3(arm: string, dir: string): Promise<TaskGrade> {
  const hiddenTest = `
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveState, nextResetUtc } from "./cron-window.ts";

test("exact boundary equality must advance a full week", () => {
  const exact = new Date("2026-11-23T00:00:00.000Z"); // Monday 00:00:00Z
  const next = nextResetUtc(exact, { resetWeekdayUtc: 1, resetHourUtc: 0 });
  assert.equal(next.toISOString(), "2026-11-30T00:00:00.000Z");
});

test("same weekday 1ms after reset advances 7 days", () => {
  const after = new Date("2026-11-23T00:00:00.001Z");
  const next = nextResetUtc(after, { resetWeekdayUtc: 1, resetHourUtc: 0 });
  assert.equal(next.toISOString(), "2026-11-30T00:00:00.000Z");
});

test("same weekday before reset stays same day", () => {
  const before = new Date("2026-11-23T08:59:59.999Z");
  const next = nextResetUtc(before, { resetWeekdayUtc: 1, resetHourUtc: 9 });
  assert.equal(next.toISOString(), "2026-11-23T09:00:00.000Z");
});

test("month and year rollover across Dec 31 -> Jan", () => {
  const dec31 = new Date("2026-12-31T23:30:00Z"); // Thursday
  const next = nextResetUtc(dec31, { resetWeekdayUtc: 5, resetHourUtc: 0 }); // Friday Jan 1
  assert.equal(next.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("leap day rollover Feb 28 -> Feb 29 (2028)", () => {
  const feb28 = new Date("2028-02-28T15:00:00Z"); // Monday
  const next = nextResetUtc(feb28, { resetWeekdayUtc: 2, resetHourUtc: 6 }); // Tuesday Feb 29
  assert.equal(next.toISOString(), "2028-02-29T06:00:00.000Z");
});

test("effectiveState handles positive timezone offset properly", () => {
  // 2026-11-24T13:30:00+02:00 === 2026-11-24T11:30:00Z (BEFORE 12:00Z!)
  const st = effectiveState(
    { state: "throttled", resetsAt: "2026-11-24T13:30:00+02:00" },
    new Date("2026-11-24T12:00:00Z"),
  );
  assert.equal(st, "normal");
});

test("effectiveState handles negative timezone offset properly", () => {
  // 2026-11-24T08:30:00-05:00 === 2026-11-24T13:30:00Z (AFTER 12:00Z!)
  const st = effectiveState(
    { state: "throttled", resetsAt: "2026-11-24T08:30:00-05:00" },
    new Date("2026-11-24T12:00:00Z"),
  );
  assert.equal(st, "throttled");
});

test("effectiveState recovers at exact resetsAt === now", () => {
  const st = effectiveState(
    { state: "throttled", resetsAt: "2026-11-24T12:00:00.000Z" },
    new Date("2026-11-24T12:00:00.000Z"),
  );
  assert.equal(st, "normal");
});

test("effectiveState does not crash or wrongly recover on malformed resetsAt", () => {
  const st = effectiveState(
    { state: "throttled", resetsAt: "not-a-real-date" },
    new Date("2026-11-24T12:00:00Z"),
  );
  assert.equal(st, "throttled");
});

test("non-throttled states remain unchanged even if resetsAt is past", () => {
  const st = effectiveState(
    { state: "scarce", resetsAt: "2020-01-01T00:00:00Z" },
    new Date("2026-11-24T12:00:00Z"),
  );
  assert.equal(st, "scarce");
});
`;
  const tmpPath = resolve(dir, "__hidden_grade.test.ts");
  await writeFile(tmpPath, hiddenTest, "utf8");
  try {
    const res = spawnSync("node", ["--test", "--test-reporter=tap", tmpPath], {
      cwd: dir,
      timeout: 10000,
      encoding: "utf8",
    });
    const okCount = (res.stdout.match(/^ok \d+/gm) ?? []).length;
    const total = 10;
    return {
      arm,
      taskId: "t3-r1-subtle-bugfix",
      passed: res.status === 0 && okCount === total,
      score: okCount,
      maxScore: total,
      detail: `${okCount}/${total} hidden edge cases passed`,
    };
  } finally {
    await rm(tmpPath, { force: true });
  }
}

async function gradeT4(arm: string, dir: string): Promise<TaskGrade> {
  const hiddenTest = `
import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncCoordinator } from "./coordinator.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("1. single waiter abort isolates error; other waiter succeeds", async () => {
  let calls = 0;
  let upstreamAborted = false;
  const c = new AsyncCoordinator<string>(async (k, sig) => {
    calls += 1;
    sig.addEventListener("abort", () => { upstreamAborted = true; });
    await delay(40);
    return "v:" + k;
  });
  const a1 = new AbortController();
  const a2 = new AbortController();
  const p1 = c.load("k", a1.signal);
  const p2 = c.load("k", a2.signal);
  a1.abort();
  await assert.rejects(p1, /Abort/i);
  assert.equal(await p2, "v:k");
  assert.equal(calls, 1);
  assert.equal(upstreamAborted, false);
});

test("2. aborting ALL waiters aborts upstream loader and cleans inflight map", async () => {
  let upstreamAborted = false;
  const c = new AsyncCoordinator<string>(async (_k, sig) => {
    return new Promise((resolve, reject) => {
      sig.addEventListener("abort", () => {
        upstreamAborted = true;
        reject(new Error("upstream cancelled"));
      });
      setTimeout(() => resolve("late"), 100);
    });
  });
  const a1 = new AbortController();
  const a2 = new AbortController();
  const p1 = c.load("k", a1.signal);
  const p2 = c.load("k", a2.signal);
  a1.abort();
  assert.equal(upstreamAborted, false);
  a2.abort();
  await assert.rejects(p1, /Abort/i);
  await assert.rejects(p2, /Abort/i);
  await delay(15);
  assert.equal(upstreamAborted, true);
  assert.equal(c.inFlightCount(), 0);
});

test("3. stale fetch does not overwrite newer set()", async () => {
  const c = new AsyncCoordinator<string>(async () => {
    await delay(45);
    return "stale";
  });
  const slow = c.load("k");
  await delay(10);
  c.set("k", "fresh");
  await slow;
  assert.equal(await c.load("k"), "fresh");
});

test("4. invalidate() mid-flight forces next load() to start a new fetch and ignores stale write", async () => {
  let calls = 0;
  const c = new AsyncCoordinator<string>(async () => {
    calls += 1;
    const n = calls;
    await delay(n === 1 ? 60 : 15);
    return "v" + n;
  });
  const p1 = c.load("k");
  await delay(10);
  c.invalidate("k");
  const p2 = c.load("k");
  assert.equal(await p2, "v2");
  await p1;
  assert.equal(calls, 2);
  assert.equal(await c.load("k"), "v2");
});

test("5. failed upstream load does not poison future loads", async () => {
  let calls = 0;
  const c = new AsyncCoordinator<string>(async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient");
    return "recovered";
  });
  await assert.rejects(c.load("k"), /transient/);
  assert.equal(c.inFlightCount(), 0);
  assert.equal(await c.load("k"), "recovered");
});

test("6. already-aborted signal rejects immediately without calling loader", async () => {
  let calls = 0;
  const c = new AsyncCoordinator<string>(async () => {
    calls += 1;
    return "never";
  });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(c.load("k", ac.signal), /Abort/i);
  assert.equal(calls, 0);
  assert.equal(c.inFlightCount(), 0);
});
`;
  const tmpPath = resolve(dir, "__hidden_grade.test.ts");
  await writeFile(tmpPath, hiddenTest, "utf8");
  try {
    const res = spawnSync("node", ["--test", "--test-reporter=tap", tmpPath], {
      cwd: dir,
      timeout: 15000,
      encoding: "utf8",
    });
    const okCount = (res.stdout.match(/^ok \d+/gm) ?? []).length;
    const total = 6;
    return {
      arm,
      taskId: "t4-r2-async-state",
      passed: res.status === 0 && okCount === total,
      score: okCount,
      maxScore: total,
      detail: `${okCount}/${total} hidden concurrency/race tests passed`,
    };
  } finally {
    await rm(tmpPath, { force: true });
  }
}

async function gradeT5(arm: string, dir: string): Promise<TaskGrade> {
  try {
    const raw = await readFile(resolve(dir, "review.json"), "utf8");
    const parsed = JSON.parse(raw) as { readonly findings?: readonly Record<string, unknown>[] };
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const blob = findings.map((f) => JSON.stringify(f).toLowerCase()).join("\n");

    const bugChecks: ReadonlyArray<readonly [string, RegExp]> = [
      [
        "timing-attack",
        /timingsafeequal|constant[- ]time|timing attack|non-constant/,
      ],
      [
        "unsigned-replay-key",
        /x-request-id.*(unsigned|unauthenticated|spoof|bypass|replay|not signed|outside.*hmac)|replay.*x-request-id|spoof.*request-id/,
      ],
      [
        "future-timestamp-skew",
        /math\.abs|future timestamp|future.*skew|negative.*skew|ts\s*>\s*now|timestamp.*future|far[- ]future/,
      ],
    ];

    const caught: string[] = [];
    const missed: string[] = [];
    for (const [name, re] of bugChecks) {
      if (re.test(blob)) caught.push(name);
      else missed.push(name);
    }

    return {
      arm,
      taskId: "t5-r2-cross-review",
      passed: caught.length >= 2,
      score: caught.length,
      maxScore: 3,
      detail: `caught ${caught.length}/3 (${caught.join(", ") || "none"}${missed.length ? `; missed: ${missed.join(", ")}` : ""})`,
    };
  } catch (err) {
    return {
      arm,
      taskId: "t5-r2-cross-review",
      passed: false,
      score: 0,
      maxScore: 3,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const arms = process.argv.slice(2);
  const targetArms = arms.length > 0 ? arms : ["pareto", "flagship", "naive-surplus"];
  const allGrades: TaskGrade[] = [];

  for (const arm of targetArms) {
    allGrades.push(
      await gradeT1(arm, resolve(WORK_DIR, arm, "t1-r0-scout")),
      await gradeT2(arm, resolve(WORK_DIR, arm, "t2-r1-strict-tests")),
      await gradeT3(arm, resolve(WORK_DIR, arm, "t3-r1-subtle-bugfix")),
      await gradeT4(arm, resolve(WORK_DIR, arm, "t4-r2-async-state")),
      await gradeT5(arm, resolve(WORK_DIR, arm, "t5-r2-cross-review")),
    );
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(allGrades, null, 2));
    return;
  }

  for (const arm of targetArms) {
    const rows = allGrades.filter((g) => g.arm === arm);
    const passed = rows.filter((r) => r.passed).length;
    console.log(`\n=== ARM: ${arm} (${passed}/${rows.length} passed) ===`);
    for (const r of rows) {
      console.log(
        `  [${r.passed ? "PASS" : "FAIL"}] ${r.taskId.padEnd(22)} ${String(r.score).padStart(2)}/${r.maxScore}  ${r.detail}`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
