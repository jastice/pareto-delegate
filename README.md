# pareto-delegate

A T3 Code skill and calibration framework for routing delegated agent tasks across heterogeneous providers, models, and reasoning effort levels.

## Goals

- Collapse 40+ `(provider, model, effort)` combinations into a small set of calibrated **Pareto-frontier rungs** filtered against live `orchestrator_capabilities`.
- Route subtasks by **verifiability**, **blast radius**, and **ambiguity** rather than vague difficulty labels.
- Account for **subscription quota economics**: soak up excess/expiring quota on secondary plans where a model clears a task's quality floor, while preserving scarce frontier quota for hard work.
- **Escalate systematically** on verification failure, poor cross-provider review, or time/attempt overrun—using fresh delegates instead of burning turns on a struggling model.
- Continuously recalibrate from lightweight local outcome telemetry (`outcomes.jsonl`) and optional repo canary tasks.

See [DESIGN.md](./DESIGN.md) for the full architecture.
