# Evaluation

Local fixtures verify software behavior; provider trials evaluate model decisions.
The current macOS ARM64 build completed two real Nebius/NVIDIA trials on
2026-10-14. This is one historical task repeated twice, not a broad success rate.

## Current build — real inference

NVIDIA `nvidia/nemotron-3-super-120b-a12b` made the coding decisions through
Nebius Token Factory. Each fresh repository copy started with the same fixed
27-check oracle. Only `index.js` changed; no manual code edits were applied.

| Trial | Agent test sequence | Corrections after failed tests | Full trial | Provider requests | Estimated cost |
| --- | --- | --- | --- | --- | --- |
| Qualification | 22/27 → 27/27 | 0 | 52.472 s | 10 | $0.0300822 |
| Recorded English demo | 22/27 → 25/27 → 27/27 | 1 | 86.175 s | 12 | $0.0396504 |

Both final external oracle runs passed 27/27, and both engine read-only snapshot
receipts passed. Receipts use shadow mode; current filesystem freshness is
unverified, with no signed attestation. In each trial the engine rejected a
premature edit until the model recorded its plan. This tool-policy recovery is
counted separately from correction after a failing test.

Qualification used 89,501 input and 3,591 completion tokens; the demo used
116,949 input and 5,073 completion tokens. Completion totals include reasoning.
Summed request durations were 40.125 s and 69.883 s, respectively. Full-trial
time includes setup, baseline and independent final checks; task-to-idle times
are recorded separately in [the evidence](evidence/live-20261014.json).

Prices were checked against the provider catalog at execution: $0.30/million
input and $0.90/million output tokens. Cost is usage-based estimation, not an
invoice. The earlier cumulative $0.2185578 was preserved, producing $0.2882904
against the owner's $0.50 ceiling. A startup attempt failed before any model
request because its workspace was inside a denied tree; it cost $0 and remains
in the evidence. No failed inference trial is omitted from this cohort.

Inspect the [actual patch](evidence/ms-pr111.patch),
[baseline](evidence/ms-pr111-before.tap),
[intermediate failing tests](evidence/ms-pr111-correction.tap) and
[final tests](evidence/ms-pr111-after.tap). Local path prefixes are sanitized;
the original oracle, logs and hashes were retained privately. A loopback QA proxy
kept the provider credential outside the agent and enforced cumulative spending.
It relayed real inference; its endpoint has no UI price estimate.

## Historical evidence

Results below belong to the earlier October 12 build, not this candidate.

| Cohort | Observed result | Scope |
| --- | --- | --- |
| Three seeded tasks | Small original oracles passed; retry failed a later held-out case | Authored sanity tasks |
| Initial historical ms | 17/22, then budget stop | Failed attempt |
| Literal-read ms | 22/22; later compatibility check failed | Narrow oracle |
| Strict ms, three fresh TUI trials | 27/27 each | One task repeated with fixed strengthened oracle |

Strict durations: 72.383, 33.577, 46.512 seconds. Corrections after failed tests:
2, 0, 1. Only the permitted implementation changed. Initial 22-check and later
27-check oracles are not directly comparable. No general success rate or winning
probability follows from these results.

## Reproduction and metrics

`examples/live/UPSTREAM.json` pins the primary input. `pnpm demo:prepare` and
`pnpm demo:test` reproduce the failing baseline with 27 checks. Historical Mocha
tests are retained but not run by this evaluation. Three distinct authored tasks
under `examples/seeded` cover pagination, interval merging and Retry-After.
They do not substitute for three historical repository tasks.

For each fresh copy, retain source/oracle hashes, task, model, endpoint, binary/
source identifier and limits. Test before and after; retain failed/stopped trials.

| Metric | Definition |
| --- | --- |
| Task success | Fixed oracle passes, permitted scope respected, required verification completes |
| Test pass rate | Passed / total checks for the stated oracle |
| Corrections | Corrective edits after failed validation, excluding initial edit |
| Duration | Submission to terminal outcome, wall time |
| Model latency | Actual provider request durations, separate from tool time |
| Tokens | Reported input/output/reasoning/cache usage; unavailable fields labeled |
| Estimated cost | Usage times verified model/date rates, not a bill |
| Failure | Provider/budget/timeout/permission, incorrect patch, oracle change or verification failure |

A paired baseline is pending. Use equal models, tasks, oracles, starting source,
token/time/spending limits and trial counts. Do not pool different oracles or
omit failures. More distinct tasks and paired trials remain future evaluation.
