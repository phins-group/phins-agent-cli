import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Location } from "../src/workspace/location"
import { select } from "../src/verification/local"

const location = { directory: "/reviewed", project: { directory: "/reviewed", id: "local-test" } } as Location.Interface

test("local verifier pins reviewed commands and refuses missing or out-of-root policies", () => {
  const first = select(location, ["node --test", "node check.mjs"])
  expect(first.plan.check.argv).toEqual(["/bin/sh", "-c", "(\nnode --test\n) &&\n(\nnode check.mjs\n)"])
  expect(first.plan.containment).toMatchObject({ filesystem: "read-only", network: "network-deny" })
  expect(first.verifier.digest).not.toBe(select(location, ["node other.mjs"]).verifier.digest)
  expect(() => select(location, [])).toThrow()
  expect(() => select(location, ["bad\0command"])).toThrow()
  expect(() => select({ ...location, directory: "/outside" } as Location.Interface, ["node --test"])).toThrow()
})

test.skipIf(process.env.PHINS_TEST_OS_SANDBOX !== "1")(
  "local snapshot checks fail closed on denied grants, revocation, writes, timeout and interruption", async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "phins-verifier-local-")))
    const project = path.join(base, "project")
    await fs.mkdir(project)
    await fs.writeFile(path.join(project, "marker"), "unchanged")
    const script = `
      import { Effect, Exit } from "effect";
      import fs from "node:fs/promises";
      import path from "node:path";
      import * as Local from ${JSON.stringify(path.resolve(import.meta.dir, "../src/verification/local.ts"))};
      import { VerifierRegistry } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/verification/registry.ts"))};
      import { ProcessRunner } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/execution/process/runner.ts"))};
      const root=process.argv[1], results=[];
      const location={directory:root,project:{directory:root,id:"local-test"}};
      await Effect.runPromise(Effect.gen(function*() {
        const process=yield* ProcessRunner.Service;
        for(const mode of ["pass","fail","denied","revoked","write","timeout","stop"]) {
          let copied=0,cleaned=0,grants=0;
          let selection=Local.select(location,[mode==="write" ? "printf modified > marker" :
            mode==="fail" ? "exit 7" : ["timeout","stop"].includes(mode) ? "sleep 5" : "cat marker"]);
          if(mode==="timeout") selection=VerifierRegistry.pin({...selection.plan,
            check:{...selection.plan.check,timeoutMs:100}},selection);
          const containment=Local.make({selection,process,
            authorize:Effect.suspend(()=> {
              grants++;
              return mode==="denied" || (mode==="revoked" && grants>=2) ? Effect.fail("grant unavailable") : Effect.void;
            }),
            snapshots:{materialize:(snapshot)=>Effect.promise(async()=> {
              copied++;
              const directory=await fs.mkdtemp(path.join(path.dirname(root),"copy-"));
              await fs.cp(root,directory,{recursive:true});
              return {snapshot,projectRoot:root,directory,cleanup:Effect.promise(async()=>{cleaned++;await fs.rm(directory,{recursive:true,force:true})})};
            })}});
          const execute=containment.execute({selection,subject:{executionID:"receipt",snapshot:"tree",projectID:"local-test",locationKey:"location"}});
          const exit=yield* (mode==="stop" ? Effect.raceFirst(execute,Effect.sleep(100).pipe(Effect.andThen(Effect.interrupt))) : execute).pipe(Effect.exit);
          results.push({mode,copied,cleaned,grants,ok:Exit.isSuccess(exit),...(Exit.isSuccess(exit)?{status:exit.value.status,exitCode:exit.value.exitCode}: {})});
        }
      }).pipe(Effect.provide(ProcessRunner.defaultLayer)));
      console.log(JSON.stringify(results));
    `
    try {
      const child = Bun.spawn([process.execPath, "-e", script, project], {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { PATH: process.env.PATH, PHINS_SAFE_MODE: "1", PHINS_TEST_HOME: path.join(base, "profile") },
        stdout: "pipe", stderr: "pipe",
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect(exit, stderr).toBe(0)
      const results = JSON.parse(stdout)
      expect(results[0]).toMatchObject({ status: "passed", exitCode: 0, grants: 3, copied: 1, cleaned: 1 })
      expect(results[1]).toMatchObject({ status: "failed", exitCode: 7 })
      expect(results[2]).toMatchObject({ ok: false, copied: 0, cleaned: 0 })
      expect(results[3]).toMatchObject({ ok: false, copied: 1, cleaned: 1 })
      expect(results[4]).toMatchObject({ status: "failed" })
      expect(results[5]).toMatchObject({ ok: false, copied: 1, cleaned: 1 })
      expect(results[6]).toMatchObject({ ok: false, copied: 1, cleaned: 1 })
      expect(await fs.readFile(path.join(project, "marker"), "utf8")).toBe("unchanged")
      expect((await fs.readdir(base)).filter((name) => name.startsWith("copy-"))).toEqual([])
    } finally { await fs.rm(base, { recursive: true, force: true }) }
  }, 30_000,
)
