# -*- coding: utf-8 -*-
"""Start the ported NX bridge inside NX and keep pumping until told to stop.

Works on NX 12 (CPython 3.6.1), NX 2406 (3.10) and NX 2506 (3.12): the modules
below are written for the oldest of those and shim forward.

Run with:  run_journal.exe bridge_journal.py
Environment:
  NX_MCP_WORKSPACE                 workspace directory NX writes into
  NX_MCP_STATE_DIR                 shared dir for bridge.json
  NX_MCP_BRIDGE_STOP_FILE          create this file to stop the loop
  NX_MCP_ALLOW_UNVERIFIED_PYTHON_BRIDGE=1
  NX_MCP_SRC                       path to the ported src/ directory
  NX_MCP_SMOKE_RESULT              where to write this journal's own log
"""
from __future__ import print_function

import io
import os
import sys
import traceback

# Default to this file's own folder: run_journal starts the journal from an
# arbitrary working directory, and a hard-coded path here would make the journal
# work on exactly one machine.
_HERE = os.path.dirname(os.path.abspath(globals().get("__file__") or "."))
SRC = os.environ.get("NX_MCP_SRC", _HERE)
LOG = os.environ.get("NX_MCP_SMOKE_RESULT", os.path.join(_HERE, "bridge-log.txt"))

log = io.open(LOG, "w", encoding="utf-8", buffering=1)


def say(text):
    log.write(text + "\n")
    log.flush()


say("python: %s" % sys.version.replace("\n", " "))
sys.path.insert(0, SRC)

try:
    from nx_mcp.nx_bridge import pump_bridge, start_bridge, stop_bridge

    say("import ok")
    workspace = os.environ["NX_MCP_WORKSPACE"]
    stop_file = os.environ["NX_MCP_BRIDGE_STOP_FILE"]
    descriptor = start_bridge(workspace, allow_unverified_threading=True)
    say("bridge started: port=%s nx_version=%s pid=%s" % (descriptor.port, descriptor.nx_version, descriptor.pid))

    pumped = 0
    while not os.path.exists(stop_file):
        pumped += pump_bridge(0.2)
    say("stop file seen, pumped=%d calls" % pumped)
    stop_bridge()
    say("stopped cleanly")
except Exception:
    say("BRIDGE_FAIL")
    say(traceback.format_exc())
finally:
    log.close()
