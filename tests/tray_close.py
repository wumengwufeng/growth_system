"""关窗退托盘测试：验证桌面版「关窗不退出、只收进托盘」，以及单实例锁与唤回。

要验证的四件事：
  1. 窗口过程拦下 WM_CLOSE 并转成 hide（不是退出）；
  2. 托盘单击/双击唤回窗口，一次双击只唤一回；
  3. 「退出」菜单（_quitting=True）时 WM_CLOSE 正常往下传，窗口才真的销毁；
  4. 重复双击桌面版时，第二个实例抢不到锁，并连上锁端口把隐藏的窗口唤回来。

1~3 用真实 HWND + 真实 Shell_NotifyIcon，放子进程里跑——窗口过程写错 Python 会
hard crash，不能让主测试进程跟着死。4 直接加载桌面版模块（不建窗口，不需要 pythonnet）。

沙箱限制（这是环境问题，不是代码问题，遇到就 skip 而不是 FAIL）：
  · CreatePipe 被拒 → 子进程输出一律走文件；
  · mkdtemp 建的目录不可写 → 结果文件放项目目录；
  · Shell_NotifyIcon 被拒 → 托盘断言 skip；
  · 127.0.0.1 监听被拦 → 单实例断言 skip。

运行：python tests/tray_close.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHILD = os.path.join(HERE, "tests", "_tray_close_child.py")
ENTRY = os.path.join(HERE, "宿主成长系统.pyw")


def can_create_file(dirpath):
    """这个环境能不能在 dirpath 下新建文件（沙箱有的目录只允许改已有文件）。"""
    probe = os.path.join(dirpath, ".write_probe")
    try:
        with open(probe, "w", encoding="utf-8") as f:
            f.write("x")
        os.remove(probe)
        return True
    except OSError:
        return False


def port_open(port, timeout=0.3):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _run(argv, **kw):
    """subprocess.run，stderr 落临时文件（沙箱里 CreatePipe 会 WinError 5）。"""
    with tempfile.TemporaryFile() as err:
        rc = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=err, **kw).returncode
        err.seek(0)
        msg = err.read().decode("utf-8", "replace")
    return rc, msg


def run_child():
    out = os.path.join(HERE, ".tray_close_child.json")   # 别用 mkdtemp：沙箱下它建的子目录不可写
    try:
        if os.path.exists(out):
            os.remove(out)
        rc, err = _run([sys.executable, CHILD, out], cwd=HERE, timeout=120,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        try:
            with open(out, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            print("FAIL 子进程没能给出结果（可能崩溃）：rc=%s" % rc)
            print(err.strip()[:800])
            return None
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


def _import_desktop():
    """直接加载桌面版模块（只 import，不调 main）：锁端口/唤回是纯 Python 逻辑。"""
    import importlib.util
    if HERE not in sys.path:
        sys.path.insert(0, HERE)          # 它 import server 时要找得到
    spec = importlib.util.spec_from_file_location("desktop_mod", ENTRY)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def run_lock_test():
    m = _import_desktop()
    if port_open(m.LOCK_PORT):
        print("skip: 锁端口已被占用（桌面版可能正开着），跳过单实例部分")
        return None
    lock = m.acquire_lock()
    if lock is None:
        return "no-listen"
    woke = []
    threading.Thread(target=m.serve_wakeups, args=(lambda: woke.append(1), lock),
                     daemon=True).start()
    time.sleep(0.2)
    second = m.acquire_lock()            # 第二个实例：应当拿不到锁
    second_blocked = second is None
    if second is not None:
        second.close()
    m.wake_existing()                    # 第二个实例被抢锁后就是这样唤回旧窗口的
    for _ in range(50):
        if woke:
            break
        time.sleep(0.05)
    lock.close()
    return {"held": True, "second_blocked": second_blocked, "woken": bool(woke)}


def main():
    fails = 0

    def A(name, cond, extra=""):
        nonlocal fails
        print(("ok: " if cond else "FAIL: ") + name + (("  → " + str(extra)) if not cond and extra != "" else ""))
        if not cond:
            fails += 1

    r = run_child()
    if r is None:
        return 1

    A("托盘线程起来了（tkinter 宿主，窗口过程已子类化）", r["tray_started"] is True)
    A("托盘宿主会回应探活消息（幽灵图标不会）", r["probe_answered"] is True)
    A("托盘图标挂在顶层窗口上（否则收不到 TaskbarCreated）",
      r.get("tray_hwnd_is_root") is True and r.get("tray_hwnd_is_child") is False,
      "root=%s child=%s" % (r.get("tray_hwnd_is_root"), r.get("tray_hwnd_is_child")))
    if (r.get("probe_roundtrip") or 0) < 0:
        print("skip: 锁端口被占用，探活端到端无法验证")
    else:
        A("探活能真的收到回信（不是永远 0 次）", (r.get("probe_roundtrip") or 0) > 0,
          r.get("probe_roundtrip"))
    if r.get("icon_added"):
        A("图标掉了能自检重挂", r.get("health_readds") is True, r.get("health_readds"))
    else:
        print("skip: 本环境加不上图标，自检重挂断言无法验证")
    A("右键「退出」能清掉图标并交给退出流程", r.get("quit_drains") is True
      and r.get("quit_clears_icon") is True,
      "%s/%s" % (r.get("quit_drains"), r.get("quit_clears_icon")))
    A("点了关窗只收进托盘，窗口没被销毁", r["close_hides"] is True
      and r["window_alive_after_close"] is True,
      "%s/%s" % (r["close_hides"], r["window_alive_after_close"]))
    # 新方案：closing 事件（旧方案的窗口过程子类化在"没等到窗口"时什么都不装，
    # 于是点关闭真的退进程、托盘图标一起消失——线上真出过这个 bug）
    A("关闭事件会取消关闭并收进托盘", r.get("closing_cancels") is True
      and r.get("closing_hides") is True,
      "%s/%s" % (r.get("closing_cancels"), r.get("closing_hides")))
    A("托盘「退出」时关闭事件放行", r.get("closing_allows_quit") is True, r.get("closing_allows_quit"))
    A("关闭事件能挂到窗口上", r.get("closing_attached") is True
      and r.get("attached_handler_cancels") is True,
      "%s/%s" % (r.get("closing_attached"), r.get("attached_handler_cancels")))
    if can_create_file(os.path.join(HERE, "data")):
        A("托盘事件写进了 data/tray.log", r["log_written"] is True)
    else:
        print("skip: 本环境不允许在 data/ 下新建文件，日志断言无法验证")

    A("窗口意外消失会拉起新进程", r.get("restart_spawns") == 2, r.get("restart_spawns"))
    A("自动重启前先标记退出（好放锁端口）", r.get("restart_sets_quitting") is True)
    A("短时间内反复崩溃就不再自动重启", r.get("restart_guard") is True, r.get("restart_guard"))

    if not r["icon_added"]:
        # 沙箱里 Shell_NotifyIcon 一律被拒（连 explorer 都在、静态窗口也加不上）。
        # 这是环境限制，不是代码问题：可以断言「消息处理链路」，但不能断言「加图标成功」。
        print("skip: 本环境拿不到托盘（Shell_NotifyIcon 被拒），图标/点击断言无法验证")
    else:
        A("托盘图标已加入", r["icon_added"] is True)
        A("托盘消息能送到窗口过程", r["tray_messages_seen"] >= 1, r["tray_messages_seen"])
        A("一次双击只唤回一次", r["click_shows_once"] is True)
        A("去抖过后单击又能唤回", r["click_shows_again"] is True)
        A("任务栏重建后图标能重挂", r["readd_after_taskbar"] is True)

    lk = run_lock_test()
    if lk is None:
        pass
    elif lk == "no-listen":
        print("skip: 本环境不允许监听 127.0.0.1，单实例断言无法验证")
    else:
        A("桌面版能占住单实例锁端口", lk["held"] is True)
        A("锁被占时第二个实例拿不到锁（不再开一个窗口）", lk["second_blocked"] is True)
        A("第二个实例能唤回已在托盘的窗口", lk["woken"] is True)

    print("\n关窗退托盘测试通过 ✓" if not fails else f"\n{fails} 项失败 ✗")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
