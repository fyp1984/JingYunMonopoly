#!/usr/bin/env python3
"""dump_py.py —— 用 engine.py 跑单局并导出 JSON，供 JS 侧「同种子对拍」。

用法::

    python3 tests/parity/dump_py.py \
        --engine "<...>/生成脚本/engine.py" \
        --data   "public/assets/data/gamedata.json" \
        --seeds  42,1234,7 \
        --players 4 [--pawns 1] [--no-season] [--build-rule free]

stdout = 一个 JSON 数组，每个元素是一局的 play() 结果（与 engine.py 同结构）。
engine.py 不修改、不复制，只 import 后调用 —— 保证对拍基准就是权威源本身。
"""
import argparse
import importlib.util
import json
import sys


def load_engine(path):
    spec = importlib.util.spec_from_file_location("jym_engine_ref", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, help="engine.py 的绝对路径")
    ap.add_argument("--data", required=True, help="gamedata.json 的路径")
    ap.add_argument("--seeds", required=True, help="逗号分隔的种子列表")
    ap.add_argument("--players", type=int, default=4)
    ap.add_argument("--pawns", type=int, default=1)
    ap.add_argument("--no-season", action="store_true")
    ap.add_argument("--build-rule", default="free")
    ap.add_argument("--skill-limit", type=int, default=None)
    ap.add_argument("--season-mode", default=None)
    ap.add_argument("--season-scale", type=float, default=None)
    ap.add_argument("--hutong", type=int, default=None, help="1/0，省略=默认")
    ap.add_argument("--hutong-draw", type=int, default=None, help="1/0")
    ap.add_argument("--hutong-flat", type=int, default=None)
    args = ap.parse_args()

    eng = load_engine(args.engine)
    data = eng.GameData(args.data)
    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]

    out = []
    for s in seeds:
        gm = eng.Game(
            data, n_players=args.players, seed=s,
            season_on=not args.no_season,
            build_rule=args.build_rule, pawns=args.pawns,
            skill_limit=args.skill_limit,
            season_mode=args.season_mode,
            season_scale=args.season_scale,
            hutong=(None if args.hutong is None else bool(args.hutong)),
            hutong_draw=(None if args.hutong_draw is None else bool(args.hutong_draw)),
            hutong_flat=args.hutong_flat,
        )
        out.append(gm.play())

    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
