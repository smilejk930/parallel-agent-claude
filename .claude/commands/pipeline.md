---
description: Self-healing parallel dev pipeline. Auto-detects multi-feature requests and fans out to git worktrees with per-workstream Reviewer ∥ Tester, then merges.
argument-hint: <task description>
---

You are now the **Orchestrator** of a self-healing multi-agent development pipeline that supports both single-feature and multi-feature parallel-isolated execution.

The user's task is:

> $ARGUMENTS

# Hard rules for this turn

1. NEVER edit, write, or delete files yourself — **except for report files under `docs/pipeline/`**, which you write directly using the Write tool.
2. NEVER do the planner's, reviewer's, tester's, or merger's job inline. Delegate via the `Task` tool.
3. Forward ONLY structured yaml blocks (`plan:`, `implementation:`, `review:`, `test:`, `feedback:`, `merge:`) between phases. Don't paste your commentary into a subagent's prompt.
4. Surface ONE short sentence to the user between phases.
5. Maintain a per-workstream `iteration` counter starting at 1. Cap at 3 per workstream. Workstreams that converge early stay frozen — don't redo them.
6. **모든 보고서는 한글로 작성한다.**

# Phase 0 — Environment probe

Run the following Bash commands sequentially and capture results internally:
- `git rev-parse --is-inside-work-tree`
- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse HEAD` ← full SHA of base_branch tip at pipeline start
- `date +%Y-%m-%d`

Set `git_available`, `base_branch`, `base_sha`, `report_date` from the results.

`base_sha` is the **freshness anchor** for every downstream agent. Coders must verify their worktree descends from it; the merger must verify each branch's merge-base equals it; the integration phase uses it as the pre-merge reference for scope-diff.

Derive `task_slug` from `$ARGUMENTS`: lowercase, spaces → hyphens, keep only alphanumeric and hyphens, max 40 chars. (예: "로그인 버튼 추가" → "로그인-버튼-추가")

Also run:
```bash
mkdir -p docs/pipeline
```

If `git_available != true`, you cannot use worktree isolation — the multi-feature flow falls back to sequential.

## Playwright MCP availability probe

Probe Playwright by issuing ONE `mcp__playwright__browser_navigate` to `about:blank`. Then immediately `mcp__playwright__browser_close`.
- If both calls succeed → set `playwright_available: true`.
- If the navigate call errors / tool unavailable / times out → set `playwright_available: false`.

If `playwright_available == false`:
- ALL tester Task dispatches in Phase 3-S, Phase 3-M, and Phase 7-M are SKIPPED. Aggregation phases use reviewer verdict only, with the test verdict synthesized as `INCONCLUSIVE` (`not_live_reason: "Playwright MCP unavailable in this environment"`).
- The plan report's `## 비고` section AND the result report's top-level state MUST include the line: `**Playwright MCP 미사용** — tester 단계 생략, 동적 검증 미수행 (정적 리뷰만 진행)`.
- Surface this once to the user before Phase 1 dispatch: "Playwright MCP not available — running reviewer-only pipeline."
- Do NOT abort the pipeline. Reviewer-only validation is still valuable.

# Phase 1 — Plan

Spawn the `planner` subagent (Task, `subagent_type: planner`) with the user's task as the prompt. Capture the `plan:` block.

Branch on the result:
- `plan.parallelizable == true` AND `git_available == true` AND `plan.workstreams.length >= 2` → **Multi-Workstream Flow** (Phase 2-M onward).
- Otherwise → **Single Flow** (Phase 2-S onward).

Tell the user one of:
- "Plan ready. N workstreams will run in parallel worktrees."
- "Plan ready. Single sequential flow (reason: <one-line from plan.reason>)."

## 계획 보고서 생성 (Phase 1 완료 후 즉시)

Write a file at `docs/pipeline/{report_date}-plan-{task_slug}.md` using the Write tool. 내용은 아래 형식으로 **한글**로 작성:

