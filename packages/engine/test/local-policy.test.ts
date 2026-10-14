import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { permitted, childEnvironment } from "../src/security/launcher-policy"

test("canonical project boundary rejects secrets, traversal and symlink escapes", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "phins-policy-")))
  try {
    await fs.mkdir(path.join(root, "src"))
    await fs.symlink(os.tmpdir(), path.join(root, "outside"))
    expect(permitted(root, path.join(root, "src/new.ts"), true)).toBe(true)
    expect(permitted(root, path.join(root, ".env.local"))).toBe(false)
    expect(permitted(root, path.join(root, ".phins/share/credentials.db"))).toBe(false)
    expect(permitted(root, path.join(root, "outside"))).toBe(false)
    expect(permitted(root, path.join(root, "../outside"))).toBe(false)
    expect(permitted(root, path.join(root, ".git/config"), true)).toBe(false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test("child environment allowlist removes keys and execution startup hooks", () => {
  expect(childEnvironment({ PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", NEBIUS_API_KEY: "synthetic",
    NODE_OPTIONS: "--require private", BASH_ENV: "/private", ENV: "/private", PYTHONPATH: "/private",
    HTTP_PROXY: "http://private", PHINS_SPENDING_LEDGER: "/private", UNKNOWN_CREDENTIAL: "synthetic" })).toEqual({
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
    })
})
test.skipIf(process.env.PHINS_TEST_OS_SANDBOX !== "1")("safe child blocks credential reads, oracle writes and unlisted commands", async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "phins-policy-os-")))
  const root = path.join(base, "project")
  const profile = path.join(base, "profile")
  await fs.mkdir(root)
  await fs.mkdir(path.join(profile, ".phins"), { recursive: true })
  await fs.writeFile(path.join(profile, ".phins/credential"), "synthetic-secret")
  await fs.writeFile(path.join(root, "oracle.txt"), "fixed oracle")
  await fs.symlink("oracle.txt", path.join(root, "oracle-link"))
  const script = `
    import { Effect } from "effect";
    import * as P from ${JSON.stringify(path.resolve(import.meta.dir, "../src/security/launcher-policy.ts"))};
    import * as S from ${JSON.stringify(path.resolve(import.meta.dir, "../src/execution/sandbox.ts"))};
    const root=process.argv[1], profile=process.argv[2];
    let blocked=false;
    try { await Effect.runPromise(P.assertCommand("rm -rf .")); } catch { blocked=true }
    if (!blocked) throw Error("command bypass");
    if(P.permitted(root,root+"/oracle.txt",true)) throw Error("protected alias bypass");
    const commands=${JSON.stringify(['printf "%s" "$NEBIUS_API_KEY"', `cat ${profile}/.phins/credential`, "printf changed > oracle.txt", "printf escaped > ../escape"])};
    const results=[];
    for(const command of commands) {
      const prepared=await Effect.runPromise(S.prepare({command:"/bin/sh",args:["-c",command],cwd:root,root}));
      const child=Bun.spawn([prepared.command,...prepared.args], {cwd:root,env:P.childEnvironment(),stdout:"pipe",stderr:"pipe"});
      const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      results.push({code,out});
    }
    console.log(JSON.stringify(results));
  `
  try {
    const child = Bun.spawn([process.execPath, "-e", script, root, profile], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { PATH: process.env.PATH!, PHINS_SAFE_MODE: "1", PHINS_TEST_HOME: profile,
        PHINS_PROTECTED_PATHS: '["oracle-link"]', NEBIUS_API_KEY: "synthetic-secret" },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(code, stderr).toBe(0)
    const results = JSON.parse(stdout)
    expect(results[0]).toEqual({ code: 0, out: "" })
    expect(results.slice(1).every((r: { code: number }) => r.code !== 0)).toBe(true)
    expect(stdout).not.toContain("synthetic-secret")
    expect(await fs.readFile(path.join(root, "oracle.txt"), "utf8")).toBe("fixed oracle")
  } finally { await fs.rm(base, { recursive: true, force: true }) }
}, 30000)
