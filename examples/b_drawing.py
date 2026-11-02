# -*- coding: utf-8 -*-
# 用法：dsh-nx run-journal examples/b_drawing.py --expect DRAWING_PRODUCTS_OK --allow-traceback
# 需要：先跑 a_model.py 得到 sw_model.prt；NX_HOME + 许可；workdir 可写。
# 产出：sw_test.prt / sw_test.pdf / sw_test.stl；末尾打 DRAWING_PRODUCTS_OK。
# 示例：出图一半。先跑 a_model.py 得到 sw_model.prt，再跑这个。
"""NX2406 journal B: 给 sw_model.prt 出 GB A3 工程图（三视图 + 标注 + 图框 + 标题栏 + PDF）。

步骤：复制模型件 -> 打开 -> GB 预置 -> A3 图框 -> 三视图(2:1) -> 标题栏/技术要求
     -> 标注（Ø50/Ø30/76/40/18/12/8/R6/2-Ø10/32/25/10）-> 中心线 -> PDF -> 保存。
每一步独立 try/except 记日志；出图失败不影响已完成的步骤。
"""
import os
import shutil
import sys
import traceback

import NXOpen
import NXOpen.UF

# 技能目录按环境变量或默认位置解析, 不写死某台机器的路径
SKILL = os.environ.get("NXOPEN_JOURNAL_SKILL", "")
if not SKILL:
    for base in (os.path.join(os.path.expanduser("~"), ".dsh", "skills"),
                 os.path.join(os.path.expanduser("~"), ".codex", "skills")):
        candidate = os.path.join(base, "nxopen-journal")
        if os.path.isdir(candidate):
            SKILL = candidate
            break
if not SKILL or not os.path.isdir(SKILL):
    raise RuntimeError("nxopen-journal skill not found; set NXOPEN_JOURNAL_SKILL")
for p in (os.path.join(SKILL, "scripts"),):
    if p not in sys.path:
        sys.path.insert(0, p)

import gb_drawing as gb
from nxlib.modeling import classify_edges

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "drawing.log")
MODEL = os.path.join(HERE, "sw_model.prt")
PART = os.path.join(HERE, "sw_test.prt")
PDF = os.path.join(HERE, "sw_test.pdf")
STL = os.path.join(HERE, "sw_test.stl")
SCALE = 2.0

BOSS_R = 25.0
BORE_R = 15.0
HOLE_R = 5.0
FILLET_R = 6.0
ARM_HALF = 20.0
POCKET_HALF_W = 14.0
ARM_END_X = 76.0
ARM_H = 25.0
FLOOR_Z = 15.0
KEY_W = 8.0
HOLE_XS = (46.0, 64.0)   # 孔位设计值（全圆边 GetVertices 在 NX2406 返回圆周上一点，不是圆心）


def say(msg):
    line = str(msg)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    try:
        print(line)
    except Exception:
        pass
    sys.stdout.flush()


def step(fn, *a, **kw):
    say("### %s" % fn.__name__)
    try:
        return fn(*a, **kw)
    except Exception:
        say("FAIL_%s\n%s" % (fn.__name__, traceback.format_exc()))
        return None


