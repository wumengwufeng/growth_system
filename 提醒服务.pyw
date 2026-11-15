"""宿主成长系统 · 常驻提醒（托盘）

与桌面版（宿主成长系统.pyw）的分工：
  · 桌面版 = 打开面板做题，**关窗只是收进托盘**，程序与提醒继续常驻；
  · 本脚本 = 只做提醒，不开面板窗口。常驻托盘，到发布时刻弹 Windows toast。

两者是互补的：没开过桌面版时由本脚本兜底提醒；桌面版在托盘里时它自己就在提醒，
本脚本会自动让路（见 poll_loop 的 quiet_when_webview 参数）——两个进程各弹一次同一个
提醒最闹人。桌面版退出了，本脚本自动接回。

为什么不自己建窗口类：ctypes 自建 WNDCLASSW 在部分环境下 CreateWindowExW 会失败
（返回 0 且 GetLastError 也是 0），排查成本高。tkinter 有可用的真实 HWND，
直接拿它做 Shell_NotifyIcon 的宿主，稳定且代码更短。

双击托盘图标 → 唤出面板（桌面版窗口优先，没有才开浏览器）；右键 → 打开面板 / 开机自启 / 退出。
"""
import ctypes
import ctypes.wintypes as wt
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORT_FILE = os.path.join(HERE, "data", "port.txt")
ICON_FILE = os.path.join(HERE, "assets", "icon.ico")
LOG_FILE = os.path.join(HERE, "data", "tray.log")


def log(msg):
    """pythonw 没有控制台：托盘相关事件落 data/tray.log。"""
    line = "{} [提醒服务] {}\n".format(time.strftime("%m-%d %H:%M:%S"), msg)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass


def load_hicon():
    """品牌图标；取不到退回系统默认图标。"""
    user32 = ctypes.windll.user32
    if os.path.exists(ICON_FILE):
        h = user32.LoadImageW(None, ICON_FILE, 1, 0, 0, 0x10 | 0x40)  # IMAGE_ICON|FROMFILE
        if h:
            return h
    return user32.LoadIconW(None, wt.LPCWSTR(32512))
PORT = int(os.environ.get("GROWTH_PORT") or 8765)
LOCK_PORT = int(os.environ.get("GROWTH_TRAY_PORT") or 8769)
WEBVIEW_LOCK_PORT = int(os.environ.get("GROWTH_WEBVIEW_PORT") or 8768)  # 桌面版单实例锁
DESKTOP = os.path.join(HERE, "宿主成长系统.pyw")

NIM_ADD, NIM_DELETE = 0, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP = 0x01, 0x02, 0x04
WM_LBUTTONUP, WM_RBUTTONUP, WM_LBUTTONDBLCLK = 0x0202, 0x0205, 0x0203
WM_TRAYICON = 0x0400 + 20
CLICK_DEBOUNCE_SEC = 1.5   # 双击会连发多条鼠标消息，短时间内的重复打开一律忽略
MF_STRING, MF_CHECKED = 0x0000, 0x0008
TPM_RIGHTBUTTON, TPM_RETURNCMD, TPM_NONOTIFY = 0x0002, 0x0100, 0x0080
ID_OPEN, ID_AUTOSTART, ID_QUIT = 1001, 1002, 1003

STARTUP_DIR = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows",
                           "Start Menu", "Programs", "Startup")
SHORTCUT = os.path.join(STARTUP_DIR, "宿主成长系统提醒.lnk")


class NOTIFYICONDATA(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("hWnd", wt.HWND), ("uID", wt.UINT),
                ("uFlags", wt.UINT), ("uCallbackMessage", wt.UINT),
                ("hIcon", wt.HICON), ("szTip", wt.WCHAR * 128)]


def panel_url():
    """优先用 server.py 写出的实际端口（8765 被占用时会换端口）。"""
    try:
        with open(PORT_FILE, encoding="utf-8") as f:
            p = f.read().strip()
        if p.isdigit():
            return f"http://127.0.0.1:{p}"
    except OSError:
        pass
    return f"http://127.0.0.1:{PORT}"


def webview_alive():
    """桌面版窗口是否在跑。它被关窗后不退出、只留在托盘里，所以只能问它的单实例
    锁端口：连得上 = 窗口活着。"""
    try:
        socket.create_connection(("127.0.0.1", WEBVIEW_LOCK_PORT), timeout=0.5).close()
        return True
    except OSError:
        return False


def wake_desktop():
    """让已在托盘里的桌面版窗口亮出来（锁端口收到 show 就唤窗）。"""
    try:
        with socket.create_connection(("127.0.0.1", WEBVIEW_LOCK_PORT), timeout=1.5) as c:
            c.sendall(b"show")
        return True
    except OSError:
        return False


