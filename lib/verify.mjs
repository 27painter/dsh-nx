// Read a part back out of NX and say whether it is the part that was asked for.
//
// run-journal answers "did the journal finish". This answers the next question,
// and it has to ask NX itself: a .prt is a binary only NX can read. So the
// measurement runs as a journal inside the same batch session, and this module
// only compares numbers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exists, resolveLayout } from "./paths.mjs";
import { runJournal } from "./run-journal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_JOURNAL = path.join(HERE, "verify_journal.py");
const STANDARDS = path.join(HERE, "standards.json");

function say(msg) {
  process.stderr.write(`[dsh-nx] ${msg}\n`);
}

function parseArgs(argv) {
  const options = { expect: {}, tol: 0.01, quiet: false, json: false, out: null, workdir: null, profile: "normal" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--expect-volume") options.expect.volume = Number(next());
    else if (arg === "--expect-mass") options.expect.mass = Number(next());
    else if (arg === "--expect-bodies") options.expect.bodies = Number(next());
    else if (arg === "--expect-bbox") options.expect.bbox = String(next()).split(/[x*×,]/i).map(Number);
    // --tol is a percentage: --tol 1 means ±1%, --tol 0.5 means ±0.5%.
    else if (arg === "--tol") options.tol = (parseFloat(String(next()).replace("%", "")) || 1) / 100;
    else if (arg === "--out") options.out = next();
    else if (arg === "-w" || arg === "--workdir") options.workdir = next();
    else if (arg === "--timeout" || arg === "-t") options.timeout = Number(next());
    else if (arg === "--profile") options.profile = next() === "half" ? "half" : "normal";
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--json") options.json = true;
    else if (!options.part) options.part = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

function readVerifyJson(logPath) {
  if (!exists(logPath)) return null;
  const text = fs.readFileSync(logPath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.includes("VERIFY_JSON="));
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const raw = last.slice(last.indexOf("VERIFY_JSON=") + "VERIFY_JSON=".length).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function near(got, want, tol) {
  if (got === null || got === undefined) return false;
  if (want === 0) return Math.abs(got) <= tol;
  return Math.abs(got - want) / Math.abs(want) <= tol;
}

export async function verifyPart(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    say(err.message);
    return 2;
  }
  if (!options.part) {
    say("verify needs a .prt to open");
    return 2;
  }
  const partPath = path.resolve(options.part);
  if (!exists(partPath)) {
    say(`no such part: ${partPath}`);
    return 2;
  }

  const layout = resolveLayout();
  const workdir = path.resolve(options.workdir || path.dirname(partPath));
  // The journal reads the path from the environment: run_journal.exe takes the
  // journal as its only argument unless -args is used, and an env var survives
  // the cmd.exe hop without quoting games.
  process.env.NX_VERIFY_PART = partPath;

  let payload = null;
  const code = await runJournal(VERIFY_JOURNAL, {
    layout,
    workdir,
    quiet: true,
    timeout: options.timeout,
    expect: ["VERIFY_JSON="],
    onResult: (result) => {
      payload = result;
    },
  });

  const report = payload ? readVerifyJson(payload.log) : null;
  if (!report) {
    say("the journal did not report a part: NX could not open it, or the run failed before measuring");
    if (payload) {
      for (const reason of payload.reasons) say(`  - ${reason}`);
      say(`  log: ${payload.log}`);
    }
    return 1;
  }

  const problems = [];
  const rows = [];
  const tolPct = Math.round(options.tol * 10000) / 100;

  const add = (label, got, want, ok, unit, tolNote = true) => {
    rows.push({ label, got, want, ok, unit });
    if (!ok) {
      const note = tolNote ? ` (±${tolPct}%)` : "";
      problems.push(`${label}: got ${got}${unit}, expected ${want}${unit}${note}`);
    }
  };

  if (options.expect.volume !== undefined) {
    add("volume", report.volume, options.expect.volume, near(report.volume, options.expect.volume, options.tol), " mm³");
  }
  if (options.expect.mass !== undefined) {
    add("mass", report.mass, options.expect.mass, near(report.mass, options.expect.mass, options.tol), " kg");
  }
  if (options.expect.bodies !== undefined) {
    add("bodies", report.bodies, options.expect.bodies, report.bodies === options.expect.bodies, "", false);
  }
  if (options.expect.bbox) {
    const box = report.bbox;
    if (!box) {
      problems.push("bbox: NX did not report one");
    } else {
      const sizes = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
      options.expect.bbox.forEach((want, index) => {
        add(`bbox[${"xyz"[index]}]`, Math.round(sizes[index] * 1000) / 1000, want, near(sizes[index], want, options.tol), " mm");
      });
    }
  }

  // Half-delivery: the material, fits and finish written on the part must come
  // from lib/standards.json. In NX they live as attributes or named expressions,
  // so they are read from the part rather than from the plot.
  if (options.profile === "half") {
    const table = JSON.parse(fs.readFileSync(STANDARDS, "utf8"));
    const grades = Object.entries(table.materials)
      .filter(([group]) => !group.startsWith("_"))
      .flatMap(([, values]) => values);
    const fits = Object.entries(table.fits)
      .filter(([group]) => !group.startsWith("_"))
      .flatMap(([, values]) => values);
    const ra = table.roughness_ra.values.map((value) => String(value));

    const attrs = report.attributes || {};
    const exprs = report.expressions || {};
    // Values only, never expression names: "p10" is not grade 10.
    const valueText = [...Object.values(attrs), ...Object.values(exprs)].map(String).join("\n");
    const bounded = (needle) => new RegExp(`(^|[^0-9A-Za-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9A-Za-z]|$)`);

    const materialAttr = Object.entries(attrs).find(([key]) => /材料|material/i.test(key) && !/^NX_/.test(key));
    const materialSource = materialAttr ? String(materialAttr[1]) : [...Object.values(attrs)].map(String).join("\n");
    const materialHit = grades.find((grade) => bounded(grade).test(materialSource));
    const materialMissing = String(attrs.NX_MaterialMissingAssignments || "").toUpperCase() === "TRUE";

    if (materialHit) {
      rows.push({ label: "material", got: materialHit, want: "-", ok: true, unit: "" });
    } else {
      const detail = materialMissing
        ? "NX reports NX_MaterialMissingAssignments=TRUE: the part has no material assigned"
        : materialAttr
          ? `材料 attribute is ${JSON.stringify(materialAttr[1])}, which is not in lib/standards.json`
          : "no material attribute and no grade from lib/standards.json in the part";
      problems.push(`material: ${detail}`);
    }

    const fitCodes = [...new Set(valueText.match(/[A-Z]{1,2}\d{1,2}\/[a-z]{1,2}\d{1,2}/g) || [])];
    const badFits = fitCodes.filter((code) => !fits.includes(code));
    if (badFits.length) problems.push(`fit: not in the table: ${badFits.join(", ")}`);
    else rows.push({ label: "fit", got: fitCodes.join(", ") || "none", want: "-", ok: true, unit: "" });

    const raValues = [...new Set(valueText.match(/Ra\s*([0-9]+(?:\.[0-9]+)?)/gi) || [])].map((hit) => hit.replace(/Ra\s*/i, ""));
    if (!raValues.length) {
      problems.push("roughness: no Ra value on the part; a half-delivery part states surface finish");
    } else {
      const badRa = raValues.filter((value) => !ra.includes(value));
      if (badRa.length) problems.push(`roughness: Ra ${badRa.join(", ")} not in the preferred series`);
      else rows.push({ label: "roughness", got: `Ra ${raValues.join(", ")}`, want: "-", ok: true, unit: "" });
    }
  }

  const out = options.out ? path.resolve(options.out) : path.join(workdir, `${path.basename(partPath, path.extname(partPath))}.verify.json`);
  const record = {
    part: partPath,
    verdict: problems.length ? "fail" : "pass",
    profile: options.profile,
    not_checked: options.profile === "half" ? ["审签（设计/校对/审核/批准）", "尺寸链闭合", "零件可加工性"] : [],
    tolerance: options.tol,
    measured: report,
    expected: options.expect,
    problems,
    seconds: payload ? payload.seconds : null,
    log: payload ? payload.log : null,
    nx_root: payload ? payload.nx_root : null,
  };
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n", "utf8");

  if (!options.quiet) {
    console.log(`${report.name || path.basename(partPath)}  bodies ${report.bodies}, faces ${report.faces}, edges ${report.edges}`);
    if (report.volume !== null) console.log(`  volume ${report.volume} mm³   mass ${report.mass} kg`);
    if (report.bbox) {
      const b = report.bbox;
      console.log(`  bbox   ${(b[3] - b[0]).toFixed(2)} x ${(b[4] - b[1]).toFixed(2)} x ${(b[5] - b[2]).toFixed(2)} mm`);
    }
    for (const row of rows) {
      console.log(`  ${row.ok ? "ok  " : "FAIL"} ${row.label.padEnd(10)} ${row.got}${row.unit}${row.ok ? "" : `  (expected ${row.want}${row.unit})`}`);
    }
    for (const problem of problems) say(`  - ${problem}`);
  }
  console.log(`${problems.length ? "FAIL" : "OK"}  ${payload ? payload.seconds : "?"}s  -> ${out}`);
  if (options.json) console.log(JSON.stringify(record));

  return problems.length ? 1 : 0;
}
