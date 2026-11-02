# -*- coding: utf-8 -*-
# 示例：建模一半。产出 sw_model.prt，b_drawing.py 接着给它出工程图。
# 每步记体数断言，失败不静默。用 dsh-nx run-journal examples\a_model.py 跑。
"""NX2406 journal A: 摇臂/摆臂 零件建模（参照 三维CAD习题集 p7 右图）

结构（单位 mm）：
  摆臂    40 宽（y ±20），x 0..76，高 25（z 0..25）
  凸台    Ø50 圆柱，高 32（z 0..32），Ø30 通孔，孔内键槽 8 宽（槽底距中心 20）
  台阶腔  顶部中间 28 宽（y ±14），底 z=15（深 10），左端沿 Ø50 圆柱面，两角 R6
  孔      2-Ø10 通孔，x=46/64，y=0（从腔底 z=15 钻穿到底 z=0）

建造顺序（避免"工具体伸出目标体"的布尔体数异常）：
  臂块 → 臂上切腔（直壁 x=0） → 并 Ø50 凸台（把 x=0 直壁变成圆柱面）
  → Ø30 通孔 → 键槽 → 2-Ø10 孔 → 腔角 R6
"""
import math
import os
import sys
import traceback

import NXOpen
import NXOpen.UF

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "model.log")
WORK = HERE
PART = os.path.join(WORK, "sw_test.prt")

BOSS_D = 50.0
BOSS_H = 32.0
BORE_D = 30.0
KEY_W = 8.0
KEY_BOTTOM_X = -20.0
ARM_W = 40.0
ARM_END_X = 76.0
ARM_H = 25.0
POCKET_HALF_W = 14.0
POCKET_FLOOR_Z = 15.0
POCKET_FILLET = 6.0
HOLE_D = 10.0
HOLE_XS = (46.0, 64.0)
CORNER_X = math.sqrt((BOSS_D / 2.0) ** 2 - POCKET_HALF_W ** 2)


def say(msg):
    line = str(msg)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    try:
        print(line)
    except Exception:
        pass
    sys.stdout.flush()


def stage(name):
    def deco(fn):
        def wrapper(*a, **kw):
            say("=== STAGE %s ===" % name)
            try:
                return fn(*a, **kw)
            except Exception:
                say("STAGE_%s_FAIL\n%s" % (name, traceback.format_exc()))
                raise
        return wrapper
    return deco


def bodies(part):
    return list(part.Bodies)


def new_part(s, ufs, path):
    if os.path.exists(path):
        os.remove(path)
    fn = s.Parts.FileNew()
    fn.Units = NXOpen.Part.Units.Millimeters
    fn.TemplateFileName = "model-plain-1-mm-template.prt"
    fn.UseBlankTemplate = False
    fn.NewFileName = path
    part = fn.Commit()
    fn.Destroy()
    s.Parts.SetWork(part)
    ufs.Part.SetDisplayPart(part.Tag)
    return part


