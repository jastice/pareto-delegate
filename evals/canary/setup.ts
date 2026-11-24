import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANARY_DIR = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = resolve(CANARY_DIR, "tasks");
const WORK_DIR = resolve(CANARY_DIR, "work");

export const ARMS = ["pareto", "flagship", "naive-surplus"] as const;
export const TASK_IDS = [
  "t1-r0-scout",
  "t2-r1-strict-tests",
  "t3-r1-subtle-bugfix",
  "t4-r2-async-state",
  "t5-r2-cross-review",
] as const;

async function main(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true });
  for (const arm of ARMS) {
    for (const taskId of TASK_IDS) {
      const dest = resolve(WORK_DIR, arm, taskId);
      await mkdir(dest, { recursive: true });
      if (taskId !== "t1-r0-scout") {
        await cp(resolve(TASKS_DIR, taskId), dest, { recursive: true });
      }
    }
  }
  console.log(
    `Prepared ${ARMS.length * TASK_IDS.length} isolated canary workdirs under ${WORK_DIR}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
