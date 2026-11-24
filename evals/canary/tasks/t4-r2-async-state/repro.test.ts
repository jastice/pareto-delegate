import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncCoordinator } from "./coordinator.ts";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("aborting one waiter does not cancel other waiters on same key", async () => {
  let calls = 0;
  let upstreamAborted = false;
  const coord = new AsyncCoordinator<string>(async (key, signal) => {
    calls += 1;
    signal.addEventListener("abort", () => {
      upstreamAborted = true;
    });
    await delay(40);
    if (signal.aborted) throw new Error("upstream aborted");
    return `val:${key}`;
  });

  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const p1 = coord.load("k1", ac1.signal);
  const p2 = coord.load("k1", ac2.signal);

  ac1.abort();
  await assert.rejects(p1, /Abort/i);
  assert.equal(await p2, "val:k1");
  assert.equal(calls, 1);
  assert.equal(upstreamAborted, false);
});

test("stale in-flight load does not overwrite newer set/invalidate", async () => {
  let calls = 0;
  const coord = new AsyncCoordinator<string>(async () => {
    calls += 1;
    const n = calls;
    await delay(n === 1 ? 50 : 10);
    return `fetch-${n}`;
  });

  const slow = coord.load("k2");
  await delay(10);
  coord.set("k2", "fresh-manual");
  await slow;

  assert.equal(await coord.load("k2"), "fresh-manual");
});
