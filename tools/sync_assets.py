#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从《京韵大富翁·胡同漫游记》文档库同步最新素材与 gamedata.json。

为什么用 unicode 转义写源路径：
    本项目文档库路径含「人」字（@西北人的成长）。本项目工具链在这一路径上
    有过「人 -> の」的渲染陷阱，因此源根目录一律用 \\uXXXX 转义构造，
    避免写操作把路径写歪。子目录名（04_打样与量产 等）不含该字，保持字面量。

来源（最新权威版本，2026-10-07 数据基线）：
    <SRC>/04_打样与量产/V0纸样_R3京韵微缩/assets_建筑图标  -> public/assets/landmarks
    <SRC>/04_打样与量产/V0纸样_R3京韵微缩/assets_特殊格    -> public/assets/special
    <SRC>/04_打样与量产/V0纸样_R3京韵微缩/assets_卡牌      -> public/assets/cards
    <SRC>/08_试玩与用户反馈/05_数字试玩版/生成脚本/gamedata.json -> public/assets/data/gamedata.json

用法：
    python3 tools/sync_assets.py            # 同步 + 瘦身
    python3 tools/sync_assets.py --check    # 只校验目标是否齐全、是否超标，不复制

瘦身（不可回退）：
    源素材是印刷用大图，全部同步进来会把仓库撑到 ~21.7MB。脚本在每次同步结束后
    会自动跑一遍「等比重压」，把素材压回「够用尺寸」（约 9.3MB）；--check 也会
    复查尺寸，超标即判失败。因此「手动跑一次同步就把原图拉回来」这条回退路径不存在。
