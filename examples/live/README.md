# Historical demo inputs

`ms-pr111/` contains nine unchanged files from MIT-licensed vercel/ms at
`fe0bae301a6c41f68a01595658a4f4f0dcba0e84`, an added 22-check Node oracle and
notes. `UPSTREAM.json` records hashes and the issue link. Retain Zeit copyright
and `license.md`.

`ms-pr111-strict/` contains the 27-check oracle used by `pnpm demo:prepare`.
Five compatibility checks were added after reviewing an earlier model patch;
the initial and strict results are not directly comparable. Historical Mocha
tests are retained but not run by this demo.

Preparation copies the base, overlays the strict oracle and creates an empty
local Git directory for snapshots. Inputs remain unchanged. No reference fix is
included, and only `index.js` may be edited. No commit, remote or inference is
created during preparation.

In the prepared project run:
`node --test --test-reporter=tap test/regression.test.mjs`.
Initial failure is expected. See [the judging guide](../../docs/JUDGING_GUIDE.md).