def main():
    s = NXOpen.Session.GetSession()
    ufs = NXOpen.UF.UFSession.GetUFSession()
    state = {}

    @stage("new_part")
    def s_new():
        part = new_part(s, ufs, PART)
        u = part.UnitCollection.GetBase("Length")
        part.Expressions.CreateSystemExpressionWithUnits("HOLE_D = %.4f" % HOLE_D, u)
        state["part"] = part
        say("PART=%s" % PART)

    @stage("arm_block")
    def s_arm():
        part = state["part"]
        blk = part.Features.CreateBlockFeatureBuilder(NXOpen.Features.Feature.Null)
        blk.SetOriginAndLengths(NXOpen.Point3d(0.0, -ARM_W / 2.0, 0.0),
                                "%.4f" % ARM_END_X, "%.4f" % ARM_W,
                                "%.4f" % ARM_H)
        blk.CommitFeature()
        blk.Destroy()
        say("ARM_OK bodies=%d" % len(bodies(part)))
        state["body"] = bodies(part)[0]

    @stage("pocket_cut")
    def s_pocket():
        part = state["part"]
        blk = part.Features.CreateBlockFeatureBuilder(NXOpen.Features.Feature.Null)
        blk.SetOriginAndLengths(
            NXOpen.Point3d(0.0, -POCKET_HALF_W, POCKET_FLOOR_Z),
            "%.4f" % ARM_END_X, "%.4f" % (2.0 * POCKET_HALF_W),
            "%.4f" % (ARM_H - POCKET_FLOOR_Z))
        blk.SetBooleanOperationAndTarget(
            NXOpen.Features.Feature.BooleanType.Subtract, state["body"])
        blk.CommitFeature()
        blk.Destroy()
        n = len(bodies(part))
        say("POCKET_OK bodies=%d" % n)
        if n != 1:
            raise RuntimeError("pocket cut bodies=%d" % n)
        state["body"] = bodies(part)[0]

    @stage("boss_unite")
    def s_boss():
        part = state["part"]
        cb = part.Features.CreateCylinderBuilder(NXOpen.Features.Feature.Null)
        cb.Type = NXOpen.Features.CylinderBuilder.Types.AxisDiameterAndHeight
        cb.Axis = part.Axes.CreateAxis(
            NXOpen.Point3d(0.0, 0.0, 0.0), NXOpen.Vector3d(0.0, 0.0, 1.0),
            NXOpen.SmartObject.UpdateOption.WithinModeling)
        cb.Diameter.RightHandSide = "%.4f" % BOSS_D
        cb.Height.RightHandSide = "%.4f" % BOSS_H
        before = set(b.Tag for b in part.Bodies)
        cb.CommitFeature()
        cb.Destroy()
        new = [b for b in part.Bodies if b.Tag not in before]
        if len(new) != 1:
            raise RuntimeError("boss cylinder created %d bodies" % len(new))
        boss = new[0]
        bb = part.Features.CreateBooleanBuilder(NXOpen.Features.BooleanFeature.Null)
        bb.Target = state["body"]
        bb.Tool = boss
        bb.Operation = NXOpen.Features.Feature.BooleanType.Unite
        bb.CommitFeature()
        bb.Destroy()
        n = len(bodies(part))
        say("BOSS_UNITE_OK bodies=%d" % n)
        if n != 1:
            raise RuntimeError("boss unite bodies=%d" % n)
        state["body"] = bodies(part)[0]

    @stage("bore")
    def s_bore():
        part = state["part"]
        body = state["body"]
        part.Expressions.CreateSystemExpressionWithUnits(
            "BORE_D = %.4f" % BORE_D, part.UnitCollection.GetBase("Length"))
        top = None
        bottom = None
        for f in body.GetFaces():
            d = ufs.Modeling.AskFaceData(f.Tag)
            if d[0] != 22:
                continue
            if abs(d[2][2] - 1.0) < 0.01 and abs(d[1][2] - BOSS_H) < 0.02 and top is None:
                top = f
            if abs(d[2][2] + 1.0) < 0.01 and abs(d[1][2]) < 0.02 and bottom is None:
                bottom = f
        if top is None or bottom is None:
            raise RuntimeError("bore faces missing")
        hb = part.Features.CreateHoleFeatureBuilder(NXOpen.Features.Feature.Null)
        hb.Subtype = NXOpen.Features.HoleFeatureBuilder.HoleSubtype.Simple
        pt = NXOpen.Point3d(0.0, 0.0, BOSS_H)
        hb.SetSimpleHole(pt, False, top, "BORE_D")
        hb.SetThruFace(bottom)
        hb.HoleLocation = pt
        hb.CommitFeature()
        hb.Destroy()
        say("BORE_OK bodies=%d" % len(bodies(part)))

    @stage("keyway")
    def s_keyway():
        part = state["part"]
        body = bodies(part)[0]
        blk = part.Features.CreateBlockFeatureBuilder(NXOpen.Features.Feature.Null)
        blk.SetOriginAndLengths(
            NXOpen.Point3d(KEY_BOTTOM_X, -KEY_W / 2.0, 0.0),
            "%.4f" % (-KEY_BOTTOM_X), "%.4f" % KEY_W, "%.4f" % BOSS_H)
        blk.SetBooleanOperationAndTarget(
            NXOpen.Features.Feature.BooleanType.Subtract, body)
        blk.CommitFeature()
        blk.Destroy()
        n = len(bodies(part))
        say("KEYWAY_OK bodies=%d" % n)
        if n != 1:
            raise RuntimeError("keyway bodies=%d" % n)
        state["body"] = bodies(part)[0]

    @stage("holes")
    def s_holes():
        part = state["part"]
        body = bodies(part)[0]
        top = None
        bottom = None
        for f in body.GetFaces():
            d = ufs.Modeling.AskFaceData(f.Tag)
            if d[0] != 22:
                continue
            if abs(d[2][2] - 1.0) < 0.01 and abs(d[1][2] - POCKET_FLOOR_Z) < 0.02 and top is None:
                top = f
            if abs(d[2][2] + 1.0) < 0.01 and abs(d[1][2]) < 0.02 and bottom is None:
                bottom = f
        if top is None or bottom is None:
            raise RuntimeError("pocket floor / bottom faces missing")
        for x in HOLE_XS:
            hb = part.Features.CreateHoleFeatureBuilder(NXOpen.Features.Feature.Null)
            hb.Subtype = NXOpen.Features.HoleFeatureBuilder.HoleSubtype.Simple
            pt = NXOpen.Point3d(x, 0.0, POCKET_FLOOR_Z)
            hb.SetSimpleHole(pt, False, top, "HOLE_D")
            hb.SetThruFace(bottom)
            hb.HoleLocation = pt
            hb.CommitFeature()
            hb.Destroy()
            say("HOLE_OK x=%.1f bodies=%d" % (x, len(bodies(part))))
        state["body"] = bodies(part)[0]

    @stage("pocket_fillet")
    def s_fillet():
        part = state["part"]
        body = bodies(part)[0]
        say("EXPECT_CORNER_X=%.3f" % CORNER_X)
        edges = []
        for e in body.GetEdges():
            try:
                p1, p2 = e.GetVertices()
            except Exception:
                continue
            if abs(abs(p1.Y) - POCKET_HALF_W) > 0.05 or abs(abs(p2.Y) - POCKET_HALF_W) > 0.05:
                continue
            if abs(p1.X - p2.X) > 0.05:
                continue
            if abs(abs(p1.X) - CORNER_X) > 0.2:
                continue
            zlo, zhi = min(p1.Z, p2.Z), max(p1.Z, p2.Z)
            if abs(zlo - POCKET_FLOOR_Z) > 0.05 or abs(zhi - ARM_H) > 0.05:
                continue
            edges.append(e)
        say("CORNER_EDGES=%d %s" % (len(edges), [e.Tag for e in edges]))
        if len(edges) != 2:
            raise RuntimeError("pocket corner edges=%d" % len(edges))
        rule = part.ScRuleFactory.CreateRuleEdgeDumb(edges)
        col = part.ScCollectors.CreateCollector()
        col.ReplaceRules([rule], False)
        eb = part.Features.CreateEdgeBlendBuilder(NXOpen.Features.Feature.Null)
        eb.AddChainset(col, "%.4f" % POCKET_FILLET)
        eb.CommitFeature()
        eb.Destroy()
        col.Destroy()
        say("FILLET_R6_OK bodies=%d" % len(bodies(part)))

    @stage("verify")
    def s_verify():
        part = state["part"]
        body = bodies(part)[0]
        r = ufs.ModlGeneral.AskBoundingBox(body.Tag)
        say("BBOX=(%.3f,%.3f,%.3f)-(%.3f,%.3f,%.3f)"
            % (r[0], r[1], r[2], r[3], r[4], r[5]))
        exp = (-BOSS_D / 2.0, -BOSS_D / 2.0, 0.0, ARM_END_X, BOSS_D / 2.0, BOSS_H)
        for got, want in zip((r[0], r[1], r[2], r[3], r[4], r[5]), exp):
            if abs(got - want) > 0.05:
                raise RuntimeError("bbox %.3f != %.3f" % (got, want))
        uc = part.UnitCollection
        units = [uc.FindObject(n) for n in
                 ("SquareMilliMeter", "CubicMilliMeter", "Kilogram",
                  "MilliMeter", "Newton")]
        v = part.MeasureManager.NewMassProperties(units, [0.99], [body]).Volume
        say("VOLUME=%.3f (analytic est. ~76000)" % v)
        rads = {}
        for f in body.GetFaces():
            if f.SolidFaceType != NXOpen.Face.FaceType.Cylindrical:
                continue
            dd = ufs.Modeling.AskFaceData(f.Tag)
            rr = round(abs(dd[4]), 2)
            rads[rr] = rads.get(rr, 0) + 1
        say("CYL_RADII=%s" % sorted(rads.items()))
        for want in (BOSS_D / 2.0, BORE_D / 2.0, HOLE_D / 2.0, POCKET_FILLET):
            if round(want, 2) not in rads:
                say("WARN missing cylindrical face r=%.2f" % want)

    ok = True
    for fn in (s_new, s_arm, s_pocket, s_boss, s_bore, s_keyway, s_holes,
               s_fillet, s_verify):
        try:
            fn()
        except Exception:
            ok = False
            say("ABORT at %s" % fn.__name__)
            break

    if ok:
        ufs.Part.Save()
        size = os.path.getsize(PART) if os.path.exists(PART) else -1
        say("SAVED bytes=%d" % size)
        say("MODEL_DONE")
    else:
        say("MODEL_FAIL")


main()
