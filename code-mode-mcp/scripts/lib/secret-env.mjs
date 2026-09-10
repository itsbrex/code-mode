// Secret-env bootstrap for the config tooling (parity, config-builder,
// exclusion generator). The live bridge is launched by the host as
// `op run --env-file configs/code-mode.env -- node dist/index.js`, so every
// secret-dependent manual resolves its ${VAR} references from namespaced
// environment variables that only exist inside that wrapper. Running the
// tooling bare therefore fails registration for exactly those manuals
// ("Variable 'x_Y' ... not found"), which parity cannot tell apart from a
// genuinely broken server.
//
// ensureSecretEnv() closes that gap: when the env file exists and we are not
// already inside the wrapper, it re-executes the current script under
// `op run` with identical node/tsx flags and argv, then exits with the
// child's status. Re-exec (rather than loading the file in-process) is
// deliberate: the env file may carry op:// secret references only the 1Password
// CLI can resolve, and vars like NODE_EXTRA_CA_CERTS must be present at
// process start to take effect.
//
// Opt-outs / overrides:
//   CODE_MODE_NO_OP=1        skip the wrapper entirely
//   CODE_MODE_ENV_FILE=path  use a different env file
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import process from "process";

const MARKER = "CODE_MODE_SECRET_ENV";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function findOpBinary() {
  for (const candidate of [process.env.OP_BIN, "op", "/usr/local/bin/op", "/opt/homebrew/bin/op"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

export function ensureSecretEnv() {
  if (process.env[MARKER] || process.env.CODE_MODE_NO_OP) return;

  const envFile =
    process.env.CODE_MODE_ENV_FILE ?? join(packageRoot, "configs", "code-mode.env");
  if (!existsSync(envFile)) return;

  const op = findOpBinary();
  if (!op) {
    console.error(
      `[secret-env] ${envFile} exists but the 1Password CLI (op) was not found; ` +
        "continuing without it — secret-dependent manuals may fail to register."
    );
    return;
  }

  const child = spawnSync(
    op,
    [
      "run",
      `--env-file=${envFile}`,
      "--",
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    { stdio: "inherit", env: { ...process.env, [MARKER]: "1" } }
  );
  if (child.error) {
    console.error(`[secret-env] failed to re-exec under op run: ${child.error.message}`);
    console.error("[secret-env] continuing without secrets — secret-dependent manuals may fail.");
    return;
  }
  process.exit(child.status ?? 1);
}
