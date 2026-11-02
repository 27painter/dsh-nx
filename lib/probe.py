# -*- coding: utf-8 -*-
"""Report the Siemens NX install(s) this bundle would drive.

Prints one JSON object. Reads the environment and the install tree only: it does
not start NX and does not touch the registry (reg.exe is not always permitted).

The bridge code is version-agnostic on purpose -- everything it needs from
Python 3.7+ is shimmed in ``nx_mcp/_compat.py`` -- so what this probe reports is
the *interpreter* NX embeds, not the NX release number. A release number only
tells you which interpreter to expect:

    NX 12      CPython 3.6.1
    NX 2406    CPython 3.10
    NX 2506    CPython 3.12
"""
import ctypes
import glob
import json
import os
import sys
from ctypes import wintypes

# Folders that hold one subfolder per NX release. A release installs as
# "NX 12.0", "NX2406", "NX 2506" or "UG NX2406" depending on the installer and
# on what the user typed, so the name is matched by prefix, not by pattern.
SIEMENS_PARENTS = [
    r"C:\Program Files\Siemens",
    r"D:\Program Files\Siemens",
    r"C:\Siemens",
    r"D:\Siemens",
]
# Install roots that are themselves a release, plus the "D:\UG*" habit this
# machine (and the NX documentation) uses.
SIEMENS_GLOBS = [
    r"C:\UG*",
    r"D:\UG*",
    r"E:\UG*",
    r"C:\Program Files\Siemens\NX*",
    r"D:\Program Files\Siemens\NX*",
]

# Interpreter -> the release it was actually exercised on. "expected" is not a
# guess about correctness, it is the honest label for "same code path, no run".
VERIFIED_PYTHON = {
    "3.6": "NX 12.0.0.27",
    "3.10": "NX 2406.1700",
}
SUPPORTED_MIN = (3, 7)
SUPPORTED_MAX = (3, 14)


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


def embedded_python(root):
    """Report the Python NX embeds, e.g. "2.7", "3.6", "3.10", "3.12".

    NX 12 keeps python36.dll under NXBIN\\python; later builds drop python3NN.dll
    straight into NXBIN. Matching the pattern covers both without a version list.
    """
    for folder in (os.path.join(root, "NXBIN", "python"), os.path.join(root, "NXBIN")):
        if not os.path.isdir(folder):
            continue
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in sorted(names):
            low = name.lower()
            if not low.startswith("python") or not low.endswith(".dll"):
                continue
            digits = low[len("python"):-len(".dll")]
            if digits == "27":
                return "2.7"
            if len(digits) == 2 and digits.isdigit():
                return "%s.%s" % (digits[0], digits[1])
            if len(digits) == 3 and digits.isdigit():
                return "%s.%s" % (digits[0], digits[1:])
    return "unknown"


def python_tuple(text):
    try:
        return tuple(int(part) for part in text.split("."))
    except (AttributeError, ValueError):
        return None


def python_at_least(text, minimum):
    parts = python_tuple(text)
    return parts is not None and parts >= minimum


def support_level(python_version):
    """(level, note) for the interpreter NX embeds.

    verified -- the shipped code has been run on a release with this interpreter
    expected -- same code path, nothing run yet on this interpreter
    unsupported -- no NX release is known to embed it, or it is too old
    """
    if python_version in VERIFIED_PYTHON:
        return "verified", "run on %s" % VERIFIED_PYTHON[python_version]
    if python_version == "2.7":
        return "unsupported", "NX 11 and older embed Python 2.7; the bridge is Python 3"
    if python_at_least(python_version, SUPPORTED_MIN) and not python_at_least(
        python_version, SUPPORTED_MAX
    ):
        return "expected", "same code path, no run on this interpreter yet"
    return "unsupported", "no known NX release embeds Python %s" % python_version


def release_of(version):
    """'2406.1700.0.0' -> '2406', '12.0.0.27' -> '12.0'."""
    if not version:
        return None
    parts = version.split(".")
    if parts[0] == "12":
        return ".".join(parts[:2])
    return parts[0]


def probe_root(root):
    if not root or not os.path.isdir(root):
        return None
    run_journal = os.path.join(root, "NXBIN", "run_journal.exe")
    ugraf = os.path.join(root, "NXBIN", "ugraf.exe")
    if not os.path.isfile(run_journal):
        return None
    version = file_version(ugraf) if os.path.isfile(ugraf) else None
    python_version = embedded_python(root)
    level, note = support_level(python_version)
    return {
        "root": os.path.normpath(root),
        "run_journal": run_journal,
        "version": version,
        "release": release_of(version),
        "nxopen_python": python_version,
        "support": level,
        "support_note": note,
    }


def candidate_roots():
    """Environment first, then every release found on disk, de-duplicated."""
    seen = set()
    ordered = []

    def add(candidate):
        if not candidate:
            return
        key = os.path.normpath(candidate).lower()
        if key in seen:
            return
        seen.add(key)
        ordered.append(os.path.normpath(candidate))

    for var in ("UGII_BASE_DIR", "NX_HOME"):
        add(os.environ.get(var))

    for parent in SIEMENS_PARENTS:
        add(parent)
        if not os.path.isdir(parent):
            continue
        try:
            names = os.listdir(parent)
        except OSError:
            continue
        for name in names:
            upper = name.upper()
            if upper.startswith("NX") or upper.startswith("UG"):
                add(os.path.join(parent, name))

    for pattern in SIEMENS_GLOBS:
        for path in glob.glob(pattern):
            add(path)

    return ordered


def version_key(install):
    parts = python_tuple(install.get("version") or "")
    return parts or (0,)


def main():
    roots = candidate_roots()
    found = [install for install in (probe_root(root) for root in roots) if install]

    if not found:
        print(json.dumps({"installed": False, "searched": roots[:6]}))
        return

    # The environment variable wins even when it names an older release: it is
    # the only way to say "use this one" when several are installed.
    env_roots = [
        os.path.normpath(os.environ[var]).lower()
        for var in ("UGII_BASE_DIR", "NX_HOME")
        if os.environ.get(var)
    ]
    chosen = next(
        (item for item in found if item["root"].lower() in env_roots),
        max(found, key=version_key),
    )

    for item in found:
        item["chosen"] = item["root"] == chosen["root"]

    report = dict(chosen)
    report["installed"] = True
    report["is_nx12"] = (chosen["version"] or "").startswith("12.")
    report["supported"] = chosen["support"] != "unsupported"
    report["installations"] = [
        {
            "root": item["root"],
            "version": item["version"],
            "release": item["release"],
            "nxopen_python": item["nxopen_python"],
            "support": item["support"],
            "chosen": item["chosen"],
        }
        for item in sorted(found, key=version_key, reverse=True)
    ]
    print(json.dumps(report))


if __name__ == "__main__":
    sys.exit(main() or 0)
