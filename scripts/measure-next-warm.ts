// TEMPORARY (#38): measures whether a warmed Next distDir, cloned per boot, saves time on the runner. Reverted after the measurement.
import { spawnSync } from "bun";
import { rmSync } from "node:fs";
import { serveOnFreePort, stopProcess } from "../app-test/cdp.ts";
import { spawnChild } from "../app-test/child.ts";
import { childEnv } from "../app-test/child-env.ts";
const WEB = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ROUTES = ["/", "/panel?fixture=1", "/loans", "/approvals/nope", "/health", "/hooks/health"];
async function boot(distDir: string, label: string) {
  const t0 = performance.now();
  const web = await serveOnFreePort((p) => spawnChild({ cmd: ["bun","--bun","run","next","dev","--port",String(p)], cwd: WEB,
    env: childEnv({ NODE_ENV: "development", PORT: String(p), CG_NEXT_DIST_DIR: distDir, APP_PUBLIC_HOST: `127.0.0.1:${p}`, GOVERNANCE_DB_PATH: ":memory:", LOANS_DB_PATH: ":memory:", IDP_DB_PATH: ":memory:" }), stdout: "pipe", stderr: "pipe" }),
    { url: (p) => `http://127.0.0.1:${p}/hooks/health` });
  const t1 = performance.now(); const per: string[] = [];
  for (const r of ROUTES) { const a = performance.now(); const res = await fetch(`http://127.0.0.1:${web.port}${r}`); await res.text(); per.push(`${r}=${(performance.now()-a|0)}(${res.status})`); }
  const t2 = performance.now();
  console.log(`${label}: ready ${(t1-t0|0)}ms, routes ${(t2-t1|0)}ms, total ${(t2-t0|0)}ms  ${per.join(" ")}`);
  await stopProcess(web.child);
}
const mode = process.argv[2];
if (mode === "cold") { for (let i=0;i<3;i++){ const d=`.next/exp-cold-${i}`; rmSync(`${WEB}/${d}`,{recursive:true,force:true}); await boot(d, `cold#${i}`); rmSync(`${WEB}/${d}`,{recursive:true,force:true}); } }
if (mode === "warm") {
  rmSync(`${WEB}/.next/exp-warm`,{recursive:true,force:true});
  await boot(".next/exp-warm", "warming");
  for (let i=0;i<3;i++){ const d=`.next/exp-clone-${i}`; rmSync(`${WEB}/${d}`,{recursive:true,force:true});
    const c0=performance.now(); const cp = spawnSync(process.platform==="darwin"?["cp","-cR",`${WEB}/.next/exp-warm`,`${WEB}/${d}`]:["cp","-R","--reflink=auto",`${WEB}/.next/exp-warm`,`${WEB}/${d}`]); 
    console.log(`clone ${(performance.now()-c0|0)}ms exit ${cp.exitCode}`);
    await boot(d, `clone#${i}`); rmSync(`${WEB}/${d}`,{recursive:true,force:true}); }
  const du = spawnSync(["du","-sh",`${WEB}/.next/exp-warm`]); console.log(du.stdout.toString());
  rmSync(`${WEB}/.next/exp-warm`,{recursive:true,force:true});
}
