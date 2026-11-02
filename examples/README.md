# Examples

Three journals, in the order they are meant to be run. All of them are written to
the Python 3.6 subset, so they run unchanged on NX 12, 2406 and 2506.

| file | what it proves | success token |
|---|---|---|
| `quickcheck.py` | NXOpen did geometry: builds a 50 mm block and measures 125000 mm³ | `QUICKCHECK_OK` |
| `smoke.py` | the machine can run a journal at all — prints the interpreter, imports `NXOpen` | `SMOKE_OK` |
| `a_model.py` | a full part: boss, bore, keyway, pocket, holes, with body-count assertions per step | `MODEL_DONE` |
| `b_drawing.py` | GB A3 drawing of that part: three views at 2:1, 12 dimensions, frame, title block, PDF | `DRAWING_PRODUCTS_OK` |

```powershell
dsh-nx run-journal examples\quickcheck.py --expect QUICKCHECK_OK -w D:\nx-work
dsh-nx run-journal examples\smoke.py --expect SMOKE_OK
dsh-nx run-journal examples\a_model.py --expect MODEL_DONE -w D:\nx-work
dsh-nx run-journal examples\b_drawing.py --expect DRAWING_PRODUCTS_OK -w D:\nx-work --allow-traceback
```

`quickcheck.py` is the one to run first: it is the only example that fails when the geometry is
wrong rather than when NX fails to start. About 20 s cold, 11 s warm, and its `.prt` lands in
`--workdir` (`NX_MCP_WORKSPACE`), not next to the journal.

## What they need

- `NX_HOME` pointing at the install (or `UGII_BASE_DIR`), and a free licence seat —
  a batch NX takes one for as long as it runs.
- **A writable workdir.** The default is the journal's own folder, which is read-only
  when the bundle is loaded out of a `~/.dsh/profiles` junction. Pass
  `--workdir` somewhere under your own directories:

  ```powershell
  dsh-nx run-journal examples\a_model.py -w D:\nx-work --expect MODEL_DONE
  ```

  (Since v0.2.0 a read-only default falls back to `%TEMP%\dsh-nx-run-<pid>`
  instead of failing, but the parts then land in a folder you did not choose.)
- `b_drawing.py` runs *after* `a_model.py` and needs `sw_model.prt` next to it.
  It also imports the skill (`gb_drawing`, `nxlib`), resolved from
  `NXOPEN_JOURNAL_SKILL` or `~/.dsh/skills/nxopen-journal`.

## Why `--allow-traceback` on the drawing one

The house style for a journal is `try/except` per step plus a traceback in the log,
so a healthy run of a robust journal contains one. `run-journal` fails on a traceback
by default (a silent failure is worse than a false alarm) and downgrades it to a
warning when you say the journal is meant to catch and continue.

## What "products" means

`b_drawing.py` ends with a check, not just a print: the `.prt` over 50 KB, the PDF
over 2 KB, and exactly 12 dimensions. It prints `DRAWING_PRODUCTS_OK` when all three
hold and `DRAWING_PRODUCTS_FAIL <what>` otherwise — so `--expect DRAWING_PRODUCTS_OK`
is a quantitative gate, and `--fail-on DRAWING_PRODUCTS_FAIL` catches the failure
even if you expected something else.

## Running under a sandbox

`run-journal` writes the child's output through a file descriptor rather than a pipe,
which is what lets it start NX under the default policy. NX itself still needs to read
and write outside the workspace:

| path | access | why |
|---|---|---|
| `C:\ProgramData\Siemens` | read | licence data (`siemens_SSQ.dat`) |
| `%LOCALAPPDATA%\Siemens\NX<release>` | read/write | user profile and preferences |
| `<NX_HOME>` | read | the install, `ugiicmd.bat`, `run_journal.exe` |
| `%TEMP%` | read/write | NX's own scratch files |
| `<workdir>` | read/write | parts, log, `.nx-profile`, `.nx-tmp` |

Without the first four the run stops at `failed to initialize UFUN 948792`, which the
verdict reports as a licence/profile problem rather than a broken journal.
