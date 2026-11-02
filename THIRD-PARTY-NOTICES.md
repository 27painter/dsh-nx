# Third-party notices

`dsh-nx` contains one vendored upstream and one that is fetched at install time. This file records
what each is, which commit, under what terms, and what this repository changed.

## Components

### DreamEnding/NX_MCP — vendored, ported

- Source: <https://github.com/DreamEnding/NX_MCP>
- Commit: `4a7c8811`
- Licence: MIT, reproduced at [`nxsrc/LICENSE-DreamEnding-NX_MCP`](nxsrc/LICENSE-DreamEnding-NX_MCP)
- Where: `nxsrc/`

The Python batch bridge and the modules it imports are copied into `nxsrc/` and ported to CPython
3.6.1, which is what NX 12 embeds. The upstream C# GUI bridge is **not** included: it would need
recompiling against NX 12's assemblies, and loading an unsigned DLL requires an NX Open .NET author
licence.

What changed, and why, is recorded change by change in [`nxsrc/PORT-NOTES.md`](nxsrc/PORT-NOTES.md).
In short: the `from __future__ import annotations` line removed and 256 annotations re-quoted, a
`dataclasses` stand-in for 3.6 that is a pass-through above 3.7, three stdlib calls replaced, and the
extrude section rebuilt to try four section-builder combinations instead of assuming one signature.

No upstream logic was rewritten beyond what those changes require.

### EVOL233awa/nxopen-journal — fetched at install, not redistributed

- Source: <https://github.com/EVOL233awa/nxopen-journal>
- Commit: `4b77d88` (v1.3.0)
- Licence: MIT, held by its author
- Where: fetched by `install.ps1` into `<BaseDir>\dsh-skills\nxopen-journal`, then junctioned into
  `~/.dsh/skills` and `~/.codex/skills`

Not vendored: nothing of it is in this repository, and nothing of it is redistributed. Two of its
files are patched in place after the fetch, because it was written for NX 12 only:

| file | change |
|---|---|
| `SKILL.md` | the interpreter guidance now lists 3.6.1 / 3.10 / 3.12 per release instead of stating 3.6.1 as a fact |
| `scripts/check_journal.py` | the API traps are version-gated (`--python-version`, `--print-python`) instead of unconditional |

Those two patches are local and have not been merged upstream. If the upstream adopts them, the patch
step becomes a no-op rather than a divergence.

## What this repository adds

Everything outside `nxsrc/`: the executor (`lib/run-journal.mjs`), the install probe
(`lib/probe.py`), the CLI and lifecycle (`bin/dsh-nx.mjs`, `install.ps1`), the MCP row
(`lib/index.js`), and the examples. MIT, Copyright (c) 2026 27painter — see [LICENSE](LICENSE).
