// `dsh-nx run-journal` — run one NXOpen journal in a batch NX and decide pass/fail.
//
// The skill's run_journal_batch.bat is the same idea with no verdict: it prints
// the journal's output and returns NX's exit code. That exit code is not a
// result — NX batch exits 0xC0000409 on a clean shutdown, and a journal that
// swallows its own exception still exits 0. So the verdict comes from the log,
// and the exit code is only one of several inputs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCapturedSync } from "./capture.mjs";
import { explainMissingNx, probeNx, resolveNxRoot } from "./nx-root.mjs";
import { exists } from "./paths.mjs";

const LOG = "[dsh-nx]";
const say = (m) => process.stderr.write(`${LOG} ${m}\n`);

// NX batch shutdown paths. 0xC0000409 (3221226505 unsigned / -1073740791
// signed) shows up after a journal that finished cleanly; treating it as
// failure would make every good run red.
const BENIGN_EXIT = new Set([0, -1073740791, 3221226505]);

// A journal that stops here did not do what it was asked, whatever the exit
// code says.
const HARD_FAILURES = [
  ["General Fault Exception", "NX crashed (signal 11)"],
  ["failed to initialize UFUN", "UFUN init failed (licence/profile)"],
  ["BRIDGE_FAIL", "bridge journal failed"],
  ["_FAIL", "journal reported a failed step"],
  ["FATAL ERROR", "NX reported a fatal error"],
];

// Caught exceptions. The house style for a robust journal is try/except per
// step plus a traceback in the log, so these show up in healthy runs too —
// they fail the run by default (a silent failure is worse than a false alarm)
// and become a warning with --allow-traceback.
const SOFT_FAILURES = [
  ["Traceback (most recent call last)", "an exception was caught and logged"],
  ["NXException", "NX API raised (caught)"],
];

const DEFAULT_TIMEOUT = 600;

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
    // NX's embedded interpreter buffers stdout when it is not a console, so a
    // journal that prints and then dies loses its output. The journal's own
    // file log is the reliable record; this is a cheap attempt at the rest.
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

// NX on a Chinese Windows writes GBK to the console, while a journal that sets
// PYTHONIOENCODING writes UTF-8. Deciding per chunk would break on a split
// multibyte character, so a run's slice is decoded once at the end: strict
// UTF-8 first, GBK when that fails.
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

function readRange(fd, from, to) {
  const length = to - from;
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, from);
  return buffer.subarray(0, read);
}

// /T because NX spawns helpers (ugraf.exe among them): killing the shell alone
// leaves them running, still holding the licence seat.
function killTree(pid) {
  const res = runCapturedSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  const output = res.stdout.trim();
  const killed = [...new Set([...output.matchAll(/PID (\d+)/g)].map((match) => Number(match[1])))];
  return {
    ok: res.status === 0,
    killed,
    output,
    error: res.error ? res.error.code || res.error.message : null,
  };
}

