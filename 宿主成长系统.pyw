"""宿主成长系统 · 桌面版

双击运行（.pyw 由 pythonw 启动，无控制台黑窗）：
  本地起服务（静态页 + Magpie 代理）→ 打开原生窗口（WebView2）→ **关窗只是收进托盘**，
  程序与提醒继续常驻；托盘图标单击/双击唤回窗口，右键「打开面板 / 开机自启 / 退出」，
  只有「退出」才真正结束进程。
另有后台轮询线程：每 60 秒读 data/growth.json，用与页面一致的确定性算法
（notifier.py，经 tests/plan_parity.py 对拍）判断发布时刻，到点发 Windows toast。
存档（localStorage）持久化在 %LOCALAPPDATA%\\growth_system_webview。

端口：默认 8765，可用环境变量 GROWTH_PORT 覆盖。若被**其他程序**占用，自动改用下一个
空闲端口——绝不把别人的页面当成本系统打开。
单实例：占住 127.0.0.1:8768（GROWTH_WEBVIEW_PORT）。重复双击不再起第二个窗口，而是把
已经在托盘里的窗口唤回来；提醒服务.pyw 也靠这个端口判断「窗口还活着」。

两处 Win32 细节（都踩过坑，改之前先看注释）：
  · 收托盘：子类化面板窗口过程拦 WM_CLOSE。它在 .NET 的 UI 线程上被回调，所以里面只准
    写队列，window.hide()/show()/destroy() 一律交给自己的线程去做。
  · 托盘图标：**不挂在面板窗口上**。同一个窗口既跑 .NET 消息循环又用 ctypes 回调时，
    Shell_NotifyIcon 挂上去能看见图标，但点击/右键收不到（实测）。tray 改由独立线程里的
    tkinter 窗口托管——与 提醒服务.pyw 同一套已验证可行的做法。

托盘排障：一切托盘相关事件都写进 data/tray.log（pythonw 没有控制台，print 看不到）。
"""
import ctypes
import ctypes.wintypes as wt
import http.server
import os
import socket
import sys
import threading
import time

import webview

from server import Handler, probe_port, find_free_port

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("GROWTH_PORT") or 8765)
LOCK_PORT = int(os.environ.get("GROWTH_WEBVIEW_PORT") or 8768)
ICON_FILE = os.path.join(HERE, "assets", "icon.ico")
LOG_FILE = os.path.join(HERE, "data", "tray.log")
RESTART_FILE = os.path.join(HERE, "data", "restart.log")   # 自动重启时间戳（防崩溃循环）

WM_CLOSE, WM_NCDESTROY = 0x0010, 0x0082
NIM_ADD, NIM_DELETE = 0, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP = 0x01, 0x02, 0x04
WM_LBUTTONUP, WM_RBUTTONUP, WM_LBUTTONDBLCLK = 0x0202, 0x0205, 0x0203
WM_TRAYICON = 0x0400 + 30
CLICK_DEBOUNCE_SEC = 1.5
# 探活消息：「退出」菜单发出后等托盘线程回一句 ack，收不到就说明那个图标是死的（无宿主）
WM_PROBE, WM_PONG = 0x0400 + 31, 0x0400 + 32
MF_STRING, MF_CHECKED = 0x0000, 0x0008
TPM_RIGHTBUTTON, TPM_RETURNCMD, TPM_NONOTIFY = 0x0002, 0x0100, 0x0080
ID_OPEN, ID_AUTOSTART, ID_QUIT = 2001, 2002, 2003

STARTUP_DIR = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows",
                           "Start Menu", "Programs", "Startup")
SHORTCUT = os.path.join(STARTUP_DIR, "宿主成长系统提醒.lnk")   # 与 提醒服务.pyw 共用


def log(msg):
    """pythonw 没有控制台：托盘相关的一切都落 data/tray.log，排障只看它。"""
    line = "{} {}\n".format(time.strftime("%m-%d %H:%M:%S"), msg)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    try:
        print("[tray]", msg)
    except Exception:
        pass


def load_hicon():
    """从 assets/icon.ico 取托盘/窗口图标；取不到就退回系统默认图标。"""
    user32 = ctypes.windll.user32
    if os.path.exists(ICON_FILE):
        IMAGE_ICON, LR_LOADFROMFILE, LR_DEFAULTSIZE = 1, 0x10, 0x40
        h = user32.LoadImageW(None, ICON_FILE, IMAGE_ICON, 0, 0,
                              LR_LOADFROMFILE | LR_DEFAULTSIZE)
        if h:
            return h
        log("LoadImageW 失败，退回默认图标（GetLastError=%s）" % ctypes.get_last_error())
    return user32.LoadIconW(None, wt.LPCWSTR(32512))    # IDI_APPLICATION


