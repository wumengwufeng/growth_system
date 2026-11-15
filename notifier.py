"""notifier.py — 任务发布提醒（桌面版后台轮询）。

只读 data/growth.json，不写存档：用与 js/core.js 完全一致的确定性算法
（fnv1a + mulberry32，经 tests/plan_parity.py 对拍验证）计算当天发布时刻，
到点发 Windows toast。面板若已打开并处理过该槽位（状态非 waiting）则静默跳过。
"""
import json
import os
import time
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
M = 0xFFFFFFFF


def fnv1a(s):
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & M
    return h


def mulberry32(a):
    state = a & M
    def rnd():
        nonlocal state
        state = (state + 0x6D2B79F5) & M
        a = state
        t = a ^ (a >> 15)
        t = (t * (1 | a)) & M
        u = t ^ (t >> 7)
        t = ((t + ((u * (61 | t)) & M)) & M) ^ t
        return ((t ^ (t >> 14)) & M) / 4294967296
    return rnd


def plan_day(day_str, salt, win):
    r = mulberry32(fnv1a(f"{day_str}|{salt}"))
    sh, sm = map(int, win["start"].split(":"))
    eh, em = map(int, win["end"].split(":"))
    frm = sh * 60 + sm
    to = max(eh * 60 + em, frm + 60)
    count = 2 + (1 if r() < 0.45 else 0)
    slots = [{"at": frm + int(r() * (to - frm)), "kind": "burst" if r() < 0.32 else "side"}
             for _ in range(count)]
    slots.sort(key=lambda s: s["at"])
    return slots


def send_toast(title, msg):
    try:
        from winotify import Notification
        Notification(app_id="宿主成长系统", title=title, msg=msg).show()
        return True
    except Exception as e:
        print("[notifier] toast 失败:", e)
        return False


# 与 js/core.js 的 OFFLINE_GAP_MIN 保持一致：两轮轮询间隔超过它 → 电脑睡过/关过
OFFLINE_GAP_MIN = 30


def fmt_gap(minutes):
    m = int(round(minutes or 0))
    return "{} 小时".format(round(m / 60, 1)) if m >= 60 else "{} 分钟".format(max(1, m))


