// Check what a job left behind, without starting NX.
//
// `verify` opens the part inside NX, which is the only way to read a .prt.
// This is the cheaper half: the exchange files and the plot, checked from the
// bytes. A .prt that is present but never verified is reported as such rather
// than assumed good.
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

import { exists } from "./paths.mjs";

const KINDS = {
  ".step": "step",
  ".stp": "step",
  ".stl": "stl",
  ".pdf": "pdf",
  ".prt": "part",
  ".dxf": "drawing",
};

const MIN_BYTES = { step: 1024, stl: 1024, pdf: 1024, part: 10240, drawing: 2048 };

// ISO 216, portrait width x height in mm.
const SHEETS = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };

const SCHEMAS = [
  ["AP242", /ap242|managed_model_based_3d_engineering/i],
  ["AP214", /automotive_design/i],
  ["AP203", /config_control_design/i],
];

function say(msg) {
  process.stderr.write(`[dsh-nx] ${msg}\n`);
}

function check(id, ok, detail, severity = "error") {
  return { id, ok: Boolean(ok), detail, severity };
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function checkStep(file, bytes) {
  const head = bytes.subarray(0, 16384).toString("utf8");
  const schemaLine = (head.split(/\r?\n/).find((line) => /FILE_SCHEMA/i.test(line)) || "").trim();
  const schema = SCHEMAS.find(([, pattern]) => pattern.test(schemaLine));
  const text = bytes.toString("utf8");
  const entities = (text.match(/^#\d+=/gm) || []).length;
  const points = [...text.matchAll(/CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-0-9.eE+]+)\s*,\s*([-0-9.eE+]+)\s*,\s*([-0-9.eE+]+)/g)];
  const checks = [
    check("step.schema", Boolean(schema), schema ? `${schema[0]}  [${schemaLine.slice(0, 60)}]` : `unrecognised FILE_SCHEMA: ${schemaLine.slice(0, 80) || "missing"}`),
    check("step.entities", entities > 100, `${entities} entities, ${points.length} CARTESIAN_POINTs`),
  ];
  if (schema && schema[0] === "AP203") {
    checks.push(check("step.pmi", false, "AP203 drops colour and assembly structure; use AP214 or AP242", "warning"));
  }
  if (points.length) {
    const axis = (index) => points.map((match) => Number(match[index + 1]));
    const sizes = [0, 1, 2].map((index) => {
      const values = axis(index);
      return Math.max(...values) - Math.min(...values);
    });
    const degenerate = Math.max(...sizes) <= 1e-6;
    checks.push(
      check("step.bbox", !degenerate, degenerate ? "every point sits at the same place: no geometry" : `bounding box ${sizes.map((n) => n.toFixed(3)).join(" x ")} (from raw points)`),
    );
  } else {
    checks.push(check("step.bbox", false, "no CARTESIAN_POINT coordinates could be read", "warning"));
  }
  return checks;
}

function checkStl(file, bytes) {
  const ascii = bytes.subarray(0, 5).toString("ascii").toLowerCase() === "solid";
  let triangles = 0;
  const xs = [];
  const ys = [];
  const zs = [];
  if (ascii) {
    const text = bytes.toString("utf8");
    triangles = (text.match(/facet\s+normal/gi) || []).length;
    for (const match of text.matchAll(/vertex\s+([-0-9.eE+]+)\s+([-0-9.eE+]+)\s+([-0-9.eE+]+)/g)) {
      xs.push(Number(match[1]));
      ys.push(Number(match[2]));
      zs.push(Number(match[3]));
    }
  } else if (bytes.length >= 84) {
    triangles = bytes.readUInt32LE(80);
    const stride = 50;
    for (let offset = 84, i = 0; i < triangles && offset + stride <= bytes.length; i++, offset += stride) {
      for (let v = 0; v < 3; v++) {
        xs.push(bytes.readFloatLE(offset + 12 + v * 12));
        ys.push(bytes.readFloatLE(offset + 16 + v * 12));
        zs.push(bytes.readFloatLE(offset + 20 + v * 12));
      }
    }
  }
  const checks = [
    check("stl.parsed", true, ascii ? "ASCII STL" : "binary STL"),
    check("stl.triangles", triangles > 0, `${triangles} triangle(s)`),
  ];
  if (xs.length) {
    const sizes = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)];
    const degenerate = Math.max(...sizes) <= 1e-6;
    checks.push(check("stl.bbox", !degenerate, degenerate ? "all vertices coincide" : `bounding box ${sizes.map((n) => n.toFixed(2)).join(" x ")}`));
  }
  return checks;
}

// Page dictionaries live inside FlateDecode streams in anything newer than
// PDF 1.4, so searching the raw bytes finds nothing and reports a good file as
// unreadable. Inflating the streams costs one pass and no dependency.
function inflateStreams(bytes) {
  const raw = bytes.toString("latin1");
  const parts = [];
  const pattern = /stream\r?\n/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const chunk = bytes.subarray(start, end);
    try {
      parts.push(zlib.inflateSync(chunk).toString("latin1"));
    } catch {
      // not a zlib stream (image, or already plain) -- skip it
    }
  }
  return parts.join("\n");
}

