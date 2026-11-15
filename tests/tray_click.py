"""托盘交互测试：验证双击/左键能打开面板、右键能弹菜单、任务栏重建能重挂图标。

用独立子进程跑，因为这个测试会真的往窗口投递消息——一旦子类化的窗口过程写错，
Python 会 hard crash（PyEval_RestoreThread），不能让主测试进程跟着死。

运行：python tests/tray_click.py
"""
import json
import os
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CHILD = r'''
import importlib.util, ctypes, json, os, sys, time
os.chdir(r"{here}")
sys.path.insert(0, r"{here}")
spec = importlib.util.spec_from_file_location("tray", "提醒服务.pyw")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

t = m.Tray()
result = {{"uflags_message": bool(t.nid.uFlags & m.NIF_MESSAGE),
           "callback_msg": t.nid.uCallbackMessage,
           "subclassed": bool(t._old_proc),
           "icon": t.start()}}

# 拦住真的去开浏览器/弹菜单，只记录调用
opened = []
m.open_panel = lambda: opened.append(1)
menu_calls = []
t._menu = lambda: (menu_calls.append(1), 0)[1]

user32 = ctypes.windll.user32
hwnd = ctypes.wintypes.HWND(t.hwnd)
MSG = m.WM_TRAYICON

def drive(ms, until=None, tries=40):
    """投递托盘消息并推动 Tk 主循环，让它被消费。
    until 只用于提前结束的加速判断；不传就固定推若干轮
    （早先版本无条件 `if t.clicks: break`，第一次之后永远立刻 break，
      后面的消息根本没被处理，误判成失败）。"""
    user32.PostMessageW(hwnd, MSG, 1, ms)
    for _ in range(tries):
        t.root.update()
        time.sleep(0.01)
        if until is not None and until():
            break

drive(m.WM_LBUTTONDBLCLK, until=lambda: opened)
result["dblclick_recorded"] = m.WM_LBUTTONDBLCLK in t.clicks
result["dblclick_opened"] = len(opened) > 0

# 真实双击的消息序列：UP → DBLCLK → UP。必须只开一个面板。
opened.clear()
t._last_open = 0.0
user32.PostMessageW(hwnd, MSG, 1, m.WM_LBUTTONUP)
user32.PostMessageW(hwnd, MSG, 1, m.WM_LBUTTONDBLCLK)
user32.PostMessageW(hwnd, MSG, 1, m.WM_LBUTTONUP)
for _ in range(40):
    t.root.update()
    time.sleep(0.01)
    if opened:
        break
# 再推几轮，确认不会继续累加
for _ in range(20):
    t.root.update()
    time.sleep(0.01)
result["dblclick_opens_count"] = len(opened)

# 去抖窗口过后，再点应该能再开一次
opened.clear()
t._last_open = 0.0
drive(m.WM_LBUTTONUP, until=lambda: opened)
result["lclick_opened"] = len(opened) > 0

drive(m.WM_RBUTTONUP, until=lambda: menu_calls)
result["menu_popped"] = len(menu_calls) > 0

# 任务栏重建 → 图标重新挂上
t._added = False
user32.PostMessageW(hwnd, t._taskbar_created, 0, 0)
for _ in range(40):
    t.root.update()
    time.sleep(0.01)
    if t._added:
        break
result["readd_after_taskbar"] = t._added

t.root.destroy()
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(result, f)
'''


def main():
    code = CHILD.format(here=HERE)
    # 结果文件 + stderr 落临时文件：沙箱里 CreatePipe 会 PermissionError(WinError 5)。
    # 结果文件放项目目录而不是 mkdtemp——沙箱下 mkdtemp 建的目录不可写。
    outpath = os.path.join(HERE, ".tray_click_child.json")
    if os.path.exists(outpath):
        os.remove(outpath)
    try:
        with tempfile.TemporaryFile() as err:
            rc = subprocess.run([sys.executable, "-c", code, outpath], cwd=HERE,
                                stdout=subprocess.DEVNULL, stderr=err, timeout=120,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"}).returncode
            err.seek(0)
            errtext = err.read().decode("utf-8", "replace")
        try:
            with open(outpath, encoding="utf-8") as f:
                r = json.load(f)
        except (OSError, ValueError):
            print("FAIL 子进程没能给出结果（可能崩溃）：rc=%s" % rc)
            print(errtext.strip()[:800])
            return 1
    finally:
        try:
            os.remove(outpath)
        except OSError:
            pass

    fails = 0

    def A(name, cond, extra=""):
        nonlocal fails
        print(("ok: " if cond else "FAIL: ") + name + (("  → " + str(extra)) if extra and not cond else ""))
        if not cond:
            fails += 1

    A("图标注册了 NIF_MESSAGE", r["uflags_message"] is True)
    A("回调消息号非 0", r["callback_msg"] != 0, r["callback_msg"])
    A("窗口过程子类化成功", r["subclassed"] is True)
    if not r["icon"]:
        # 沙箱/无外壳环境里 Shell_NotifyIcon 会被拒：这是环境限制，不是代码问题。
        # 明确 skip，别把依赖托盘的断言混进耗时里的假失败或假通过。
        print("skip: 本环境拿不到托盘（Shell_NotifyIcon 被拒），交互断言无法验证")
    else:
        A("托盘图标已加入", r["icon"] is True)
        A("双击能收到托盘消息", r["dblclick_recorded"] is True)
        A("双击会打开面板", r["dblclick_opened"] is True)
        A("一次双击只开一个面板", r["dblclick_opens_count"] == 1, r["dblclick_opens_count"])
        A("单击也会打开面板", r["lclick_opened"] is True)
        A("右键会弹出菜单", r["menu_popped"] is True)
        A("任务栏重建后图标能重挂", r["readd_after_taskbar"] is True)

    print("\n托盘交互测试通过 ✓" if not fails else f"\n{fails} 项失败 ✗")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())