"""子进程驱动：被 tray_close.py 拉起，结果写进项目目录下的 json 文件。

为什么不用 subprocess 管道：沙箱里 CreatePipe 会 PermissionError（WinError 5）。
为什么结果不写 mkdtemp：沙箱下 mkdtemp 建的目录不可写。
"""
import ctypes
import ctypes.wintypes as wt
import importlib.util
import json
import os
import sys
import threading
import time

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)
sys.path.insert(0, root)   # 入口脚本会 import server；用 spec 加载时不会自动加上脚本目录

spec = importlib.util.spec_from_file_location("desktop", "宿主成长系统.pyw")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

user32 = ctypes.windll.user32
result = {}


def pump(sec=0.6):
    end = time.time() + sec
    msg = wt.MSG()
    while time.time() < end:
        while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        time.sleep(0.01)


# ── 1) 托盘线程：能起来、能加图标、能收到托盘消息 ──
state = {"quitting": False}
shown = []
m.show_panel = lambda: shown.append(1)

tray = m.TrayThread(state)
tray.start()
for _ in range(100):                      # 等托盘线程就绪
    if getattr(tray, "_old_proc", None):
        break
    time.sleep(0.05)
result["tray_started"] = bool(getattr(tray, "_old_proc", None))
result["icon_added"] = bool(getattr(tray, "_added", False))

def wait(cond, sec=3.0):
    """等条件成立。Tk 的 mainloop 在托盘线程里跑着，这里**不能**再去碰 tray.root
    （跨线程操作 Tcl 解释器会死锁）。"""
    end = time.time() + sec
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


if result["tray_started"]:
    hwnd = tray.hwnd
    # 单击唤回面板（一次双击连发三条，只应唤一回）
    tray._last_show = 0.0
    tray.clicks.clear()
    for msg in (m.WM_LBUTTONUP, m.WM_LBUTTONDBLCLK, m.WM_LBUTTONUP):
        user32.PostMessageW(wt.HWND(hwnd), m.WM_TRAYICON, 1, msg)
    wait(lambda: shown)
    time.sleep(0.4)          # 多等一会儿，确认没有第二次唤回
    result["tray_messages_seen"] = len(tray.clicks)
    result["click_shows_once"] = len(shown) == 1

    # 去抖窗口过后再点，应能再唤回一次
    shown.clear()
    tray._last_show = 0.0
    user32.PostMessageW(wt.HWND(hwnd), m.WM_TRAYICON, 1, m.WM_LBUTTONUP)
    result["click_shows_again"] = wait(lambda: shown) and len(shown) == 1

    # 资源管理器重启 → 图标重挂
    tray._added = False
    user32.PostMessageW(wt.HWND(hwnd), tray._taskbar_created, 0, 0)
    result["readd_after_taskbar"] = wait(lambda: tray._added, 2.0)

    # 探活：别的进程广播 WM_PROBE，宿主必须回 pong（死图标不会回 → 靠这个识别幽灵）
    user32.PostMessageW(wt.HWND(hwnd), m.WM_PROBE, 0, 0)
    result["probe_answered"] = wait(lambda: tray.pongs > 0, 2.0)

    # 图标宿主必须是顶层窗口：广播消息（TaskbarCreated / 探活）只送给顶层窗口。
    # 挂在 Tk 的子窗口上时，资源管理器一重启就收不到 TaskbarCreated，
    # 图标再也挂不回来 → 用户看到的就是「收进托盘一段时间后自己掉了」。
    # Tk 的顶层外壳可能晚一拍才建出来，宿主会自己迁过去，这里等一会儿。
    def root_ok():
        st = user32.GetWindowLongW(wt.HWND(tray.hwnd), -16)
        return (not (st & 0x40000000)) and user32.GetAncestor(wt.HWND(tray.hwnd), 2) == tray.hwnd

    result["tray_hwnd_is_root"] = wait(root_ok, 4.0)
    result["tray_hwnd_is_child"] = bool(user32.GetWindowLongW(wt.HWND(tray.hwnd), -16) & 0x40000000)

    # 探活端到端：锁端口上问一句，活宿主必须回 pong。
    # 早先靠广播 Windows 消息，托盘窗口是 Tk 子窗口收不到、探活方又不抽消息，
    # 于是永远「应答 0 次」——等于没有探活。
    lock = m.acquire_lock()
    if lock is None:
        result["probe_roundtrip"] = -1        # 端口被桌面版占着，本环境无法验证
    else:
        threading.Thread(target=m.serve_wakeups, args=(lambda: None, lock),
                         daemon=True).start()
        time.sleep(0.3)
        result["probe_roundtrip"] = m.probe_tray_host(timeout=1.5)
        import socket as _s
        try:
            with _s.create_connection(("127.0.0.1", m.LOCK_PORT), timeout=1.0) as c:
                c.settimeout(1.0); c.sendall(b"show")
        except OSError:
            pass
        lock.close()

    # 图标丢了要能自己挂回来：伪造「shell 窗口变了」（= 资源管理器重启）走重挂分支
    tray._shell = 0
    tray._health_check()
    result["health_readds"] = bool(tray._added)

    # 右键菜单「退出」：清图标 + 交棒给 quit_all（真实进程退出由它 os._exit 完成）
    quit_calls = []
    m.quit_all = lambda st: quit_calls.append(st)
    tray._pending.append("quit")          # 等价于菜单选中 ID_QUIT 后的入队
    result["quit_drains"] = wait(lambda: quit_calls, 2.0)
    result["quit_clears_icon"] = not tray._added