def spawn_desktop():
    """拉起桌面版窗口（它自己会起服务）。已在运行也无妨：锁已占，新进程会唤出旧窗口。"""
    try:
        os.startfile(DESKTOP)
        return True
    except OSError:
        return False


def open_panel():
    """唤面板：优先桌面版窗口（它的提醒是权威的那一份）；没有它才退回浏览器。"""
    if wake_desktop() or spawn_desktop():
        return
    url = panel_url()
    try:
        with urllib.request.urlopen(url + "/api/ping", timeout=1.5) as r:
            if r.status == 200:
                webbrowser.open(url)
    except Exception:
        pass


def autostart_enabled():
    return os.path.exists(SHORTCUT)


def set_autostart(enable):
    """用启动文件夹快捷方式实现开机自启（无需管理员权限）。

    自启项指向**桌面版**：它关窗后常驻托盘，提醒 + 唤面板都在一个进程里搞定，
    本脚本不必再跟着起（托盘右键勾选也用这个）。"""
    target = DESKTOP if os.path.exists(DESKTOP) else os.path.abspath(__file__)
    if not enable:
        try:
            os.remove(SHORTCUT)
            return True
        except OSError:
            return False
    try:
        import subprocess
        ps = (
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}');"
            "$s.TargetPath='{py}';$s.Arguments='\"{script}\"';"
            "$s.WorkingDirectory='{wd}';$s.WindowStyle=7;$s.Save()"
        ).format(lnk=SHORTCUT, py=sys.executable, script=os.path.abspath(target), wd=HERE)
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, timeout=20, creationflags=0x08000000)
        return os.path.exists(SHORTCUT)
    except Exception as e:
        log("创建自启快捷方式失败：%s" % e)
        return False


