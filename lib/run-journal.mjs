// `dsh-nx run-journal` — run one NXOpen journal in a batch NX and decide pass/fail.
//
// The skill's run_journal_batch.bat is the same idea with no verdict: it prints
// the journal's output and returns NX's exit code. That exit code is not a
// result — NX batch exits 0xC0000409 on a clean shutdown, and a journal that
// swallows its own exception still exits 0. So the verdict here comes from the
// log, and the exit code is only one of several inputs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exists } from "./paths.mjs";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

const LOG = "[dsh-nx]";
const say = (m) => process.stderr.write(`${LOG} ${m}\n`);

// NX batch shutdown paths. 0xC0000409 (3221226505 unsigned / -1073740791
// signed) shows up after a journal that finished cleanly; treating it as
// failure would make every good run red.
const BENIGN_EXIT = new Set([0, -1073740791, 3221226505]);

// Anything here means the run did not do what it was asked, whatever the exit
// code says. Kept short and literal: a regex that fires on the word "error" in
// a journal's own log line is worse than no check at all.
const FAILURE_MARKERS = [
  ["Traceback (most recent call last)", "uncaught exception"],
  ["General Fault Exception", "NX crashed (signal 11)"],
  ["failed to initialize UFUN", "UFUN init failed (licence/profile)"],
  ["NXException", "NX API raised"],
  ["_FAIL", "journal reported a failed step"],
  ["BRIDGE_FAIL", "bridge journal failed"],
];

const DEFAULT_TIMEOUT = 300;

function pythonFor(layout) {
  const venv = path.join(layout.baseDir, "venv-nx", "Scripts", "python.exe");
  return exists(venv) ? venv : layout.python;
}

function probeNx(layout) {
  const script = path.join(LIB_DIR, "probe.py");
  const res = spawnSync(pythonFor(layout), [script], { encoding: "utf8", timeout: 30000 });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop());
  } catch {
    return null;
  }
}

// The NX root the journal will actually run in: an explicit NX_HOME wins over
// whatever the probe picked, because the probe's "highest version" guess is not
// always the install the user meant.
function resolveNxRoot(layout, nx) {
  const envRoot = process.env.NX_HOME || process.env.UGII_BASE_DIR;
  if (envRoot && exists(path.join(envRoot, "NXBIN", "run_journal.exe"))) {
    return { root: envRoot, source: "NX_HOME" };
  }
  if (layout.nxHome && exists(path.join(layout.nxHome, "NXBIN", "run_journal.exe"))) {
    return { root: layout.nxHome, source: "layout" };
  }
  if (nx && nx.root && exists(path.join(nx.root, "NXBIN", "run_journal.exe"))) {
    return { root: nx.root, source: "probe" };
  }
  return null;
}

// ugiicmd.bat is what sets up the NX command environment (licence server, PATH,
// UGII_* defaults). Skipping it works on a machine where those are already in
// the user environment, and fails on one where they are not — so call it when
// it is there.
function buildCommand(nxRoot, journalPath) {
  const ugiicmd = path.join(nxRoot, "UGII", "ugiicmd.bat");
  const exe = path.join(nxRoot, "NXBIN", "run_journal.exe");
  if (exists(ugiicmd)) {
    // windowsVerbatimArguments is not optional here: Node's own quoting turns
    // the embedded quotes into \" and cmd.exe then fails with "the filename,
    // directory name, or volume label syntax is incorrect" before NX starts.
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `""${ugiicmd}" "${nxRoot}" && "${exe}" "${journalPath}"`],
      verbatim: true,
      viaUgiicmd: true,
    };
  }
  return { file: exe, args: [journalPath], verbatim: false, viaUgiicmd: false };
}

// NX on a Chinese Windows writes GBK to the console, while a journal that sets
// PYTHONIOENCODING writes UTF-8. Deciding per chunk would break on a split
// multibyte character, so the log is decoded once at the end: strict UTF-8
// first, GBK when that fails.
function decodeLog(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buffer);
    } catch {
      return buffer.toString("utf8");
    }
  }
}

