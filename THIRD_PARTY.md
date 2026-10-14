# Third-party licenses and assets

Source attribution and the scope of PHINs and inherited licenses are in
[NOTICE](NOTICE). Complete third-party license texts are retained in
[notices/](notices/).

[The dependency inventory](notices/dependency-licenses.json) records 379
name/version pairs, including development and optional native dependencies for
the cross-platform builds. It is metadata, not a
complete notice bundle for compiled binaries. The source archive excludes
`node_modules`, native binaries and model weights.

- `seq-queue@0.0.5` has no package license field but includes an MIT LICENSE,
  retained unchanged in `notices/seq-queue-LICENSE`.
- `node-forge@1.4.0` offers BSD-3-Clause or GPL-2.0. This distribution uses the BSD
  branch and retains the original choice in `notices/node-forge-LICENSE`.
- `caniuse-lite@1.0.30001800` data is CC-BY-4.0; attribution remains necessary
  in artifacts bundling that data.

Five MP3s and inherited portions of 33 themes retain the upstream MIT notice.
Their comparison reference and the PHINs logo declaration are in
[PROVENANCE.md](PROVENANCE.md). The historical `vercel/ms` fixture retains its
Copyright (c) 2016 Zeit, Inc. MIT notice in `examples/live/ms-pr111/license.md`.

Nebius services and NVIDIA models have separate terms. Source licensing does not
grant service access or replace model terms. Before distributing a compiled
binary, review its actual bundled OpenTUI/native payload and applicable notices;
this source candidate is not binary redistribution clearance.

The pinned OpenTUI/Solid combination reports a peer-version mismatch
(Solid 1.9.10 versus OpenTUI's 1.9.12 peer). Local validation qualifies this
pinned combination only; no dependency upgrade is implied.

Supplemental texts for FFF 0.9.4, Remeda 2.26.0, Drizzle ORM 1.0.0-rc.2 and
Bun 1.3.12 are retained with pinned URLs and hashes in
[the supplemental inventory](notices/supplemental-notices.json). Packaging merges
these with installed-package notices only for the matching version. Drizzle's
exact published-source correlation, the missing opentui-spinner copyright/text,
and Bun/native/WASM transitive obligations remain under review. Retaining these
texts does not itself clear a compiled binary for redistribution.
