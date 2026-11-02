# dsh-nx

Siemens NX for [dsh](https://github.com/deepseek-ai/dsh) and Codex — NX 12, 2406 and 2506.

| release | interpreter inside NX | status |
|---|---|---|
| NX 12 (12.0.0.27) | CPython 3.6.1 | **verified** — all 16 tools |
| NX 2406 (2406.1700) | CPython 3.10 | **verified** — all 16 tools |
| NX 2506 | CPython 3.12 | same code path, **not yet run** on a real 2506 |

"All 16 tools" covers **modelling and export only**: part, sketch, rectangle, line, finish,
extrude, undo, the three list tools, STEP export, save, close, fit, open. There is no Drafting
tool in that set — no view projection, no dimension, no title block, no GB frame, no PDF. A
drawing job still ends in a journal, whichever route you take; `dsh-nx run-journal` is how you
run that journal with a verdict.

The bridge is written against the *oldest* interpreter (NX 12's 3.6.1) and shims forward, so a newer
release runs the same code with the shims inert — `nx_mcp/_compat.py` explains which branch each
interpreter takes. `dsh-nx doctor` reports the interpreter it found and labels it `verified` or
`expected`, so the table above is never the only thing you have to go on.

Two ways in, and the difference matters:

| | what it is | costs |
|---|---|---|
| **Skill** (default) | the `nxopen-journal` skill: the agent writes NXOpen Python and runs it through `run_journal.exe` | nothing until used; NX opens per task and exits |
| **MCP tools** (opt-in, `NX_ENABLE_MCP=1`) | 16 typed tools — `nx_create_part`, `nx_sketch_rectangle`, `nx_extrude`, `nx_export_step`, … | starts a **batch NX session** that stays up; NX is busy while it lives |

The skill is on by default because it does not hold NX. The tools are off by default because booting dsh should not wait for a CAD application.

## Why this exists

[`DreamEnding/NX_MCP`](https://github.com/DreamEnding/NX_MCP) is the closest thing to an NX MCP server, but it targets NX 2206 (C# GUI bridge) and NX 2506 (Python batch bridge). NX 12 embeds **CPython 3.6.1**, and the code that runs inside NX needs 3.7+/3.8+ features. `nxsrc/` is that project, patched so it imports and runs on 3.6.1 — `nxsrc/PORT-NOTES.md` lists the six changes and the evidence.

The C# GUI bridge is not ported: it would need recompiling against NX 12 assemblies, and loading an unsigned DLL requires an NX Open .NET author licence. NX 12 therefore uses the **batch** bridge only, which is why NX is busy while the tools are registered.

[`EVOL233awa/nxopen-journal`](https://github.com/EVOL233awa/nxopen-journal) is the skill, pinned at `4b77d88` (v1.3.0) — it targets NX 12 exactly, ships 35 regression cases and a static pitfall checker.

## Install

```powershell
npm install -g dsh-nx
dsh-nx install          # venv for the sidecar, the pinned skill, the skill junctions
dsh-nx doctor           # read-only; exits 1 if something is missing
```

`install` creates `venv-nx` (the sidecar needs `mcp>=2.2`, which conflicts with an `mcp 1.x` venv), fetches the skill at the pinned commit, and junctions it into `~/.dsh/skills` and `~/.codex/skills`. It never touches the NX installation and never deletes a venv.

Requires: Windows, NX 12 / 2406 / 2506, Python 3.11+ on PATH. `install` detects the NX root and
sets `NX_HOME` for the current user if it is not set — the skill's own runner needs it and defaults to a
path that exists on almost no machine.

When several releases are installed side by side, `doctor` lists all of them and drives the one
`NX_HOME` (or `UGII_BASE_DIR`) names; with neither set it picks the newest. To switch:

```powershell
$env:NX_HOME = "C:\Program Files\Siemens\NX2506"
dsh-nx doctor
```

### Linking the bundle into a dsh profile

`lib/index.js` imports `@deepseek-ai/dsh-mcp-client`, which dsh provides. Node resolves that import
from the plugin's **real** path, not the profile's — so a profile entry pointing at a folder outside
dsh's tree (e.g. `D:\dsh_plugins\dsh-nx`) fails at load with `ERR_MODULE_NOT_FOUND` unless the plugin
can see it. Give the plugin its own link to dsh's copy:

```powershell
$src = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-mcp-client"
$dst = "D:\dsh_plugins\dsh-nx\node_modules\@deepseek-ai\dsh-mcp-client"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
New-Item -ItemType Junction -Path $dst -Target $src
```

Same version as the dsh that will load it, so nothing is pinned behind dsh's back. Check it with
`node -e "import('dsh-nx').then(m => console.log(Object.keys(m)))"` from the profile folder — it
should print `apply, inject, name`.

## Using the skill

Nothing to do — the skill appears in `~/.dsh/skills` and dsh loads it when a request mentions NX. Say what you want:

```text
用 NX 建一个 120×80×12 的支座，四角 M8 沉头孔，导出三视图。
```

The agent reads `SKILL.md`, routes to the right domain file, writes a journal, checks it with `scripts/check_journal.py`, and runs it. `NX_HOME` must point at your install (`D:\UG` here), which `install` records.

## Running one journal

`run-journal` is for the half of the work the 16 tools do not cover — Drafting, GB frames, PDF —
and for anyone who has a journal in hand and wants a verdict rather than a wall of NX output.

```powershell
dsh-nx run-journal .\part.py                       # workdir = the journal's folder
dsh-nx run-journal .\part.py -w .\build -t 600     # explicit workdir and timeout
dsh-nx run-journal .\part.py --expect DRAWING_OK   # require a token in the output
dsh-nx run-journal .\part.py --json                # machine-readable verdict
dsh-nx run-journal .\part.py --print-command       # show the command and env, run nothing
```

It resolves the NX root (`NX_HOME`, then the recorded layout, then the probe), calls
`UGII\ugiicmd.bat` first so the licence environment is set up, tees the output to
`<workdir>\<journal>.log`, and kills the process tree on timeout.

**The exit code is not the verdict.** NX batch exits `0xC0000409` after a clean journal, and a
journal that swallows its own exception still exits `0`. So the verdict comes from the log —
`Traceback`, `General Fault Exception`, `failed to initialize UFUN`, `NXException`, `_FAIL` — plus
whatever `--expect` / `--fail-on` you add, and the exit code only decides when nothing else did.

`UGII_USER_PROFILE_DIR` and `UGII_TMP_DIR` are pointed at `<workdir>\.nx-profile` and
`<workdir>\.nx-tmp`. NX otherwise writes into `%LOCALAPPDATA%\Siemens` and `%TEMP%`, which is
where an unattended run turns into `General Fault Exception` when those are not writable.

Running it from a sandboxed agent needs three paths outside the workspace:

| path | access | why |
|---|---|---|
| `C:\ProgramData\Siemens` | read | licence data (`siemens_SSQ.dat`) |
| `<NX_HOME>` | read | the install and `ugiicmd.bat` |
| `<workdir>` | read/write | parts, log, `.nx-profile`, `.nx-tmp` |

`examples/smoke.py` is the smallest journal that proves a machine can run one:

```powershell
dsh-nx run-journal examples\smoke.py --expect SMOKE_OK
```

**An NX that is already open cannot be driven.** NXOpen runs in-process, so there is no external
handle into the GUI session — `run-journal` and the bridge both start their own batch NX. If you
want to reuse an open session, the only route is running the journal inside it by hand
(Tools → Journal → Run).

## Using the tools

Two steps, in this order, because a batch NX session takes about a minute to come up — longer
than an MCP client waits for `tools/list`. If the bridge is started during the handshake, the
tools never appear, which is exactly what happened the first time this was wired up.

```powershell
dsh-nx bridge-start        # starts a batch NX session and waits for it
$env:NX_ENABLE_MCP = "1"
dsh --profile web          # the nx row now connects immediately
```

`bridge-start` leaves NX running; `dsh-nx bridge-stop` ends it. NX is busy while the bridge
lives, so do this when you want the agent driving NX, not all day. `serve` refuses to cold-start
for exactly this reason and tells you to run `bridge-start` first.

```
tools/list → 16 tools
nx_status  → {"connected": true, "nx_version": "v12", "bridge_implementation": "python_batch"}
```

Manual control, if you want it without dsh:

```powershell
dsh-nx where            # every path it will use
dsh-nx run-journal .\part.py    # one journal, with a verdict
dsh-nx bridge-start     # start the batch NX session (detached)
dsh-nx serve            # sidecar on stdio, against a running bridge
dsh-nx bridge-stop      # ask the bridge to stop
```

## What is verified

Verified on **NX 12.0.0.27 (Python 3.6.1)** and **NX 2406.1700 (Python 3.10)** on Windows 11:

- the ported modules import inside NX 12's 3.6.1, and `NXOpen` answers (`UGII_VERSION: v12`);
- the bridge starts, authenticates, answers `nx_status` with `connected: true`, and stops cleanly;
- the sidecar lists all 16 tools over stdio and forwards `nx_status`;
- `dsh-nx bridge-start` brings the bridge up detached, `serve` reuses it, and neither leaves an
  orphan process;
- in dsh itself, with the bridge already up, the model called `mcp__nx__nx_status` and got
  `connected: true`.

**All sixteen tools work** on both 12.0.0.27 and 2406.1700: part, sketch, rectangle, line, finish, extrude, undo,
the three list tools, STEP export, save, close, fit and open. `nxsrc/PORT-NOTES.md` records the
3.6/3.9 gaps the runs exposed and the two diagnostics kept from finding them.

**NX 2506 (Python 3.12) is expected, not verified.** What has been checked without the release
installed: every ported module parses under the 3.6, 3.10 and 3.12 grammars, the five in-NX modules
import and build their dataclasses on 3.12, and the probe labels a 3.12 build `expected` rather than
`verified`. What has *not* been checked: an actual NX 2506 session. Nothing in the code branches on
the interpreter, so the risk is in NX's own API rather than in Python — run one part through the
skill and, if it passes, add the release to `VERIFIED_PYTHON` in `lib/probe.py` and to the table at
the top of this file.

`run-journal` is verified on 2406.1700 against three cases, each of which has to produce a different
verdict from the same code path:

| journal | expected | result |
|---|---|---|
| `examples/smoke.py` | ok | `verdict: ok`, 10.1 s, exit `0xC0000409` treated as clean |
| one that raises | fail | `uncaught exception (log contains "Traceback …")`, exit 1 |
| one that sleeps past `--timeout 5` | fail | `timeout: NX did not exit in time`, killed at 5.2 s |

The skill route does not depend on any of this: `run_journal_batch.bat` was verified end to end,
writing a journal result file from a batch NX started with the `NX_HOME` that `install` sets.

The skill route is version-aware too. `SKILL.md` lists the interpreter per release (12 = 3.6.1,
2406 = 3.10, 2506 = 3.12) and `check_journal.py` defaults to the 3.6 subset — the one that runs on
all three — with `--python-version 3.10|3.12` to relax the API checks and `--print-python` to read
the answer out of `NX_HOME`. Those two files are the only local divergence from the pinned
upstream: `install.ps1` skips the skill when `SKILL.md` is already present, so the edits survive
`dsh-nx install`, but deleting the skill directory refetches upstream text and loses them.

## Attribution

- `nxsrc/` is [`DreamEnding/NX_MCP`](https://github.com/DreamEnding/NX_MCP) at `4a7c8811`, MIT, patched for Python 3.6. Licence kept at `nxsrc/LICENSE-DreamEnding-NX_MCP`.
- The skill is [`EVOL233awa/nxopen-journal`](https://github.com/EVOL233awa/nxopen-journal) at `4b77d88`, MIT, fetched at install time — not vendored.
- This package adds the Python 3.6 compatibility layer, the install/lifecycle wrapper, and the opt-in MCP row. MIT.
