/** Compile local artifacts only. Never publishes or calls a model provider. */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

const root = path.resolve(import.meta.dir, "..")
const cli = path.join(root, "packages/terminal")
const engine = path.join(root, "packages/engine")
const pkg = await Bun.file(path.join(root, "package.json")).json()
if (pkg.private !== true || process.env.PHINS_RELEASE)
  throw new Error("Local builds require private package metadata and no PHINS_RELEASE")

const targets = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "windows-x64": "bun-windows-x64-baseline",
} as const
type Target = keyof typeof targets
const args = process.argv.slice(2)
if (args[0] === "--help") {
  console.log(`pnpm build [--all | --target ${Object.keys(targets).join("|")}]`)
  process.exit(0)
}
const native = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const requested = args.length === 0 ? [native] : args.length === 1 && args[0] === "--all"
  ? Object.keys(targets) : args.length === 2 && args[0] === "--target" ? [args[1]!] : []
if (!requested.length || requested.some(name => !Object.hasOwn(targets, name)))
  throw new Error("Unsupported build target. Run pnpm build --help.")
const { createSolidTransformPlugin } = await import(
  await Bun.resolve("@opentui/solid/bun-plugin", cli),
)
const worker = path.join(cli, "node_modules/@opentui/core/parser.worker.js")
const outdir = path.join(root, "dist")
const catalog = await Bun.file(path.join(root, "configs/models.json")).text()

for (const name of requested as Target[]) {
  const windows = name.startsWith("windows")
  const linux = name.startsWith("linux")
  const platform = windows ? "win32" : name.split("-")[0]!
  const architecture = name.split("-")[1]!
  const directory = args.length === 0 ? outdir : path.join(outdir, name)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const binary = path.join(directory, windows ? "phins.exe" : "phins")
  const watcherPackage = `@parcel/watcher-${platform}-${architecture}${linux ? "-glibc" : ""}`
  const watcher = await Bun.resolve(watcherPackage,
    path.dirname(await Bun.resolve("@parcel/watcher", engine)))
  const embeddedRoot = windows ? "B:/~BUN/root/" : "/$bunfs/root/"
  console.log(`Building ${name} → ${path.relative(root, binary)}`)
  const result = await Bun.build({
    root,
    entrypoints: [path.join(root, "scripts/standalone.ts"), worker],
    tsconfig: path.join(cli, "tsconfig.json"),
    plugins: [createSolidTransformPlugin()],
    external: ["node-gyp"],
    target: "bun", format: "esm", minify: true, sourcemap: "none",
    metafile: true,
    compile: { target: targets[name], outfile: binary, autoloadBunfig: false,
      autoloadDotenv: false, autoloadTsconfig: false, autoloadPackageJson: false },
    define: {
      PHINS_VERSION: JSON.stringify(`${pkg.version}-local`),
      PHINS_CLI_NAME: JSON.stringify("phins"),
      PHINS_CHANNEL: JSON.stringify("local"),
      PHINS_MODELS_DEV: catalog,
      PHINS_LIBC: JSON.stringify("glibc"),
      FFF_LIBC: JSON.stringify("gnu"),
      "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
      PHINS_WATCHER_BINDING: JSON.stringify(watcher),
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(
        embeddedRoot + path.relative(root, worker).split(path.sep).join("/"),
      ),
    },
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    throw new Error(`Native build failed: ${name}`)
  }
  const inputs = Object.keys(result.metafile!.inputs)
  const assets = inputs.filter(input => /\.(dylib|so|dll|node|wasm)$/.test(input))
  // A successful JS bundle can still omit a dynamic native import. Fail here,
  // before presenting that artifact as standalone.
  for (const required of [watcherPackage, `@opentui/core-${platform}-${architecture}`,
    `@ff-labs/fff-bin-${platform}-${architecture}`, "bun-pty", "photon_rs_bg.wasm",
    "tree-sitter.wasm", "tree-sitter-markdown.wasm"])
    if (!assets.some(asset => asset.includes(required)))
      throw new Error(`${name}: native/WASM asset missing from build: ${required}`)
  // Ad-hoc signing is local integrity, not Apple notarization.
  if (process.platform === "darwin" && platform === "darwin") {
    Bun.spawnSync(["codesign", "--remove-signature", binary], { stderr: "ignore" })
    for (const signArgs of [["--force", "--sign", "-"], ["--verify", "--strict"]]) {
      const signed = Bun.spawnSync(["codesign", ...signArgs, binary])
      if (signed.exitCode !== 0) throw new Error(`Ad-hoc signing failed: ${name}`)
    }
  }
  const bytes = await Bun.file(binary).arrayBuffer()
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
  await writeFile(path.join(directory, "build-inputs.json"),
    JSON.stringify(result.metafile, null, 2) + "\n", { mode: 0o600 })
  await writeFile(path.join(directory, "build.json"), JSON.stringify({
    version: `${pkg.version}-local`, target: name, bun: Bun.version,
    binary: path.basename(binary), bytes: bytes.byteLength, sha256,
    nativeAssets: assets, status: "local-build; runtime qualification is separate",
  }, null, 2) + "\n", { mode: 0o600 })
  await writeFile(path.join(directory, "SHA256SUMS"),
    `${sha256}  ${path.basename(binary)}\n`, { mode: 0o600 })
  console.log(`Built ${name}: ${Math.round(bytes.byteLength / 1024 / 1024)} MiB`)
}
