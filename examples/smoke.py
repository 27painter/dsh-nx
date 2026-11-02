# -*- coding: utf-8 -*-
"""Smallest journal that proves a machine can run one.

    dsh-nx run-journal examples\\smoke.py --expect SMOKE_OK

It imports nothing from NXOpen on purpose: if this fails, the problem is the
install, the licence or the permissions, not the modelling code. Once it passes,
the next step is a journal that imports NXOpen and reports NXOpen_IMPORTED.

Written to the 3.6 subset so it runs on NX 12, 2406 and 2506 unchanged.
"""
import sys


def main():
    print("SMOKE_PY=%s" % sys.version.split()[0])
    try:
        import NXOpen  # noqa: F401

        print("NXOPEN_IMPORTED")
    except Exception as exc:
        print("NXOPEN_IMPORT_FAILED: %s" % exc)
    print("SMOKE_OK")


if __name__ == "__main__":
    main()
