# Historical repository evaluation

Repository: https://github.com/vercel/ms
Pinned base: fe0bae301a6c41f68a01595658a4f4f0dcba0e84
Historical issue evidence: https://github.com/vercel/ms/pull/111
Retain license.md and the upstream copyright attribution.
Original upstream files are unchanged before the agent run. Added Node tests are
an independent regression oracle; the historical Mocha suite is not run here.

Run: node --test --test-reporter=tap test/regression.test.mjs
Only index.js may be edited. Do not change tests or upstream license files.
