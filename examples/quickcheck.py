# -*- coding: utf-8 -*-
"""One cube, one number, one verdict — the smallest end-to-end proof this works.

    dsh-nx run-journal examples/quickcheck.py --expect QUICKCHECK_OK -w D:\\nx-work

`smoke.py` proves NX starts and NXOpen imports. This goes one step further: it
builds a 50 mm cube, asks MeasureManager for its volume, and fails the run when
the number is not 125000 mm³. That is the difference between "the process ran"
and "NXOpen actually did geometry" — the claim the whole plugin rests on.

Written to the 3.6 subset, so it runs on NX 12, 2406 and 2506 unchanged.
"""
import os
import sys

import NXOpen
import NXOpen.UF

# run-journal points NX_MCP_WORKSPACE at --workdir; fall back to this file's
# folder when the journal is run by hand.
HERE = os.environ.get("NX_MCP_WORKSPACE") or os.path.dirname(os.path.abspath(__file__))
PART = os.path.join(HERE, "quickcheck.prt")
EDGE = 50.0
EXPECTED_VOLUME = EDGE ** 3


def main():
    session = NXOpen.Session.GetSession()

    if os.path.exists(PART):
        os.remove(PART)

    file_new = session.Parts.FileNew()
    file_new.Units = NXOpen.Part.Units.Millimeters
    file_new.TemplateFileName = "model-plain-1-mm-template.prt"
    file_new.NewFileName = PART
    file_new.UseBlankTemplate = False
    part = file_new.Commit()
    file_new.Destroy()

    block = part.Features.CreateBlockFeatureBuilder(NXOpen.Features.Feature.Null)
    block.SetOriginAndLengths(
        NXOpen.Point3d(0.0, 0.0, 0.0),
        "%.1f" % EDGE,
        "%.1f" % EDGE,
        "%.1f" % EDGE,
    )
    block.CommitFeature()
    block.Destroy()

    body = list(part.Bodies)[0]
    units = [
        part.UnitCollection.FindObject(name)
        for name in ("SquareMilliMeter", "CubicMilliMeter", "Kilogram", "MilliMeter", "Newton")
    ]
    volume = part.MeasureManager.NewMassProperties(units, [0.99], [body]).Volume

    print("CUBE_EDGE=%.1f" % EDGE)
    print("VOLUME=%.3f" % volume)

    if abs(volume - EXPECTED_VOLUME) > 1.0:
        print("QUICKCHECK_FAIL volume %.3f != %.3f" % (volume, EXPECTED_VOLUME))
        sys.exit(1)

    part.Save(
        NXOpen.BasePart.SaveComponents.TrueValue,
        NXOpen.BasePart.CloseAfterSave.FalseValue,
    )
    print("PART=%s" % PART)
    print("QUICKCHECK_OK")


if __name__ == "__main__":
    main()
