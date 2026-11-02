// One place that answers "which NX will this run against".
//
// There used to be two: `doctor` had its own probe call and `run-journal` had
// another, so a shell where one said "not found" and the other resolved a root
// was possible — and reported. Both now go through here.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCapturedSync } from "./capture.mjs";
import { exists } from "./paths.mjs";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

export function pythonFor(layout) {
  const venv = path.join(layout.baseDir, "venv-nx", "Scripts", "python.exe");
  return exists(venv) ? venv : layout.python;
}

// The probe reads the install tree, so it needs an interpreter — but its output
// goes to a temp file, not a pipe: under a sandbox a pipe is refused before the
// probe starts, and the caller would read that as "NX is not installed".
export function probeNxResult(layout) {
  const script = path.join(LIB_DIR, "probe.py");
  const res = runCapturedSync(pythonFor(layout), [script], { timeout: 30000 });
  if (res.error) return { nx: null, error: res.error.code || res.error.message || "probe could not start" };
  const text = res.stdout.trim();
  if (!text) return { nx: null, error: `probe printed nothing (exit ${res.status})` };
  try {
    return { nx: JSON.parse(text.split("\n").pop()), error: null };
  } catch {
    return { nx: null, error: "probe output was not JSON" };
  }
}

export function probeNx(layout) {
  return probeNxResult(layout).nx;
}

// An explicit NX_HOME wins over the probe's "highest version" guess: with two
// releases installed, the one the user named is the one they meant.
export function resolveNxRoot(layout, nx) {
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

// A bare "not found" is misleading when NX_HOME is set and correct: the usual
// cause is that this process cannot stat the install (a sandbox), not that the
// install is absent.
export function explainMissingNx(layout, nx) {
  const envRoot = process.env.NX_HOME || process.env.UGII_BASE_DIR;
  if (envRoot) {
    const exe = path.join(envRoot, "NXBIN", "run_journal.exe");
    if (!exists(envRoot)) {
      return `${envRoot} (from NX_HOME) does not exist or is not readable from this process`;
    }
    if (!exists(exe)) {
      return `NX_HOME is ${envRoot}, but ${exe} is missing`;
    }
    return `NX_HOME is ${envRoot}, but run_journal.exe is not reachable`;
  }
  if (layout.nxHome) {
    return `the recorded install ${layout.nxHome} has no NXBIN\\run_journal.exe`;
  }
  if (nx && nx.installed === false) {
    return "no NX install found; set NX_HOME to the folder holding NXBIN";
  }
  return "no NX install found (set NX_HOME), and the probe could not run";
}