class NOTIFYICONDATA(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("hWnd", wt.HWND), ("uID", wt.UINT),
                ("uFlags", wt.UINT), ("uCallbackMessage", wt.UINT),
                ("hIcon", wt.HICON), ("szTip", wt.WCHAR * 128)]


# ── 单实例锁与唤回 ──
def acquire_lock():
    """占住锁端口；已被占用返回 None（说明已有窗口，可能正躺在托盘里）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", LOCK_PORT))
        s.listen(1)
        return s
    except OSError:
        s.close()
        return None


def probe_tray_host(timeout=1.0):
    """问一句「还有活的宿主吗」，活着的那个会在锁端口上回 pong。

    锁端口挡不住死图标：进程被杀后图标会以幽灵形式留在托盘里继续响应右键，
    点菜单却永远没反应。所以不能「有锁 = 有宿主」，得让宿主亲口回一句。

    早先的实现靠广播 Windows 消息（WM_PROBE/WM_PONG），两个致命问题：
      1. 托盘窗口挂在 Tk 的子窗口上，广播只送顶层窗口 → 根本收不到；
      2. 探活方只 sleep 不抽消息 → 就算回了也读不到。
    结果日志里永远「应答 0 次」，等于没有探活。走锁端口的 socket 一句话解决。

    返回应答次数；>0 说明有活宿主（此时什么都不用做，它自己会处理菜单）。
    """
    try:
        with socket.create_connection(("127.0.0.1", LOCK_PORT), timeout=timeout) as c:
            c.settimeout(timeout)
            c.sendall(b"ping")
            reply = c.recv(16)
    except OSError:
        log("探活结果：应答 0 次")
        return 0
    ok = 1 if reply.strip().lower() == b"pong" else 0
    log("探活结果：应答 %d 次" % ok)
    return ok


def wake_existing():
    """让已在托盘里的窗口自己亮出来：连上锁端口发一句 show。"""
    try:
        with socket.create_connection(("127.0.0.1", LOCK_PORT), timeout=1.5) as c:
            c.sendall(b"show")
        return True
    except OSError as e:
        log("唤回失败：%s" % e)
        return False


def serve_wakeups(on_wake, lock):
    while True:
        try:
            conn, _ = lock.accept()
        except OSError:
            return
        with conn:
            try:
                conn.settimeout(1.0)
                data = conn.recv(16)
            except OSError:
                continue
            cmd = data.strip().lower()
            if cmd == b"ping":
                # 探活：只回话，不唤窗口（探活是启动前问的，不该把面板弹出来）
                try:
                    conn.sendall(b"pong")
                except OSError:
                    pass
                continue
        if cmd in (b"show", b"ping"):
            try:
                on_wake()
            except Exception as e:
                log("唤回回调异常：%s" % e)


# ── 面板操作（只在 _drain 线程里调用，pywebview 内部会切回 UI 线程）──
def panel():
    return webview.windows[0] if webview.windows else None


def show_panel():
    p = panel()
    if p:
        p.show()
        log("面板已唤出")


def hide_panel():
    p = panel()
    if p:
        p.hide()
        log("面板已收进托盘（点关闭）")


class CloseToTray:
    """「点关闭 = 收进托盘」用一个 pywebview 的 closing 事件处理器实现。

    早期版本是等窗口出现后子类化 WinForms 的窗口过程去拦 WM_CLOSE。那条路不可靠：
    启动瞬间（还没等到窗口）或窗口句柄变过时，日志里只有一句「没等到面板窗口」
    然后什么都不装——这时点关闭就是真关闭，pywebview 销毁最后一个窗口，
    webview.start() 返回，进程退出、托盘图标随之消失。表现正是「关掉就彻底没了」。
    事件处理器不依赖窗口句柄，也不会被 .NET 换掉。"""

    def __init__(self, state):
        self.state = state

    def __call__(self):
        if self.state.get("quitting"):
            return True           # 托盘「退出」走这条路：放行，让 main() 正常收尾
        log("拦到窗口关闭 → 收进托盘")
        threading.Thread(target=hide_panel, daemon=True).start()
        return False              # 取消这次关闭

    def attach(self, window):
        # closing 回调约定：返回 True = 放行关闭。两种轮询在 Windows 上取值可能不同，
        # 所以回调返回的是「是否放行」，直接接上即可。
        window.events.closing += self


def quit_all(state):
    """彻底退出：撤图标 → 销毁窗口 → 结束进程。

    必须真把进程干掉：pywebview 的 window.destroy() 只关窗口，.NET 消息循环还在，
    进程留在后台——图标撤了，但进程表里还在跑，下次点快捷方式也只会「唤回」这个空壳。
    """
    state["quitting"] = True
    log("收到退出指令，结束进程")
    # 托盘「退出」走的是真关闭：closing 事件此时放行，但为了防止 .NET 层把进程留下，
    # 下面依旧直接 os._exit（见 docstring）
    p = panel()
    if p:
        try:
            p.destroy()
        except Exception as e:
            log("销毁窗口异常：%s" % e)
    sys.stdout.flush()
    os._exit(0)          # 不走 atexit：WebView2 的收尾会卡住


# ── 托盘（独立线程 + tkinter 消息循环托管图标）──
class TrayThread(threading.Thread):
    """在自己的线程里跑 tkinter 并托管托盘图标。

    为什么不在面板窗口上托管（省一个线程）：
      面板窗口的消息循环属于 .NET（winforms），ctypes 窗口过程在那里被回调；实测
      Shell_NotifyIcon 加图标能成功、图标也出现，但点击/右键消息一条都收不到。
      提醒服务.pyw 用 tkinter 的 HWND 托管一直是好的——托盘这种靠回调吃饭的东西，
      外壳必须是有 Python 消息循环、自己跑得动的窗口。
    """

    def __init__(self, state):
        super().__init__(daemon=True, name="tray")
        self.state = state
        self.clicks = []          # 收到的托盘鼠标事件（供无头测试断言）
        self.pongs = 0            # 收到的探活应答次数（供无头测试断言）
        self._pending = []
        self._last_show = 0.0
        self._added = False

    # —— 以下都在托盘线程里 ——
    def run(self):
        import tkinter as tk
        try:
            self.root = tk.Tk()
        except Exception as e:
            log("tkinter 初始化失败，托盘不可用：%s" % e)
            return
        self.root.withdraw()
        # Tk 回调里的异常默认只往 stderr 写，pythonw 下等于吞掉；至少记进日志
        self.root.report_callback_exception = self._on_tk_error
        # 让 Tk 把顶层外壳窗口真正建出来（withdraw 后它可能还没创建，
        # 这时 GetAncestor 只能拿到子窗口，图标就挂错了地方）
        try:
            self.root.update_idletasks()
        except Exception:
            pass
        hwnd = self.root.winfo_id()
        # 必须挂在**顶层**窗口上：winfo_id() 拿到的是 Tk 的子窗口（class TkChild），
        # 而广播消息（TaskbarCreated、探活）只送给顶层窗口。挂在子窗口上时，
        # 资源管理器一重启就收不到 TaskbarCreated → 图标再也挂不回来，
        # 表现就是「收进托盘一段时间后自己掉了」。
        self._tk_hwnd = hwnd
        self.hwnd = self._resolve_owner(hwnd)
        self.tk = tk

        user32 = ctypes.windll.user32
        self._taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")
        self._shell = user32.GetShellWindow()      # 自检基准，别让首轮误判成"变了"
        self.nid = NOTIFYICONDATA()
        self.nid.cbSize = ctypes.sizeof(NOTIFYICONDATA)
        self.nid.hWnd = self.hwnd
        self.nid.uID = 1
        self.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP  # 少 NIF_MESSAGE 永远收不到点击
        self.nid.uCallbackMessage = WM_TRAYICON
        self.nid.hIcon = load_hicon()
        self.nid.szTip = "宿主成长系统 · 提醒中（单击打开面板，右键退出）"

        cls = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)
        self._keep = cls(self._on_message)          # 必须留引用，否则回调被回收
        user32.SetWindowLongPtrW.restype = ctypes.c_void_p
        user32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_void_p]
        user32.CallWindowProcW.restype = ctypes.c_ssize_t
        user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wt.HWND, wt.UINT,
                                           wt.WPARAM, wt.LPARAM]
        self._hook(self.hwnd)

        self._add_icon()
        self.root.after(80, self._drain)
        log("托盘线程就绪 hwnd=%s 图标=%s" % (self.hwnd, self._added))
        self.root.mainloop()
        log("托盘线程退出")

    def _hook(self, hwnd):
        """把窗口过程换成我们的：托盘消息（WM_TRAYICON）只走这条回调。

        迁移宿主窗口时必须重挂一次——图标挂在哪个窗口，消息就只发给哪个窗口，
        换了窗口不重挂 = 图标看得见、点了没反应。
        """
        self._old_proc = ctypes.windll.user32.SetWindowLongPtrW(
            wt.HWND(hwnd), -4, ctypes.cast(self._keep, ctypes.c_void_p))
        self._hooked = hwnd
        return self._old_proc

    def _resolve_owner(self, hwnd):
        """找到 hwnd 所在的顶层窗口（托盘图标要挂它，广播消息才到得了）。

        Tk 的 winfo_id() 是子窗口 TkChild，真正的顶层外壳是它的祖先（class TkTopLevel）。
        刚建好时祖先链偶尔还没接上，所以这里重试一小会儿；实在找不到就用原窗口，
        后面 _health_check 还会再试一次并迁移图标。
        """
        u32 = ctypes.windll.user32
        u32.GetAncestor.restype = wt.HWND
        u32.GetAncestor.argtypes = [wt.HWND, ctypes.c_uint]
        for _ in range(40):                      # 最多 2 秒
            cand = u32.GetAncestor(wt.HWND(hwnd), 2)   # GA_ROOT
            if cand:
                style = u32.GetWindowLongW(wt.HWND(cand), -16)
                if not (style & 0x40000000):           # 没有 WS_CHILD → 真·顶层
                    return cand
            time.sleep(0.05)
        return u32.GetAncestor(wt.HWND(hwnd), 2) or u32.GetParent(wt.HWND(hwnd)) or hwnd

    def _on_tk_error(self, exc, val, tb):
        """Tk 回调异常（以前直接写 stderr，pythonw 下等于丢进黑洞）。"""
        try:
            import traceback
            log("Tk 回调异常：%s" % "".join(traceback.format_exception(exc, val, tb)).strip()[-800:])
        except Exception:
            pass

    def _add_icon(self):
        if not self._added:
            if ctypes.windll.shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(self.nid)):
                self._added = True
            else:
                log("Shell_NotifyIcon(NIM_ADD) 失败 GetLastError=%s" % ctypes.get_last_error())
        return self._added

    def _remove_icon(self):
        try:
            ctypes.windll.shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self.nid))
        except Exception:
            pass
        self._added = False

    def _on_message(self, hwnd, msg, wparam, lparam):
        """窗口过程。这里绝不能重入 Tk（它就是在 Tk 处理消息的回调里），只入队。"""
        try:
            if msg == WM_TRAYICON:
                mouse = lparam & 0xFFFF
                self.clicks.append(mouse)
                # 鼠标划过图标会刷出几百条 0x0200，全记下来只会把日志淹掉
                if mouse != 0x0200:
                    log("收到托盘消息 mouse=0x%04X" % mouse)
                self._pending.append(mouse)
                return 0
            if msg == WM_PROBE:
                self.pongs += 1
                # 回一声：探活方只认 WM_PONG。以前这里只入队不回话，
                # 于是「有没有活宿主」永远问不出结果（日志里永远是应答 0 次）。
                target = wparam or 0xFFFF
                try:
                    ctypes.windll.user32.PostMessageW(wt.HWND(target), WM_PONG, 0, 0)
                except Exception:
                    pass
                self._pending.append("pong")
                return 0
            if msg == self._taskbar_created:
                log("TaskbarCreated：资源管理器重启，重挂图标")
                self._pending.append("readd")
                return 0
        except Exception as e:
            log("窗口过程异常：%s" % e)
        return ctypes.windll.user32.CallWindowProcW(
            self._old_proc, hwnd, msg, wparam, lparam)

    def _drain(self):
        # 必须用不含睡眠的时钟：用 monotonic 的话，睡眠期间的跳变会让 watchdog
        # 在每次唤醒后误判「托盘线程已死」（见 steady_clock 的说明）。
        self.state["tray_beat"] = steady_clock()
        # 对 watchdog 的探活回一个序号：这条才是「Tk 事件循环真的转起来了」的证据，
        # 时间戳只能证明过去。（旧的判死逻辑就是拿时间戳当证据，四次误杀）
        self.state["tray_ack"] = self.state.get("tray_probe", 0)
        # 整个回调包一层：以前只要这里抛一次异常，after 链就断在半路，
        # 之后图标还在、却再也不理任何点击（也不报错、也不退出）——最难查的那种。
        try:
            self._drain_once()
        except Exception as e:
            log("托盘轮询异常：%s" % e)
        finally:
            self._ticks = getattr(self, "_ticks", 0) + 1
            try:
                self._ensure_owner()                 # 顶层外壳一出现就把图标迁过去
            except Exception as e:
                log("托盘宿主检查异常：%s" % e)
            if self._ticks % 180 == 0:               # 约 15 秒
                try:
                    self._health_check()
                except Exception as e:
                    log("托盘自检异常：%s" % e)
            self.root.after(80, self._drain)

    def _ensure_owner(self):
        """图标还没挂到顶层窗口上就迁过去（Tk 的顶层外壳可能晚一点才建出来）。"""
        user32 = ctypes.windll.user32
        best = self._resolve_owner(getattr(self, "_tk_hwnd", self.hwnd))
        if best == self.hwnd:
            return
        if user32.GetWindowLongW(wt.HWND(best), -16) & 0x40000000:
            return                                   # 还是子窗口，等下次
        log("托盘宿主窗口迁到顶层：%s → %s" % (self.hwnd, best))
        self._remove_icon()
        self.hwnd = best
        self.nid.hWnd = best
        self._hook(best)                         # 换窗口必须重挂窗口过程
        self._added = False
        self._add_icon()

    def _health_check(self):
        """图标丢了自己挂回来。

        资源管理器重启（或托盘区重建）会把图标清掉，靠 TaskbarCreated 广播能补一次，
        但那是一条广播——收到才算数。这里再加一道兜底：shell 窗口句柄变了、或者
        图标状态被标成没挂上，就直接重挂，不用等人去点。
        """
        user32 = ctypes.windll.user32
        shell = user32.GetShellWindow()
        if shell != getattr(self, "_shell", None):
            log("shell 窗口变了（资源管理器重启？）→ 重挂图标")
            self._shell = shell
            self._added = False
            self._remove_icon()
            self._add_icon()
        elif not self._added:
            self._add_icon()

    def _drain_once(self):
        while self._pending:
            item = self._pending.pop(0)
            try:
                if item == "readd":
                    self._added = False
                    self._remove_icon()
                    self._add_icon()
                elif item == "pong":
                    log("探活应答")
                elif item == "quit":
                    # 清图标必须在托盘线程里做（图标归这个线程的 Tk 窗口所有）
                    self._remove_icon()
                    threading.Thread(target=quit_all, args=(self.state,),
                                     daemon=True).start()
                    return            # 不再续命，主循环随之结束
                elif item in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
                    self._request_show()
                elif item == WM_RBUTTONUP:
                    self._dispatch(self._menu())
            except Exception as e:
                log("处理托盘事件异常：%s" % e)

    def _request_show(self):
        """去抖：一次双击连发 ONUP → DBLCLK → UP 三条消息，逐条响应会反复开关。"""
        now = time.monotonic()
        if now - self._last_show < CLICK_DEBOUNCE_SEC:
            return
        self._last_show = now
        threading.Thread(target=show_panel, daemon=True).start()

    def _menu(self):
        user32 = ctypes.windll.user32
        hmenu = user32.CreatePopupMenu()
        user32.AppendMenuW(hmenu, MF_STRING, ID_OPEN, "打开面板")
        flag = MF_CHECKED if autostart_enabled() else 0
        user32.AppendMenuW(hmenu, MF_STRING | flag, ID_AUTOSTART, "开机自启")
        user32.AppendMenuW(hmenu, MF_STRING, ID_QUIT, "退出")
        pt = wt.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        user32.SetForegroundWindow(self.hwnd)   # 不抢前台，点菜单外面菜单不消失
        # TPM_RETURNCMD 让 TrackPopupMenu 直接返回选中项。不用 WM_COMMAND：创建菜单时
        # 窗口过程已被换成我们的，命令消息会被漏掉——那正是「点了没反应」。
        cmd = user32.TrackPopupMenu(hmenu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                                    pt.x, pt.y, 0, wt.HWND(self.hwnd), None)
        user32.PostMessageW(wt.HWND(self.hwnd), 0, 0, 0)
        user32.DestroyMenu(hmenu)
        log("右键菜单选择 cmd=%s" % cmd)
        return cmd

    def _dispatch(self, cmd):
        if not cmd:
            log("右键菜单被取消（没选中任何项）")
            return
        if cmd == ID_OPEN:
            self._request_show()
        elif cmd == ID_AUTOSTART:
            set_autostart(not autostart_enabled())
        elif cmd == ID_QUIT:
            self._pending.append("quit")
        else:
            # 这种情况在旧代码里很常见：TrackPopupMenu 没加 TPM_RETURNCMD 时返回布尔值 1，
            # 菜单命令一条都匹配不上 → 点了像没反应。
            log("未知菜单项 cmd=%s（预期 %s/%s/%s）" % (cmd, ID_OPEN, ID_AUTOSTART, ID_QUIT))


# ── 面板窗口：拦 WM_CLOSE → 收进托盘 ──
def install_close_handler(state, hwnd=None):
    """等面板窗口出现，子类化它的窗口过程，把 WM_CLOSE 变成「收进托盘」。

    只拦 WM_CLOSE（这条实测可靠）。托盘消息不走这个窗口，见 TrayThread 的说明。
    hwnd 传入时不搜索窗口（测试用）。
    """
    user32 = ctypes.windll.user32
    cls_name = ""
    if hwnd is None:
        for _ in range(600):
            if state["quitting"]:
                return
            found = user32.FindWindowW(None, "宿主成长系统")
            if found:
                buf = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(found, buf, 256)
                # 只认 pywebview 的 WinForms 窗口。Windows 自己也有同名窗口
                # （实测找到过 Windows.Internal.Shell.TabProxyWindow），拦错了关窗就不生效。
                if buf.value.startswith("WindowsForms10."):
                    hwnd, cls_name = found, buf.value
                    break
            time.sleep(0.1)
        else:
            log("没等到面板窗口，关窗将直接退出")
            return

    cls = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)

    def proc(h, msg, wp, lp):
        if msg == WM_CLOSE and not state["quitting"]:
            log("拦到 WM_CLOSE → 收进托盘")
            threading.Thread(target=hide_panel, daemon=True).start()
            return 0
        return user32.CallWindowProcW(old, h, msg, wp, lp)

    keep = cls(proc)          # 留引用防回收
    user32.SetWindowLongPtrW.restype = ctypes.c_void_p
    user32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_void_p]
    user32.CallWindowProcW.restype = ctypes.c_ssize_t
    user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wt.HWND, wt.UINT,
                                       wt.WPARAM, wt.LPARAM]
    old = user32.SetWindowLongPtrW(wt.HWND(hwnd), -4,
                                   ctypes.cast(keep, ctypes.c_void_p))
    state["close_handler"] = keep    # 防 GC
    log("关窗处理已安装 hwnd=%s class=%s" % (hwnd, cls_name or "?"))
    return True


# ── 开机自启 ──
def autostart_enabled():
    return os.path.exists(SHORTCUT)


def set_autostart(enable):
    """启动文件夹快捷方式（免管理员），指向本脚本：一个进程搞定提醒 + 唤面板。"""
    if not enable:
        try:
            os.remove(SHORTCUT)
            log("已关闭开机自启")
            return True
        except OSError:
            return False
    try:
        import subprocess
        ps = (
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}');"
            "$s.TargetPath='{py}';$s.Arguments='\"{script}\"';"
            "$s.WorkingDirectory='{wd}';$s.WindowStyle=7;$s.Save()"
        ).format(lnk=SHORTCUT, py=sys.executable, script=os.path.abspath(__file__), wd=HERE)
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, timeout=20, creationflags=0x08000000)
        log("已开启开机自启：%s" % os.path.exists(SHORTCUT))
        return os.path.exists(SHORTCUT)
    except Exception as e:
        log("创建自启快捷方式失败：%s" % e)
        return False


class Api:
    """暴露给页面 JS 的桥（window.pywebview.api.*）。"""

    def notify(self, title, msg):
        from notifier import send_toast
        send_toast(title, msg)


def resolve_port():
    state = probe_port(PORT)
    if state == "ours":
        return PORT, False
    if state == "other":
        return find_free_port(PORT + 1), True
    return PORT, True


def start_server(port):
    from server import Handler as H
    try:
        s = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    except OSError:
        return None
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def start_notifier():
    try:
        from notifier import poll_loop
        threading.Thread(target=poll_loop, daemon=True).start()
    except Exception as e:
        log("提醒线程启动失败：%s" % e)


def steady_clock():
    """**不含系统睡眠**的单调时钟（秒）。

    为什么不能用 time.monotonic()：CPython 3.12 在 Windows 上把它实现成
    GetTickCount64，**睡眠期间照样走**。实测本机开机 4 天里睡了 2.5 天，
    monotonic 比不含睡眠的时钟多走了 219279 秒。拿它算「托盘线程 3 秒没心跳」，
    合盖一觉醒来差值就是几个小时 → 判据必然成立 → watchdog 直接自杀。
    2026-11-09 14:45、23:39、2026-11-10 19:03 三次「托盘自己没了」都是这个原因，
    三次都精确落在系统唤醒后 1~8 秒内。

    QueryUnbiasedInterruptTime 是官方口径的「不含睡眠」计时器，单位 100ns。
    """
    try:
        v = ctypes.c_ulonglong()
        if ctypes.windll.kernel32.QueryUnbiasedInterruptTime(ctypes.byref(v)):
            return v.value / 1e7
    except Exception:
        pass
    return time.monotonic()          # 极端兜底：至少还是单调的


def tray_heartbeat(state, clock=None):
    """托盘线程**最近**还在动吗：它每轮 _drain 都会刷一次时间戳。

    注意：这只说明「过去某一刻它还在」，不能用来判死。判死必须用 tray_alive()。
    clock 可注入（测试用）：传 None 就用 steady_clock。
    """
    clock = clock or steady_clock
    return clock() - state.get("tray_beat", 0.0) < 3.0


TRAY_PROBE_WAIT = 10.0      # 等托盘回一个序号，最多等这么久
TRAY_PROBE_MISS = 3         # 连续几次问不到才判死


def tray_alive(state, wait=TRAY_PROBE_WAIT):
    """让托盘线程亲口回一句：回得上 = 它的 Tk 事件循环真的在转。

    为什么不用「上次心跳时间戳」判死：时间戳只能证明过去，而系统睡眠会把整段
    等待压成一次跳变，判定边界永远踩在唤醒瞬间。实测 2026-11-09 14:45、
    11-09 23:39、11-10 19:03、11-12 12:30 四次自愈退出**全部**落在唤醒后
    1~8 秒内，四次都是误杀，真幽灵一次没抓到。
    改成「问一句、等回话」之后，判据不再依赖任何时钟语义。
    """
    state["tray_probe"] = state.get("tray_probe", 0) + 1
    want = state["tray_probe"]
    deadline = steady_clock() + wait
    while steady_clock() < deadline:
        if state.get("tray_ack", 0) >= want:
            return True
        time.sleep(0.1)
    return state.get("tray_ack", 0) >= want


def redirect_stderr():
    """pythonw 没有控制台：未捕获的异常连栈都留不下（sys.stderr 是 None）。

    托盘线程一旦因为异常悄悄死掉，界面只表现为「图标不见了」，什么线索都没有。
    把 stdout/stderr 接到 data/stderr.log，下次至少能看到 traceback。
    """
    try:
        f = open(os.path.join(HERE, "data", "stderr.log"), "a",
                 encoding="utf-8", buffering=1)
    except OSError:
        return
    if sys.stderr is None:
        sys.stderr = f
    if sys.stdout is None:
        sys.stdout = f


def panel_visible():
    """面板窗口是不是真的显示着（pywebview 的 Window.hidden 从来不更新，不能拿来判断）。"""
    user32 = ctypes.windll.user32
    hwnd = user32.FindWindowW(None, "宿主成长系统")
    if not hwnd:
        return None                    # 窗口还没建出来
    return bool(user32.IsWindowVisible(wt.HWND(hwnd)))


def watchdog(state, grace=120.0):
    """自愈：启动两分钟后托盘心跳停了、面板又看不见 = 这个进程已不可用。

    pywebview 的 webview.start() 在窗口销毁后有时不返回（.NET 消息循环空转），
    进程就变成「看不见、点不动、关不掉」的幽灵，下次启动还被锁端口拦在门外。
    真出现这种情况就自己结束，别赖在后台。

    注意：隐藏到托盘（面板不可见）是正常状态，所以判据是**托盘线程真的不应声**才算死。
    判据用 tray_alive()（问一句等回话），不用时间戳——时间戳判死实测误杀 4 次，
    每次都发生在系统睡眠唤醒的瞬间（见 tray_alive 的说明）。
    """
    started = steady_clock()
    last_beat = steady_clock()
    miss = 0
    # 唤醒检测：墙上时钟走得比「不含睡眠」的时钟快很多 = 刚从睡眠回来。
    # 这时托盘线程可能还没被调度，第一轮别急着判（判定边界永远踩在唤醒瞬间，
    # 四次误杀全在这里）。
    wall = time.time()
    while not state["quitting"]:
        time.sleep(5)
        # 每 10 分钟记一条心跳：进程要是被硬杀（睡眠唤醒后崩溃、任务管理器、蓝屏前兆），
        # 日志里至少能看出"最后一次活着是什么时候"，否则只剩一片空白没法判断。
        if steady_clock() - last_beat > 600:
            last_beat = steady_clock()
            try:
                log("心跳：面板可见=%s 托盘=%s" % (panel_visible(), tray_heartbeat(state)))
            except Exception:
                pass
        # 本轮墙上时间多走了多少，而不含睡眠的时钟只走了 5 秒 → 中间睡过
        wall_now = time.time()
        if wall_now - wall > 60:
            log("检测到系统睡眠唤醒（墙上时间跳了 %.0f 秒）→ 本轮不判定" % (wall_now - wall))
            wall = wall_now
            miss = 0
            started = steady_clock()     # 重新给一轮宽限，等托盘线程回来
            continue
        wall = wall_now
        if steady_clock() - started < grace:
            continue
        visible = panel_visible()
        if visible is None:
            continue                   # 窗口还没出来，不判
        if visible:
            miss = 0
            continue                   # 面板可见 = 进程明显可用，不必探活
        # 面板在托盘里：只有托盘线程连续几次都不回话才算死
        if tray_alive(state):
            miss = 0
            continue
        miss += 1
        log("托盘线程没应声（第 %d/%d 次）" % (miss, TRAY_PROBE_MISS))
        if miss >= TRAY_PROBE_MISS:
            # 判死之后的动作很关键：以前直接 quit_all()，结果是「程序凭空消失」，
            # 用户第二天只看到托盘没了。判对了也不该让程序不见——重新拉一个干净进程，
            # 判错了（睡眠唤醒那种）也能立刻恢复，代价只是重启一次。
            log("托盘线程确认无响应 → 重启自身而不是消失")
            restart_self(state, state.get("lock"))
            sys.stdout.flush()
            os._exit(0)              # 必须真退出，否则锁端口不放、新进程起不来


def main():
    os.chdir(HERE)
    redirect_stderr()
    state = {"quitting": False}
    lock = acquire_lock()
    state["lock"] = lock          # watchdog 重启自身时要用它放开锁端口
    if lock is None:
        # 锁被占不一定是活窗口：也可能是个已经不可用的旧进程。先问托盘有没有人应声。
        if probe_tray_host() == 0:
            log("锁端口有占用但托盘无人应答（多半是残留进程）")
            wake_existing()   # 至少试着让它亮出来，让人能看到并手动退出
            return 0
        wake_existing()       # 已有窗口在托盘里：唤起它，不再起第二个
        return 0
    probe_tray_host()         # 只做记录：有应声说明托盘上还有别的活宿主（提醒服务）
    port, need_start = resolve_port()
    if need_start:
        start_server(port)
    start_notifier()
    log("启动：端口=%s 锁=%s 图标=%s" % (port, LOCK_PORT, os.path.exists(ICON_FILE)))

    window = webview.create_window("宿主成长系统", f"http://127.0.0.1:{port}",
                                   width=1120, height=880, min_size=(760, 600), js_api=Api(),
                                   text_select=True)  # 允许选中/复制文字：False（默认）会注入 user-select:none，
                                                      # 且 WebView2 后端只在 debug 模式给右键菜单，两头都堵死复制
    # 关窗收进托盘：走 pywebview 的 closing 事件，不再子类化窗口过程
    CloseToTray(state).attach(window)
    threading.Thread(target=serve_wakeups,
                     args=(lambda: threading.Thread(target=show_panel, daemon=True).start(), lock),
                     daemon=True).start()
    # 兜底：只有 closing 事件装不上（窗口对象缺 events）时才回到旧的窗口过程方案
    if not hasattr(window, "events"):
        threading.Thread(target=install_close_handler, args=(state,), daemon=True).start()
    TrayThread(state).start()
    threading.Thread(target=watchdog, args=(state,), daemon=True).start()

    webview.start(private_mode=False,  # 关闭隐私模式 → localStorage 跨会话持久保存
                  storage_path=os.path.join(os.environ["LOCALAPPDATA"], "growth_system_webview"),
                  icon=ICON_FILE)

    # 走到这里说明 GUI 循环结束了（窗口被销毁 / WebView2 挂了 / 睡眠唤醒后没恢复）。
    # 以前直接 return，进程无声无息消失：日志没有、崩溃记录没有，用户只看到「托盘没了」。
    log("webview.start() 已返回：窗口循环结束（quitting=%s）" % state.get("quitting"))
    if not state.get("quitting"):
        log("窗口意外消失 → 尝试自动重启")
        restart_self(state, lock)
    return 0


def restart_self(state, lock=None, limit=3, window_sec=600):
    """窗口没了但用户没让退出：自己再起一个新进程，别只剩下一个空壳。

    频繁崩溃时最多 10 分钟内重启 3 次，超过就放弃（把「崩溃循环」变成一条日志，
    而不是无限弹窗）。"""
    try:
        hist = [t for t in _restart_history() if time.time() - t < window_sec]
    except Exception:
        hist = []
    if len(hist) >= limit:
        log("最近 %d 秒内已重启 %d 次，不再自动重启" % (window_sec, len(hist)))
        return False
    hist.append(time.time())
    try:
        _save_restart_history(hist)
    except Exception:
        pass
    # 先松手：不释放锁端口的话，新进程会把自己当成"已有一个活宿主"而直接退出
    state["quitting"] = True
    try:
        if lock is not None:
            lock.close()
    except Exception:
        pass
    time.sleep(0.3)
    try:
        import subprocess
        subprocess.Popen([sys.executable, os.path.abspath(__file__)],
                         cwd=HERE, close_fds=True,
                         creationflags=0x00000008)   # DETACHED_PROCESS
        log("已拉起新进程")
    except Exception as e:
        log("自动重启失败：%s" % e)
        return False
    return True


def _restart_history():
    try:
        with open(RESTART_FILE, encoding="utf-8") as f:
            return [float(x) for x in f.read().split() if x]
    except (OSError, ValueError):
        return []


def _save_restart_history(hist):
    with open(RESTART_FILE, "w", encoding="utf-8") as f:
        f.write(" ".join("%.0f" % t for t in hist))


if __name__ == "__main__":
    raise SystemExit(main())