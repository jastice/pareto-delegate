import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveState, nextResetUtc } from "./cron-window.ts";

test("basic nextResetUtc advances to upcoming Monday 00:00Z", () => {
  const sat = new Date("2026-11-21T12:00:00Z"); // Saturday
  const next = nextResetUtc(sat, { resetWeekdayUtc: 1, resetHourUtc: 0 });
  assert.equal(next.toISOString(), "2026-11-23T00:00:00.000Z");
});

test("basic effectiveState keeps throttled when resetsAt is in future", () => {
  const state = effectiveState(
    { state: "throttled", resetsAt: "2026-11-25T00:00:00Z" },
    new Date("2026-11-24T12:00:00Z"),
  );
  assert.equal(state, "throttled");
});
