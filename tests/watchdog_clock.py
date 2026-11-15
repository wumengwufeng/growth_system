"""watchdog 判死判据测试：托盘线程还活着时，绝不许被判死。

两代 bug 都在这里钉住：

① 时钟语义（2026-11-09 / 11-10）：
   CPython 3.12 在 Windows 上 time.monotonic() = GetTickCount64，**睡眠期间照样走**。
   拿它算「3 秒没心跳」，合盖一觉醒来差值就是几小时 → 判据必然成立 → 自杀。
   实测本机 monotonic 比 QueryUnbiasedInterruptTime 多走 329343 秒（91 小时）。

② 判据结构（2026-11-12 12:30，换过时钟后**仍然**自杀）：
   改用不含睡眠的时钟只解决一半。四次自愈退出（11-09 14:45、11-09 23:39、
   11-10 19:03、11-12 12:30）全部落在系统唤醒后 1~8 秒内，一次真幽灵都没抓到 ——
   「上次心跳时间戳」只能证明过去，而睡眠把整段等待压成一次跳变，判定边界永远
   踩在唤醒瞬间。现在改成「问一句、等托盘回一个序号」（tray_alive），
   判据不再依赖任何时钟语义。

运行：python tests/watchdog_clock.py
"""
import ctypes
import importlib.util
import os
import sys
import threading
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join(HERE, "宿主成长系统.pyw")

fails = 0


def A(name, cond, extra=""):
    global fails
    print(("ok: " if cond else "FAIL: ") + name + (("  → " + str(extra)) if extra and not cond else ""))
    if not cond:
        fails += 1


def load_desktop():
    """只 import 桌面版模块（不调 main），拿判据函数。"""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    spec = importlib.util.spec_from_file_location("desktop_clock_mod", ENTRY)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def unbiased_now():
    v = ctypes.c_ulonglong()
    ctypes.windll.kernel32.QueryUnbiasedInterruptTime(ctypes.byref(v))
    return v.value / 1e7