def remind_text(due, gap_min=None):
    """把本轮到点的槽位合成一条提醒。

    电脑刚从睡眠/关机恢复时，可能一次就有好几个槽位同时到点——逐条弹会把屏幕糊住，
    也没人愿意逐条读。这里合并成一条，并在"隔了很久才轮询到"时说明补救口径。
    """
    times = " / ".join("{:02d}:{:02d}".format(s["at"] // 60, s["at"] % 60) for s in due)
    bursts = sum(1 for s in due if s["kind"] == "burst")
    away = gap_min is not None and gap_min >= OFFLINE_GAP_MIN
    if len(due) == 1:
        msg = "叮！系统到了发布时刻（{}），打开面板查看新任务。".format(times)
        if bursts:
            msg += "此为突发限时任务，奖励 ×2！"
        if away:
            msg += "（你离开了约 {}，任务会按你打开面板的时刻重新计时）".format(fmt_gap(gap_min))
        return msg
    msg = "叮！你不在的时候系统到了 {} 次发布时刻（{}），打开面板查看。".format(len(due), times)
    if bursts:
        msg += "其中 {} 个突发限时任务（奖励 ×2）。".format(bursts)
    msg += "错过的提醒已补上，打开面板后任务会重新计时。"
    return msg


def _state_path(save_path):
    return os.path.join(os.path.dirname(save_path), "notified.json")


def load_notified(save_path):
    """已通知的键要落盘：只放内存的话，托盘进程每次重启都会把同一条再弹一遍。"""
    try:
        with open(_state_path(save_path), encoding="utf-8") as f:
            raw = json.load(f)
        return {tuple(k) for k in raw if isinstance(k, list) and len(k) == 3}
    except (OSError, ValueError):
        return set()


def save_notified(save_path, notified):
    try:
        with open(_state_path(save_path), "w", encoding="utf-8") as f:
            json.dump(sorted(notified), f, ensure_ascii=False)
    except OSError:
        pass


def poll_once(save_path=None, notified=None, notify=send_toast, now=None, gap_min=None,
              persist=False):
    """跑一轮轮询。返回本轮新提醒的槽数（测试用）。

    gap_min：距上一轮轮询的分钟数。超过 OFFLINE_GAP_MIN 说明电脑睡过/关过，
    这期间的提醒没人接收，措辞与面板的补救逻辑保持一致。
    persist：常驻服务传 True——把已通知键落盘，避免进程重启后重复弹同一条。
    """
    save_path = save_path or os.path.join(HERE, "data", "growth.json")
    if notified is None:
        notified = load_notified(save_path) if persist else set()
    if not os.path.exists(save_path):
        return 0
    with open(save_path, encoding="utf-8") as f:
        d = json.load(f)
    st = d.get("settings", {})
    win = {"start": st.get("dayStart", "09:00"), "end": st.get("dayEnd", "22:00")}
    now = now or datetime.now()
    today = now.strftime("%Y-%m-%d")
    now_m = now.hour * 60 + now.minute

    # notified 只保留今天与昨天的键：常驻运行几天后会无限增长，且旧键永远用不上
    if notified:
        keep = {today}
        y = now - timedelta(days=1)
        keep.add(y.strftime("%Y-%m-%d"))
        for k in [k for k in notified if k[0] not in keep]:
            notified.discard(k)

    slots = plan_day(today, d.get("created", 0), win)
    day = d.get("days", {}).get(today, {})
    handled = {s.get("at") for s in day.get("slots", []) if s.get("status") != "waiting"}

    # 今日全部完成任务 → 发一次收尾鼓励（每天仅一次）
    done_all = False
    todays = day.get("slots", [])
    published = [s for s in todays if s.get("status") not in ("waiting",)]
    if published and all(s.get("status") == "done" for s in published):
        done_all = True

    fired = 0
    due = []
    for sl in slots:
        if sl["at"] > now_m:
            continue
        key = (today, sl["at"], sl["kind"])
        if key in notified:
            continue
        notified.add(key)
        if sl["at"] in handled:
            continue  # 面板已发布/处理过，页面内会有提示
        if sl["kind"] == "burst" and now_m - sl["at"] > 120:
            continue  # 突发任务 2 小时未响应已被系统收回，不再打扰
        due.append(sl)
    # 合并成一条：睡眠唤醒/关机一天后回来，一次可能到点 2~3 个槽位
    if due:
        notify("宿主成长系统", remind_text(due, gap_min))
        fired += len(due)

    if done_all:
        key = (today, "alldone", "done")
        if key not in notified:
            notified.add(key)
            notify("宿主成长系统", "今日任务全部完成。系统记录在案，宿主可以休息了。")
            fired += 1

    if persist:
        save_notified(save_path, notified)
    return fired


def poll_loop(stop_check=None, save_path=None, quiet_when=None):
    """常驻轮询。quiet_when：返回 True 时本轮只更新「已通知」状态、不弹窗。

    用来避免两个常驻进程重复打扰：桌面版（关窗后仍在托盘里）自己会弹提醒，
    此时独立的托盘脚本应当让路；桌面版退出后它自动接回，中间不丢不重。
    仍然照常记录已通知键，所以谁先弹过，另一份就不会再弹。
    """
    save_path = save_path or os.path.join(HERE, "data", "growth.json")
    notified = load_notified(save_path)   # 跨进程重启去重：否则每次启动都会重弹同一条
    last = time.time()
    while True:
        # 间隔远大于 60 秒 → 电脑睡过/被挂起，这期间的提醒没人接收
        gap_min = (time.time() - last) / 60
        last = time.time()
        try:
            quiet = False
            if quiet_when:
                try:
                    quiet = bool(quiet_when())
                except Exception:
                    quiet = False
            poll_once(save_path=save_path, notified=notified, gap_min=gap_min, persist=True,
                      notify=(lambda *a, **k: False) if quiet else send_toast)
        except Exception as e:
            print("[notifier] 轮询异常:", e)
        if stop_check and stop_check():
            break
        time.sleep(60)


if __name__ == "__main__":
    print("单轮测试（读取 data/growth.json 并对到期槽位实发 toast）：")
    print("fired =", poll_once())
