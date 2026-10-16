// Repro: engine logic scripts (def.scripts) are shadow-sandboxed only.
import { runScript, createResponseState } from "/home/claude/rescript/packages/engine/dist/index.js";
const ctx = { get(){}, set(){}, getCalc(){}, setCalc(){}, getEmbedded(){}, setEmbedded(){}, expr(){}, pipe(s){return s}, flag(){}, loop:null,
  getCurrentLoopItem(){}, getCurrentLoopIndex(){}, getLoopCount(){}, getCurrentLoopReference(){}, getLoopItems(){}, getLoopAnswer(){}, getElement(){}, getQuestion(){}, getOption(){}, getRow(){}, getColumn(){}, getGroup(){}, value: undefined };
// 1. a thrown error is caught (does not propagate)
let r = runScript("throw new Error('boom')", ctx);
console.log("1 throw caught ->", r.failed);
// 2. shadowing escape: reach the real global via a constructor chain
r = runScript("const g = [].constructor.constructor('return globalThis')(); log(typeof g.setTimeout); log(typeof g.fetch)", { ...ctx, log: (m)=> console.log("   script log:", m) });
console.log("2 escape failed? ->", r.failed ?? "no error (escape succeeded)");
// 3. infinite loop: bounded? (run with a watchdog in a child so we can report)
const t0 = Date.now();
import { spawnSync } from "node:child_process";
const out = spawnSync(process.execPath, ["-e", `
  import("/home/claude/rescript/packages/engine/dist/index.js").then(({runScript}) => {
    runScript("while(true){}", ${JSON.stringify({})});
    console.log("finished");
  });
`], { timeout: 3000 });
console.log("3 while(true) ->", out.status === null ? `KILLED by watchdog after ${Date.now()-t0}ms (no loop guard)` : `exited ${out.status}: ${out.stdout}`);