function judge({ timedOut, exitCode, log, expects, extraFailures, allowTraceback, kill }) {
  const reasons = [];
  const warnings = [];
  const cleanExit = BENIGN_EXIT.has(exitCode);

  if (timedOut) {
    if (kill && kill.skipped) {
      reasons.push("timeout: NX did not exit in time (--no-kill, the process is still running)");
    } else if (kill && kill.ok === false) {
      reasons.push(
        `timeout: NX did not exit in time, and taskkill failed (${kill.error || kill.output || "refused"}) — the process may still be running`,
      );
    } else if (kill && kill.killed.length) {
      reasons.push(`timeout: NX did not exit in time; killed ${kill.killed.length} process(es)`);
    } else {
      reasons.push("timeout: NX did not exit in time");
    }
  }

  for (const [needle, why] of HARD_FAILURES) {
    if (log.includes(needle)) reasons.push(`${why} (log contains ${JSON.stringify(needle)})`);
  }
  for (const pattern of extraFailures) {
    try {
      if (new RegExp(pattern).test(log)) reasons.push(`--fail-on matched ${JSON.stringify(pattern)}`);
    } catch {
      reasons.push(`--fail-on is not a valid regex: ${pattern}`);
    }
  }

  // A traceback means one of two very different things, and the exit code is
  // what tells them apart: a crash, or a per-step journal that caught it and
  // carried on. --allow-traceback only forgives the second.
  const traceback = SOFT_FAILURES.find(([needle]) => log.includes(needle));
  if (traceback) {
    if (!cleanExit) {
      reasons.push(`uncaught exception (exit ${exitCode}); the journal stopped on it`);
    } else if (allowTraceback) {
      warnings.push(`${traceback[1]} (log contains ${JSON.stringify(traceback[0])})`);
    } else {
      reasons.push(
        `${traceback[1]} (log contains ${JSON.stringify(traceback[0])}); the journal exited cleanly, so pass --allow-traceback if the run still did its job`,
      );
    }
  }

  if (!timedOut && !cleanExit && reasons.length === 0) {
    reasons.push(`exit code ${exitCode} (not one of NX's clean shutdown codes)`);
  }

  const missing = expects.filter((token) => !log.includes(token));
  if (missing.length) {
    reasons.push(`expected token(s) missing: ${missing.join(", ")}`);
  }

  return { ok: reasons.length === 0, reasons, warnings };
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
    say(`no NX install to run in: ${explainMissingNx(layout, nx)}`);
    return 2;
  }

  let workdir = path.resolve(options.workdir || path.dirname(journalPath));
  try {
    if (!exists(workdir)) fs.mkdirSync(workdir, { recursive: true });
  } catch (err) {
    // The default workdir is the journal's own folder, which is read-only when
    // the bundle is loaded out of a profile. Losing the run over that would be
    // silly; move to a temp dir and say so.
    const fallback = path.join(os.tmpdir(), `dsh-nx-run-${process.pid}`);
    say(`${workdir} is not writable (${err.code || err.message}); using ${fallback}`);
    workdir = fallback;
    fs.mkdirSync(workdir, { recursive: true });
  }
  const logPath = path.resolve(options.log || path.join(workdir, `${path.basename(journalPath, ".py")}.log`));
  const command = buildCommand(resolved.root, journalPath);
  const env = envFor(resolved.root, workdir);
  const timeoutSec = Number(options.timeout || DEFAULT_TIMEOUT);
  // How long the tree gets to die before the pid is re-checked. taskkill returns
  // as soon as it has signalled, not when the process is gone.
  const graceSec = Number(options.killGrace ?? 2);

  if (options.printCommand) {
    console.log(`nx root   ${resolved.root}  (from ${resolved.source}${nx ? `, NXOpen Python ${nx.nxopen_python}` : ""})`);
    console.log(`workdir   ${workdir}`);
    console.log(`log       ${logPath}  (append)`);
    console.log(`command   ${command.file} ${command.args.join(" ")}`);
    console.log(`ugiicmd   ${command.viaUgiicmd ? "yes" : "no (not present)"}`);
    console.log(`timeout   ${timeoutSec}s`);
    for (const key of ["NX_HOME", "UGII_USER_PROFILE_DIR", "UGII_TMP_DIR", "NX_MCP_WORKSPACE"]) {
      console.log(`${key.padEnd(9)} ${env[key]}`);
    }
    return 0;
  }

  // Output goes straight into the log through a descriptor, not through a pipe.
  // A pipe needs a kernel handle a sandbox may refuse (spawn EPERM), and it
  // would have to be teed anyway; a descriptor is one write path, always
  // readable afterwards, and works under the default policy.
  const fd = fs.openSync(logPath, "a+");
  const startOffset = fs.fstatSync(fd).size;
  let readPos = startOffset;

  if (!options.quiet) {
    say(`running ${path.basename(journalPath)} in ${resolved.root} (timeout ${timeoutSec}s)`);
    say(`log: ${logPath}${startOffset ? ` (appending from byte ${startOffset})` : ""}`);
  }
  const started = Date.now();
  const child = spawn(command.file, command.args, {
    cwd: workdir,
    env,
    stdio: ["ignore", fd, fd],
    windowsVerbatimArguments: command.verbatim,
  });

  // Live view is a tail of the file: raw bytes, so the console renders them in
  // its own code page exactly as a plain run would.
  const tail = setInterval(() => {
    let size = 0;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      return;
    }
    if (size <= readPos) return;
    const chunk = readRange(fd, readPos, size);
    readPos += chunk.length;
    if (!options.quiet) process.stdout.write(chunk);
  }, 300);

  let timedOut = false;
  let kill = null;
  const timer = setTimeout(() => {
    timedOut = true;
    kill = options.kill === false ? { skipped: true, ok: false, killed: [], output: "--no-kill" } : killTree(child.pid);
  }, timeoutSec * 1000);

  let extra = "";
  const finish = (exitCode) => {
    clearTimeout(timer);
    clearInterval(tail);
    let size = 0;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      size = readPos;
    }
    if (size > readPos && !options.quiet) {
      process.stdout.write(readRange(fd, readPos, size));
    }
    // Only this run's slice is judged: the log is appended to, so an earlier
    // failure must not decide a later run.
    const slice = readRange(fd, startOffset, size);
    fs.closeSync(fd);
    const log = decodeLog(slice) + extra;

    const verdict = judge({
      timedOut,
      exitCode,
      log,
      expects: options.expect || [],
      extraFailures: options.failOn || [],
      allowTraceback: Boolean(options.allowTraceback),
      kill,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const payload = {
      verdict: verdict.ok ? "ok" : "fail",
      reasons: verdict.reasons,
      warnings: verdict.warnings,
      exit_code: exitCode,
      timed_out: timedOut,
      seconds: Number(seconds),
      journal: journalPath,
      workdir,
      log: logPath,
      nx_root: resolved.root,
      ...(kill ? { killed: kill.killed || [], kill_ok: kill.ok } : {}),
    };
    if (options.json) {
      console.log(JSON.stringify(payload));
    } else {
      if (verdict.ok) {
        say(`OK  ${seconds}s  (${logPath})`);
      } else {
        say(`FAIL ${seconds}s`);
        for (const reason of verdict.reasons) say(`  - ${reason}`);
        if (timedOut) say(`  the run was cut at ${timeoutSec}s; raise it with --timeout`);
        // --quiet means "just the verdict": the log tail is for a human reading
        // the terminal, and the path is already in --json.
        if (!options.quiet) {
          const lines = log.trimEnd().split("\n").slice(-8);
          if (lines.length) {
            say("  last log lines:");
            for (const line of lines) say(`    ${line}`);
          }
          say(`  full log: ${logPath}`);
        }
      }
      for (const warning of verdict.warnings) say(`  warning: ${warning}`);
    }
    return verdict.ok ? 0 : 1;
  };

  return new Promise((resolve) => {
    child.on("error", (err) => {
      extra += `\n[dsh-nx] failed to start: ${err.message}\n`;
      resolve(finish(127));
    });
    child.on("close", async (code, signal) => {
      if (signal && !timedOut) extra += `\n[dsh-nx] killed by ${signal}\n`;
      // taskkill returns before the tree is gone; give it a moment, then look.
      if (timedOut && kill && kill.ok) {
        await new Promise((done) => setTimeout(done, graceSec * 1000));
        try {
          process.kill(child.pid, 0);
          kill.ok = false;
          kill.output = `pid ${child.pid} still alive after ${graceSec}s`;
        } catch {
          // gone, which is the point
        }
      }
      resolve(finish(code === null ? 1 : code));
    });
  });
}

export function parseRunJournalArgs(argv) {
  const options = {
    expect: [],
    failOn: [],
    json: false,
    quiet: false,
    printCommand: false,
    allowTraceback: false,
    kill: true,
    killGrace: 2,
  };
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
    else if (arg === "--log") options.log = next();
    else if (arg === "--expect") options.expect.push(next());
    else if (arg === "--fail-on") options.failOn.push(next());
    else if (arg === "--allow-traceback") options.allowTraceback = true;
    else if (arg === "--no-kill") options.kill = false;
    else if (arg === "--kill-grace") options.killGrace = Number(next());
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