# ── 2) 关窗拦截：WM_CLOSE 只隐藏（不销毁窗口）──
hid = []
m.hide_panel = lambda: hid.append(1)
win = user32.CreateWindowExW(0, "STATIC", "close-probe", 0, 0, 0, 10, 10,
                             None, None, None, None)
result["close_installed"] = bool(m.install_close_handler(state, hwnd=win))
user32.PostMessageW(wt.HWND(win), m.WM_CLOSE, 0, 0)
pump()
result["close_hides"] = len(hid) == 1
result["window_alive_after_close"] = bool(user32.IsWindow(wt.HWND(win)))
user32.DestroyWindow(wt.HWND(win))

# ── 2b) 关闭拦截新方案：closing 事件处理器（不依赖窗口句柄，也不等窗口出现）──
# 旧方案等不到 WinForms 窗口时就什么都不装，点关闭直接退进程——「关掉就彻底没了」的根因。
hid2 = []
m.hide_panel = lambda: hid2.append(1)
handler = m.CloseToTray({"quitting": False})
result["closing_cancels"] = (handler() is False)            # 普通关闭：取消，收托盘
time.sleep(0.3)
result["closing_hides"] = len(hid2) == 1
result["closing_allows_quit"] = (m.CloseToTray({"quitting": True})() is True)   # 托盘退出：放行


class FakeEvents:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self


class FakeWindow:
    def __init__(self):
        self.events = type("E", (), {"closing": FakeEvents()})()


fw = FakeWindow()
m.CloseToTray({"quitting": False}).attach(fw)
result["closing_attached"] = len(fw.events.closing.handlers) == 1
result["attached_handler_cancels"] = (fw.events.closing.handlers[0]() is False)

result["log_written"] = os.path.exists(m.LOG_FILE)

# ── 3) 窗口意外消失后的自动重启（含防崩溃循环）──
# 真机事故：睡眠唤醒后 webview.start() 静默返回，main() 直接 return，
# 进程无声消失——日志没有、崩溃记录没有，用户只看到「托盘又不见了」。
import subprocess
spawned = []


class FakePopen:
    def __init__(self, args, **kw):
        spawned.append((args, kw))


subprocess.Popen = FakePopen
_probe_dir = os.path.dirname(os.path.abspath(sys.argv[1]))
m.RESTART_FILE = os.path.join(_probe_dir, "restart_probe.log")
# 日志也指到临时文件：别把测试的「已拉起新进程」写进真实的 data/tray.log
_real_log = m.LOG_FILE
m.LOG_FILE = os.path.join(_probe_dir, "restart_probe_tray.log")
try:
    os.remove(m.RESTART_FILE)
except OSError:
    pass

st1 = {"quitting": False}
ok1 = m.restart_self(st1, None, limit=2, window_sec=600)
result["restart_sets_quitting"] = st1.get("quitting") is True
ok2 = m.restart_self({"quitting": False}, None, limit=2, window_sec=600)
ok3 = m.restart_self({"quitting": False}, None, limit=2, window_sec=600)   # 超限，应被拦
result["restart_spawns"] = len(spawned)
result["restart_guard"] = (ok1 is True and ok2 is True and ok3 is False)
try:
    os.remove(m.RESTART_FILE)
except OSError:
    pass
try:
    os.remove(m.LOG_FILE)
except OSError:
    pass
m.LOG_FILE = _real_log

with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(result, f)
os._exit(0)   # 托盘线程的 mainloop 是 daemon，直接退出即可（别跨线程碰 Tk）