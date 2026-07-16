#!/usr/bin/env bun
// Reusable interactive-plan server for Claude Code proposals.
//
// Serves an interactive HTML plan (findings + approve/reject choices) and
// collects the user's decisions back to disk + stdout so Claude can act on them.
//
// The plan HTML POSTs its decisions to the same origin (`fetch('/submit')`), so
// this server works on any port with no hard-coded URL in the page.
//
// Usage (from code-mode-mcp/):
//   bun run plan                       # serve newest docs/plans/*.html, open browser
//   bun run plan -- --plan foo.html    # serve a specific plan
//   bun run plan -- --port 5000        # custom port
//   bun run plan -- --no-open          # don't auto-open the browser
//
// Future proposals: drop a new *.html into code-mode-mcp/docs/plans/ and re-run
// `bun run plan` — the newest file is served automatically.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpRoot = resolve(__dirname, ".."); // code-mode-mcp/
const plansDir = join(mcpRoot, "docs", "plans");
const decisionsDir = join(plansDir, "decisions");

function parseArgs(argv) {
  const args = {
    port: Number(process.env.PLAN_PORT) || 4319,
    open: true,
    plan: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--no-open") args.open = false;
    else if (a === "--plan") args.plan = argv[++i];
  }
  return args;
}

function newestPlan() {
  if (!existsSync(plansDir)) return null;
  const htmls = readdirSync(plansDir).filter((f) => f.endsWith(".html"));
  if (!htmls.length) return null;
  htmls.sort(
    (a, b) =>
      statSync(join(plansDir, b)).mtimeMs - statSync(join(plansDir, a)).mtimeMs
  );
  return join(plansDir, htmls[0]);
}

const args = parseArgs(process.argv.slice(2));
const planFile = args.plan ? resolve(args.plan) : newestPlan();

if (!planFile || !existsSync(planFile)) {
  console.error(
    "[plan-server] No plan HTML found. Pass --plan <file> or add one to docs/plans/."
  );
  process.exit(1);
}
if (!existsSync(decisionsDir)) mkdirSync(decisionsDir, { recursive: true });

const url = `http://localhost:${args.port}/`;

Bun.serve({
  port: args.port,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return new Response(readFileSync(planFile, "utf8"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true, plan: basename(planFile) });
    }

    if (req.method === "POST" && pathname === "/submit") {
      let payload;
      try {
        payload = await req.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const out = join(decisionsDir, `decision-${stamp}.json`);
      writeFileSync(
        out,
        JSON.stringify(
          {
            receivedAt: new Date().toISOString(),
            plan: basename(planFile),
            payload,
          },
          null,
          2
        )
      );
      console.log("\n========== PLAN DECISIONS RECEIVED ==========");
      console.log(JSON.stringify(payload, null, 2));
      console.log("saved: " + out);
      console.log("=============================================\n");
      return Response.json({ ok: true, saved: basename(out) });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`[plan-server] serving ${basename(planFile)} at ${url}`);
console.log(`[plan-server] decisions → ${decisionsDir}`);
if (args.open) {
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* non-macOS or no `open`; just print the URL */
  }
}
