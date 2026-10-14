# Judging guide

Download the standalone archive for your OS from the [Quick Start](QUICKSTART.md).
It covers macOS, Linux and Windows downloads, masked Nebius setup and startup;
judges do not need Bun, pnpm or agent package installation. The bundled tests
need Node.js 22+ and Git. No private package/backend is required.

The protected sandbox/independent-check sequence below is qualified on macOS
ARM64. See the Quick Start for ordinary Linux/Windows permission-based trials
and the validation report for platform scope. A free judge-credential arrangement
remains pending; BYOK setup alone does not prove competition-access compliance.

## Install

Extract your archive, keep its notices, and open a terminal in the extracted
folder. Follow [installation and launch](QUICKSTART.md). The executable is
`phins` (`phins.exe` on Windows); no arguments open the TUI.

## Reproduce the original bug

```sh
node scripts/demo.mjs prepare
node scripts/demo.mjs test
```

Preparation creates `.local/demo-ms-pr111` and refuses overwrite. The first test
run should exit 1 on the unfixed input. Source is pinned at
`fe0bae301a6c41f68a01595658a4f4f0dcba0e84` in
[vercel/ms](https://github.com/vercel/ms); see [PR 111](https://github.com/vercel/ms/pull/111).
Our added oracle has 27 checks. Historical Mocha tests are retained but not run here.

## Configure and run

```sh
node scripts/demo.mjs setup
node scripts/demo.mjs tui
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
node scripts/demo.mjs test
git diff --no-index examples/live/ms-pr111/index.js .local/demo-ms-pr111/project/index.js
```

The diff exits 1 when files differ; that is expected. The test helper rejects an
altered oracle. Confirm only the permitted file changed, tests pass and the
independent receipt is present. Final prose alone is insufficient.

Record outcome, passed/total tests, corrections, duration, model latency, tokens,
estimated cost and failure reasons, tied to source/binary and test hashes.
See [evaluation](BENCHMARK.md).

`pnpm test` and `pnpm test:coding` use local/scripted providers to exercise tools
and wiring, not real model decisions. Recorded real-model trials reached
27/27 final checks; one corrected a 25/27 intermediate result. Inspect
[the recorded evidence](evidence/live-20261014.json) and
[evaluation limits](BENCHMARK.md). A local English video draft is prepared;
video publication and free judge access remain unresolved. The downloadable
platform startup checks are separate from hardened coding-workflow qualification.
