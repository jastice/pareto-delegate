# pareto-delegate

A relocatable T3 Code skill and calibration framework for routing delegated agent tasks across heterogeneous providers, models, and reasoning effort levels.

## How It Works

- **Zero network calls at delegation time:** Reads local [frontier.json](./frontier.json) and `quota.local.json` (falling back to [quota.json](./quota.json)) and intersects them with live `orchestrator_capabilities`.
- **Full AA cache + dynamic auto-matching:** Downloads the full Artificial Analysis v5 snapshot into [benchmarks.json](./benchmarks.json) (zero-key daily mirror by default, or official AA API v2 with `ARTIFICIAL_ANALYSIS_API_KEY`). When a new model appears in `orchestrator_capabilities`, [scripts/sync-benchmarks.ts](./scripts/sync-benchmarks.ts) auto-matches it against the full catalog (offline-first; fetches only if missing from cache or `--refresh` is passed) and recalculates `R0`–`R3`.
- **Works in both API and subscription modes:** Default [quota.json](./quota.json) sets all providers to `"normal"` (pure API-cost Pareto routing). Copying it to gitignored `quota.local.json` lets you mark expiring plans `"surplus"` or tight plans `"scarce"`.
- **Account-local overrides without evals:** Universal safety floors live in [overrides.json](./overrides.json); machine/plan-specific exclusions (e.g., models requiring extra usage credits) live in optional gitignored `overrides.local.json` and are merged automatically on sync.

## Usage (Works From Any Directory)

Zero runtime dependencies — runs directly with `bun` or Node 22.6+/26+ from any working directory:

```bash
# Refresh full benchmarks.json and recompute frontier.json
bun run <skill-dir>/scripts/sync-benchmarks.ts

# Auto-match newly enabled models (offline-first against cached benchmarks.json; fetches if missing)
bun run <skill-dir>/scripts/sync-benchmarks.ts --models codex:gpt-6.2-astra,cursor:grok-4.7

# Or pipe raw T3 orchestrator_capabilities JSON directly
bun run <skill-dir>/scripts/sync-benchmarks.ts --capabilities capabilities.json

# Offline recompute (e.g. after editing overrides.json or overrides.local.json)
bun run <skill-dir>/scripts/sync-benchmarks.ts --offline

# Check whether live model IDs are uncalibrated (no network; exits 2 if stale)
bun run <skill-dir>/scripts/sync-benchmarks.ts --check-models claude-opus-5-5,gemini-4-neon,grok-4.7
```

## Local Config on a New Machine (No Evals Required)

1. **Pure API / balanced usage:** No config needed — [quota.json](./quota.json) defaults to all `"normal"`.
2. **Subscription headroom:** Create `quota.local.json` (gitignored) from [quota.json](./quota.json) and flip providers between `"surplus"` / `"normal"` / `"scarce"` / `"throttled"`.
3. **Plan-specific model exclusions:** Optionally create `overrides.local.json` (gitignored), e.g.:
   ```json
   {
     "schema_version": 1,
     "model_overrides": {
       "claudeAgent:claude-fable-5-2": { "exclude": true }
     }
   }
   ```
   Then run `bun run <skill-dir>/scripts/sync-benchmarks.ts --offline`.

## Installation

- **Antigravity inside T3 Code (T3-only):**
  ```bash
  mkdir -p ~/.t3/userdata/providers/antigravity/<profile-hash>/config/skills
  ln -s /path/to/pareto-delegate ~/.t3/userdata/providers/antigravity/<profile-hash>/config/skills/pareto-delegate
  ```
- **Claude / Cursor / Codex:** Symlink into `~/.claude/skills/pareto-delegate`, `~/.cursor/skills/pareto-delegate`, and/or `~/.codex/skills/pareto-delegate`. [SKILL.md](./SKILL.md) includes a frontmatter guard so standalone CLI/IDE sessions ignore it unless T3's `orchestrator_capabilities` and `delegate_task` MCP tools are available.

## Development & Evals

```bash
bun install
bun run typecheck       # strict tsc --noEmit
bun run test            # unit tests (scripts/route.test.ts)
bun run eval:sim        # 1,000-task AA v5 workload-replay simulation
bun run eval:setup      # prepare isolated live canary workdirs
bun run eval:grade      # grade live canary arms (mutation + hidden tests + security recall)
```

See [DESIGN.md](./DESIGN.md) for architecture details and [SKILL.md](./SKILL.md) for the runtime routing policy.
