# -*- coding: utf-8 -*-
"""Report the Siemens NX install this bundle would drive.

Prints one JSON object. Reads the environment and the install tree only: it does
not start NX and does not touch the registry (reg.exe is not always permitted).
"""
import ctypes
import json
import os
import sys
from ctypes import wintypes

COMMON_ROOTS = [
    r"D:\UG",
    r"C:\Program Files\Siemens\NX 12.0",
    r"D:\Program Files\Siemens\NX 12.0",
    r"C:\Siemens\NX12",
]


def file_version(path):
    """Product version from a PE file, without running it."""
    size = ctypes.windll.version.GetFileVersionInfoSizeW(path, None)
    if not size:
        return None
    buffer = ctypes.create_string_buffer(size)
    if not ctypes.windll.version.GetFileVersionInfoW(path, 0, size, buffer):
        return None
    pointer = ctypes.c_void_p()
    length = wintypes.UINT()
    if not ctypes.windll.version.VerQueryValueW(
        buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)
    ):
        return None
    fixed = ctypes.cast(pointer, ctypes.POINTER(ctypes.c_uint32 * 4)).contents
    ms, ls = fixed[2], fixed[3]
    return "%d.%d.%d.%d" % (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)


def probe_root(root):
    if not root or not os.path.isdir(root):
        return None
    run_journal = os.path.join(root, "NXBIN", "run_journal.exe")
    ugraf = os.path.join(root, "NXBIN", "ugraf.exe")
    py36 = os.path.join(root, "NXBIN", "python", "python36.dll")
    py27 = os.path.join(root, "NXBIN", "python27.dll")
    if not os.path.isfile(run_journal):
        return None
    return {
        "root": root,
        "run_journal": run_journal,
        "version": file_version(ugraf) if os.path.isfile(ugraf) else None,
        "nxopen_python": "3.6" if os.path.isfile(py36) else ("2.7" if os.path.isfile(py27) else "unknown"),
    }


def main():
    roots = []
    for var in ("UGII_BASE_DIR", "NX_HOME"):
        value = os.environ.get(var)
        if value:
            roots.append(value)
    roots.extend(COMMON_ROOTS)

    found = None
    for root in roots:
        found = probe_root(root)
        if found:
            break

    if found is None:
        print(json.dumps({"installed": False, "searched": roots[:4]}))
        return

    version = found["version"] or ""
    found["installed"] = True
    found["is_nx12"] = version.startswith("12.")
    # The skill was written and validated on NX 12; anything else is unproven.
    found["supported"] = found["is_nx12"] and found["nxopen_python"] == "3.6"
    print(json.dumps(found))


if __name__ == "__main__":
    sys.exit(main() or 0)
