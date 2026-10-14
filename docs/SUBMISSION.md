# PHINs Agent — Autonomous Coding with Open Models

Devpost draft for **team PHINs**. **Duy Huỳnh** is Founder, Developer and the
designated submission representative. Publication and judge access remain pending.

**Pitch:** From a bug report to a reviewable patch and real test results in a local
terminal, powered by NVIDIA Nemotron on Nebius Token Factory.

**Track:** Coding and Agentic Engineering.

## Problem and users

Maintainers must understand unfamiliar code, reproduce failures and verify fixes.
Generated code alone leaves this coordination to the developer. PHINs Agent
brings those steps into one visible CLI/TUI workflow for repository maintainers.

## Solution and implementation

The agent selects context, records a plan, uses real tools, edits permitted files
and learns from test failures within bounded correction. The demo protects a
fixed oracle and adds an independent read-only snapshot check. Developers can
inspect changes, tools, permissions and results.

Two TypeScript/Bun workspaces share the engine across CLI and Solid/OpenTUI.
Effect-based provider transport connects to Nebius Token Factory; NVIDIA Nemotron
reasons and selects tools in the core loop. SQLite persists sessions. The demo
uses an attributed historical vercel/ms bug, with buggy source and tests but no
reference fix. See [JUDGING_GUIDE.md](JUDGING_GUIDE.md).

## Contribution and impact

The contribution is an inspectable local workflow with explicit permission,
correction and verification boundaries. Open-model inference makes engineering
decisions. The intended benefit is less manual coordination between a generated
answer and proof that it works; productivity savings are not yet measured.

Pre-existing engine/terminal code was reused with attribution. Qualification
records dated October 12–14, 2026 cover this edition's standalone packaging,
Nebius/NVIDIA onboarding, inspect/plan/baseline gates, bounded correction,
independent snapshot checks, spending controls and reproducible demo. October 14
also adds checkpoint-aware context reporting and the current real-model evidence.
These updates fall inside the official development window. Retained attribution
identifies the foundation; these dates do not imply the entire engine or TUI was
newly authored for the competition.

## Evaluation and provider feedback

The current compiled macOS ARM64 candidate completed two fresh real-model trials
on October 14: 22/27 → 27/27 in 52.472 seconds and 22/27 → 25/27 → 27/27 in
86.175 seconds. The second includes one autonomous correction after failed tests.
Only index.js changed; the protected oracle and independent checks passed.
Receipts use shadow mode, with current filesystem freshness unverified and no
signed attestation. [Current evidence](evidence/live-20261014.json) records hashes,
tokens, latency, costs and limits. Repeated runs of one task are not distinct
benchmark tasks. Earlier failed and narrower-oracle trials remain identified in
[BENCHMARK.md](BENCHMARK.md).

All 22 current Nebius requests returned HTTP 200 with streamed tool calls and
usage. Nemotron attempted an edit before planning in both sessions; the engine
rejected it until a plan was recorded. One repair initially retained two syntax
regressions, and Nemotron corrected them from actual test output. This supports
keeping execution gates and strengthened tests outside model instructions.

Costs were estimated at $0.0300822 and $0.0396504, using verified catalog prices.
Full prompt totals were 89,501 and 116,949 input tokens. Reducing repeated context
is a future measurement target; no paired efficiency improvement is claimed.
The private QA proxy kept the provider credential outside the agent but has no
UI price estimate. An initial workspace/sandbox harness failure made no model
request and is preserved separately.

## Entry assets

The source release is authorized for
[phins-group/phins-agent-cli](https://github.com/phins-group/phins-agent-cli).
Local assets include five prebuilt target candidates, measured live evidence and
a captioned English video draft. An accepted test-build URL, free judge access
and the public YouTube URL remain pending. Binary redistribution review and
Windows runtime testing are incomplete.

[Rules](https://nebiusglobalaihackathon.devpost.com/rules) and
[FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs) were checked
2026-10-14. Registration is owner-confirmed; legal acceptance and submission
remain owner actions.
