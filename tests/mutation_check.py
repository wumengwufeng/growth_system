"""变异测试：故意破坏关键逻辑，验证测试能否抓到。

精简测试最大的风险是「删掉了本来有用的断言」。这个脚本用来证明精简后的
测试仍然守得住关键行为——每一个变异体都必须让至少一个测试失败。
"""
import io
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
ROOT_FILES = {"notifier.py", "server.py"}


def src_path(fname):
    """js/ 下的前端文件与根目录的后端文件分开放置。"""
    return os.path.join(HERE, fname) if fname in ROOT_FILES else os.path.join(HERE, "js", fname)

MUTANTS = [
    ("core.js", "rescueDecision 的跨天上界",
     "const burstDeadline = Math.min(dayEnd, Math.max(",
     "const burstDeadline = (Math.max(",
     ["node", "tests/engine_smoke.mjs"]),
    ("core.js", "突发截断成 2 小时",
     "nowMs + 120*60000));", "nowMs + 60*60000));",
     ["node", "tests/engine_smoke.mjs"]),
    ("core.js", "救回额度不夹到 0",
     "return { total, used, left: Math.max(0, total - used), exhausted: used >= total };",
     "return { total, used, left: total - used, exhausted: used >= total };",
     ["node", "tests/engine_smoke.mjs"]),
    ("core.js", "窗口建议样本门槛失效",
     "if(mins.length < WINDOW_MIN_SAMPLES) return null;",
     "if(mins.length < 1) return null;",
     ["node", "tests/engine_smoke.mjs"]),
    ("core.js", "补救结论永不 warn",
     "if(rs.quotaDays >= 2 || share >= 30){",
     "if(false){",
     ["node", "tests/engine_smoke.mjs"]),
    ("core.js", "周报不汇总补救",
     "if(r && r.n){", "if(false){",
     ["node", "tests/engine_smoke.mjs"]),
    ("engine.js", "收回后不回写状态（会导致每轮重复播报）",
     "sl.status='void'; sl.voidReason=d.reason||'ignored'; dirty=true;",
     "sl.voidReason=d.reason||'ignored'; dirty=true;",
     ["node", "tests/engine_smoke.mjs"]),
    ("engine.js", "补救不记事件",
     "noteRescue(dayRec, 'grace', gapMin, now);",
     "void 0;",
     ["node", "tests/engine_smoke.mjs"]),
    ("ui.js", "applyWindow 读过期快照",
     "const w = suggestActiveWindow(S, ds(new Date()), 7);",
     "const w = S.lastReport && S.lastReport.metrics && S.lastReport.metrics.windowSuggestion;",
     ["node", "tests/engine_smoke.mjs"]),
    ("core.js", "发布计划失去确定性（JS/Python 对拍必挂）",
     "const r = rngFor(dayStr+'|'+salt);",
     "const r = rngFor(dayStr+'|'+salt+'|x');",
     ["python", "tests/plan_parity.py"]),
    ("notifier.py", "已通知键不落盘（重启会重复提醒）",
     "        save_notified(save_path, notified)\n",
     "",
     ["python", "tests/notifier_logic.py"]),
    ("notifier.py", "通知不合并去重",
     "        if key in notified:\n            continue\n",
     "",
     ["python", "tests/notifier_logic.py"]),
]


def run(cmd):
    # 必须显式指定 utf-8：子进程输出含中文与符号，按系统默认 GBK 解码会抛
    # UnicodeDecodeError，导致 returncode 读不到、变异体被误判为「逃逸」。
    p = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=ENV, timeout=300)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def main():
    originals = {}
    ok = fails = 0
    try:
        for fname, desc, old, new, cmd in MUTANTS:
            path = src_path(fname)
            if fname not in originals:
                originals[fname] = io.open(path, encoding="utf-8").read()
            src = originals[fname]
            if old not in src:
                print(f"跳过（锚点不存在）: {desc}")
                continue
            io.open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
            code, out = run(cmd)
            caught = code != 0
            mark = "抓到 ✓" if caught else "漏掉 ✗"
            print(f"{mark}  {fname}: {desc}")
            if caught:
                ok += 1
            else:
                fails += 1
                print("   ", out.strip().splitlines()[-1][:120] if out.strip() else "")
            # 立即还原，避免下一个变异体基于脏文件
            io.open(path, "w", encoding="utf-8").write(originals[fname])
    finally:
        for fname, src in originals.items():
            io.open(src_path(fname), "w", encoding="utf-8").write(src)
        print("\n已全部还原源文件")

    total = ok + fails
    print(f"\n变异测试：{ok}/{total} 个变异体被捕获")
    if fails:
        print(f"{fails} 个变异体逃逸——说明对应行为缺少测试覆盖")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
