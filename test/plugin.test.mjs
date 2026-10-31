// What dsh-nx registers, and when it refuses to.
//
// The NX row is deliberately opt-in: it starts a batch NX session, so a default
// install must not pay for it at boot.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");

let peer = null;
try {
  peer = await import("@deepseek-ai/dsh-mcp-client");
} catch {
  // A developer without devDependencies can skip; CI cannot — a skipped test
  // that exits 0 is a green run that verified nothing.
  if (process.env.CI) {
    console.error("FAIL: @deepseek-ai/dsh-mcp-client missing in CI; run npm install first");
    process.exit(1);
  }
  console.log("SKIP: @deepseek-ai/dsh-mcp-client is not installed (npm install)");
  process.exit(0);
}

const plugin = await import(pathToFileURL(path.join(pkgRoot, "lib", "index.js")).href);

assert.equal(plugin.name, "dsh-nx");
assert.equal(typeof plugin.apply, "function");
assert.deepEqual(plugin.inject, peer.inject, "inject must match the MCP client's");

function attempt(env) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const registered = [];
  const ctx = { plugin: (mod, cfg) => registered.push({ mod, cfg }) };
  let error = null;
  try {
    plugin.apply(ctx);
  } catch (err) {
    error = err;
  }
  Object.assign(process.env, saved);
  return { registered, error };
}

// --- default: nothing registered, no throw ---------------------------------
const off = attempt({ NX_ENABLE_MCP: undefined });
assert.equal(off.registered.length, 0, "must not register NX tools unless asked");
assert.equal(off.error, null, "skipping must not throw");
console.log("default        -> nothing registered");

// --- opt-in: one row, absolute command, loud failures ----------------------
const on = attempt({ NX_ENABLE_MCP: "1" });
assert.equal(on.error, null, `enabling must not throw: ${on.error && on.error.message}`);
assert.equal(on.registered.length, 1, "exactly one row");
const row = on.registered[0];
assert.equal(row.mod, peer, "must register the MCP client itself");
assert.equal(row.cfg.serverName, "nx");
assert.equal(row.cfg.transport, "stdio");
assert.ok(path.isAbsolute(row.cfg.command), "command must be absolute, not a PATH name");
assert.equal(row.cfg.failOnStartupError, true, "a row that cannot start must say so");
assert.ok(row.cfg.args.some((a) => a.endsWith("dsh-nx.mjs")), "must run this package's own entry");
assert.ok(row.cfg.args.includes("serve"), "must run the serve subcommand, which owns the bridge");
console.log("NX_ENABLE_MCP  -> nx registered, failOnStartupError=true");

// --- missing skill must be a clear error, not a silent skip ----------------
const baseDir = fs.mkdtempSync(path.join(require_tmp(), "dsh-nx-"));
const withBase = attempt({ NX_ENABLE_MCP: "1", NX_BASE_DIR: baseDir });
assert.ok(withBase.error, "must throw when the skill is not installed");
assert.match(withBase.error.message, /dsh-nx install/i);
assert.equal(withBase.registered.length, 0, "must not register a row that cannot work");
console.log("no skill       -> throws, registers nothing");
fs.rmSync(baseDir, { recursive: true, force: true });

console.log("\nall cases behave as intended");

function require_tmp() {
  return process.env.TEMP || process.env.TMP || ".";
}
