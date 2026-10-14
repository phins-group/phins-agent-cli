# Binary licenses and runtime source

The `v0.1.0` hackathon preview includes a Bun **1.3.12** runtime and third-party
native/WASM libraries. PHINs' Apache-2.0 license applies to PHINs contributions;
it does not replace inherited MIT or dependency licenses. Keep `LICENSE`,
`NOTICE`, `DEPENDENCIES.json`, `dependencies/` and `runtime-notices/` with the
executable when redistributing it.

## Source access

The [release](https://github.com/phins-group/phins-agent-cli/releases/tag/v0.1.0)
provides these optional assets in addition to the five runnable archives:

- `phins-agent-cli-source-0.1.0.zip`: the approved application source, build
  scripts and frozen dependency lockfile, also available from the release tag.
- `PHINs-Agent-runtime-sources-0.1.0.tar.gz`: the pinned Bun source, its WebKit/
  JavaScriptCore build sources, TinyCC, linked library sources, native library
  sources, grammar sources and published Rust crate sources.
- `PHINs-Agent-third-party-notices-0.1.0.tar.gz`: collected runtime/native
  license and attribution texts. The same collection accompanies each binary.
- `SHA256SUMS`: checksums for the release assets.

Judges do **not** need the source or notice-only downloads to run the binary.
The [source index](../notices/runtime-sources.json) records source revisions,
original URLs, checksums and collection scope. No model weights, API key or
commercial PHINs code are included.

## Runtime rebuilding and relinking

Bun's own license is MIT. Its JavaScriptCore/WebKit portions and TinyCC have
LGPL terms. Their source and the complete PHINs application source are supplied
for inspecting, modifying and rebuilding the combination. The release imposes
no additional restriction on library modification or reverse engineering for
debugging those modifications; the applicable library licenses govern.
See [Bun's license explanation](https://bun.com/docs/project/license) and the
unchanged license texts in the source collection.

The exact runtime pins are:

| Component | Revision |
| --- | --- |
| Bun 1.3.12 | `700fc117a2fd01ac0201deaa6fa69c5557acb04f` |
| WebKit / JavaScriptCore | `c2010c47d12c525d36adabe3a17b2eb6ec850960` |
| TinyCC | `12882eee073cfe5c7621bcfadf679e1372d4537b` |

Extract the runtime-source asset, then its Bun and WebKit archives. The Bun
source includes the platform/toolchain prerequisites, dependency recipes and
TinyCC patch. At this revision `BUN_WEBKIT_PATH` selects your modified WebKit
source, and the local release profile builds it from source:

```sh
bun install --frozen-lockfile
export BUN_WEBKIT_PATH=/absolute/path/to/WebKit-c2010c47d12c525d36adabe3a17b2eb6ec850960
bun run build:release:local
```

Run those commands **inside the extracted Bun source**, after installing its
upstream compiler/build prerequisites. Dependencies may be fetched by the
upstream build; their pinned sources are also in the companion asset. The
resulting runtime is normally `build/release-local/bun`. Modify TinyCC in the
source selected by `scripts/build/deps/tinycc.ts`; its patch and link recipe
are included. Build paths and prerequisites are defined by these pinned
upstream scripts, not by the Quick Start.

To rebuild PHINs with that modified runtime, install the application lockfile
from the approved application source, then run the native build script using
your rebuilt Bun executable:

```sh
pnpm install --frozen-lockfile --ignore-scripts
/absolute/path/to/bun/build/release-local/bun scripts/build-local.ts
```

This is a source/relinking route for maintainers, not an installation step for
judges. The published application was compiled with the official Bun runtime;
**a complete modified-runtime rebuild/relink has not been executed in this
validation**. No byte-identical compiler reproduction is claimed.

## Collection boundaries

The WebKit archive contains source and build resources, including `Source`,
`Tools`, `WebKitLibraries` and platform configurations. Git internals and
unrelated browser test/website directories are excluded. Library sources and
licenses remain unmodified.

The Rust collection is a conservative union of the FFF, bun-pty and published
Photon crate lockfiles, including build/dev/platform dependencies. It is not a
claim that every collected crate is linked on every target. Published crate
checksums are verified. Photon 0.3.3's crate VCS pin matches the source commit
used by the 0.3.4 npm wrapper. `option-ext`'s MPL-2.0 source is supplied in that
collection; permissive alternatives are retained for dual-licensed crates.
Upstream prebuilt native payloads were not independently reproduced.

Some npm/crate publishers declare a license without shipping a standalone
text. Supplemental notices identify the publisher/source and basis; no missing
copyright year or independent PHINs ownership is invented. Current upstream
query-license references and packages without a VCS pin are labeled in the
index. Retaining these limits avoids treating package metadata as a verified
reproducible build of every third-party binary.
