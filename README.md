# dsh-nx

English | [中文](README.zh.md)

> Other NX MCP servers tell the agent what to do. **dsh-nx tells it whether it actually worked.**

Drive Siemens NX **12, 2406 and 2506** from a DeepSeek Harness agent. The oldest of the three is the
one no other NX bridge supports: the upstream project requires Python 3.10+ and NX 12 embeds 3.6.1.

NXOpen runs inside NX, so automation means starting a batch NX and running a journal inside it. This
repository is the NX 12 implementation of that: the bridge ported to the interpreter NX 12 actually
ships, an executor that reports whether the journal did what it was asked, and a probe that keeps
three releases apart. Nothing else in this space covers NX 12, because nothing else can.

## What was missing, and what this adds

| capability | before | here |
|---|---|---|
| automate **NX 12** | the upstream bridge requires Python 3.10+; NX 12 embeds 3.6.1, so it does not run | 1,785 lines ported across five modules; NX 12 runs the same 16 tools |
| know whether a run **worked** | `run_journal.exe` returns `0` for a journal that swallowed its own exception | `run-journal`: verdict from the log, process-tree kill on timeout, JSON with the reasons |
| know **which NX** is on the machine | read the registry, or guess | `probe.py`: every install, its interpreter, and a `verified` / `expected` label |
| **install** it | clone, venv, junctions, `NX_HOME`, licence dirs, by hand | `install.ps1` + `doctor`, which names the one thing that is wrong |
| NXOpen knowledge for an agent | a skill pinned to NX 12, with the release baked into the text | the same skill, with the interpreter guidance and API checks following the release |

The first two rows are the reason this exists. The other three are what makes it usable on a real
machine rather than in a demo.

## Installing

NX is neither installed nor modified. `install.ps1` builds a venv for the sidecar, fetches the pinned
skill, and junctions it in.

```powershell
git clone https://github.com/27painter/dsh-nx
cd dsh-nx
npm install -g .            # puts `dsh-nx` on PATH
dsh-nx install              # [1/5] python  [2/5] venv-nx  [3/5] skill  [4/5] NX_HOME  [5/5] junctions
dsh-nx doctor               # read-only; exit 1 when something is missing
```

`dsh-nx install` is a thin wrapper around `install.ps1`; run the script directly to see its output:

```powershell
.\install.ps1
.\install.ps1 -BaseDir "E:\cad" -Force      # different location / rebuild
```

The package is not on npm, so `npm install -g dsh-nx` does not resolve.

### Before you start

