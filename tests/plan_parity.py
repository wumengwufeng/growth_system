"""JS(js/core.js) 与 Python(notifier.py) 发布算法的一致性对拍测试。

早期版本只把 Python 结果与「曾经由浏览器生成」的硬编码常量比对——js/core.js
怎么改都不会被发现，等于没在对拍。现在改为**真的执行 JS**：用 node 加载
js/core.js 跑同一批用例，再与 Python 结果逐项比较。

三方比对的意义：
  · JS ↔ Python 不一致 → 桌面版与托盘提醒看到的发布时刻不同（严重）
  · 两者都漂移但彼此一致 → 冻结基准会拦住（避免「一起改错」）

运行：python tests/plan_parity.py
"""
import json
import os
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from notifier import plan_day, mulberry32, fnv1a  # noqa: E402

W1 = {"start": "09:00", "end": "22:00"}
W2 = {"start": "00:00", "end": "01:30"}

CASES = [
    (("2026-10-26", 1792948000000, W1),
     [{"at": 1071, "kind": "side"}, {"at": 1122, "kind": "side"}, {"at": 1167, "kind": "burst"}]),
    (("2026-10-27", 1792948000000, W1),
     [{"at": 729, "kind": "side"}, {"at": 992, "kind": "burst"}, {"at": 1302, "kind": "side"}]),
    (("2026-10-26", 1000000000, W1),
     [{"at": 667, "kind": "side"}, {"at": 1231, "kind": "side"}]),
    (("2026-10-26", 1792948000000, W2),
     [{"at": 61, "kind": "side"}, {"at": 67, "kind": "side"}, {"at": 72, "kind": "burst"}]),
    (("2026-12-31", 1792948000000, W2),
     [{"at": 11, "kind": "side"}, {"at": 43, "kind": "side"}, {"at": 77, "kind": "side"}]),
]

JS_SEQ = [0.3441211662720889, 0.7467197431251407, 0.9200806738808751,
          0.8051153835840523, 0.025293605867773294, 0.6811170838773251,
          0.7190294449683279]


def run_js():
    """真的在 node 里跑 js/core.js 的 planDay，返回与 CASES 同构的结果。"""
    payload = [[d, salt, w] for (d, salt, w), _ in CASES]
    # 纯函数 RNG 序列由 Python 侧独立校验（mulberry32 已内置对拍常量），
    # 这里只需 planDay 结果
    script = """
const fs = require('fs');
const src = fs.readFileSync('js/core.js', 'utf8').replace("'use strict';", '');
const api = new Function(src + ';return { planDay };')();
const cases = JSON.parse(process.argv[1]);
const plans = cases.map(([d, salt, win]) =>
  api.planDay(d, salt, win).map(s => ({ at: s.at, kind: s.kind })));
process.stdout.write(JSON.stringify(plans));
"""
    p = subprocess.run(["node", "-e", script, json.dumps(payload)],
                       cwd=HERE, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    if p.returncode != 0:
        print("FAIL 无法执行 js/core.js 的 planDay：")
        print((p.stderr or "").strip()[:500])
        return None
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        print("FAIL node 输出不是合法 JSON：", p.stdout[:300])
        return None


def main():
    ok = True

    js_plans = run_js()
    if js_plans is None:
        sys.exit(1)

    for i, (args, expect) in enumerate(CASES):
        py = plan_day(*args)
        js = js_plans[i]
        tag = f"{args[0]}|{args[1]}|{args[2]['start']}-{args[2]['end']}"
        if js != py:
            ok = False
            print(f"FAIL JS 与 Python 不一致 {tag}\n  js     {js}\n  py     {py}")
        if py != expect:
            ok = False
            print(f"FAIL Python 偏离冻结基准 {tag}\n  got    {py}\n  expect {expect}")

    rnd = mulberry32(fnv1a("2026-10-26|1792948000000"))
    seq = [rnd() for _ in range(7)]
    if seq != JS_SEQ:
        ok = False
        print("FAIL mulberry32 序列与 JS 基准不一致")

    print("对拍通过 ✓（JS / Python / 冻结基准 三方一致）" if ok else "对拍失败 ✗")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()