def main():
    s = NXOpen.Session.GetSession()
    ufs = NXOpen.UF.UFSession.GetUFSession()
    st = {}

    def open_copy():
        if os.path.exists(PART):
            os.remove(PART)
        shutil.copyfile(MODEL, PART)
        part, status = s.Parts.Open(PART)
        ufs.Part.SetDisplayPart(part.Tag)
        s.Parts.SetWork(part)
        st["part"] = part
        st["body"] = list(part.Bodies)[0]
        say("OPEN_OK bodies=%d part=%s" % (len(list(part.Bodies)), PART))
    step(open_copy)

    part = st["part"]
    body = st["body"]

    def prefs():
        say("BLANK_DATUMS=%d" % gb.blank_datums(part))
        gb.apply_gb_preferences(part)
        fid = gb.set_cjk_font(part)
        say("CJK_FONT=%s" % fid)
        st["sheet"] = gb.new_sheet(part, "SHT1", "A3")
        st["frame"] = gb.frame(st["sheet"], "A3")
        f = st["frame"]
        say("FRAME left=%.1f right=%.1f top=%.1f bottom=%.1f"
            % (f["left"], f["right"], f["top"], f["bottom"]))
    step(prefs)
    if "sheet" not in st:
        say("ABORT: sheet not created")
        return

    sheet = st["sheet"]

    def views():
        v = gb.standard_views(part, sheet, body=body, scale=SCALE, gap=30.0,
                              size="A3")
        st.update(v)
        st["mbbox"] = gb.model_bbox(body)
        for k in ("FRONT", "TOP", "RIGHT"):
            cb = gb.content_bbox(v[k], *st["mbbox"])
            say("VIEW %s content=(%.1f,%.1f)-(%.1f,%.1f)" % (k, cb[0], cb[1], cb[2], cb[3]))
    step(views)
    if "TOP" not in st:
        say("ABORT: views not created")
        return

    def furniture():
        tb = gb.title_block(sheet, st["frame"], name=u"摇臂", dwg_no="NX-SW-01",
                            scale_txt=gb.scale_text(SCALE), material=None)
        st["tb"] = tb
        note = gb.tech_note(sheet, tb, [
            u"技术要求：",
            u"1. 未注线性尺寸公差按GB/T 1804-m。",
            u"2. 未注形位公差按GB/T 1184-K。",
            u"3. 键槽宽8，槽底距孔中心20。",
            u"4. 锐边倒钝去毛刺。",
        ])
        say("TB_OK left=%.1f top=%.1f note=%s" % (tb["left"], tb["top"], note is not None))
    step(furniture)

    # ---------------- geometry pickers -------------------------------------
    mbb = st["mbbox"]
    top = st["TOP"]
    front = st["FRONT"]
    right = st["RIGHT"]
    cb_top = gb.content_bbox(top, *mbb)
    cb_front = gb.content_bbox(front, *mbb)
    cb_right = gb.content_bbox(right, *mbb)
    say("CB_TOP=(%.2f,%.2f)-(%.2f,%.2f) CB_FRONT=(%.2f,%.2f)-(%.2f,%.2f) "
        "CB_RIGHT=(%.2f,%.2f)-(%.2f,%.2f)"
        % (cb_top + cb_front + cb_right))

    cyc = classify_edges(body)      # [(r, edge, p1, p2, kind)]

    def circles(radius, kind=None, z=None):
        out = []
        for r, e, p1, p2, k in cyc:
            if abs(r - radius) > 0.05:
                continue
            if kind is not None and k != kind:
                continue
            if z is not None:
                zz = max(p1.Z, p2.Z)
                if abs(zz - z) > 0.05:
                    continue
            out.append((e, p1, p2, k))
        return out

    od_top = circles(BOSS_R, "circle", z=32.0)
    bore_top = circles(BORE_R, "arc", z=32.0)
    holes = circles(HOLE_R, "circle", z=FLOOR_Z)
    fillets = circles(FILLET_R, "arc", z=ARM_H)
    say("OD_TOP=%d BORE_ARC=%d HOLES=%d FILLET_ARCS=%d"
        % (len(od_top), len(bore_top), len(holes), len(fillets)))

    lin = gb.linear_edges(body)     # [(edge, p1, p2)]

    def lines_at_x(x):
        return [(e, p1, p2) for e, p1, p2 in lin
                if abs(p1.X - x) < 0.02 and abs(p2.X - x) < 0.02
                and abs(p1.Y - p2.Y) > 1.0]

    def lines_at_y_along_x(y, z):
        return [(e, p1, p2) for e, p1, p2 in lin
                if abs(p1.Y - y) < 0.02 and abs(p2.Y - y) < 0.02
                and abs(p1.Z - z) < 0.02 and abs(p2.Z - z) < 0.02
                and abs(p1.X - p2.X) > 1.0]

    end_edges = lines_at_x(ARM_END_X)
    say("END_EDGES=%d %s" % (len(end_edges),
                             [(round(a.Y, 1), round(a.Z, 1)) for _e, a, b in end_edges]))

    def pick_end(z):
        cand = [(e, p1, p2) for e, p1, p2 in end_edges if abs(p1.Z - z) < 0.02]
        if not cand:
            raise RuntimeError("no end edge at z=%.1f" % z)
        e, p1, p2 = cand[0]
        return (e, p1.Y, p1.Z), (e, p2.Y, p2.Z)

    def mid_pt(p1, p2):
        return ((p1.X + p2.X) / 2.0, (p1.Y + p2.Y) / 2.0, (p1.Z + p2.Z) / 2.0)

    def end_pt_xy(edge, pt):
        """END_POINT attachment: needs a model point on/near the edge endpoint."""
        v1, v2 = edge.GetVertices()
        best = v1 if (abs(v1.X - pt[0]) + abs(v1.Y - pt[1]) + abs(v1.Z - pt[2])) < \
            (abs(v2.X - pt[0]) + abs(v2.Y - pt[1]) + abs(v2.Z - pt[2])) else v2
        return (best.X, best.Y, best.Z)

    # ---------------- dimensions -------------------------------------------
    lanes = {
        "top_inner": cb_top[1] - gb.LANE_FIRST,
        "top_outer": cb_top[1] - gb.LANE_FIRST - gb.LANE_STEP,
        "top_right": cb_top[2] + gb.LANE_FIRST,
        "top_left": cb_top[0] - gb.LANE_FIRST,        "front_left": cb_front[0] - gb.LANE_FIRST,
        "right_right": cb_right[2] + gb.LANE_FIRST,
    }
    say("LANES=%s" % {k: round(v, 2) for k, v in lanes.items()})
    cx_top = (cb_top[0] + cb_top[2]) / 2.0
    cy_top = (cb_top[1] + cb_top[3]) / 2.0

    def d_od():
        e = od_top[0][0]
        gb.dim_diameter(part, top, e, (0.0, 0.0, 32.0),
                        (cx_top - 34.0, cb_top[3] + 12.0))
        say("DIM_D50_OK")
    step(d_od)

    def d_bore():
        e = bore_top[0][0]
        gb.dim_diameter(part, top, e, (0.0, 0.0, 32.0),
                        (cx_top + 26.0, cb_top[3] + 12.0))
        say("DIM_D30_OK")
    step(d_bore)

    def d_76():
        e_end = lines_at_x(ARM_END_X)[0]
        pt = end_pt_xy(e_end[0], (ARM_END_X, 0.0, ARM_H))
        gb.dim_between(part, top,
                       (bore_top[0][0], "ARC_CENTER", (0.0, 0.0, 32.0)),
                       (e_end[0], "END_POINT", pt),
                       lane_y=lanes["top_outer"])
        say("DIM_76_OK")
    step(d_76)

    def d_40():
        lo = lines_at_y_along_x(-ARM_HALF, ARM_H)
        hi = lines_at_y_along_x(ARM_HALF, ARM_H)
        if not lo or not hi:
            raise RuntimeError("arm side edges missing lo=%d hi=%d" % (len(lo), len(hi)))
        e_lo = lo[0]
        e_hi = hi[0]
        gb.dim_between(part, top,
                       (e_lo[0], "END_POINT", end_pt_xy(e_lo[0], (ARM_END_X, -ARM_HALF, ARM_H))),
                       (e_hi[0], "END_POINT", end_pt_xy(e_hi[0], (ARM_END_X, ARM_HALF, ARM_H))),
                       lane_x=lanes["top_right"], horizontal=False)
        say("DIM_40_OK")
    step(d_40)

    def d_pitch():
        hs = sorted(holes, key=lambda t: t[1].X)
        if len(hs) != 2:
            raise RuntimeError("holes=%d" % len(hs))
        h1, h2 = hs[0], hs[1]
        c1 = (HOLE_XS[0], 0.0, FLOOR_Z)
        c2 = (HOLE_XS[1], 0.0, FLOOR_Z)
        gb.dim_between(part, top,
                       (h1[0], "ARC_CENTER", c1), (h2[0], "ARC_CENTER", c2),
                       lane_y=lanes["top_inner"])
        say("DIM_18_OK h1=%.1f h2=%.1f" % (c1[0], c2[0]))
        e_end = lines_at_x(ARM_END_X)[0]
        pt = end_pt_xy(e_end[0], (ARM_END_X, 0.0, ARM_H))
        gb.dim_between(part, top,
                       (h2[0], "ARC_CENTER", c2),
                       (e_end[0], "END_POINT", pt),
                       lane_y=lanes["top_inner"])
        say("DIM_12_OK")
    step(d_pitch)

    def d_key():
        e_hi = lines_at_y_along_x(KEY_W / 2.0, 32.0)
        e_lo = lines_at_y_along_x(-KEY_W / 2.0, 32.0)
        if not e_hi or not e_lo:
            raise RuntimeError("keyway top edges missing")
        gb.dim_between(part, top,
                       (e_lo[0][0], "END_POINT", end_pt_xy(e_lo[0][0], (-17.0, -KEY_W / 2.0, 32.0))),
                       (e_hi[0][0], "END_POINT", end_pt_xy(e_hi[0][0], (-17.0, KEY_W / 2.0, 32.0))),
                       lane_x=lanes["top_left"], horizontal=False)
        say("DIM_8_OK")
    step(d_key)

    def d_rib6():
        inner = lines_at_y_along_x(POCKET_HALF_W, ARM_H)
        outer = lines_at_y_along_x(ARM_HALF, ARM_H)
        if not inner or not outer:
            raise RuntimeError("rib edges missing inner=%d outer=%d" % (len(inner), len(outer)))
        gb.dim_between(part, top,
                       (inner[0][0], "END_POINT",
                        end_pt_xy(inner[0][0], (ARM_END_X, POCKET_HALF_W, ARM_H))),
                       (outer[0][0], "END_POINT",
                        end_pt_xy(outer[0][0], (ARM_END_X, ARM_HALF, ARM_H))),
                       lane_x=lanes["top_right"] + gb.LANE_STEP, horizontal=False)
        say("DIM_RIB6_OK")
    step(d_rib6)

    def d_hole_label():
        hs = sorted(holes, key=lambda t: t[1].X)
        h1 = hs[0]
        c1 = (HOLE_XS[0], 0.0, FLOOR_Z)
        gb.quantity_label(part, top, h1[0], c1, (cx_top + 46.0, cb_top[3] + 12.0),
                          u"2-<O>10")
        say("LABEL_2xD10_OK")
    step(d_hole_label)

    def d_radius():
        fn = fillets[0]
        e, p1, p2 = fn[0], fn[1], fn[2]
        mid = mid_pt(p1, p2)
        ufs2 = NXOpen.UF.UFSession.GetUFSession()
        xy = gb.map_point(top, mid)
        o = ufs2.Drf.Object()
        ufs2.Drf.InitObjectStructure(o)
        o.ObjectAssocType = NXOpen.UF.Drf.AssocType.ARC_CENTER
        o.ObjectTag = e.Tag
        o.ObjectViewTag = top.Tag
        o.AssocDwgPos = [float(xy[0]), float(xy[1])]
        txt = ufs2.Drf.Text()
        ufs2.Drf.CreateRadiusDim(o, txt, [float(cx_top + 40.0), float(cy_top - 18.0), 0.0])
        say("DIM_R6_OK")
    step(d_radius)

    def d_front32():
        bot = circles(BOSS_R, "arc", z=0.0)
        if not bot:
            raise RuntimeError("boss bottom arc missing")
        gb.dim_between(part, front,
                       (od_top[0][0], "ARC_CENTER", (0.0, 0.0, 32.0)),
                       (bot[0][0], "ARC_CENTER", (0.0, 0.0, 0.0)),
                       lane_x=lanes["front_left"], horizontal=False)
        say("DIM_32_OK (arcs=%d)" % len(bot))
    step(d_front32)

    def d_right_z():
        zmap = {}
        for e, p1, p2 in lines_at_x(ARM_END_X):
            z = round(p1.Z, 2)
            zmap.setdefault(z, (e, p1, p2))
        say("RIGHT_END_ZS=%s" % sorted(zmap.keys()))
        cand = [(e, p1, p2) for e, p1, p2 in lines_at_x(ARM_END_X) if abs(p1.Z - 25.0) < 0.02]
        floor = [(e, p1, p2) for e, p1, p2 in lines_at_x(ARM_END_X) if abs(p1.Z - FLOOR_Z) < 0.02]
        base = [(e, p1, p2) for e, p1, p2 in lines_at_x(ARM_END_X) if abs(p1.Z) < 0.02]
        if not cand or not floor or not base:
            raise RuntimeError("right-end edges missing")
        top_e = cand[0]
        fl_e = floor[0]
        bs_e = base[0]
        gb.dim_between(part, right,
                       (fl_e[0], "END_POINT", end_pt_xy(fl_e[0], (ARM_END_X, 14.0, FLOOR_Z))),
                       (top_e[0], "END_POINT", end_pt_xy(top_e[0], (ARM_END_X, 14.0, ARM_H))),
                       lane_x=lanes["right_right"], horizontal=False)
        say("DIM_10_OK")
        gb.dim_between(part, right,
                       (bs_e[0], "END_POINT", end_pt_xy(bs_e[0], (ARM_END_X, ARM_HALF, 0.0))),
                       (top_e[0], "END_POINT", end_pt_xy(top_e[0], (ARM_END_X, ARM_HALF, ARM_H))),
                       lane_x=lanes["right_right"] + gb.LANE_STEP, horizontal=False)
        say("DIM_25_OK")
    step(d_right_z)

    def centers():
        hs = sorted(holes, key=lambda t: t[1].X)
        cs = [(HOLE_XS[0], 0.0, FLOOR_Z), (HOLE_XS[1], 0.0, FLOOR_Z)]
        keep = set()
        for h, c in zip(hs, cs):
            r = gb.centermark(part, top, h[0], c)
            if r is not None:
                keep.add(int(r.Tag))
        r = gb.centerline_by_points(part, top, hs[0][0], cs[0], hs[1][0], cs[1])
        if r is not None:
            keep.add(int(r.Tag))
        if od_top:
            r = gb.centermark(part, top, od_top[0][0], (0.0, 0.0, 32.0))
            if r is not None:
                keep.add(int(r.Tag))
        # 清理 NX 自动生成的其它中心标记 / 3D 中心线（gb-drawing.md 钉过的坑）
        blanked = 0
        for c in list(part.Annotations.Centerlines):
            if int(c.Tag) in keep:
                continue
            try:
                c.Blank()
                blanked += 1
            except Exception:
                try:
                    c.Delete()
                    blanked += 1
                except Exception as exc:
                    say("CLEAN_FAIL %s %s" % (c.Tag, exc))
        say("CENTERS_OK kept=%s blanked=%d" % (sorted(keep), blanked))
    step(centers)

    def export_pdf():
        gb.export_pdf(part, sheet, PDF)
        say("PDF bytes=%d" % os.path.getsize(PDF))
    step(export_pdf)

    def export_stl():
        sc = s.DexManager.CreateStlCreator()
        sc.OutputFile = STL
        sc.ExportSelectionBlock.SetArray([body])
        sc.ChordalTol = 0.01
        sc.Commit()
        sc.Destroy()
        say("STL bytes=%d" % (os.path.getsize(STL) if os.path.exists(STL) else -1))
    step(export_stl)

    def audit():
        say("ORIENT top_x0=%.1f top_x76=%.1f top_y-25=%.1f front_x0=%.1f right_y0=%.1f"
            % (gb.map_point(top, (0.0, 0.0, 32.0))[0],
               gb.map_point(top, (ARM_END_X, 0.0, 32.0))[0],
               gb.map_point(top, (0.0, -BOSS_R, 32.0))[1],
               gb.map_point(front, (0.0, 0.0, 0.0))[0],
               gb.map_point(right, (ARM_END_X, 0.0, 0.0))[0]))
        for d in part.Dimensions:
            try:
                main, dual = d.GetDimensionText()
                txt = main[0] if main else ""
            except Exception as exc:
                txt = "?%s" % exc
            try:
                size = d.ComputedSize
            except Exception as exc:
                size = -1
            o = d.AnnotationOrigin
            say("AUDIT %-18s size=%8.3f text=%-10r origin=(%.1f,%.1f)"
                % (type(d).__name__, size, txt, o.X, o.Y))
        say("AUDIT_TOTAL dims=%d" % len(list(part.Dimensions)))
    step(audit)

    def save():
        ufs.Part.Save()
        say("SAVED bytes=%d ndims=%d" % (os.path.getsize(PART), len(list(part.Dimensions))))
    step(save)

    def products():
        bad = []
        for path, minimum in ((PART, 50 * 1024), (PDF, 2 * 1024)):
            if not os.path.exists(path) or os.path.getsize(path) < minimum:
                bad.append(os.path.basename(path))
        dims = len(list(part.Dimensions))
        if dims != 12:
            bad.append("dims=%d" % dims)
        if bad:
            say("DRAWING_PRODUCTS_FAIL " + ", ".join(bad))
        else:
            say("DRAWING_PRODUCTS_OK")
    step(products)

    say("DRAWING_DONE")


main()