def single_instance():
    """端口占位做单实例锁：避免多个托盘图标与重复提醒。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", LOCK_PORT))
        s.listen(1)
        return s
    except OSError:
        return None


class Tray:
    def __init__(self):
        import tkinter as tk
        self.tk = tk
        self.root = tk.Tk()
        self.root.withdraw()
        hwnd = self.root.winfo_id()
        parent = ctypes.windll.user32.GetParent(hwnd)
        self.hwnd = parent or hwnd

        user32 = ctypes.windll.user32
        self.hicon = load_hicon()
        self.clicks = []          # 记录收到的托盘鼠标事件（供无头测试断言）
        self._pending = []        # WndProc 写入、Tk 定时器消费的事件队列
        self._last_open = 0.0     # 上次打开面板的时刻（去抖用）
        self._old_proc = None
        # 资源管理器重启后广播的注册消息，用于重新挂上托盘图标
        self._taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")

        self.nid = NOTIFYICONDATA()
        self.nid.cbSize = ctypes.sizeof(NOTIFYICONDATA)
        self.nid.hWnd = self.hwnd
        self.nid.uID = 1
        # NIF_MESSAGE 是必须的：不设它 + 不填 uCallbackMessage，Windows 就永远不会
        # 把托盘点击事件发过来，双击自然毫无反应（这是之前打不开面板的根因）。
        self.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        self.nid.uCallbackMessage = WM_TRAYICON
        self.nid.hIcon = self.hicon
        self.nid.szTip = "宿主成长系统 · 提醒中（双击打开面板）"
        self._added = False

        self._install_wndproc()

    # ── 窗口过程子类化：接管托盘回调消息 ──
    def _install_wndproc(self):
        user32 = ctypes.windll.user32
        self._wndproc_t = ctypes.WINFUNCTYPE(
            ctypes.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)
        self._wndproc = self._wndproc_t(self._on_message)

        user32.SetWindowLongPtrW.restype = ctypes.c_void_p
        user32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_void_p]
        user32.CallWindowProcW.restype = ctypes.c_ssize_t
        user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wt.HWND, wt.UINT,
                                           wt.WPARAM, wt.LPARAM]
        GWLP_WNDPROC = -4
        old = user32.SetWindowLongPtrW(
            wt.HWND(self.hwnd), GWLP_WNDPROC,
            ctypes.cast(self._wndproc, ctypes.c_void_p))
        self._old_proc = old
        return old

    def _on_message(self, hwnd, msg, wparam, lparam):
        """窗口过程。**绝不能在这里调用任何 Tk API**——它是在 Tk 处理消息的过程中
        被回调的，重入 Tcl 解释器会让进程直接崩（PyEval_RestoreThread 致命错误）。
        这里只把事件记进队列，交由 Tk 的定时器在主循环里处理。"""
        try:
            if msg == WM_TRAYICON:
                self._pending.append(lparam & 0xFFFF)
                return 0
            if msg == self._taskbar_created:
                # 资源管理器重启后托盘图标会消失，收到这条要把图标加回去
                self._pending.append("readd")
                return 0
        except Exception:
            pass
        return ctypes.windll.user32.CallWindowProcW(
            self._old_proc, hwnd, msg, wparam, lparam)

    def _drain(self):
        """在主循环里消费托盘事件（Tk 定时器驱动，安全）。"""
        while self._pending:
            ev = self._pending.pop(0)
            try:
                if ev == "readd":
                    # 资源管理器重启后原图标已消失。先删一遍再添加：
                    # 若图标其实还在，重复 NIM_ADD 会失败，删掉重建才可靠。
                    try:
                        ctypes.windll.shell32.Shell_NotifyIconW(
                            NIM_DELETE, ctypes.byref(self.nid))
                    except Exception:
                        pass
                    self._added = False
                    self._add_icon()
                elif ev in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
                    self.clicks.append(ev)
                    self._open_once()
                elif ev == WM_RBUTTONUP:
                    self.clicks.append(ev)
                    self._menu_and_dispatch()
            except Exception:
                pass
        self.root.after(80, self._drain)

    def _open_once(self):
        """一次双击会连发 WM_LBUTTONUP、WM_LBUTTONDBLCLK、WM_LBUTTONUP 三条消息，
        逐条响应就会一次开出三个面板。这里做去抖：短时间内只认第一次。"""
        now = time.monotonic()
        if now - self._last_open < CLICK_DEBOUNCE_SEC:
            return False
        self._last_open = now
        threading.Thread(target=open_panel, daemon=True).start()
        return True

    def on_tray_mouse(self, mouse):
        """把托盘鼠标事件入队（公开方法，测试可直接调用）。"""
        self._pending.append(mouse)

    def _add_icon(self):
        if not self._added:
            if ctypes.windll.shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(self.nid)):
                self._added = True
            else:
                log("Shell_NotifyIcon(NIM_ADD) 失败 GetLastError=%s" % ctypes.get_last_error())
        return self._added

    def _menu(self):
        user32 = ctypes.windll.user32
        hmenu = user32.CreatePopupMenu()
        user32.AppendMenuW(hmenu, MF_STRING, ID_OPEN, "打开面板")
        flag = MF_CHECKED if autostart_enabled() else 0
        user32.AppendMenuW(hmenu, MF_STRING | flag, ID_AUTOSTART, "开机自启")
        user32.AppendMenuW(hmenu, MF_STRING, ID_QUIT, "退出")
        pt = wt.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        # 必须先抢前台，否则点菜单外面菜单不会消失（Win32 的经典坑）
        user32.SetForegroundWindow(self.hwnd)
        # TPM_RETURNCMD：直接拿到选择结果，不依赖 WM_COMMAND（子类化窗口过程时那条会丢）
        cmd = user32.TrackPopupMenu(hmenu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                                    pt.x, pt.y, 0, wt.HWND(self.hwnd), None)
        user32.PostMessageW(wt.HWND(self.hwnd), 0, 0, 0)
        user32.DestroyMenu(hmenu)
        return cmd

    def _menu_and_dispatch(self):
        cmd = self._menu()
        if cmd == ID_OPEN:
            threading.Thread(target=open_panel, daemon=True).start()
        elif cmd == ID_AUTOSTART:
            set_autostart(not autostart_enabled())
        elif cmd == ID_QUIT:
            self.quit()

    def quit(self):
        try:
            ctypes.windll.shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self.nid))
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass
        os._exit(0)   # 进程必须真退，否则托盘里会留下点不动的幽灵图标

    def start(self):
        """挂图标 + 起事件消费定时器。测试可以直接调用它而不进 mainloop。"""
        ok = self._add_icon()
        self.root.after(80, self._drain)
        return ok

    def run(self):
        self.start()
        self.root.mainloop()


def start_notifier():
    try:
        from notifier import poll_loop
    except Exception as e:
        print("[tray] 无法加载 notifier:", e)
        return
    # 桌面版在托盘里时它自己会提醒，这边让路，免得同一个槽位弹两次
    threading.Thread(target=poll_loop, kwargs={"quiet_when": webview_alive},
                     daemon=True).start()


def exit_if_webview_running():
    """桌面版在托盘里时，它已自带提醒 + 托盘图标：本脚本再常驻就只是重复打扰。
    开机自启只需指向桌面版；这是给老快捷方式留的兜底。"""
    if webview_alive():
        print("桌面版已在托盘常驻（自带提醒），提醒服务本次启动退出。")
        return True
    return False


def main():
    if exit_if_webview_running():
        return 0
    lock = single_instance()
    if lock is None:
        print("提醒服务已在运行，本次启动退出。")
        return 0
    os.chdir(HERE)
    start_notifier()
    Tray().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
