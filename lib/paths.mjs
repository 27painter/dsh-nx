// Paths this bundle resolves at runtime. Nothing here is absolute in the package.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));

export const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

// Base dir: honour an explicit override, otherwise the first drive that already
// holds the CAD bundle, otherwise D: (C: is the one drive we keep clean).
export function defaultBaseDir() {
  if (process.env.NX_BASE_DIR) return process.env.NX_BASE_DIR;
  const candidates = [];
  for (const drive of ["D:", "E:", "F:"]) {
    candidates.push(path.join(drive, "cad-agents"));
    candidates.push(path.join(drive, "nx-agents"));
  }
  for (const candidate of candidates) {
    if (exists(path.join(candidate, "dsh-skills"))) return candidate;
  }
  return path.join("D:", "cad-agents");
}

export function configPath() {
  const home = os.homedir();
  return path.join(home, ".dsh", "nx.json");
}

export function resolveLayout() {
  let cfg = {};
  const cfgFile = configPath();
  if (exists(cfgFile)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    } catch {
      cfg = {};
    }
  }
  const baseDir = process.env.NX_BASE_DIR || cfg.baseDir || defaultBaseDir();
  const skillDir = path.join(baseDir, "dsh-skills", "nxopen-journal");
  const layout = {
    baseDir,
    skillDir,
    skillFile: path.join(skillDir, "SKILL.md"),
    checkRepo: path.join(skillDir, "scripts", "check_repo.py"),
    dshSkills: path.join(os.homedir(), ".dsh", "skills"),
    codexSkills: path.join(os.homedir(), ".codex", "skills"),
    nxHome: process.env.NX_HOME || process.env.UGII_BASE_DIR || cfg.nxHome || "",
    python: process.env.NX_PYTHON || cfg.python || "python",
    configFile: cfgFile,
  };
  layout.runJournal = layout.nxHome ? path.join(layout.nxHome, "NXBIN", "run_journal.exe") : "";
  return layout;
}

export function missingPieces(layout) {
  const missing = [];
  if (!exists(layout.skillFile)) missing.push(layout.skillFile);
  if (!layout.nxHome) missing.push("NX_HOME / UGII_BASE_DIR is not set");
  else if (!exists(layout.runJournal)) missing.push(layout.runJournal);
  return missing;
}