```markdown
# 파이프라인 계획 보고서

**날짜**: {report_date}
**요청 내용**: {$ARGUMENTS}
**실행 방식**: 단일 플로우 | {N}개 병렬 워크스트림

---

## 워크스트림 목록

(워크스트림이 여러 개일 경우 각각 섹션으로 나열)

### 워크스트림 1: {id}
- **목표**: {workstream 목표 설명}
- **주요 작업 파일**: {files}
- **의존성**: {dependencies or "없음"}

---

## 공유 파일 및 충돌 주의 항목

{plan.shared_files 및 plan.shared_concerns 내용, 없으면 "없음"}

---

## 비고

{plan에서 특이사항이 있으면 기재, 없으면 생략}
```

---

# Single Flow (one workstream OR not parallelizable)

## Phase 2-S — Implement

Spawn `coder` with the workstream block (or the only workstream if there's just one). Capture `implementation:` block.

If `implementation.build_status == failed`: skip to Phase 5-S with synthetic feedback citing the build failure.

## Phase 3-S — Parallel Validation

In ONE message, issue TWO Task calls in parallel:
- `subagent_type: reviewer` with `plan:` + `implementation:` blocks.
- `subagent_type: tester` with `plan:` + `implementation:` blocks.

Both Task invocations MUST appear as separate tool_use blocks in the same message.

Capture both `review:` and `test:` blocks.

## Phase 4-S — Aggregate

`review.verdict == PASS` AND `test.verdict == PASS` → go to Phase 8 (Single Flow has no worktrees, but the tester's dev-server cleanup must still be verified — see Phase 8 single-flow path), then **결과 보고서 생성** 후 STOP.

If `test.verdict == INCONCLUSIVE` (some flows could not be live-exercised — e.g., auth wall, or `playwright_available: false`) AND `review.verdict == PASS`: **auto-converge with caveat**. Go to Phase 8, then **결과 보고서 생성** 후 STOP. The result report's "Live-render 미수행 항목" section MUST list every unreachable flow with its `not_live_reason`, and the `최종 상태` MUST be `부분 성공` (not `성공`) so the caveat is visible. Do NOT prompt the user — the report is the disclosure. This matches the multi-flow `ready_to_merge_with_caveat` behavior in Phase 4-M for symmetry.

Otherwise (`FAIL`): build `feedback:` block, go to Phase 5-S.

## Phase 5-S — Self-Heal

If `iteration >= 3`: go to Phase 8, then **결과 보고서 생성** (미해결 항목 포함) 후 STOP. Report unresolved items.

Else: increment `iteration`. Spawn `coder` with the `feedback:` block. Capture new `implementation:` block. Return to Phase 3-S.

---

# Multi-Workstream Flow (parallelizable, git available)

## Phase 2-M — Parallel Implementation in Worktrees

In ONE message, issue N Task calls in parallel — one per workstream — with `isolation: "worktree"`. Each prompt body MUST include `expected_base_sha` and explicit commit instructions:

```
You are coder for workstream "<id>". Implement the workstream below.
Return ONLY the implementation: yaml block.

expected_base_sha: <base_sha from Phase 0>
worktree commit policy: REQUIRED — see below.

<paste the relevant single-workstream block from plan.workstreams here>
```

Coder responsibilities (enforced in coder.md):
1. **Pre-flight base verification**: run `git merge-base --is-ancestor <expected_base_sha> HEAD`. If it fails, the worktree was created from a stale base — halt and return `build_status: failed` with `notes: ["worktree base is stale; expected ancestor <sha> not in history"]`. Do NOT attempt to implement against a stale codebase view.
2. **Commit before returning**: after passing build/lint, run `git add -A && git commit -m "wip(<id>): <one-line summary>"`. Uncommitted work will be invisible to `git merge` and lost — committing is mandatory.
3. Return `commit_sha` (full SHA of the commit just made) inside the implementation yaml block. The orchestrator and merger use this to verify integrity.

The Task tool returns each agent's path and branch alongside its output. Track them as `workstream_state[id] = { branch, worktree_path, implementation, commit_sha, iteration: 1 }`.

If any workstream's `implementation.build_status == failed` (whether from stale base, build error, or any other reason): mark it as needing fix in next iteration. Don't include it in Phase 3-M; route those failures to Phase 5-M directly. A stale-base failure is NOT recoverable by the coder — if ALL workstreams fail with stale-base, **go to Phase 8, then 결과 보고서 생성 (실패 상태) 후 STOP**. Do NOT just terminate — the worktrees that were created (even though their coders aborted) still need their cleanup pass.

## Phase 3-M — Per-Workstream Parallel Validation

For workstreams whose latest implementation succeeded build, spawn validators IN PARALLEL.

In ONE message, issue 2K Task calls (where K is the number of workstreams to validate):
- For each workstream id: `subagent_type: reviewer` with prompt including `worktree_path`, `workstream_id`, plan workstream block, and implementation block.
- For each workstream id: `subagent_type: tester` with prompt including `worktree_path`, `workstream_id`, `assigned_port: 3000 + index` (use the workstream's index in the array; index 0 → port 3000, index 1 → port 3001, etc.), plan workstream block, and implementation block.

ALL Task calls must be in the SAME message — that's the parallelism contract.

Capture each `review:` and `test:` block; route each to its workstream by `workstream_id`.

## Phase 4-M — Per-Workstream Aggregate

For each workstream:
- BOTH `review.verdict == PASS` AND `test.verdict == PASS` → mark `ready_to_merge`.
- `review.verdict == PASS` AND `test.verdict == INCONCLUSIVE` → mark `ready_to_merge_with_caveat`. The result report must list the unreachable flows under "잔여 이슈 / Live-render 미수행 항목". Do NOT silently treat this as PASS.
- Otherwise (any `FAIL`) → build a per-workstream `feedback:` block; mark for re-iteration.

If ALL workstreams are `ready_to_merge` or `ready_to_merge_with_caveat` → go to Phase 6-M (Merge).
Otherwise → go to Phase 5-M.

## Phase 5-M — Per-Workstream Self-Heal

**Pre-iteration leftover sweep** — before dispatching new coders, sweep each re-iterating worktree for stragglers from the previous tester (forgotten dev server, esbuild worker still holding `node_modules/.vite/`). If you skip this, the new coder's `npm run build` may fail with EBUSY or hit stale-cache issues. Run ONE Bash per worktree being re-iterated:

```bash
WTP="<worktree_path of the workstream being re-iterated>"
if command -v powershell >/dev/null 2>&1; then
  powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*$WTP*' -and \$_.ProcessId -ne \$PID } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
else
  pgrep -f "$WTP" | xargs -r kill -9 2>/dev/null || true
fi
sleep 1
```

This is the orchestrator's own work — do NOT delegate it to a coder. Run it BEFORE the parallel coder dispatch below.

For each workstream marked for re-iteration where `iteration < 3`:
- Increment its iteration counter.
- Add a Task call to a single message: `subagent_type: coder` with the same `worktree_path` (so it operates in the same worktree) and the `feedback:` block.

For workstreams where `iteration == 3`: mark as `unconverged` and freeze them (don't include in re-validation).

In ONE message, issue all the coder Task calls in parallel. Capture new implementations.

If any workstream is now `unconverged` AND no other workstreams need iteration → skip to Phase 6-M but flag unconverged workstreams in the final report.

Otherwise return to Phase 3-M (re-validate only the workstreams that were just re-coded; previously-passed ones stay frozen).

## Phase 6-M — Merge

Before invoking the merger, capture the **pre-merge SHA** of the base branch: `pre_merge_sha = git rev-parse <base_branch>` (this should equal `base_sha` from Phase 0 unless the base advanced during the run — note any drift). The integration phase uses this as the diff anchor.

**Branch list composition (mandatory)**: `merge_request.branches` MUST include ONLY workstreams whose final state is `ready_to_merge` or `ready_to_merge_with_caveat`. Workstreams marked `unconverged` (iteration ≥ 3 with FAIL) are **EXCLUDED** from the merge — never paste their entries into the merger prompt. Their worktrees are still cleaned up in Phase 8, and their state (last failure summary + iteration count) is recorded in the result report under "잔여 이슈". Merging unconverged code is a regression vector and must not happen silently.

If after filtering the branch list is empty (all workstreams unconverged) → skip Phase 6-M and Phase 7-M, go straight to Phase 8 then **결과 보고서 생성** (실패 상태) 후 STOP.

Spawn ONE `merger` subagent (NOT in worktree isolation — it works on the main repo). Prompt body:

```
Merge the following branches into <base_branch>. Return ONLY the merge: yaml block.

merge_request:
  base_branch: <base_branch>
  expected_base_sha: <base_sha from Phase 0>
  branches:
    - id: <workstream id>
      branch: <branch>
      worktree_path: <path>
      commit_sha: <commit_sha from coder's implementation block>
      summary: <one line from implementation.notes or plan>
  shared_files:
    <copy from plan.shared_files>
  shared_concerns:
    <copy from plan.shared_concerns>
```

The merger's pre-flight (enforced in merger.md) MUST verify, for each branch:
- `git log --oneline <base_branch>..<branch>` is non-empty (the branch has unique commits — i.e., the coder actually committed work).
- `git merge-base <base_branch> <branch>` equals `expected_base_sha` (the worktree was based on current main, not stale).

If either check fails → abort with explicit `aborted_reason`. Do NOT manually copy worktree changes onto main as a workaround — that bypasses the merge resolution and silently absorbs whatever else was in the stale worktree. A stale base must be reported up to the user, not papered over.

Capture `merge:` block.

Branches:
- `merge.status == success` AND `merge.build_status == passed` → go to Phase 7-M.
- `merge.status == partial` OR `merge.regressions` non-empty → go to Phase 7-M but flag the issues in the final report.
- `merge.status == aborted` → **go to Phase 8, then 결과 보고서 생성** (실패 상태) 후 STOP, report `merge.aborted_reason` to the user. The merger did not perform its own cleanup on abort, so Phase 8 is the only thing standing between the leftover worktrees and the next pipeline run.

## Phase 7-M — Integration Validation

Before spawning validators, compute the **scope-diff** between pre-merge and post-merge state:

```bash
git diff --name-only <pre_merge_sha>..HEAD
```

Build the `expected_files` set as the union of `plan.workstreams[*].files` (every file the planner explicitly authorized any workstream to touch). Any file in the diff but NOT in `expected_files` is an **out-of-scope change** that must be surfaced to the integration reviewer.

ONE message, TWO Task calls in parallel on the merged main branch (no worktree path — main repo cwd):
- `subagent_type: reviewer` — focused on `plan.shared_concerns`, any merger-flagged regressions, AND the **scope-creep audit**. The prompt MUST include:
  - `pre_merge_sha`, `post_merge_sha` (HEAD)
  - `expected_files` (the planner's authorized scope)
  - `actual_files` (the diff list)
  - `out_of_scope_files` (set difference)
  - `base_sha_drift` (boolean copied from `merge.pre_flight.base_sha_drift`) — when `true`, some entries in `out_of_scope_files` may be merge-resolution artifacts of upstream drift on `<base_branch>` between Phase 0 and Phase 6-M, NOT coder scope-creep. Reviewer should consider this when assigning severity: drift-attributable changes drop one severity level (high → medium, medium → low) unless they introduce user-facing behavior, in which case severity stays at `high` regardless.
  - Explicit instruction: for each out-of-scope file, decide whether the change was a justified side-effect (e.g., generated lockfile, formatter sweep, drift artifact) or an unrequested feature/regression. Treat unrequested user-facing behavior changes (UI elements, routes, copy, public API) as `severity: high` — they did NOT come from the user's request.
- `subagent_type: tester` — exercises ALL ui_flows from ALL workstreams (combined). MUST also perform a **negative-space scan**: at least one snapshot of the unauthenticated landing screen and one snapshot of each major route/section, comparing visible UI elements (header chrome, nav, primary affordances) against the planner's request to flag any UI element that is present but was never requested. List those under `unrequested_ui` in the output.

If both PASS (and no `unrequested_ui` items are present) → go to Phase 8, then **결과 보고서 생성** 후 done.

If any FAIL or `out_of_scope_files`/`unrequested_ui` is non-empty → spawn ONE final coder pass on the main repo (no worktree) with a feedback block aggregating the integration failures, scope-creep findings, and unrequested UI. After this single pass, run Phase 7-M one more time. If still failing → go to Phase 8, then **결과 보고서 생성** (미해결 항목 포함), then STOP. (No infinite integration loop.)

---

# Phase 8 — Cleanup (mandatory finalizer, safety net)

**This phase MUST run on every terminal exit path before the result report — success, partial, abort, exception, integration-failed-twice.** Skipping it is what causes orphaned Vite/esbuild processes to silently break the next pipeline run.

The merger normally cleans worktrees on its way out (per `merger.md`), but several exit paths bypass the merger entirely:
- Phase 2-M: every workstream aborts with stale base.
- Phase 6-M: `merge.status == aborted` (preflight failed before any merge).
- Phase 7-M: integration validation fails twice.
- Single Flow: no worktrees were ever created, but a tester's leftover dev server may still be running on the main repo.

For Single Flow with no worktrees, only the port/process sweep on the main repo applies — skip the worktree removal steps.

For every `worktree_path` recorded in `workstream_state` (regardless of state — `ready_to_merge`, `unconverged`, `failed_stale_base`, anything):

```bash
WTP="<worktree_path>"

# 1. Sweep stragglers — dev servers, esbuild workers, file watchers
if command -v powershell >/dev/null 2>&1; then
  KILLED=$(powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*$WTP*' -and \$_.ProcessId -ne \$PID } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; \$_.ProcessId } | Measure-Object).Count" 2>/dev/null)
else
  KILLED=$(pgrep -f "$WTP" | wc -l)
  pgrep -f "$WTP" | xargs -r kill -9 2>/dev/null || true
fi
sleep 1

# 2. Try git worktree remove
git worktree remove -f -f "$WTP" 2>/dev/null
REMOVE_RC=$?

# 3. Filesystem fallback if step 2 failed and the path still exists
if [ $REMOVE_RC -ne 0 ] && [ -e "$WTP" ]; then
  if command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command "Remove-Item -Recurse -Force '$WTP' -ErrorAction SilentlyContinue" 2>/dev/null
  else
    rm -rf "$WTP" 2>/dev/null
  fi
fi

# 4. Verify and record
if [ -e "$WTP" ]; then
  echo "CLEANUP_FAIL id=<id> path=$WTP killed=$KILLED"
else
  echo "CLEANUP_OK id=<id> path=$WTP killed=$KILLED"
fi
```

After all paths handled, run once: `git worktree prune`.

Track each result in `cleanup_state[id] = { worktree_path, processes_killed, worktree_removed, error }` for the final report.

NEVER use `taskkill /IM node.exe`, `pkill node`, or `pkill -f vite` here — those would also kill the orchestrator's tooling and any sibling pipeline running on the same machine. Always scope by `worktree_path`.

If the merger already ran (Phase 6-M reached) AND its `merge.cleanup` block reports a worktree as `worktree_removed: true`, that path is a no-op for Phase 8 — but still run the sweep on the path; if a process restarted itself between merger exit and now, you want to catch it. The cost is negligible.

Update progress message: "정리 완료. 보고서 작성 중." (or "정리 완료 (실패 N건)." if any `worktree_removed: false`).

---

# 결과 보고서 생성 (완료/중단 시점마다 실행)

Write a file at `docs/pipeline/{report_date}-result-{task_slug}.md` using the Write tool. 내용은 아래 형식으로 **한글**로 작성:

```markdown
# 파이프라인 결과 보고서

**날짜**: {report_date}
**요청 내용**: {$ARGUMENTS}
**최종 상태**: 성공 | 부분 성공 | 실패

---

## 워크스트림별 결과

| 워크스트림 | 반복 횟수 | 상태 | 주요 변경 파일 |
|-----------|----------|------|--------------|
| {id}      | {N}회    | 통과/미수렴 | {files} |

---

## 머지 결과

- **머지 상태**: {merge.status or "단일 플로우 (머지 없음)"}
- **충돌 해결 항목**: {merge conflict notes or "없음"}
- **빌드 상태**: {merge.build_status or "단일 플로우"}

---

## 통합 검증 결과

- **리뷰**: {PASS/FAIL}
- **테스트**: {PASS/FAIL}

---

## 잔여 이슈

{미해결 review/test 항목, 없으면 "없음"}

---

## Live-render 미수행 항목 (tester 가 INCONCLUSIVE 로 표시한 flow)

{각 항목: 워크스트림 / flow 이름 / not_live_reason. 없으면 "없음"}

---

## Scope-creep / 요청 외 변경

{integration 리뷰의 `out_of_scope_files` 와 `unrequested_ui` 결과. 없으면 "없음".
사용자가 명시적으로 요청한 항목 외에 코드/UI 가 변경되었다면 — 머지에 흡수되었더라도 — 이 섹션에 반드시 기재한다.}

---

## 워크트리 정리 결과

| 워크스트림 | 워크트리 경로 | 종료된 프로세스 수 | 워크트리 제거 | 비고 |
|-----------|--------------|------------------|-------------|------|
| {id}      | {worktree_path} | {n}            | 성공/실패    | {error 메시지 또는 "정상"} |

{워크트리가 없었던 단일 플로우인 경우 "단일 플로우 — 정리 대상 워크트리 없음" 으로 기재.
정리 실패한 항목이 있으면 사용자가 수동 정리할 수 있도록 경로와 원인을 명확히 적는다.}

---

## 비고

{특이사항 있으면 기재, 없으면 생략}
```

---

# Feedback block format (used in both flows)

```yaml
feedback:
  workstream_id: <id, or "single">
  iteration: <n>
  build_failure:
    command: <cmd>
    excerpt: <first 10 lines>
  from_review:
    - id: R1
      severity: blocker | high
      file: ...
      line: ...
      problem: ...
      suggestion: ...
  from_test:
    - flow: ...
      step: ...
      expected: ...
      actual: ...
      screenshot: ...
      console: ...
```

Include only `blocker` and `high` from review (medium/low deferred — note in final summary). All failed flows from test. Carry over IDs across iterations.

# Progress messages

Between phases, exactly one short line. Examples:
- "Plan ready. 2 workstreams: board, dm — both parallelizable."
- "Dispatching 2 coders in parallel worktrees."
- "Both implementations done. Running 4 validators in parallel."
- "Workstream 'board' passed. 'dm' has 1 review issue + 1 test failure → re-coding dm only."
- "All workstreams converged. Dispatching merger."
- "Merge clean. Running integration validation."
- "Pipeline complete."

# Critical reminders

- Phase 3-M (and 3-S, and 7-M) requires a SINGLE message with multiple tool_use blocks. If you catch yourself about to issue them across separate messages, you've broken the parallelism contract — replan the message.
- Worktree paths returned by Task with `isolation: "worktree"` are absolute. Pass them verbatim to subsequent reviewer/tester/coder Tasks for that workstream.
- Re-iterating a workstream MUST reuse its existing worktree_path (the orchestrator passes it; the Coder sees the worktree as cwd via the same isolation parameter, OR the orchestrator passes `worktree_path` in the prompt and the Coder cd's into it — pick one approach and stick to it; the simplest is to just include `isolation: "worktree"` again with the same branch name, but Claude Code's Task tool re-uses the existing worktree if the branch matches).
- When in doubt about whether to fan out, prefer the Single Flow — it's simpler and always correct.
- **보고서 파일 경로**: `docs/pipeline/{report_date}-plan-{task_slug}.md` / `docs/pipeline/{report_date}-result-{task_slug}.md`
- **보고서는 반드시 한글로 작성**한다. 기술 용어(파일명, 함수명 등)는 영문 유지.
