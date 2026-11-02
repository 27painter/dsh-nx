# dsh-nx

Siemens NX for DeepSeek Harness and Codex.

It ships as a **dsh plugin** — one bundle row whose `apply()` registers an MCP server — plus a
**skill**. The MCP row stays off unless `NX_ENABLE_MCP=1`, because a batch NX holds a licence seat for
as long as it runs; the skill needs no NX at all until it is used.

NX has no automation server a script can attach to — NXOpen is in-process — so anything automated has
to start a batch NX and run a journal inside it. This repository does three things about that: it
ports an existing MIT bridge to NX 12, it executes one journal and tells you whether it worked, and it
optionally keeps a batch NX alive for a set of typed tools.

English | [中文](README.zh.md)

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

Read this before the rest; everything below is scoped by it.

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

Two things make NX automation awkward, and both shape the design:

**NXOpen runs inside NX.** No COM server, no out-of-process handle, no way for an agent to attach to
the NX you have open. The options are "start our own batch NX" or "run the journal by hand"; every
route here takes the first one, which is also why NX is busy while the resident bridge is up.

**NX releases do not share a Python.** 12 embeds CPython 3.6.1, 2406 embeds 3.10, 2506 embeds 3.12.
Code written for the newest release does not run on the oldest, and NX 12 is the one most seats still
have. The port below is written against 3.6.1 and shims forward, so a newer release executes the same
code with the shims inert.

## What is in the box

| path | lines | what it is |
|---|---|---|
| `nxsrc/` | 3,030 (30 files) | the bridge that runs *inside* NX — a port, see [Provenance](#provenance) |
| `nxsrc/nx_mcp/nx_bridge.py` + `bridge.py` | 766 + 872 | the ported core: session, JSON-RPC over loopback, 16 tool implementations |
| `lib/run-journal.mjs` | 408 | the executor: resolve NX, run, judge, kill |
| `lib/probe.py` | 243 | finds every NX install and labels what each one can do |
| `bin/dsh-nx.mjs` | 374 | `install` / `doctor` / `where` / `serve` / `run-journal` / `bridge-start` / `bridge-stop` |
| `lib/capture.mjs` | 74 | runs a child through a file descriptor instead of a pipe |
| `lib/nx-root.mjs` + `lib/paths.mjs` | 77 + 71 | one resolver for "which NX", and the layout defaults |
| `install.ps1` | 155 | venv, the pinned skill, the junctions, `NX_HOME` |
| `examples/` | 3 journals | a smoke test, a part, and a GB A3 drawing of that part |

Original code in `bin/`, `lib/` and `install.ps1`: 1,402 lines.

## Provenance

Three parties. Two are other people's MIT code; the third is this repository.

**The bridge — [`DreamEnding/NX_MCP`](https://github.com/DreamEnding/NX_MCP) at `4a7c8811`.**
Upstream requires Python 3.10+ and ships a C# GUI bridge and a Python batch bridge. This keeps only
the Python one — the C# bridge would need recompiling against NX 12's assemblies, and loading an
unsigned DLL needs an NX Open .NET author licence. Five modules (1,785 lines) were ported to 3.6.1:

- `from __future__ import annotations` removed, then **256 annotations re-quoted** with an AST-offset
  rewriter so they are never evaluated (`str | None` and `dict[str, int]` are 3.10/3.9 syntax). A
  regex would have eaten comments and formatting; this does not.
- A `dataclasses` stand-in for 3.6 that is **a pass-through above 3.7**, because Pydantic inspects
  `__dataclass_fields__` and rejects anything that merely imitates a dataclass.
- `str.isascii()`, `Path.unlink(missing_ok=True)` and the walrus operator replaced at their call
  sites. All three were found by running the tools — none is visible by reading the code.
- The extrude section rewritten: upstream's `CreateRuleCurveFeature([sketch], Null)` fails with NX
  error 650004 on 12 and 2406 alike, so the section is now built by trying four combinations in
  order, each attempt recording which call failed. A failure names the step instead of returning
  "Bridge execution failed".

[`nxsrc/PORT-NOTES.md`](nxsrc/PORT-NOTES.md) records each change with the evidence that prompted it.

**The skill — [`EVOL233awa/nxopen-journal`](https://github.com/EVOL233awa/nxopen-journal) at
`4b77d88` (v1.3.0).** A different author, not this account. Fetched at install time as a zip (so git
is not needed) and junctioned into `~/.dsh/skills` and `~/.codex/skills`; **not vendored**, so you get
their current code and they keep the copyright. Two of its files are patched locally, because it was
written for NX 12 only:

| file | what was wrong | what it does now |
|---|---|---|
| `SKILL.md` | "the journal interpreter is 3.6.1", stated as a fact | lists 3.6.1 / 3.10 / 3.12 per release, and says how to check |
| `scripts/check_journal.py` | flagged `math.dist`, `functools.cache`, `itertools.pairwise` as errors unconditionally | takes a target version (`--python-version`, `--print-python`), defaulting to the 3.6 subset that runs on all three |

Those patches are local and unmerged; they are the only divergence from upstream.

**Everything else** — the executor, the probe, the installer, the MCP row, the examples — is written
here, MIT, no upstream claim.

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

MIT, Copyright (c) 2026 27painter — see [LICENSE](LICENSE).

Two upstreams, one vendored and one fetched at install; what each is, which commit, and exactly what
changed is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
