---
name: self-healing-pipeline
description: Use when the user wants a multi-agent self-healing development pipeline that runs Planner → Coder(s) → Reviewer ∥ Tester (with Playwright MCP) and auto-iterates on failures. Auto-detects multi-feature requests and fans them out into parallel git worktrees with a final merge. Triggers - "/pipeline", "run the pipeline", "auto-build with review", "build feature X with self-healing", "build features X and Y in parallel".
---

# Self-Healing Parallel Development Pipeline

## When to use

Invoke when the user asks to build, fix, or change one OR MORE features AND wants:
- Up-front planning before any coding
- Independent code review by a separate agent
- Runtime validation in a real browser via Playwright
- Automatic iteration when review or tests fail
- For multi-feature requests: parallel worktree-isolated development with conflict-aware merge

If the user just wants a one-off edit, do NOT use this skill — it's overkill.

## How it works

This skill is a thin pointer to the pipeline. The orchestration logic lives in:

- `.claude/commands/pipeline.md` — orchestrator prompt (entry point, phase logic)
- `.claude/agents/planner.md` — read-only plan author + parallelizability detector
- `.claude/agents/coder.md` — implements plan or applies feedback (worktree-aware)
- `.claude/agents/reviewer.md` — static analysis (worktree-aware)
- `.claude/agents/tester.md` — Playwright MCP runtime validation (worktree-aware, port-aware)
- `.claude/agents/merger.md` — git merge across worktrees, conflict resolution
- `.claude/settings.json` — Playwright MCP server, bypass permissions, observability hooks

To run: `/pipeline <task>`. The orchestrator decides single-flow vs multi-workstream automatically.

## Two flows

### Single Flow — one feature, or planner says not parallelizable

```
[user task]
   │
   ▼
[planner]   read-only           → plan: (parallelizable: false, 1 workstream)
   │
   ▼
[coder]     edits files         → implementation:
   │
   ├─── parallel ───┬───▶ [reviewer]  → review:
   │                └───▶ [tester]    → test:
   │
   ▼
[aggregate]  both PASS → done. Otherwise feedback: → loop to coder (cap = 3).
```

### Multi-Workstream Flow — 2+ features, parallelizable, git available

```
[user task: "feature A and feature B"]
   │
   ▼
[planner]   plan with 2 workstreams + shared_files analysis
   │
   ├──── parallel ────┬───▶ [coder A in worktree A]  → impl A
   │                  └───▶ [coder B in worktree B]  → impl B
   │
   ├──── parallel ────┬───▶ [reviewer A] [tester A:port 3000]   → review A, test A
   │                  └───▶ [reviewer B] [tester B:port 3001]   → review B, test B
   │
   ▼
[per-workstream aggregate]
   ├─ A passes, B fails → re-iterate B only (A frozen)
   └─ both pass → continue
   │
   ▼
[merger]    git merge A, then B; resolves conflicts → merge:
   │
   ├──── parallel ────┬───▶ [reviewer for shared_concerns]
   │                  └───▶ [tester running ALL flows on merged main]
   │
   ▼
done.
```

## Why this design

- **Parallel implementation** halves wall time when features are independent.
- **Worktree isolation** means two Coders editing simultaneously CANNOT collide on a file — they're in physically separate checkouts. No locks, no merge-during-coding.
- **Per-workstream Reviewer ∥ Tester** means each feature is validated by both perspectives concurrently.
- **Per-workstream self-heal**: if board passes but dm fails, only dm re-iterates. Board stays frozen — no wasted work, no risk of regressing the passing branch.
- **Merger as a dedicated agent**: file-level conflict resolution is its own skill. Keeping it separate from Coder means the conflict logic doesn't leak into feature implementation.
- **Integration validation after merge**: catches regressions that only appear when both features coexist (e.g., shared route table, shared CSS).

## Iteration & convergence

- Per-workstream cap: 3 iterations.
- Workstream that fails 3 times → marked `unconverged`, frozen, surfaced in final report.
- Other workstreams continue to merge; user gets a partial-success report.
- After merge, ONE final integration round; if it fails, ONE remediation pass; then stop. No infinite loops.

## Failure modes

| Symptom | What happens |
|---|---|
| Not a git repo | Multi-workstream flow falls back to Single Flow automatically. |
| Coder build fails | That workstream skips Phase 3, goes straight back to Coder with build error as feedback. |
| Playwright MCP unavailable | Tester returns FAIL with `summary: "Playwright MCP not available"`. Orchestrator surfaces it to the user. |
| Merge conflict undecidable | Merger leaves base side, records under `regressions`, orchestrator routes to Phase 7-M Coder. |
| Iteration cap hit on a workstream | Marked unconverged, surfaced; merger proceeds with the rest. |
| Integration validation fails twice | Pipeline stops, surfaces remaining issues. |

## Adapting

- Iteration cap → edit `.claude/commands/pipeline.md` (search "iteration >= 3" / "iteration < 3").
- Add a third validator (e.g., security scanner) → create `.claude/agents/<name>.md`, add a third Task call in Phase 3-S and Phase 3-M of the orchestrator.
- Disable worktree isolation entirely → set `parallelizable: false` in planner output, OR remove the multi-workstream branch in pipeline.md.
- Different port range for testers → edit Phase 3-M's `assigned_port` formula in pipeline.md.