function envFor(nxRoot, workdir) {
  const profile = path.join(workdir, ".nx-profile");
  const tmp = path.join(workdir, ".nx-tmp");
  for (const dir of [profile, tmp]) {
    if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return {
    ...process.env,
    NX_HOME: nxRoot,
    UGII_BASE_DIR: nxRoot,
    // Both default to %LOCALAPPDATA%\Siemens and %TEMP%. Pointing them at the
    // workdir keeps an unattended run out of the user's NX profile — and is the
    // difference between "runs" and "General Fault Exception" when the caller
    // has no write access to those folders.
    UGII_USER_PROFILE_DIR: profile,
    UGII_TMP_DIR: tmp,
    NX_MCP_WORKSPACE: workdir,
    PYTHONIOENCODING: "utf-8",
  };
}

function judge({ timedOut, exitCode, log, expects, extraFailures }) {
  const reasons = [];
  if (timedOut) reasons.push("timeout: NX did not exit in time");

  for (const [needle, why] of FAILURE_MARKERS) {
    if (log.includes(needle)) reasons.push(`${why} (log contains ${JSON.stringify(needle)})`);
  }
  for (const pattern of extraFailures) {
    try {
      if (new RegExp(pattern).test(log)) reasons.push(`--fail-on matched ${JSON.stringify(pattern)}`);
    } catch {
      reasons.push(`--fail-on is not a valid regex: ${pattern}`);
    }
  }
  if (!timedOut && !BENIGN_EXIT.has(exitCode) && reasons.length === 0) {
    reasons.push(`exit code ${exitCode} (not one of NX's clean shutdown codes)`);
  }

  const missing = expects.filter((token) => !log.includes(token));
  if (missing.length) {
    reasons.push(`expected token(s) missing: ${missing.join(", ")}`);
  }

  return { ok: reasons.length === 0, reasons };
}

export function runJournal(journalArg, options = {}) {
  const layout = options.layout;
  const journalPath = path.resolve(journalArg);
  if (!exists(journalPath)) {
    say(`journal not found: ${journalPath}`);
    return 2;
  }
  if (path.extname(journalPath).toLowerCase() !== ".py") {
    say(`not a .py journal: ${journalPath}`);
    return 2;
  }

  const nx = probeNx(layout);
  const resolved = resolveNxRoot(layout, nx);
  if (!resolved) {
    say("no NX install found. Set NX_HOME to the install root (the folder holding NXBIN).");
    return 2;
  }

  const workdir = path.resolve(options.workdir || path.dirname(journalPath));
  if (!exists(workdir)) fs.mkdirSync(workdir, { recursive: true });
  const logPath = path.join(workdir, `${path.basename(journalPath, ".py")}.log`);
  const command = buildCommand(resolved.root, journalPath);
  const env = envFor(resolved.root, workdir);
  const timeoutSec = Number(options.timeout || DEFAULT_TIMEOUT);

  if (options.printCommand) {
    console.log(`nx root   ${resolved.root}  (from ${resolved.source}${nx ? `, NXOpen Python ${nx.nxopen_python}` : ""})`);
    console.log(`workdir   ${workdir}`);
    console.log(`log       ${logPath}`);
    console.log(`command   ${command.file} ${command.args.join(" ")}`);
    console.log(`ugiicmd   ${command.viaUgiicmd ? "yes" : "no (not present)"}`);
    console.log(`timeout   ${timeoutSec}s`);
    for (const key of ["NX_HOME", "UGII_USER_PROFILE_DIR", "UGII_TMP_DIR", "NX_MCP_WORKSPACE"]) {
      console.log(`${key.padEnd(9)} ${env[key]}`);
    }
    return 0;
  }

  say(`running ${path.basename(journalPath)} in ${resolved.root} (timeout ${timeoutSec}s)`);
  say(`log: ${logPath}`);
  const started = Date.now();
  const child = spawn(command.file, command.args, {
    cwd: workdir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: command.verbatim,
  });

  const chunks = [];
  const sink = (chunk) => {
    chunks.push(chunk);
    // Live view only; the authoritative text is decoded once from `chunks`.
    if (!options.quiet) process.stdout.write(new TextDecoder("utf-8").decode(chunk));
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // /T because NX spawns helpers; killing only the shell leaves them running
    // and the next run then fights for the licence.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }, timeoutSec * 1000);

  let extra = "";
  const finish = (exitCode) => {
    clearTimeout(timer);
    const log = decodeLog(Buffer.concat(chunks)) + extra;
    fs.writeFileSync(logPath, log, "utf8");
    const verdict = judge({
      timedOut,
      exitCode,
      log,
      expects: options.expect || [],
      extraFailures: options.failOn || [],
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const payload = {
      verdict: verdict.ok ? "ok" : "fail",
      reasons: verdict.reasons,
      exit_code: exitCode,
      timed_out: timedOut,
      seconds: Number(seconds),
      journal: journalPath,
      workdir,
      log: logPath,
      nx_root: resolved.root,
    };
    if (options.json) {
      console.log(JSON.stringify(payload));
    } else {
      if (verdict.ok) {
        say(`OK  ${seconds}s  (${logPath})`);
      } else {
        say(`FAIL ${seconds}s`);
        for (const reason of verdict.reasons) say(`  - ${reason}`);
        const tail = log.trimEnd().split("\n").slice(-8);
        if (tail.length) {
          say("  last log lines:");
          for (const line of tail) say(`    ${line}`);
        }
        say(`  full log: ${logPath}`);
      }
    }
    return verdict.ok ? 0 : 1;
  };

  return new Promise((resolve) => {
    child.on("error", (err) => {
      extra += `\n[dsh-nx] failed to start: ${err.message}\n`;
      resolve(finish(127));
    });
    child.on("close", (code, signal) => {
      if (signal && !timedOut) extra += `\n[dsh-nx] killed by ${signal}\n`;
      resolve(finish(code === null ? 1 : code));
    });
  });
}

export function parseRunJournalArgs(argv) {
  const options = { expect: [], failOn: [], json: false, quiet: false, printCommand: false };
  let journal = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--workdir" || arg === "-w") options.workdir = next();
    else if (arg === "--timeout" || arg === "-t") options.timeout = Number(next());
    else if (arg === "--expect") options.expect.push(next());
    else if (arg === "--fail-on") options.failOn.push(next());
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet" || arg === "-q") options.quiet = true;
    else if (arg === "--print-command") options.printCommand = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (journal === null) journal = arg;
    else throw new Error(`unexpected extra argument: ${arg}`);
  }
  if (!journal) throw new Error("missing <journal.py>");
  return { journal, options };
}
