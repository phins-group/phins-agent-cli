import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, readlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const source = await readFile(fileURLToPath(new URL("../install.sh", import.meta.url)), "utf8")
const hash = value => createHash("sha256").update(value).digest("hex")
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const options = { skip: process.platform === "win32" }

// Replace only release checksum data in a temporary script; installer logic and
// the real system SHA-256 implementation are unchanged. No network/model calls.
async function fixture(t, target = "darwin-arm64", extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phins-install-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, "user's home à")
  const tools = path.join(root, "tools")
  const label = `phins-0.1.2-local-${target}`
  const inputs = path.join(root, "inputs", label)
  await mkdir(home)
  await mkdir(tools)
  await mkdir(inputs, { recursive: true })
  const executable = "#!/bin/sh\nprintf '0.1.2-local fixture\\n'\n"
  await writeFile(path.join(inputs, "phins"), executable, { mode: 0o755 })
  await writeFile(path.join(inputs, "NOTICE"), "Fixture attribution retained\n")
  const archive = path.join(root, "release.tar.gz")
  execFileSync("tar", ["-czf", archive, "-C", path.dirname(inputs), label])
  const pins = new RegExp(`${target}\\)\\s+archive_sha256=([a-f0-9]{64})\\s+binary_sha256=([a-f0-9]{64})`).exec(source)
  assert.ok(pins, "Pinned release data missing")
  const script = path.join(root, "install.sh")
  await writeFile(script, source.replace(pins[1], hash(await readFile(archive))).replace(pins[2], hash(executable)))
  const dispatcher = path.join(tools, "tool.mjs")
  await writeFile(dispatcher, `import fs from 'node:fs';
const [tool, ...args] = process.argv.slice(2), env = process.env;
if (tool === 'uname') console.log(args[0] === '-s' ? env.FIXTURE_OS : env.FIXTURE_CPU);
if (tool === 'sysctl') console.log(env.FIXTURE_ARM);
if (tool === 'sw_vers') console.log(env.FIXTURE_MACOS);
if (tool === 'powershell.exe') fs.writeFileSync(env.FIXTURE_PS, JSON.stringify(args));
if (tool === 'curl') {
  fs.appendFileSync(env.FIXTURE_DOWNLOADS, JSON.stringify(args) + '\\n');
  if (env.FIXTURE_CURL_FAIL === '1') process.exit(22);
  fs.copyFileSync(env.FIXTURE_ARCHIVE, args[args.indexOf('-o') + 1]);
}
`)
  for (const tool of ["uname", "sysctl", "sw_vers", "curl", "powershell.exe"])
    await writeFile(path.join(tools, tool), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(dispatcher)} ${quote(tool)} "$@"\n`, { mode: 0o755 })
  const env = { PATH: tools + path.delimiter + process.env.PATH, HOME: home,
    FIXTURE_OS: target.startsWith("darwin") ? "Darwin" : "Linux",
    FIXTURE_CPU: target.endsWith("arm64") ? "aarch64" : "x86_64",
    FIXTURE_ARM: target === "darwin-arm64" ? "1" : "0", FIXTURE_MACOS: "13.0",
    FIXTURE_ARCHIVE: archive, FIXTURE_DOWNLOADS: path.join(root, "downloads"),
    FIXTURE_PS: path.join(root, "powershell.json"), ...extra }
  const bundle = path.join(home, ".local/share/phins-agent-cli", label)
  const launcher = path.join(home, ".local/bin/phins")
  const run = () => spawnSync("/bin/sh", [script], { env, encoding: "utf8", timeout: 15000 })
  const downloads = async () => (await readFile(env.FIXTURE_DOWNLOADS, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse)
  return { root, home, script, env, bundle, launcher, run, downloads, archive }
}

for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
  test(`installer detects ${target}, verifies bytes and retains the bundle`, options, async t => {
    const f = await fixture(t, target)
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readlink(f.launcher), path.join(f.bundle, "phins"))
    assert.equal(await readFile(path.join(f.bundle, "NOTICE"), "utf8"), "Fixture attribution retained\n")
    assert.ok((await f.downloads())[0].includes(`https://github.com/phins-group/phins-agent-cli/releases/download/v0.1.2/phins-0.1.2-local-${target}.tar.gz`))
    assert.deepEqual((await readdir(path.dirname(f.bundle))).filter(name => name.startsWith(".install.")), [])
  })

test("installer selects native Apple Silicon when the terminal reports x64", options, async t => {
  const f = await fixture(t, "darwin-arm64", { FIXTURE_CPU: "x86_64" })
  assert.equal(f.run().status, 0)
  assert.ok((await f.downloads())[0].some(arg => arg.endsWith("darwin-arm64.tar.gz")))
})

for (const [name, env] of [["unsupported OS", { FIXTURE_OS: "FreeBSD" }],
  ["unsupported CPU", { FIXTURE_OS: "Linux", FIXTURE_CPU: "sparc64" }],
  ["old macOS", { FIXTURE_MACOS: "12.7" }]])
  test(`installer rejects ${name} before downloading`, options, async t => {
    const f = await fixture(t, "darwin-arm64", env)
    assert.notEqual(f.run().status, 0)
    assert.deepEqual(await f.downloads(), [])
  })

test("checksum mismatch and download failure leave no executable installed", options, async t => {
  const f = await fixture(t)
  await writeFile(f.archive, "corrupted archive")
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /checksum mismatch/)
  await assert.rejects(readFile(f.launcher), { code: "ENOENT" })
  assert.deepEqual(await readdir(path.dirname(f.bundle)), [])
  f.env.FIXTURE_CURL_FAIL = "1"
  assert.notEqual(f.run().status, 0)
  assert.deepEqual(await readdir(path.dirname(f.bundle)), [])
})

test("installer preserves an unrelated command before downloading", options, async t => {
  const f = await fixture(t)
  await mkdir(path.dirname(f.launcher), { recursive: true })
  await writeFile(f.launcher, "user-owned command")
  assert.notEqual(f.run().status, 0)
  assert.equal(await readFile(f.launcher, "utf8"), "user-owned command")
  assert.deepEqual(await f.downloads(), [])
})

test("reinstallation retains user files; changed executable is rejected", options, async t => {
  const f = await fixture(t)
  assert.equal(f.run().status, 0)
  const work = path.join(f.bundle, "user-demo.txt")
  await writeFile(work, "retained work")
  assert.equal(f.run().status, 0)
  assert.equal((await f.downloads()).length, 1)
  assert.equal(await readFile(work, "utf8"), "retained work")
  await writeFile(path.join(f.bundle, "phins"), "changed executable")
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Existing installation changed/)
  assert.equal(await readFile(path.join(f.bundle, "phins"), "utf8"), "changed executable")
})

test("Windows shell detection delegates to the native PowerShell installer", options, async t => {
  const f = await fixture(t, "darwin-arm64", { FIXTURE_OS: "MINGW64_NT-10.0" })
  assert.equal(f.run().status, 0)
  const args = JSON.parse(await readFile(f.env.FIXTURE_PS, "utf8"))
  assert.ok(args.some(arg => arg.includes("/main/install.ps1")))
  assert.deepEqual(await f.downloads(), [])
})