"""

import json
import os
import re
import sys
import shutil
import subprocess
import tempfile
from collections import deque
from datetime import datetime

# ---- 源根目录：全部中文用 unicode 转义，规避「人/の」路径陷阱 ----
SRC_ROOT = (
    "/Users/sevensimle/Documents/@"
    + "\u897f\u5317\u4eba\u7684\u6210\u957f"          # 西北人的成长
    + "/10-Projects/"
    + "\u4e2a\u4eba\u9879\u76ee"                        # 个人项目
    + "/"
    + "\u7ae5\u9886\u8ba1\u5212"                        # 童领计划
    + "/"
    + "\u4eac\u97f5\u5927\u5bcc\u7fc1_\u80e1\u540c\u6f2b\u6e38\u8bb0"  # 京韵大富翁_胡同漫游记
)

PAPER = os.path.join(SRC_ROOT, "04_打样与量产", "V0纸样_R3京韵微缩")
GAME_DATA = os.path.join(
    SRC_ROOT, "08_试玩与用户反馈", "05_数字试玩版", "生成脚本", "gamedata.json"
)

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.abspath(os.path.join(HERE, ".."))
PUB = os.path.join(PROJ, "public", "assets")

JOBS = [
    (os.path.join(PAPER, "assets_建筑图标"), os.path.join(PUB, "landmarks")),
    (os.path.join(PAPER, "assets_特殊格"), os.path.join(PUB, "special")),
    (os.path.join(PAPER, "assets_卡牌"), os.path.join(PUB, "cards")),
]


def fix_board_names(path):
    """把「地标格」的棋盘格名统一成地标表的地标名（唯一权威口径）。

    背景：v1.7 做过一次「价格错位重组」—— 只把 28 个地标在棋盘上的位置重排，
    而且只落在纸样渲染器的内存里（见 gen_playkit_v1.0.py 的 lm_by_cell），
    工作簿 Board_40 的「格名」列没跟着改。于是导出出来的 gamedata.json 里
    board[i].name 是 v1.7 之前的旧名，landmark_by_cell(i).name 才是新名：
    28 个地标格里有 24 格两个名字不一致（例：第 5 格 board=雨儿胡同 / 地标=圆明园）。
    数字试玩版里棋盘格、玩家卡、地价表、买地窗用的都是地标名，只有日志抬头、
    格子悬停提示、买地窗副标题还在用旧格名 —— 同一个格子冒出两个名字。

    纸张侧（棋盘/地产卡）渲染的就是地标名，所以权威口径 = 地标表。
    这里只改显示名，不动价格/租金/归属等任何规则字段。
    """
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    by_cell = {int(k): v for k, v in data["landmark_by_cell"].items()}
    fixed = 0
    for c in data["board"]:
        lm = by_cell.get(int(c["idx"]))
        if c.get("type") == "地标" and lm and c.get("name") != lm["name"]:
            c["name"] = lm["name"]
            fixed += 1
    with open(path, "w", encoding="utf-8") as f:
        # indent=1 对齐权威导出脚本 export_game_data.py，避免整文件重排产生 diff 噪音
        json.dump(data, f, ensure_ascii=False, indent=1)
    return fixed


# 4 枚京味棋子（糖葫芦 / 鸽哨 / 脸谱 / 人力黄包车）：源图是 2048² 奶油底方图，
# 这里去底 + 裁切 + 缩到 256²，落进 public/assets/pawns。
PAWN_SRC = os.path.join(
    SRC_ROOT, "07_视觉与印刷文件", "06_风格包", "R3_京韵微缩", "04_配件与印刷品", "01_棋子"
)
PAWN_FILES = {
    "tanghulu": "R3_token_tanghulu_single.png",
    "geshao": "R3_token_geshao_single.png",
    "opera": "R3_token_opera_mask_single.png",
    "rickshaw": "R3_token_rickshaw_single_v2.png",
}
PAWN_WORK = 420     # 去底在 420² 上做（够快够准），成品 256²
PAWN_OUT = 256
PAWN_TOL = 40       # 与边框基准色的曼哈顿距离容差


def write_manifest():
    """扫描已同步的素材目录，产出 public/assets/manifest.json。

    目的：UI 侧**不硬编码任何文件名**（地标插画按 id 对应、卡背/模板按用途对应），
    素材重命名或换皮肤时只重跑本脚本，不动一行前端代码。
    """
    lm_dir = os.path.join(PUB, "landmarks")
    sp_dir = os.path.join(PUB, "special")

    landmarks = {}
    for f in sorted(os.listdir(lm_dir)):
        m = re.match(r"R3_landmark_diorama_(\d+)_", f)
        if m:
            landmarks[str(int(m.group(1)))] = f"landmarks/{f}"

    special = {}
    for f in sorted(os.listdir(sp_dir)):
        m = re.match(r"ex_(\w+)\.png$", f)
        if m:
            special[m.group(1)] = f"special/{f}"
        elif "board_center_illustration" in f:          # 棋盘中心插画
            special["center"] = f"special/{f}"
        elif f == "qixiaoguo_logo.png":                 # 七笑果品牌 Logo
            special["logo"] = f"special/{f}"

    backs, templates = {}, {}
    cb_dir = os.path.join(PUB, "cards", "backs")
    ct_dir = os.path.join(PUB, "cards", "templates")
    if os.path.isdir(cb_dir):
        for f in sorted(os.listdir(cb_dir)):
            m = re.match(r"R3_back_(\w+)_flat\.jpg$", f)
            if m:
                backs[m.group(1)] = f"cards/backs/{f}"
    if os.path.isdir(ct_dir):
        for f in sorted(os.listdir(ct_dir)):
            m = re.match(r"R3_front_template_(.+?)(?:_v\d+)?\.jpg$", f)
            if m:
                templates[m.group(1)] = f"cards/templates/{f}"

    # 卡面插画：按「牌堆 -> 卡号」索引，UI 用 manifest.vignettes[deck][no] 取图，
    # 无需知道文件名规律（treasure 的文件名是「宝藏/任务/陷阱」而非卡名，规律不可靠）。
    vignettes = {}
    vd = os.path.join(PUB, "cards", "vignettes")
    for deck in ("chance", "destiny", "treasure", "season", "identity"):
        p = os.path.join(vd, deck)
        if not os.path.isdir(p):
            continue
        m = {}
        for f in sorted(os.listdir(p)):
            mm = re.match(r"R3_vignette_\w+?_(\d+)_", f)
            if mm:
                m[str(int(mm.group(1)))] = f"cards/vignettes/{deck}/{f}"
        vignettes[deck] = m

    pawns = {}
    pw_dir = os.path.join(PUB, "pawns")
    if os.path.isdir(pw_dir):
        for f in sorted(os.listdir(pw_dir)):
            m = re.match(r"R3_token_(\w+)\.png$", f)
            if m:
                pawns[m.group(1)] = f"pawns/{f}"

    manifest = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "landmarks": landmarks,
        "special": special,
        "cardBacks": backs,
        "cardTemplates": templates,
        "vignettes": vignettes,
        "pawns": pawns,
    }
    out = os.path.join(PUB, "manifest.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print(f"✓ manifest.json -> {os.path.relpath(out, PROJ)}"
          f"（地标 {len(landmarks)} / 特殊格 {len(special)} / "
          f"卡背 {len(backs)} / 模板 {len(templates)}）")
    missing = [k for k in ("start", "rest", "lost", "teahouse", "center", "logo")
               if k not in special]
    if missing:
        print(f"  ⚠ 特殊格图标缺：{missing}")
    miss_pawn = [k for k in PAWN_FILES if k not in pawns]
    if miss_pawn:
        print(f"  ⚠ 棋子缺：{miss_pawn}")
    return manifest


def _pawn_border_ref(px, w, h):
    acc = []
    for x in range(0, w, 3):
        acc.append(px[x, 1]); acc.append(px[x, h - 2])
    for y in range(0, h, 3):
        acc.append(px[1, y]); acc.append(px[w - 2, y])
    n = len(acc)
    return (sum(p[0] for p in acc) / n,
            sum(p[1] for p in acc) / n,
            sum(p[2] for p in acc) / n)


def _pawn_flood(px, w, h, ref):
    """从四边洪泛：与边框基准色相近的连通区域 = 背景。"""
    def near(p):
        return (abs(p[0] - ref[0]) + abs(p[1] - ref[1]) + abs(p[2] - ref[2])) < PAWN_TOL
    seen = bytearray(w * h)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if not seen[i] and near(px[x, y]):
                seen[i] = 1; dq.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if not seen[i] and near(px[x, y]):
                seen[i] = 1; dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not seen[i] and near(px[nx, ny]):
                    seen[i] = 1; dq.append((nx, ny))
    return seen


def sync_pawns():
    """去底 + 裁切 + 缩放（需要 Pillow；缺失时退化为直接复制原图并告警）。"""
    if not os.path.isdir(PAWN_SRC):
        print(f"❌ 缺少棋子源目录：{PAWN_SRC}")
        return 2
    out_dir = os.path.join(PUB, "pawns")
    os.makedirs(out_dir, exist_ok=True)
    try:
        from PIL import Image
    except ImportError:
        print("⚠ 未安装 Pillow，棋子按原图复制（未去底/未缩放）")
        for key, fn in PAWN_FILES.items():
            shutil.copy2(os.path.join(PAWN_SRC, fn),
                         os.path.join(out_dir, f"R3_token_{key}.png"))
        return 0
    for key, fn in PAWN_FILES.items():
        im = Image.open(os.path.join(PAWN_SRC, fn)).convert("RGB")
        im = im.resize((PAWN_WORK, PAWN_WORK), Image.LANCZOS)
        w = h = PAWN_WORK
        px = im.load()
        seen = _pawn_flood(px, w, h, _pawn_border_ref(px, w, h))
        xs = [x for y in range(h) for x in range(w) if not seen[y * w + x]]
        ys = [y for y in range(h) for x in range(w) if not seen[y * w + x]]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        rgba = im.convert("RGBA")
        ap = rgba.load()
        for y in range(h):
            row = y * w
            for x in range(w):
                if seen[row + x]:
                    ap[x, y] = (ap[x, y][0], ap[x, y][1], ap[x, y][2], 0)
        side = max(x1 - x0 + 1, y1 - y0 + 1)
        half = side // 2 + int(side * 0.07)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        sq = min(PAWN_WORK, half * 2)
        l = max(0, min(cx - half, PAWN_WORK - sq))
        t = max(0, min(cy - half, PAWN_WORK - sq))
        out = rgba.crop((l, t, l + sq, t + sq)).resize((PAWN_OUT, PAWN_OUT), Image.LANCZOS)
        dst = os.path.join(out_dir, f"R3_token_{key}.png")
        out.save(dst, optimize=True)
        print(f"✓ 棋子 {key:<9} -> public/assets/pawns/R3_token_{key}.png")
    return 0


# ---- 素材瘦身：目录规则（最大边长, jpeg 质量或 None）----
# 只保留「实际显示够用」的像素：landmarks 棋盘格内实际显示 60-90px，
# 卡面/卡背按弹层尺寸，棋子按面板尺寸。board_center_illustration 单独放宽到 800。
SLIM_RULES = {
    "landmarks": (256, None),
    "cards/vignettes": (384, 78),
    "cards/backs": (480, 80),
    "cards/templates": (480, 80),
    "pawns": (192, None),
    "special": (256, None),
}
SLIM_SPECIAL_BIG = {"board_center_illustration": 800}
SLIM_EXT = (".png", ".jpg", ".jpeg")


def _slim_rule(rel_dir, name):
    """按目录前缀（长的优先）取瘦身规则；special 里的大图单独放宽。"""
    for key in sorted(SLIM_RULES, key=len, reverse=True):
        if rel_dir == key or rel_dir.startswith(key + "/"):
            maxdim, quality = SLIM_RULES[key]
            if key == "special":
                for token, big in SLIM_SPECIAL_BIG.items():
                    if token in name:
                        maxdim = big
            return maxdim, quality
    return None, None


def _sips_shrink(path, maxdim, quality):
    """用 macOS 自带 sips 等比缩到 maxdim（JPEG 另按 quality 重编码），返回临时文件路径。"""
    ext = os.path.splitext(path)[1].lower()
    fd, tmp = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    cmd = ["sips", "-Z", str(maxdim)]
    if ext in (".jpg", ".jpeg") and quality:
        cmd += ["-s", "format", "jpeg", "-s", "formatOptions", str(quality)]
    cmd += [path, "--out", tmp]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        os.unlink(tmp)
        return None
    return tmp


def slim(pub=None):
    """就地等比压到「够用尺寸」。

    幂等：只有确实变小的文件才覆盖，重复执行结果不变；因此同步完跑一次就等于
    把瘦身焊死在流程里，瘦身结果不可被同步回退。
    """
    pub = pub or PUB
    if not shutil.which("sips"):
        print("⚠ 未找到 sips（仅 macOS 提供），跳过素材瘦身，素材可能偏大")
        return
    before = after = 0
    changed = skipped = 0
    failed = []
    for dp, _dn, fn in os.walk(pub):
        rel = os.path.relpath(dp, pub).replace(os.sep, "/")
        rel = "" if rel == "." else rel
        if rel == "data":
            continue
        for name in sorted(fn):
            if not name.lower().endswith(SLIM_EXT):
                continue
            maxdim, quality = _slim_rule(rel, name)
            if not maxdim:
                continue
            path = os.path.join(dp, name)
            size0 = os.path.getsize(path)
            dim = _max_dimension(path)
            if dim is not None and dim <= maxdim:
                # 已在目标尺寸内：**不重编码**。JPEG 每次重编码都会掉一点画质、
                # 体积也会小幅漂移，重复跑同步会让仓库与画质一直变。
                before += size0
                after += size0
                skipped += 1
                continue
            tmp = _sips_shrink(path, maxdim, quality)
            before += size0
            if tmp is None:
                failed.append(os.path.relpath(path, PROJ))
                after += size0
                continue
            size1 = os.path.getsize(tmp)
            if size1 < size0:
                os.replace(tmp, path)
                after += size1
                changed += 1
            else:
                os.unlink(tmp)
                after += size0
                skipped += 1
    print(f"✓ 素材瘦身：压缩 {changed} 个 / 保持原样 {skipped} 个，"
          f"{before / 1048576:.1f} MB → {after / 1048576:.1f} MB")
    for f in failed:
        print(f"  ⚠ 瘦身失败（已保留原图）：{f}")


def _max_dimension(path):
    """读图片最大边长；优先 Pillow（快），退化到 sips，都不可用则返回 None。"""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return max(im.size)
    except Exception:
        pass
    if shutil.which("sips"):
        r = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                           capture_output=True, text=True)
        vals = re.findall(r"pixel(?:Width|Height):\s*(\d+)", r.stdout)
        if len(vals) == 2:
            return max(int(v) for v in vals)
    return None


def check_slim():
    """瘦身门禁：逐个复查尺寸，返回超标清单（相对 public/assets 的路径）。"""
    oversize = []
    for name in ("landmarks", "special", "cards", "pawns"):
        root = os.path.join(PUB, name)
        if not os.path.isdir(root):
            continue
        for dp, _dn, fn in os.walk(root):
            rel = os.path.relpath(dp, PUB).replace(os.sep, "/")
            for f in sorted(fn):
                if not f.lower().endswith(SLIM_EXT):
                    continue
                maxdim, _q = _slim_rule(rel, f)
                if not maxdim:
                    continue
                dim = _max_dimension(os.path.join(dp, f))
                if dim and dim > maxdim:
                    oversize.append(f"{rel}/{f}  {dim}px > {maxdim}px")
    return oversize


def count_files(root):
    n = 0
    for dp, _dn, fn in os.walk(root):
        n += len([f for f in fn if not f.startswith(".")])
    return n


def sync():
    if not os.path.isdir(SRC_ROOT):
        print(f"❌ 源目录不存在：{SRC_ROOT}")
        return 2
    total = 0
    for src, dst in JOBS:
        if not os.path.isdir(src):
            print(f"❌ 缺少源目录：{src}")
            return 2
        os.makedirs(dst, exist_ok=True)
        n = 0
        for dp, _dn, fn in os.walk(src):
            rel = os.path.relpath(dp, src)
            out_dir = dst if rel == "." else os.path.join(dst, rel)
            os.makedirs(out_dir, exist_ok=True)
            for f in fn:
                if f.startswith("."):
                    continue
                shutil.copy2(os.path.join(dp, f), os.path.join(out_dir, f))
                n += 1
        total += n
        print(f"✓ {os.path.basename(src):<14} -> {os.path.relpath(dst, PROJ):<24} {n} 个文件")

    data_dir = os.path.join(PUB, "data")
    os.makedirs(data_dir, exist_ok=True)
    dst_json = os.path.join(data_dir, "gamedata.json")
    shutil.copy2(GAME_DATA, dst_json)
    fix_board_names(dst_json)
    print(f"✓ gamedata.json -> {os.path.relpath(dst_json, PROJ)}（已统一地标格显示名）")
    total += 1

    sync_pawns()

    print(f"\n合计同步 {total} 个文件。")
    slim()
    write_manifest()
    return 0 if report() else 1


def report():
    print("\n目标目录清点：")
    for name in ("landmarks", "special", "cards", "pawns", "data"):
        p = os.path.join(PUB, name)
        print(f"  {name:<12} {count_files(p) if os.path.isdir(p) else 0} 个文件")

    # 关键断言
    lm = count_files(os.path.join(PUB, "landmarks"))
    ok = True
    if lm != 28:
        print(f"  ⚠ landmarks 期望 28，实际 {lm}")
        ok = False
    if not os.path.exists(os.path.join(PUB, "data", "gamedata.json")):
        print("  ⚠ 缺少 gamedata.json")
        ok = False

    # manifest.json：UI 侧的唯一素材索引，必须与素材目录同生共死
    mf = os.path.join(PUB, "manifest.json")
    if not os.path.exists(mf):
        print("  ⚠ 缺少 manifest.json（跑一次 python3 tools/sync_assets.py 生成）")
        ok = False
    else:
        with open(mf, encoding="utf-8") as fh:
            man = json.load(fh)
        miss_lm = 28 - len(man.get("landmarks", {}))
        miss_sp = [k for k in ("start", "rest", "lost", "teahouse", "center", "logo")
                   if k not in man.get("special", {})]
        if miss_lm:
            print(f"  ⚠ manifest 地标缺 {miss_lm} 个")
            ok = False
        if miss_sp:
            print(f"  ⚠ manifest 特殊格图标缺：{miss_sp}")
            ok = False

    # 瘦身门禁：素材尺寸超标 = 有人把印刷原图塞回了仓库
    oversize = check_slim()
    if oversize:
        print(f"  ⚠ 有 {len(oversize)} 个素材超过瘦身尺寸"
              f"（跑一次 python3 tools/sync_assets.py 会自动压回）：")
        for o in oversize[:10]:
            print(f"      {o}")
        if len(oversize) > 10:
            print(f"      … 另有 {len(oversize) - 10} 个")
        ok = False
    print("\n✅ 素材同步校验通过" if ok else "\n❌ 素材同步校验未通过")
    return ok


def main():
    if "--check" in sys.argv:
        return 0 if report() else 1
    return sync()


if __name__ == "__main__":
    raise SystemExit(main())
