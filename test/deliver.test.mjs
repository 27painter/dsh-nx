// The delivery check is the part of this bundle that decides whether a job
// holds up, so it gets its own test: one delivery that should pass, one that
// should not, and an empty folder that must never pass.
//
// No NX and no Python: these are the checks that read bytes.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "dsh-nx.mjs");

function deliver(dir, extra = []) {
  const out = path.join(dir, "delivery.json");
  const res = spawnSync(process.execPath, [CLI, "deliver", dir, "--out", out, ...extra], { encoding: "utf8" });
  let report = null;
  if (fs.existsSync(out)) report = JSON.parse(fs.readFileSync(out, "utf8"));
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, report };
}

function stepFile(target, schema, count, span) {
  const lines = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('part.step','2026-11-18T00:00:00',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    "ENDSEC;",
    "DATA;",
  ];
  for (let i = 1; i <= count; i++) {
    const t = (i / count) * span;
    lines.push(`#${i}=CARTESIAN_POINT('',(${t.toFixed(3)},${(t / 2).toFixed(3)},0.0));`);
  }
  lines.push("ENDSEC;", "END-ISO-10303-21;", "");
  fs.writeFileSync(target, lines.join("\n"), "utf8");
}

// A binary STL spanning 10 x 4 x 0 mm. Thirty triangles, because the size
// floor exists to catch a truncated file and a two-triangle STL is legitimately
// tiny.
function stlFile(target) {
  const triangles = 30;
  const buffer = Buffer.alloc(84 + triangles * 50);
  buffer.write("binary STL test", 0, "ascii");
  buffer.writeUInt32LE(triangles, 80);
  const vertices = [
    [0, 0, 0], [10, 0, 0], [10, 4, 0],
    [0, 0, 0], [10, 4, 0], [0, 4, 0],
  ];
  vertices.forEach((vertex, index) => {
    const base = 84 + Math.floor(index / 3) * 50 + 12 + (index % 3) * 12;
    buffer.writeFloatLE(vertex[0], base);
    buffer.writeFloatLE(vertex[1], base + 4);
    buffer.writeFloatLE(vertex[2], base + 8);
  });
  // repeat the same pair into the remaining slots: only the count matters here
  for (let t = 2; t < triangles; t++) {
    vertices.forEach((vertex, index) => {
      const base = 84 + t * 50 + 12 + (index % 3) * 12;
      buffer.writeFloatLE(vertex[0], base);
      buffer.writeFloatLE(vertex[1], base + 4);
      buffer.writeFloatLE(vertex[2], base + 8);
    });
  }
  fs.writeFileSync(target, buffer);
}

// Minimal PDF whose page dictionary is plain, so the regexes can read it.
function pdfFile(target, widthPt, heightPt) {
  // Padded past the size floor: a hand-written 226-byte PDF is a stub, and the
  // floor exists to catch exactly that.
  const padding = "% " + "x".repeat(1100);
  const body = [
    "%PDF-1.7",
    padding,
    "1 0 obj",
    `<</Type /Page /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources <</Font <</F1 2 0 R>>>>>>`,
    "endobj",
    "2 0 obj",
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    "endobj",
    "trailer",
    "<</Root 1 0 R>>",
    "%%EOF",
    "",
  ].join("\n");
  fs.writeFileSync(target, body, "latin1");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-nx-deliver-"));

// 1. A delivery that holds up.
const good = path.join(root, "good");
fs.mkdirSync(good);
stepFile(path.join(good, "part.step"), "AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }", 300, 100);
stlFile(path.join(good, "part.stl"));
pdfFile(path.join(good, "part.pdf"), 420 / 25.4 * 72, 297 / 25.4 * 72);
const goodRun = deliver(good, ["--require", "step,stl,pdf"]);
assert.equal(goodRun.code, 0, `a complete delivery must pass:\n${goodRun.stdout}${goodRun.stderr}`);
assert.equal(goodRun.report.verdict, "pass");
assert.equal(goodRun.report.counts.failures, 0);
const goodIds = goodRun.report.files.flatMap((file) => file.checks.map((check) => check.id));
for (const id of ["step.schema", "step.bbox", "stl.triangles", "pdf.sheet", "pdf.text"]) {
  assert.ok(goodIds.includes(id), `expected ${id} in ${goodIds}`);
}
assert.ok(
  goodRun.report.files.every((file) => file.sha256 && file.sha256.length === 64),
  "every checked file carries a sha256",
);

// 2. Wrong schema, no geometry, wrong sheet.
const bad = path.join(root, "bad");
fs.mkdirSync(bad);
stepFile(path.join(bad, "flat.step"), "CONFIG_CONTROL_DESIGN", 40, 0);
pdfFile(path.join(bad, "letter.pdf"), 8.5 * 72, 11 * 72);
const badRun = deliver(bad);
assert.equal(badRun.code, 1, "a delivery with no geometry must fail");
const badIds = badRun.report.files.flatMap((file) => file.checks.filter((check) => !check.ok).map((check) => check.id));
assert.ok(badIds.includes("step.entities"), `expected step.entities in ${badIds}`);
assert.ok(badIds.includes("step.bbox"), `expected step.bbox in ${badIds}`);
assert.ok(badIds.includes("pdf.sheet"), `expected pdf.sheet in ${badIds}`);

// 3. An empty folder must never pass.
const empty = path.join(root, "empty");
fs.mkdirSync(empty);
const emptyRun = deliver(empty);
assert.equal(emptyRun.code, 1, "an empty folder must fail");
assert.equal(emptyRun.report.verdict, "fail");

// 4. --require names a kind that is not there.
const partial = path.join(root, "partial");
fs.mkdirSync(partial);
stepFile(path.join(partial, "part.step"), "AUTOMOTIVE_DESIGN", 200, 50);
const required = deliver(partial, ["--require", "pdf"]);
assert.equal(required.code, 1, "--require pdf must fail when there is no PDF");
assert.deepEqual(required.report.missing, ["pdf"]);

fs.rmSync(root, { recursive: true, force: true });
console.log("deliver: 4 cases behave as intended");