- **You do not need to open NX, and opening it does not help.** Every route starts its own batch NX
  through `run_journal.exe`; an NX window you already have open cannot be driven, because NXOpen runs
  inside the process. The window is not reused and not seen.
  This is the opposite of [`dsh-sw-cad`](https://github.com/27painter/dsh-sw-cad), which drives
  AutoCAD and SolidWorks over COM and therefore *does* want the application already open.
- `NX_HOME` should point at the install you mean — `dsh-nx doctor` prints which one it picked and why.
- **A free licence seat.** A batch NX takes one for as long as it runs. Whether an open NX window also
  holds one depends on your licence; if runs stop at `failed to initialize UFUN 948792`, close it and
  retry before suspecting anything else.
- **A writable workdir** (`-w`), since the default is the journal's own folder — read-only when the
  bundle is loaded out of a profile junction.

### The check that matters

A cube, a volume, a verdict. If this prints `OK`, NXOpen did real geometry on this machine — which is
the claim everything else rests on:

```powershell
dsh-nx run-journal examples\quickcheck.py --expect QUICKCHECK_OK -w D:\nx-work
```

```
CUBE_EDGE=50.0
VOLUME=125000.000
QUICKCHECK_OK
[dsh-nx] OK  10.8s
```

It builds a 50 mm block, asks `MeasureManager` for the volume, and fails the run if the number is not
125000 mm³. About 20 s cold (NX has to start) and 11 s warm. `examples/smoke.py` is the same check
without the geometry, for when you only want to know whether NX starts at all.

At this point the **skill** works. The **MCP tools** also need the plugin row below.

### The plugin row

What was done on the development machine: a junction into the profile, a dependency entry, and a
bundle entry. `dsh plugin --profile desktop add link:<path>` is the pnpm equivalent.

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-nx" -Target "D:\path\to\dsh-nx"
```

A plugin reached through a `link:` resolves bare imports from its **real** path, so
`@deepseek-ai/dsh-mcp-client` must be reachable from there or the plugin fails at load:

```powershell
$src = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-mcp-client"
$dst = "D:\path\to\dsh-nx\node_modules\@deepseek-ai\dsh-mcp-client"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
New-Item -ItemType Junction -Path $dst -Target $src
```

Then `"dsh-nx": "link:D:/path/to/dsh-nx"` in `dependencies` and `"dsh-nx"` in `dsh.profile.bundles`.

## Status

Everything below is scoped by this table.

| | state |
|---|---|
| NX 12 (12.0.0.27, CPython 3.6.1) | the 16 tools, the skill and `run-journal` all ran on a real part |
| NX 2406 (2406.1700, CPython 3.10) | same, plus both worked examples end to end |
| NX 2506 (CPython 3.12) | **never run.** Parses and imports under 3.12; the probe labels it `expected`, not `verified` |
| the 16 MCP tools | modelling and export only — **no Drafting**: no view projection, dimension, title block, GB frame or PDF |
| driving an NX window you already have open | **not possible**, by design of NXOpen |
| the package on npm | not published |

If you need a drawing out of NX, that is a journal job whichever route you take — the tools cannot do
it, and this README does not claim otherwise.

## Why it exists

Two constraints shape every decision here:

**NXOpen runs inside NX.** No COM server, no out-of-process handle, no way for an agent to attach to
the NX you have open. The options are "start our own batch NX" or "run the journal by hand"; every
route here takes the first one, which is also why NX is busy while the resident bridge is up.

**NX releases do not share a Python.** 12 embeds CPython 3.6.1, 2406 embeds 3.10, 2506 embeds 3.12.
Upstream targeted the newest of those and left the oldest — the one most seats still have — with no
automation path. The port is written against 3.6.1 and shims forward, so a newer release executes the
same code with the shims inert.

## What is in the box

| path | lines | what it is |
|---|---|---|
| `nxsrc/` | 3,030 (30 files) | the bridge that runs *inside* NX — ported, see [What it builds on](#what-it-builds-on) |
| `nxsrc/nx_mcp/nx_bridge.py` + `bridge.py` | 766 + 872 | the ported core: session, JSON-RPC over loopback, 16 tool implementations |
| `lib/run-journal.mjs` | 408 | the executor: resolve NX, run, judge, kill |
| `lib/probe.py` | 243 | finds every NX install and labels what each one can do |
| `bin/dsh-nx.mjs` | 374 | `install` / `doctor` / `where` / `serve` / `run-journal` / `bridge-start` / `bridge-stop` |
| `lib/capture.mjs` | 74 | runs a child through a file descriptor instead of a pipe |
| `lib/nx-root.mjs` + `lib/paths.mjs` | 77 + 71 | one resolver for "which NX", and the layout defaults |
| `install.ps1` | 155 | venv, the pinned skill, the junctions, `NX_HOME` |
| `examples/` | 4 journals | a volume check, a smoke test, a part, and a GB A3 drawing of that part |

Original code in `bin/`, `lib/` and `install.ps1`: 1,402 lines.

## Three ways to drive NX

| route | mechanism | use it when |
|---|---|---|
| **skill** (default) | the agent writes NXOpen Python; `run-journal` executes it | anything the agent has to compose: modelling, drafting, FEA, motion |
| **`run-journal`** | one journal in, one verdict out | you already have a journal and want to know whether it worked |
| **16 MCP tools** (opt-in) | typed calls against a resident batch NX | many small calls on one part, where the ~60 s cold start would dominate |

The skill is on by default because it holds no NX. The tools are off because booting dsh should not
wait for a CAD application.

```
  agent ──writes──▶ journal.py ──run-journal──▶ run_journal.exe ──▶ batch NX ──▶ .prt / .pdf / .stp
                        │                             │
                        │                             └── verdict from the log, not the exit code
                        └── check_journal.py first (3.6 subset, runs on any release)

  agent ──nx_* tools──▶ dsh-nx plugin ──stdio──▶ sidecar (venv-nx) ──loopback──▶ batch NX
```

## Worked examples

| journal | what it proves | success token |
|---|---|---|
| `examples/quickcheck.py` | NXOpen did geometry: a 50 mm block whose measured volume is 125000 mm³ | `QUICKCHECK_OK` |
| `examples/smoke.py` | the machine can run a journal at all | `SMOKE_OK` |
| `examples/a_model.py` | a full part — boss, bore, keyway, pocket, holes — with body-count assertions per step | `MODEL_DONE` |
| `examples/b_drawing.py` | GB A3 drawing of that part: three views at 2:1, 12 dimensions, frame, title block, PDF | `DRAWING_PRODUCTS_OK` |

```powershell
dsh-nx run-journal examples\quickcheck.py --expect QUICKCHECK_OK -w D:\nx-work
dsh-nx run-journal examples\a_model.py --expect MODEL_DONE -w D:\nx-work
dsh-nx run-journal examples\b_drawing.py --expect DRAWING_PRODUCTS_OK -w D:\nx-work --allow-traceback
```

[`examples/README.md`](examples/README.md) lists what each one needs: a licence seat, a writable
workdir, and for the drawing one, the part from the previous step.

## `run-journal`

```powershell
dsh-nx run-journal .\part.py                       # workdir = the journal's folder
dsh-nx run-journal .\part.py -w .\build -t 900     # explicit workdir and timeout (default 600 s)
dsh-nx run-journal .\part.py --expect DRAWING_OK   # require a token in the output
dsh-nx run-journal .\part.py --allow-traceback     # the journal catches and logs exceptions
dsh-nx run-journal .\part.py --log run1.log        # a different log file
dsh-nx run-journal .\part.py --json                # machine-readable verdict
dsh-nx run-journal .\part.py --no-kill             # on timeout, leave NX running
dsh-nx run-journal .\part.py --kill-grace 5        # seconds the tree gets to die (default 2)
dsh-nx run-journal .\part.py --print-command       # show the command and env, run nothing
```

**Why the verdict is not the exit code.** `run_journal.exe` returns `0` for a journal that caught its
own exception, and `0xC0000409` for a clean shutdown. Neither number means what a caller wants, so the
log decides:

| signal | verdict |
|---|---|
| `General Fault Exception`, `failed to initialize UFUN`, `FATAL ERROR`, `_FAIL`, `BRIDGE_FAIL` | fail |
| traceback **and** a non-clean exit | `uncaught exception (exit N)` — `--allow-traceback` does not forgive this |
| traceback **and** a clean exit | fail by default, **warning** with `--allow-traceback` |
| `--expect TOKEN` not found | fail |
| exit code outside `0` / `0xC0000409` | fail, unless a signal above already did |

The exit code is what separates a crash from a robust journal: a per-step `try/except` that logs and
carries on still ends cleanly, while a journal that stopped on the exception does not.

**On timeout** it runs `taskkill /T /F` on the child's tree — NX spawns helpers, and killing only the
shell leaves `ugraf.exe` holding a licence seat — waits `--kill-grace`, then re-checks the pid. The
JSON carries `killed` and `kill_ok`.

**The log is appended, and only this run's bytes are judged**, so a failed attempt stays on disk
without deciding the next run.

## When it fails

Symptoms seen on this machine, and what they actually mean:

| symptom | actual cause | what to do |
|---|---|---|
| `doctor` says `nx not found` but `NX_HOME` is right | the sandbox cannot read the install, so the interpreter probe never ran | read the line after it — it names the reason; whitelist the paths below |
| a run stops at `failed to initialize UFUN 948792` | NX cannot reach its licence or profile directory | whitelist `C:\ProgramData\Siemens` and `%LOCALAPPDATA%\Siemens\NX<release>`, or set `UGII_USER_PROFILE_DIR` |
| verdict fails with a traceback, but the journal finished | a per-step journal logs tracebacks by design | add `--allow-traceback`, or gate on `--expect` |
| `tools/list` returns nothing | the bridge was started during the MCP handshake, which times out first | `dsh-nx bridge-start` **before** starting dsh |
| the plugin fails to load with `ERR_MODULE_NOT_FOUND` | a `link:` plugin cannot see `@deepseek-ai/dsh-mcp-client` | add the junction under [The plugin row](#the-plugin-row) |
| `doctor` names a copy on disk | the working tree and the installed copy are separate | update the one it names |
| the log is 100 bytes though the journal did plenty | NX buffers stdout when it is not a console | judge on `--expect`, or on the journal's own file log |
| a timeout leaves `ugraf.exe` behind | earlier builds killed only the shell | current versions kill the tree; `--no-kill` is opt-in, not the default |

## What it builds on

Two upstreams, and the line between "used" and "rewritten" is worth being exact about.

**The bridge — [`DreamEnding/NX_MCP`](https://github.com/DreamEnding/NX_MCP) at `4a7c8811`, MIT.**
Upstream requires Python 3.10+ and ships a C# GUI bridge and a Python batch bridge. This keeps only
the Python one, because the C# bridge would need recompiling against NX 12's assemblies and loading an
unsigned DLL needs an NX Open .NET author licence. Five modules — `bridge_journal.py`,
`nx_bridge.py`, `bridge.py`, `runtime.py`, `workspace.py`, 1,785 lines — were ported to 3.6.1:

- `from __future__ import annotations` removed, then **256 annotations re-quoted** with an AST-offset
  rewriter so they are never evaluated (`str | None` and `dict[str, int]` are 3.10/3.9 syntax). A
  regex would have eaten comments and formatting; this does not.
- A `dataclasses` stand-in for 3.6 that is **a pass-through above 3.7**, because Pydantic inspects
  `__dataclass_fields__` and rejects anything that merely imitates a dataclass.
- `str.isascii()`, `Path.unlink(missing_ok=True)` and the walrus operator replaced at their call
  sites. All three were found by running the tools — none is visible by reading the code.
- The extrude section rebuilt: upstream's `CreateRuleCurveFeature([sketch], Null)` fails with NX error
  650004 on 12 and 2406 alike, so the section now tries four combinations in order and records which
  call failed. A failure names the step instead of returning "Bridge execution failed".

[`nxsrc/PORT-NOTES.md`](nxsrc/PORT-NOTES.md) records each change with the evidence that prompted it.

**The skill — [`EVOL233awa/nxopen-journal`](https://github.com/EVOL233awa/nxopen-journal) at
`4b77d88` (v1.3.0), MIT.** A different author, not this account. Fetched at install time as a zip and
junctioned in; not vendored, so you get their current code and they keep the copyright. Two of its
files are patched locally, because it was written for NX 12 only: `SKILL.md` now lists the interpreter
per release instead of stating 3.6.1, and `check_journal.py` takes a target version
(`--python-version`, `--print-python`) instead of flagging 3.8+ APIs unconditionally. Those patches
are local and unmerged.

**Everything else** — the executor, the probe, the installer, the MCP row, the examples — is written
here. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) has the same split with commit hashes and
licence paths.

## How this was tested

| | NX 12.0.0.27 | NX 2406.1700 |
|---|---|---|
| five in-NX modules import | 3.6.1 | 3.10 |
| bridge starts, `nx_status` answers | `connected: true`, `v12` | `connected: true`, `v2406` |
| 16 tools | pass | pass |
| `examples/a_model.py` | — | pass, `.prt` written |
| `examples/b_drawing.py` | — | 17.9 s; `.prt` 204 KB, `.pdf` 48 KB, `.stl` 67 KB |

The verdict logic was checked against four journals on 2406. Each must produce a different answer from
the same code path, or the logic is not doing anything:

| journal | expected | observed |
|---|---|---|
| `examples/smoke.py` | ok | ok, 10.1 s, exit `0xC0000409` treated as clean |
| one that raises | fail | `uncaught exception (exit 1)` |
| one that catches and finishes | fail, then ok | traceback is a reason by default, a warning under `--allow-traceback` |
| one that sleeps past `--timeout 5` | fail | `timeout … killed 4 process(es)`, back in 7.2 s |

To reproduce the first one:

```powershell
dsh-nx run-journal examples\smoke.py --expect SMOKE_OK --json
```

CI needs no NX: the ported sources parse under the 3.6, 3.10 and 3.12 grammars; the five in-NX modules
import and build their dataclasses; the probe reports the right support level for a fake install of
each interpreter.

## Licence

MIT, Copyright (c) 2026 27painter — see [LICENSE](LICENSE). Two upstreams, one vendored and one fetched
at install; [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) records what each is and what changed.
