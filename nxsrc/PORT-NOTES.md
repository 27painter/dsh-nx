# NX_MCP on Siemens NX 12 — port notes

Fork of [`DreamEnding/NX_MCP`](https://github.com/DreamEnding/NX_MCP) at `4a7c8811` (MIT),
made to run on **NX 12** instead of NX 2206/2506.

The upstream project ships two bridges: a C# GUI bridge (validated on NX 2206) and a Python
batch bridge (validated on NX 2506). NX 12 cannot use the C# one — it would need recompiling
against NX 12's assemblies, and loading an unsigned DLL requires an NX Open .NET author
licence. This fork keeps only the **Python batch bridge** and makes it importable by the
Python 3.6.1 that NX 12 embeds.

## Why a port is needed at all

Measured on the target machine, not assumed:

```
python: 3.6.1 (v3.6.1:69c0db5, Mar 21 2017) [MSC v.1900 64 bit (AMD64)]
UGII_VERSION: v12
```

Upstream declares `requires-python = ">=3.10"`, but that only applies to the sidecar, which
runs outside NX. The code that runs *inside* NX is the journal plus the modules it imports:

```
start_nx_bridge.py → nx_mcp.nx_bridge → nx_mcp.bridge / runtime / workspace
```

Those five modules are the only ones that have to be 3.6-clean. `certified.py`, `contracts.py`,
`evidence.py`, `server.py` and the rest run in the sidecar and stay untouched.

## The six changes

1. **`from __future__ import annotations` removed** from the five in-NX modules. PEP 563 is
   3.7+, and on 3.6 the line is a hard `SyntaxError: future feature annotations is not defined`.

2. **Every annotation quoted** — 256 of them across the five modules (`x: "int"`, `-> "None"`).
   Without the future import the annotations would be evaluated at class/def time, where
   `str | None` and `dict[str, int]` are 3.10/3.9 syntax. As strings they are never evaluated,
   and `__annotations__` still carries the field names that the dataclass shim needs.
   Done with an AST-offset rewriter, not a regex, so comments and formatting survive.

3. **`src/nx_mcp/_compat.py` added** — a `dataclasses` stand-in for 3.6 (the real module is
   3.7+). It implements what this code uses: plain fields, defaults,
   `field(default_factory=...)`, `frozen`, `asdict`, `repr`, `eq`. Two subtleties cost a
   debugging round each and are commented in the file:
   - fields already bound positionally must be skipped by the default pass;
   - `field()` leaves a `_Field` on the *class*, so "already set" must be tested against
     `self.__dict__`, not `hasattr()`.

4. **`str.isascii()` replaced** (3.7+) with `_is_ascii()` in `bridge.py`, two call sites
   (descriptor read, request auth).

5. **`Path.unlink(missing_ok=True)` replaced** (3.8+) with an existence check, two call sites
   (`bridge.py`, `nx_bridge.py`).

6. **Walrus operator removed** in `bridge.py` (`if object_id := ...`), 3.8+.

`typing.Literal` (3.8+) is handled by the same compat module: on 3.6 it becomes a
subscriptable placeholder, which is all `ObjectKind = Literal[...]` needs since the alias is
never evaluated.

## Evidence

Run inside NX 12 with `run_journal.exe`:

```
python: 3.6.1 (v3.6.1:69c0db5, Mar 21 2017, 18:41:36) [MSC v.1900 64 bit (AMD64)]
NXOpen: imported
UGII_VERSION: v12
nx_bridge: imported
nx_version: v12
dataclass shim: ObjectRef(id='obj_smoke', kind='part', name='smoke', part_id='p1')
asdict: {'id': 'obj_smoke', 'kind': 'part', 'name': 'smoke', 'part_id': 'p1'}
SMOKE_OK
```

Then the real bridge, with the host side calling it over the loopback JSON-RPC:

```
bridge started: port=57492 nx_version=v12 pid=1216
nx_status ok=True
{
  "connected": true,
  "nx_version": "v12",
  "bridge_protocol": 1,
  "bridge_implementation": "python_batch",
  "active_part": null,
  "units": null
}
stop file seen, pumped=1 calls
stopped cleanly
```

## What is still unproven

The bridge answers, but no modelling tool has been exercised on NX 12 yet. The 16 certified
tools use a small, old NXOpen surface (`Point`, `Vector`, `Sketch` enums, `BasePart.Close*`,
`Session.Parts`/`UndoToMark`, `ScRuleFactory`, `Bodies`/`Sketches`/`Sections`/`Planes`/
`ModelingViews`), which NX 12 has — but each one needs a run before it can be called working.

Order worth testing: `nx_create_part` → `nx_create_sketch` → `nx_sketch_rectangle` →
`nx_finish_sketch` → `nx_extrude` → `nx_export_step`.

## Running it

```powershell
$env:UGII_BASE_DIR = "D:\UG"
$env:NX_MCP_WORKSPACE = "<workspace>"
$env:NX_MCP_STATE_DIR = "<shared state dir>"
$env:NX_MCP_BRIDGE_STOP_FILE = "<stop flag path>"
$env:NX_MCP_ALLOW_UNVERIFIED_PYTHON_BRIDGE = "1"
$env:NX_MCP_SRC = "<this dir>\src"
D:\UG\NXBIN\run_journal.exe <this dir>\bridge_journal.py
```

The journal blocks in a pump loop; write the stop file to end it. NX exits with
`-1073740791` (0xC0000409) on batch shutdown even after a clean journal — that is NX's own
exit path, not a failure of the bridge.

## Tool results on NX 12.0.0.27

All sixteen tools work. Run through the sidecar over stdio, in the order a real
job would use them:

| tool | result |
|---|---|
| `nx_status` | `connected: true`, `nx_version: v12` |
| `nx_create_part` | ok (0.6 s) |
| `nx_create_sketch` | ok — the `sketch_id` later calls need is `object.id` |
| `nx_sketch_rectangle` / `nx_sketch_line` | ok — points are `{"x": 0, "y": 0}` |
| `nx_finish_sketch` | ok |
| `nx_extrude` | ok — creates one body, feature count 3 → 4 |
| `nx_undo` | ok — undoes the extrude, bodies 1 → 0 |
| `nx_list_sketches` / `nx_list_bodies` / `nx_list_features` | ok |
| `nx_export_step` | ok — 2,230-byte STEP written |
| `nx_save_part` / `nx_close_part` / `nx_fit_view` | ok |
| `nx_open_part` | ok — reopens a saved part, `nx_status` reports it as active |

### Three 3.6/3.9 gaps the tools exposed

None of these were visible from reading the code; each needed a run.

1. `Path.is_relative_to()` is **3.9+** — reached only when a part is created.
   Replaced with `relative_to()` inside `try`.
2. `zip(..., strict=True)` is **3.10+** — broke `nx_sketch_rectangle`.
   Removed; the sequences are equal-length by construction.
3. `str.isascii()` is **3.7+** — broke token validation on shutdown.

### The extrude scare, and what it actually was

For a long stretch `nx_extrude` failed with NX error 650004 and then with
"the input section is not valid". Neither was a porting problem:

- **650004 came from `CreateRuleCurveFeature([sketch.Feature], Null)`.** The
  two-argument rule builder wants a real help point on this build. The
  `CreateRuleCurveDumb(curves)` variant gets all the way to commit, so the
  working path is: `CreateSection()` → `CreateRuleCurveDumb(GetAllGeometry())`
  → `AddToSection` → direction → builder → commit.
- **"The input section is not valid" was the test's fault.** The probe drew a
  rectangle *and* a diagonal line into the same sketch, so the profile was not
  closed. With a rectangle alone the extrude commits and produces one body.

Two changes were kept from that hunt, because they are what made it diagnosable:

- each attempt now records which call failed (`step`), and the error lists all
  four variants instead of only the last one — upstream reports a single opaque
  "Bridge execution failed";
- `NX_MCP_DEBUG_ERRORS=1` on the bridge surfaces the underlying exception,
  which upstream otherwise swallows.

### Two API habits worth knowing

- Every path argument is **relative to `NX_MCP_WORKSPACE`**; an absolute path is
  rejected with `NX_PATH_OUTSIDE_WORKSPACE`.
- `nx_create_part` refuses to overwrite, so re-running a test needs a new
  filename.

## NX 2406

Verified on 2406.1700.0.0: the same `nxsrc/` runs unchanged. NX 2406 embeds
Python 3.10, so every 3.6 workaround here is inert rather than wrong —
`_compat` is a pass-through above 3.7, the quoted annotations are never
evaluated, and the stdlib replacements are backwards compatible.

All sixteen tools pass on 2406 as well. `dsh-nx doctor` now reports the embedded
interpreter and says so, instead of warning that the build is "untested".

## NX 2506

**Not run yet.** NX 2506 embeds CPython 3.12, so it takes the same pass-through
branch 2406 does; nothing in the code switches on the interpreter version, it
switches on what imports.

What was checked without a 2506 install:

- every ported module parses under `feature_version` 3.6, 3.10 **and** 3.12 (CI,
  `check.yml`);
- the five in-NX modules import on 3.12 and 3.13, build their dataclasses and
  `asdict()` them, with `_compat.is_shim()` false — i.e. the real `dataclasses`,
  not the 3.6 stand-in (CI, same file);
- `lib/probe.py` reports a 3.12 build as `expected`, not `verified` (CI builds a
  fake NXBIN tree per interpreter and asserts the label).

Why the Python side is low-risk: the 3.6 workarounds were all *substitutions for
missing features* (`dataclasses`, `isascii`, `Literal`, `unlink(missing_ok)`,
walrus, `zip(strict)`), and every substitute is valid on 3.12. Nothing relies on
behaviour that 3.11/3.12 removed — no `distutils`, no `imp`, no
`asyncio.coroutine`, no `ast.Str`, no `getargspec`.

Where the risk actually is: **NXOpen, not Python.** The 16 tools touch a small,
old API surface (`Point`, `Vector`, `Sketch` enums, `BasePart.Close*`,
`Session.Parts`/`UndoToMark`, `ScRuleFactory`, `Bodies`/`Sketches`/`Sections`),
and `_extrude` already tries four section-builder combinations rather than
assuming one signature — that is what made it survive the 12-vs-2406 difference.
A 2506 change would show up there, as an NX error, not as a Python traceback.

To promote 2506 from `expected` to `verified`: run one part through the skill
(`nx_create_part` → sketch → rectangle → extrude → `nx_export_step`), then add
`"3.12": "NX 2506"` to `VERIFIED_PYTHON` in `lib/probe.py` and update the table at
the top of the README. `NX_MCP_DEBUG_ERRORS=1` surfaces the underlying exception
if a call fails.

## Licence

Upstream is MIT. This fork keeps `LICENSE` and adds only the compatibility layer described
above; no upstream logic was rewritten.
