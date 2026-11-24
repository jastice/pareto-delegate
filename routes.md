# pareto-delegate routes (generated)

Fallback for when `scripts/route.ts` cannot be run. Prefer the CLI: it applies live models, session throttling, author family and verifiability adjustments. Floors already include no verifiability shift here. Regenerate: `bun run scripts/route.ts --table --write`.

Quota at generation: antigravity=normal, claudeAgent=normal, cursor=normal. Cells: `model:effort` (P(pass), est $).

| role | floor | best overall | antigravity | claudeAgent | cursor |
|---|---|---|---|---|---|
| scout | R0 | claude-sonnet-5-5:low (0.82, $0.12) | gemini-4-hydrogen:low (0.86, $0.09) | claude-sonnet-5-5:low (0.82, $0.12) | grok-4.7:low (0.95, $0.15) |
| scout | R1 | gemini-4-hydrogen:high (0.98, $0.11) | gemini-4-hydrogen:high (0.98, $0.11) | claude-sonnet-5-5:high (0.81, $0.13) | — |
| scout | R2 | gemini-4-carbon:low (0.90, $0.31) | gemini-4-carbon:low (0.90, $0.31) | claude-fable-5-2:medium (0.94, $0.49) | — |
| scout | R3 | gemini-4-neon:high (0.85, $0.21) | gemini-4-neon:high (0.85, $0.21) | claude-fable-5-2:high (0.91, $0.55) | — |
| implement | R0 | gemini-4-hydrogen:medium (1.00, $0.19) | gemini-4-hydrogen:medium (1.00, $0.19) | claude-haiku-5-5:high (0.93, $0.02) | grok-4.7:low (0.95, $0.36) |
| implement | R1 | gemini-4-hydrogen:high (0.98, $0.25) | gemini-4-hydrogen:high (0.98, $0.25) | claude-sonnet-5-5:high (0.81, $0.29) | — |
| implement | R2 | gemini-4-neon:high (0.97, $0.51) | gemini-4-neon:high (0.97, $0.51) | claude-fable-5-2:medium (0.94, $0.98) | — |
| implement | R3 | gemini-4-neon:high (0.85, $0.51) | gemini-4-neon:high (0.85, $0.51) | claude-fable-5-2:high (0.91, $1.30) | — |
| debug | R0 | gemini-4-hydrogen:medium (1.00, $0.29) | gemini-4-hydrogen:medium (1.00, $0.29) | claude-haiku-5-5:high (0.93, $0.03) | grok-4.7:low (0.95, $0.58) |
| debug | R1 | gemini-4-hydrogen:high (0.98, $0.40) | gemini-4-hydrogen:high (0.98, $0.40) | claude-opus-5-5:medium (0.96, $0.81) | — |
| debug | R2 | gemini-4-neon:high (0.97, $0.80) | gemini-4-neon:high (0.97, $0.80) | claude-fable-5-2:medium (0.94, $1.51) | — |
| debug | R3 | gemini-4-neon:high (0.85, $0.80) | gemini-4-neon:high (0.85, $0.80) | claude-fable-5-2:high (0.91, $2.04) | — |
| design | R0 | gemini-4-hydrogen:medium (1.00, $0.17) | gemini-4-hydrogen:medium (1.00, $0.17) | claude-haiku-5-5:high (0.93, $0.02) | grok-4.7:low (0.95, $0.37) |
| design | R1 | gemini-4-hydrogen:high (0.98, $0.25) | gemini-4-hydrogen:high (0.98, $0.25) | claude-opus-5-5:medium (0.96, $0.47) | — |
| design | R2 | gemini-4-neon:high (0.97, $0.51) | gemini-4-neon:high (0.97, $0.51) | claude-fable-5-2:medium (0.94, $0.86) | — |
| design | R3 | gemini-4-neon:xhigh (0.90, $0.73) | gemini-4-neon:xhigh (0.90, $0.73) | claude-fable-5-2:high (0.91, $1.28) | — |
| review | R0 | claude-haiku-5-5:high (0.93, $0.01) | gemini-4-hydrogen:medium (1.00, $0.12) | claude-haiku-5-5:high (0.93, $0.01) | grok-4.7:low (0.95, $0.20) |
| review | R1 | gemini-4-hydrogen:high (0.98, $0.14) | gemini-4-hydrogen:high (0.98, $0.14) | claude-sonnet-5-5:xhigh (0.97, $0.23) | — |
| review | R2 | gemini-4-neon:high (0.97, $0.29) | gemini-4-neon:high (0.97, $0.29) | claude-fable-5-2:high (0.98, $0.75) | — |
| review | R3 | gemini-4-neon:xhigh (0.90, $0.35) | gemini-4-neon:xhigh (0.90, $0.35) | claude-fable-5-2:high (0.91, $0.75) | — |
