# English demo — 165 seconds

The local review cut is 2 minutes 45 seconds, 1920×1080, H.264, 30 fps.
It has English on-screen captions and no audio. The terminal is a replay of one
real recorded run of the current macOS ARM64 binary, with no manual code edits.

| Time | Actual content / suggested narration |
| --- | --- |
| 0–10 s | “A code change needs proof. PHINs Agent brings autonomous coding with open models into a local terminal.” Team PHINs; Duy Huỳnh, Founder and Developer. |
| 10–25 s | Show the attributed historical vercel/ms bug and observed 22/27 baseline. Negative decimals fail and misplaced signs must be rejected. The 27-check oracle is fixed. |
| 25–35 s | Explain inspection, planning, targeted edits, real tests and an independent check. NVIDIA Nemotron 3 Super supplies decisions through Nebius Token Factory. |
| 35–105 s | Replay the complete captured TUI interval at labeled 1.15× speed. It inspects files, reproduces failures, encounters a planning gate, records the plan, edits, sees two remaining test failures, corrects them and reruns tests. No trials are spliced together. |
| 105–117 s | Show the actual index.js diff. No reference patch or manual fix was supplied. |
| 117–130 s | Show 22/27 → 25/27 → 27/27, unchanged oracle, final external test exit 0 and engine read-only snapshot receipt. Explain unverified post-run freshness. |
| 130–150 s | Explain the two-workspace architecture, replaceable model transport, tool permissions and independent verification. |
| 150–165 s | Show 86.175 s full-trial duration, 12 real requests, 122,022 reported input/completion tokens and estimated $0.0396504 inference cost. State one-task and macOS qualification limits. End with credits and FROM IDEAS to IMPACT. |

## Recording and release checklist

- Source input: pinned vercel/ms PR 111, Zeit MIT notice retained; added Node oracle.
- Model: `nvidia/nemotron-3-super-120b-a12b` through the actual Nebius API.
- The owner-controlled proxy keeps the provider key outside the agent and applies
  the approved cumulative ledger. Its local endpoint has no TUI price estimate;
  the video identifies the separate usage-based cost measurement.
- Native binary, cast, model calls, test outputs and receipt are hash-bound in
  local evidence. Published evidence is in [BENCHMARK.md](BENCHMARK.md).
- English banner was selected in the isolated demo profile. Terminal: 140×40.
- Preserve original PTY bytes/timestamps, failed attempts, commands and oracle hash.
- Check full video decoding, representative frames, captions, glyph coverage and
  absence of keys/private paths before owner review. No source/layout alteration
  is needed for recording.
- The delivered draft uses captions; a voiceover is optional and must match the
  same observed facts. Keep the complete video, including credits, under 180 s.
- Public YouTube URL is pending. Owner approval is required before upload.