def main():
    m = load_desktop()

    # —— ① 时钟语义 ——
    mono = time.monotonic()
    unb = unbiased_now()
    ours = m.steady_clock()
    A("steady_clock 与 QueryUnbiasedInterruptTime 一致（±1s）",
      abs(ours - unb) < 1.0, "ours=%.1f unbiased=%.1f" % (ours, unb))
    A("steady_clock 明显小于 monotonic（证明不含睡眠）",
      ours < mono - 60,
      "steady=%.1f monotonic=%.1f 差=%.0fs" % (ours, mono, mono - ours))

    now = 1000.0
    st = {"tray_beat": now}
    A("心跳新鲜 → tray_heartbeat 为真", m.tray_heartbeat(st, clock=lambda: now + 0.5) is True)
    A("时钟跳过 4 小时 → tray_heartbeat 为假（旧判据就是这样误杀的）",
      m.tray_heartbeat(st, clock=lambda: now + 4 * 3600) is False)

    # —— ② 判据结构：tray_alive 必须放过「心跳时间戳很旧但线程还在动」的托盘 ——
    # 这正是唤醒瞬间的样子：时钟跳了很久，Tk 循环其实转得好好的。
    alive = {"tray_beat": now, "tray_probe": 0, "tray_ack": 0}
    stop = []

    def drain_loop():
        # 模拟 _drain：时间戳被睡眠拉旧，但收到探活仍然回序号
        while not stop:
            alive["tray_beat"] = now + 4 * 3600
            alive["tray_ack"] = alive.get("tray_probe", 0)
            time.sleep(0.05)

    t = threading.Thread(target=drain_loop, daemon=True)
    t.start()
    try:
        A("托盘还在动 + 心跳时间戳被睡眠拉旧 → tray_alive 判活（旧判据判死）",
          m.tray_alive(alive, wait=2.0) is True)
    finally:
        stop.append(1)
        t.join(timeout=1)

    # —— 真死必须仍能判死，别把自愈修没了 ——
    dead = {"tray_beat": now, "tray_probe": 0, "tray_ack": 0}   # 没人回话
    t0 = time.time()
    A("托盘真的不动了 → tray_alive 判死（自愈没被改坏）",
      m.tray_alive(dead, wait=0.4) is False)
    A("判死要真的等满等待窗口（不是立刻返回）", time.time() - t0 >= 0.35)

    # —— 源码层面钉住 ——
    src = open(ENTRY, encoding="utf-8").read()
    A("_drain 用 steady_clock 写心跳", 'self.state["tray_beat"] = steady_clock()' in src)
    A("_drain 会回探活序号", 'self.state["tray_ack"] = self.state.get("tray_probe", 0)' in src)
    wd = src.split("def watchdog(")[1].split("def main(")[0]
    body = wd.split('"""')
    code = [ln for ln in (body[-1] if len(body) > 2 else wd).splitlines()
            if ln.strip() and not ln.strip().startswith("#")]
    A("watchdog 不再用 tray_heartbeat 判死",
      not any("tray_heartbeat(state)" in ln and "if" in ln for ln in code),
      [ln.strip() for ln in code if "tray_heartbeat(state)" in ln])
    A("watchdog 用 tray_alive 判死", "tray_alive(state)" in wd)
    A("判死要求连续多次没应声", "TRAY_PROBE_MISS" in wd)
    A("watchdog 代码里不出现 time.monotonic()",
      not any("time.monotonic()" in ln for ln in code))
    # 唤醒当轮必须放过：判定边界永远踩在唤醒瞬间，这是四次误杀的直接现场
    A("唤醒后当轮不判定（墙上时间跳变检测）", "检测到系统睡眠唤醒" in wd)
    A("唤醒后重新给宽限期", "started = steady_clock()" in wd.split("检测到系统睡眠唤醒")[1])
    # 判死后的动作：不许让程序凭空消失（四次事故的真实观感就是「托盘自己没了」）
    A("判死后重启自身而不是退出", "restart_self" in wd and "quit_all(state)" not in wd)
    A("重启后必须真退出以放开锁端口", "os._exit(0)" in wd)
    A("main 把 lock 存进 state 供 watchdog 用", 'state["lock"] = lock' in src)

    # —— ③ 回路测试：直接跑 watchdog() 本体，验证它到底会不会误杀 ——
    # 把时钟/退出/重启都换成假的，只保留被验证的控制流。
    class FakeTime:
        def __init__(self):
            self.n = 0
            self.limit = 10 ** 9
            self.on_sleep = None
        def sleep(self, _d):
            self.n += 1
            if self.on_sleep:
                self.on_sleep()
        def time(self):
            return 1000.0 + self.n * 5      # 每轮 5 秒，不会触发唤醒判定
        def strftime(self, fmt):
            return "00-00 00:00:00"

    class FakeOS:
        def __init__(self):
            self.exited = []
        def _exit(self, code):
            self.exited.append(code)
        # log() 会用到这几个；日志在测试里没有意义，吞掉即可
        def makedirs(self, *a, **k):
            raise OSError("测试环境不写日志")
        class path:
            @staticmethod
            def dirname(p):
                return ""
            @staticmethod
            def join(*a):
                return ""

    real_time, real_os, real_visible = m.time, m.os, m.panel_visible
    real_restart = m.restart_self
    try:
        ft = FakeTime()
        fo = FakeOS()
        calls = []
        m.time = ft
        m.os = fo
        m.panel_visible = lambda: False          # 面板在托盘里（最容易误杀的状态）

        def fake_restart(state, lock=None, **kw):
            calls.append("restart")
            state["quitting"] = True             # 真实现会这么做
            return True

        # (a) 托盘活着：跑 30 轮，绝不许重启
        m.restart_self = fake_restart
        m.tray_alive = lambda st, wait=None: True
        st = {"quitting": False}
        ft.n = 0
        ft.limit = 30
        ft.on_sleep = lambda: st.__setitem__("quitting", ft.n >= ft.limit)
        m.watchdog(st, grace=0)
        A("托盘活着时跑 30 轮 → 一次都不重启（不误杀）",
          calls == [] and fo.exited == [], "restart=%s exit=%s" % (calls, fo.exited))

        # (b) 托盘真死：必须重启 + 真退出，而且不是第一次就动手
        calls.clear()
        fo.exited.clear()
        m.tray_alive = lambda st, wait=None: False
        st = {"quitting": False}
        ft.n = 0
        ft.limit = 10 ** 9
        ft.on_sleep = lambda: None
        m.watchdog(st, grace=0)
        A("托盘真死 → 触发重启", calls == ["restart"], calls)
        A("托盘真死 → 真退出以放锁", fo.exited == [0], fo.exited)
        A("重启前先等够 %d 次确认（不是一次就杀）" % m.TRAY_PROBE_MISS,
          ft.n >= m.TRAY_PROBE_MISS, "轮数=%d" % ft.n)
    finally:
        m.time, m.os, m.panel_visible = real_time, real_os, real_visible
        m.restart_self = real_restart

    print()
    if fails:
        print("FAILED: %d 项不通过" % fails)
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
