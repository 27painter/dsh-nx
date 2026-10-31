#!/usr/bin/env node
// dsh-nx: install / doctor / where / serve for Siemens NX 12.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PKG, PKG_ROOT, exists, resolveLayout, configPath } from "../lib/paths.mjs";

const LOG = "[dsh-nx]";
const say = (m) => console.error(`${LOG} ${m}`);

const NXSRC = path.join(PKG_ROOT, "nxsrc");
const JOURNAL = path.join(NXSRC, "bridge_journal.py");

function die(msg) {
  say(msg);
  process.exit(1);
}

// A descriptor file survives the NX process that wrote it, so existence is not
// liveness — and Windows reuses pids, so process.kill(pid, 0) lies too. The only
// honest test is to knock on the port the descriptor advertises.
function bridgeAlive(layout) {
  const b = bridgePaths(layout);
  if (!exists(b.descriptor)) return false;
  let port = 0;
  try {
    port = Number(JSON.parse(fs.readFileSync(b.descriptor, "utf8")).port);
  } catch {
    return false;
  }
  if (!Number.isInteger(port) || port <= 0) return false;
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const net=require('net');const s=net.connect(${port},'127.0.0.1');` +
        `s.on('connect',()=>{s.destroy();process.exit(0)});` +
        `s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500);`,
    ],
    { stdio: "ignore" },
  );
  return probe.status === 0;
}

function venvPython(layout) {
  return path.join(layout.baseDir, "venv-nx", "Scripts", "python.exe");
}

function bridgePaths(layout) {
  const state = path.join(layout.baseDir, "nx-state");
  return {
    state,
    workspace: path.join(layout.baseDir, "NX"),
    descriptor: path.join(state, "bridge.json"),
    stopFile: path.join(state, "stop.flag"),
    log: path.join(state, "bridge.log"),
  };
}

// ---------------------------------------------------------------- install
function cmdInstall() {
  const layout = resolveLayout();
  const ps = path.join(PKG_ROOT, "install.ps1");
  if (!exists(ps)) die(`install.ps1 missing from the package: ${ps}`);
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, "-BaseDir", layout.baseDir],
    { stdio: "inherit" },
  );
  if (res.status !== 0) die(`install.ps1 failed with exit code ${res.status}`);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(
    configPath(),
    JSON.stringify({ baseDir: layout.baseDir, nxHome: layout.nxHome || undefined }, null, 2) + "\n",
    "utf8",
  );
  say(`recorded ${configPath()}`);
}

// ------------------------------------------------------------------ probe
function probe(layout) {
  const script = path.join(PKG_ROOT, "lib", "probe.py");
  const python = exists(venvPython(layout)) ? venvPython(layout) : layout.python;
  const res = spawnSync(python, [script], { encoding: "utf8", timeout: 30000 });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop());
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- doctor
function cmdDoctor() {
  const layout = resolveLayout();
  const nx = probe(layout);
  say(`package   ${PKG_ROOT} (v${PKG.version})`);
  if (!nx || !nx.installed) {
    say("nx        not found (set UGII_BASE_DIR or NX_HOME)");
  } else {
    say(`nx        ${nx.root}  version ${nx.version || "unknown"}  NXOpen Python ${nx.nxopen_python}`);
    if (!nx.supported) say("nx        this build is not NX 12 with Python 3.6 — the skill is untested there");
  }
  const venv = venvPython(layout);
  say(`venv-nx   ${exists(venv) ? venv : "missing (run: dsh-nx install)"}`);
  say(`skill     ${exists(layout.skillFile) ? layout.skillDir : "missing (run: dsh-nx install)"}`);
  const b = bridgePaths(layout);
  say(`bridge    ${bridgeAlive(layout) ? "running" : "not running"}`);
  process.exit(nx && nx.installed && exists(venv) && exists(layout.skillFile) ? 0 : 1);
}

// ------------------------------------------------------------------ where
function cmdWhere() {
  const layout = resolveLayout();
  const b = bridgePaths(layout);
  const rows = {
    "base dir": layout.baseDir,
    "nx home": layout.nxHome || "(unset)",
    "run_journal": layout.runJournal || "(unset)",
    "venv-nx python": venvPython(layout),
    "ported source": NXSRC,
    "bridge journal": JOURNAL,
    "skill": layout.skillFile,
    "state dir": b.state,
    "workspace": b.workspace,
    "dsh skills": layout.dshSkills,
    "codex skills": layout.codexSkills,
  };
  for (const [k, v] of Object.entries(rows)) console.log(`${k.padEnd(16)} ${v}`);
}

// ----------------------------------------------------------------- bridge
function bridgeEnv(layout) {
  const b = bridgePaths(layout);
  return {
    ...process.env,
    UGII_BASE_DIR: layout.nxHome,
    NX_MCP_WORKSPACE: b.workspace,
    NX_MCP_STATE_DIR: b.state,
    NX_MCP_BRIDGE_STOP_FILE: b.stopFile,
    NX_MCP_ALLOW_UNVERIFIED_PYTHON_BRIDGE: "1",
    NX_MCP_SRC: NXSRC,
    NX_MCP_SMOKE_RESULT: b.log,
    // The bridge hides the cause of a failed call behind a generic message;
    // this opt-in surfaces the exception, which is how you tell an NX version
    // difference from a real bug.
    ...(process.env.NX_MCP_DEBUG_ERRORS ? { NX_MCP_DEBUG_ERRORS: process.env.NX_MCP_DEBUG_ERRORS } : {}),
  };
}

function startBridge(layout, timeoutMs = 240000) {
  const b = bridgePaths(layout);
  fs.mkdirSync(b.state, { recursive: true });
  fs.mkdirSync(b.workspace, { recursive: true });
  for (const f of [b.stopFile, b.descriptor]) {
    if (exists(f)) fs.rmSync(f, { force: true });
  }
  if (!exists(layout.runJournal)) die(`run_journal.exe not found: ${layout.runJournal}`);

  say("starting the NX bridge (a batch NX session; this takes a minute)...");
  const child = spawn(layout.runJournal, [JOURNAL], {
    env: bridgeEnv(layout),
    stdio: "ignore",
    // Detached so the bridge outlives this command: NX must stay up while the
    // MCP client talks to it.
    detached: true,
  });
  child.unref();
  child.on("error", (err) => say(`bridge failed to start: ${err.message}`));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exists(b.descriptor)) {
      say(`bridge up (${b.descriptor})`);
      return { child, ...b };
    }
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},400)"]);
  }
  const log = exists(b.log) ? fs.readFileSync(b.log, "utf8").split("\n").slice(-6).join("\n") : "(no log)";
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  die(`bridge did not come up within ${Math.round(timeoutMs / 1000)}s. Last lines:\n${log}`);
}

function stopBridge(layout) {
  const b = bridgePaths(layout);
  if (exists(b.stopFile)) return;
  fs.mkdirSync(b.state, { recursive: true });
  fs.writeFileSync(b.stopFile, "stop", "utf8");
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!exists(b.descriptor)) break;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},300)"]);
  }
}

// ------------------------------------------------------------------ serve
function cmdServe() {
  const layout = resolveLayout();
  const venv = venvPython(layout);
  if (!exists(venv)) die(`venv-nx missing: ${venv} (run: dsh-nx install)`);
  const b = bridgePaths(layout);
  if (!bridgeAlive(layout)) {
    die(
      "the NX bridge is not running, so there is nothing for the tools to talk to.\n" +
        "A batch NX session takes about a minute to come up — longer than an MCP client\n" +
        "waits for tools/list — so start it first, then connect://n//n" +
        "  dsh-nx bridge start\n\n" +
        "(The skill route does not need the bridge.)",
    );
  }
  say(`using the running bridge (${b.descriptor})`);
  const bridge = { child: { pid: null, kill() {} } };
  const env = {
    ...bridgeEnv(layout),
    PYTHONPATH: NXSRC,
    PYTHONIOENCODING: "utf-8",
  };
  const sidecar = spawn(venv, ["-m", "nx_mcp.server"], { env, stdio: "inherit" });
  const finish = (code) => {
    // The bridge was started by `bridge start`, not by us — leave it running so
    // the next session does not pay the cold start again.
    say("sidecar exited; the bridge keeps running (stop it with: dsh-nx bridge-stop)");
    process.exit(code ?? 0);
  };
  sidecar.on("error", (err) => die(`sidecar failed: ${err.message}`));
  sidecar.on("exit", (code) => finish(code));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => finish(0));
}

// ------------------------------------------------------------------- main
const cmd = process.argv[2] || "doctor";
switch (cmd) {
  case "install":
    cmdInstall();
    break;
  case "doctor":
    cmdDoctor();
    break;
  case "where":
    cmdWhere();
    break;
  case "serve":
    cmdServe();
    break;
  case "bridge-start": {
    const layout = resolveLayout();
    const b = bridgePaths(layout);
    if (bridgeAlive(layout)) {
      say(`bridge already running (${b.descriptor})`);
      break;
    }
    startBridge(layout);
    say("bridge is up; NX stays busy until you run: dsh-nx bridge-stop");
    break;
  }
  case "bridge-stop":
    stopBridge(resolveLayout());
    say("stop file written");
    break;
  case "version":
    console.log(PKG.version);
    break;
  default:
    console.error(`usage: dsh-nx <install|doctor|where|serve|bridge-start|bridge-stop|version>`);
    process.exit(2);
}