function checkPdf(file, bytes) {
  const head = bytes.subarray(0, 8).toString("ascii");
  const rawText = bytes.toString("latin1");
  const text = rawText + "\n" + inflateStreams(bytes);
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const box = text.match(/\/MediaBox\s*\[\s*([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s+([-0-9.]+)\s*\]/);
  const checks = [check("pdf.header", head.startsWith("%PDF"), `${head.trim()}  ${pages} page(s)`)];

  if (box) {
    const width = (Number(box[3]) - Number(box[1])) * 25.4 / 72;
    const height = (Number(box[4]) - Number(box[2])) * 25.4 / 72;
    const [short, long] = [width, height].sort((a, b) => a - b);
    const sheet = Object.entries(SHEETS).find(([, [w, h]]) => Math.abs(short - w) <= 2 && Math.abs(long - h) <= 2);
    checks.push(check("pdf.sheet", Boolean(sheet), `${short.toFixed(0)} x ${long.toFixed(0)} mm (${sheet ? sheet[0] : "not ISO A"})`));
  } else {
    checks.push(check("pdf.sheet", false, "no /MediaBox; the sheet size is unknown", "warning"));
  }

  // A text layer leaves font objects behind; a plot exported as an image does
  // not. It is a proxy, not proof -- PyMuPDF would settle it, and this runs
  // without it on purpose.
  const fonts = /\/Font/.test(text);
  checks.push(
    check("pdf.text", fonts, fonts ? "font objects present (text layer likely)" : "no /Font object: dimensions are probably pixels", "warning"),
  );
  return checks;
}

function checkPart(file, bytes) {
  return [
    check("part.present", bytes.length >= MIN_BYTES.part, `${bytes.length} bytes`),
    check("part.unverified", true, "geometry not read: run `dsh-nx verify` to measure it", "warning"),
  ];
}

function classify(file) {
  const ext = path.extname(file).toLowerCase();
  return KINDS[ext] || null;
}

function collect(targets) {
  const files = [];
  for (const target of targets) {
    if (!exists(target)) throw new Error(`nothing at ${target}`);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) {
        const full = path.join(target, name);
        if (fs.statSync(full).isFile()) files.push(full);
      }
    } else {
      files.push(target);
    }
  }
  return [...new Set(files)].sort();
}

export function deliver(argv) {
  const targets = [];
  let out = null;
  let require = [];
  let json = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out = argv[++i];
    else if (arg === "--require") require = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--json") json = true;
    else if (arg === "--quiet") quiet = true;
    else targets.push(arg);
  }
  if (!targets.length) {
    say("deliver needs a folder or file");
    return 2;
  }

  let files;
  try {
    files = collect(targets);
  } catch (err) {
    say(err.message);
    return 2;
  }

  const entries = [];
  for (const file of files) {
    const kind = classify(file);
    if (!kind) continue;
    const bytes = fs.readFileSync(file);
    const checks = [check("file.size", bytes.length >= (MIN_BYTES[kind] || 1), `${bytes.length} bytes`)];
    try {
      if (kind === "step") checks.push(...checkStep(file, bytes));
      else if (kind === "stl") checks.push(...checkStl(file, bytes));
      else if (kind === "pdf") checks.push(...checkPdf(file, bytes));
      else if (kind === "part") checks.push(...checkPart(file, bytes));
      else checks.push(check("drawing.unchecked", false, "DXF needs ezdxf; not checked here", "warning"));
    } catch (err) {
      checks.push(check("check.crashed", false, err.message));
    }
    entries.push({
      path: path.resolve(file),
      kind,
      bytes: bytes.length,
      sha256: sha256(bytes),
      checks,
    });
  }

  const present = new Set(entries.map((entry) => entry.kind));
  const missing = require.filter((kind) => !present.has(kind));
  const failures = [];
  const warnings = [];
  for (const entry of entries) {
    for (const item of entry.checks) {
      if (item.ok) continue;
      (item.severity === "warning" ? warnings : failures).push({ path: entry.path, ...item });
    }
  }
  for (const kind of missing) failures.push({ path: "(delivery)", id: `required.${kind}`, detail: `no ${kind} in the delivery`, severity: "error" });
  if (!entries.length) failures.push({ path: "(delivery)", id: "delivery.empty", detail: "no drawing, PDF, STEP, STL or part in the target", severity: "error" });

  const verdict = failures.length ? "fail" : "pass";
  const record = {
    generated: new Date().toISOString(),
    targets: targets.map((t) => path.resolve(t)),
    verdict,
    required: require,
    missing,
    counts: { files: entries.length, failures: failures.length, warnings: warnings.length },
    files: entries,
  };
  const target = out ? path.resolve(out) : path.join(path.dirname(path.resolve(targets[0])), "delivery.json");
  fs.writeFileSync(target, JSON.stringify(record, null, 2) + "\n", "utf8");

  if (!quiet) {
    for (const entry of entries) {
      console.log(`${entry.kind.padEnd(7)} ${path.basename(entry.path)}  ${entry.bytes} B`);
      for (const item of entry.checks) {
        const mark = item.ok ? "ok  " : item.severity === "warning" ? "warn" : "FAIL";
        console.log(`  ${mark} ${item.id.padEnd(18)} ${item.detail}`);
      }
    }
    if (missing.length) console.log(`\nmissing: ${missing.join(", ")}`);
  }
  console.log(`verdict: ${verdict}  (${failures.length} failure(s), ${warnings.length} warning(s))  -> ${target}`);
  if (json) console.log(JSON.stringify(record));
  return failures.length ? 1 : 0;
}
