# -*- coding: utf-8 -*-
"""Open a part and report what is in it, as one machine-readable line.

`run-journal` answers "did the journal finish". This answers "is the part that
came out of it the part that was asked for". A .prt is a binary only NX can
read, so the reading has to happen inside NX -- this journal is that reader.

    NX_VERIFY_PART=D:\\work\\part.prt   (or: run_journal verify_journal.py -args <path>)

Prints VERIFY_JSON=<one line of JSON>. Everything is wrapped: a measurement
that this NX release does not expose is reported as null, not as a crash, so a
part that opens always produces a report.

Written for the CPython 3.6.1 that NX 12 embeds: no f-strings with '=', no
walrus, no dataclasses.
"""
import json
import os
import sys
import traceback

import NXOpen
import NXOpen.UF


def say(text):
    print(text)
    sys.stdout.flush()


def measure(part, ufs, body):
    """Volume and mass of one body, or None where the API refuses."""
    units = []
    for name in ("SquareMilliMeter", "CubicMilliMeter", "Kilogram", "MilliMeter", "Newton"):
        try:
            units.append(part.UnitCollection.FindObject(name))
        except Exception:
            pass
    try:
        props = part.MeasureManager.NewMassProperties(units, [0.99], [body])
        return float(props.Volume), float(props.Mass)
    except Exception:
        return None, None


def bbox_of(ufs, body):
    try:
        r = ufs.ModlGeneral.AskBoundingBox(body.Tag)
        return [float(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
    except Exception:
        return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else os.environ.get("NX_VERIFY_PART", "")
    if not path:
        say("VERIFY_FAIL no part path (set NX_VERIFY_PART or pass -args <path>)")
        return 1
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        say("VERIFY_FAIL no such file: %s" % path)
        return 1

    session = NXOpen.Session.GetSession()
    ufs = NXOpen.UF.UFSession.GetUFSession()

    # Parts.Open returns (part, load_status) in batch; OpenBaseDisplay is the
    # fallback. Never SetWork after Open -- batch has no displayed part and it
    # raises "No Displayed Part".
    part = None
    for opener in ("open", "open_base"):
        try:
            if opener == "open":
                opened = session.Parts.Open(path)
                part = opened[0] if isinstance(opened, tuple) else opened
            else:
                part = session.Parts.OpenBaseDisplay(path)
        except Exception:
            say("OPEN_%s_FAILED" % opener.upper())
            say(traceback.format_exc(limit=2))
        if part is not None:
            say("OPENED_WITH=%s" % opener)
            break
    if part is None:
        say("VERIFY_FAIL could not open %s" % path)
        return 1
    # Make it the displayed part at the UF level. Without this an opened part
    # is not the work part, and MeasureManager answers 0.0 for everything --
    # which looks exactly like a broken part. Parts.SetWork is not usable here:
    # in batch it raises "No Displayed Part".
    try:
        ufs.Part.SetDisplayPart(part.Tag)
    except Exception:
        say("SET_DISPLAY_PART_FAILED")
        say(traceback.format_exc(limit=2))

    report = {
        "part": path,
        "name": "",
        "bodies": 0,
        "faces": 0,
        "edges": 0,
        "volume": None,
        "mass": None,
        "bbox": None,
        "features": None,
        "sheets": None,
    }

    try:
        report["name"] = part.Leaf
    except Exception:
        pass

    bodies = []
    try:
        bodies = list(part.Bodies)
    except Exception:
        pass
    report["bodies"] = len(bodies)

    volume = 0.0
    mass = 0.0
    volume_ok = True
    boxes = []
    faces = 0
    edges = 0
    for body in bodies:
        v, m = measure(part, ufs, body)
        if v is None:
            volume_ok = False
        else:
            volume += v
            mass += m or 0.0
        box = bbox_of(ufs, body)
        if box:
            boxes.append(box)
        try:
            faces += len(list(body.GetFaces()))
        except Exception:
            pass
        try:
            edges += len(list(body.GetEdges()))
        except Exception:
            pass

    report["faces"] = faces
    report["edges"] = edges
    if volume_ok and bodies:
        report["volume"] = round(volume, 3)
        report["mass"] = round(mass, 6)
    if boxes:
        report["bbox"] = [
            min(b[0] for b in boxes), min(b[1] for b in boxes), min(b[2] for b in boxes),
            max(b[3] for b in boxes), max(b[4] for b in boxes), max(b[5] for b in boxes),
        ]

    try:
        report["features"] = len(list(part.Features))
    except Exception:
        pass

    # Material, fit and finish are usually carried as part attributes or named
    # expressions in NX. Half-delivery reads them from here rather than from
    # the plot, because a .prt can be read and a PDF's text layer cannot be
    # trusted without a PDF library.
    attributes = {}
    try:
        for attribute in part.GetUserAttributes():
            try:
                attributes[attribute.Title] = attribute.StringValue
            except Exception:
                continue
    except Exception:
        pass
    report["attributes"] = attributes

    expressions = {}
    try:
        for expression in part.Expressions:
            try:
                expressions[expression.Name] = str(expression.Value)
            except Exception:
                continue
    except Exception:
        pass
    report["expressions"] = expressions
    try:
        report["sheets"] = len(list(part.Drafting.DrawingSheets))
    except Exception:
        pass

    say("PART=%s" % report["name"])
    say("BODIES=%d FACES=%d EDGES=%d" % (report["bodies"], report["faces"], report["edges"]))
    if report["volume"] is not None:
        say("VOLUME=%.3f  MASS=%.6f" % (report["volume"], report["mass"]))
    if report["bbox"]:
        b = report["bbox"]
        say("BBOX=(%.3f,%.3f,%.3f)-(%.3f,%.3f,%.3f)" % (b[0], b[1], b[2], b[3], b[4], b[5]))
    say("VERIFY_JSON=" + json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    main()
