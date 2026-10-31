# dsh-nx

Siemens NX 12 for [dsh](https://github.com/deepseek-ai/dsh) and Codex.

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

Requires: Windows, NX 12 (validated on 12.0.0.27), Python 3.11+ on PATH. `install` detects the NX root and
sets `NX_HOME` for the current user if it is not set — the skill's own runner needs it and defaults to a
path that exists on almost no machine.

## Using the skill

Nothing to do — the skill appears in `~/.dsh/skills` and dsh loads it when a request mentions NX. Say what you want:

```text
用 NX 建一个 120×80×12 的支座，四角 M8 沉头孔，导出三视图。
```

The agent reads `SKILL.md`, routes to the right domain file, writes a journal, checks it with `scripts/check_journal.py`, and runs it. `NX_HOME` must point at your install (`D:\UG` here), which `install` records.

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
dsh-nx bridge-start     # start the batch NX session (detached)
dsh-nx serve            # sidecar on stdio, against a running bridge
dsh-nx bridge-stop      # ask the bridge to stop
```

## What is verified

Verified on NX 12.0.0.27 on Windows 11:

- the ported modules import inside NX 12's 3.6.1, and `NXOpen` answers (`UGII_VERSION: v12`);
- the bridge starts, authenticates, answers `nx_status` with `connected: true`, and stops cleanly;
- the sidecar lists all 16 tools over stdio and forwards `nx_status`;
- `dsh-nx bridge-start` brings the bridge up detached, `serve` reuses it, and neither leaves an
  orphan process;
- in dsh itself, with the bridge already up, the model called `mcp__nx__nx_status` and got
  `connected: true`.

**All sixteen tools work** on 12.0.0.27: part, sketch, rectangle, line, finish, extrude, undo,
the three list tools, STEP export, save, close, fit and open. `nxsrc/PORT-NOTES.md` records the
3.6/3.9 gaps the runs exposed and the two diagnostics kept from finding them.

The skill route does not depend on any of this: `run_journal_batch.bat` was verified end to end,
writing a journal result file from a batch NX started with the `NX_HOME` that `install` sets.

## Attribution

- `nxsrc/` is [`DreamEnding/NX_MCP`](https://github.com/DreamEnding/NX_MCP) at `4a7c8811`, MIT, patched for Python 3.6. Licence kept at `nxsrc/LICENSE-DreamEnding-NX_MCP`.
- The skill is [`EVOL233awa/nxopen-journal`](https://github.com/EVOL233awa/nxopen-journal) at `4b77d88`, MIT, fetched at install time — not vendored.
- This package adds the Python 3.6 compatibility layer, the install/lifecycle wrapper, and the opt-in MCP row. MIT.
