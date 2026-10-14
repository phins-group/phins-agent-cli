# Judging guide

This candidate runs locally on macOS ARM64. A public test-build URL and free
judge-access arrangement remain pending. BYOK is a developer setup option,
not proof that the competition's access requirement has been met.

## Install

Install Node.js 22+, Bun 1.3.12+, pnpm 10.26.0 and Git. In the extracted source:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm source:check
pnpm check
pnpm cli --help
```

No private package/backend is required. `pnpm build` creates a local binary.
The source launcher below isolates state automatically.

## Reproduce the original bug

```sh
pnpm demo:prepare
pnpm demo:test
```

Preparation creates `.local/demo-ms-pr111` and refuses overwrite. The first test
run should exit 1 on the unfixed input. Source is pinned at
`fe0bae301a6c41f68a01595658a4f4f0dcba0e84` in
[vercel/ms](https://github.com/vercel/ms); see [PR 111](https://github.com/vercel/ms/pull/111).
Our added oracle has 27 checks. Historical Mocha tests are retained but not run here.

## Configure and run

```sh
pnpm demo:setup
pnpm demo:tui
```

Demo setup and TUI share a separate state directory and the same execution policy.
Enter the key with masking and select Nebius. The demo pins NVIDIA Nemotron 3
Super. Setup itself requests no inference. Confirm account availability, prices
and credits before submitting a task; never embed a shared key in source/video.

For the English banner: `/help` → Ctrl+T → Switch tagline to English. Use a
terminal at least 140 columns wide. Paste `.local/demo-ms-pr111/task.txt`.
Watch the plan, reads, failing baseline, edit, tests and independent check.
Only `index.js` may be edited; the exact test command is allowlisted, the oracle
is protected and test-process network is denied. Model inference runs on Nebius.
No scripted provider is used by this command.

A first-attempt correct fix is valid. Do not stage a failure to manufacture
correction footage. Preserve failed/stopped trials and all interventions.

## Verify

```sh
pnpm demo:test
git diff --no-index examples/live/ms-pr111/index.js .local/demo-ms-pr111/project/index.js
```

The diff exits 1 when files differ; that is expected. The test helper rejects an
altered oracle. Confirm only the permitted file changed, tests pass and the
independent receipt is present. Final prose alone is insufficient.

Record outcome, passed/total tests, corrections, duration, model latency, tokens,
estimated cost and failure reasons, tied to source/binary and test hashes.
See [evaluation](BENCHMARK.md).

`pnpm test` and `pnpm test:coding` use local/scripted providers to exercise tools
and wiring, not real model decisions. Two current-build real-model trials reached
27/27 final checks; one corrected a 25/27 intermediate result. Inspect
[the recorded evidence](evidence/live-20261014.json) and
[evaluation limits](BENCHMARK.md). A local English video draft is prepared;
public links, other platforms and free judge access remain unresolved.
