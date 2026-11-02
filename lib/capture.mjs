// Running a child process and reading what it said, without a pipe.
//
// `stdio: "pipe"` needs a kernel handle that a sandbox may refuse, and the
// failure is EPERM before the child ever starts — which then looks like "the
// tool found nothing" rather than "the tool could not run". Redirecting to a
// temp file costs one open/read and works under the default policy.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempFile(tag) {
  return path.join(os.tmpdir(), `dsh-nx-${tag}-${process.pid}-${Date.now()}.out`);
}

function readAndDrop(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // a leftover temp file is not worth failing a run over
    }
  }
}

// Synchronous, for probes and one-shot helpers.
export function runCapturedSync(file, args, options = {}) {
  const out = tempFile("cap");
  const fd = fs.openSync(out, "w");
  let result;
  try {
    result = spawnSync(file, args, {
      ...options,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  const text = readAndDrop(out);
  return {
    status: result.status,
    error: result.error || null,
    signal: result.signal || null,
    stdout: text,
    stderr: "",
  };
}

// Asynchronous, for anything that can take a while (NX itself, taskkill on a
// process tree). Resolves with the same shape.
export function runCaptured(file, args, options = {}) {
  return new Promise((resolve) => {
    const out = tempFile("cap");
    const fd = fs.openSync(out, "w");
    const child = spawn(file, args, {
      ...options,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.on("error", (error) => {
      fs.closeSync(fd);
      resolve({ status: null, error, signal: null, stdout: readAndDrop(out), stderr: "" });
    });
    child.on("close", (status, signal) => {
      fs.closeSync(fd);
      resolve({ status, error: null, signal, stdout: readAndDrop(out), stderr: "" });
    });
  });
}
