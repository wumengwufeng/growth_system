"""通知逻辑测试：验证 poll_once 不会重复打扰、能跨天清理、能识别今日全清。

运行：python tests/notifier_logic.py
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from notifier import plan_day, poll_once, remind_text  # noqa: E402

fails = 0


def A(name, cond, extra=""):
    global fails
    print(("ok: " if cond else "FAIL: ") + name + (("  → " + str(extra)) if extra and not cond else ""))
    if not cond:
        fails += 1


def make_save(tmp, days=None, created=1792999742652, start="09:00", end="22:00"):
    d = {"created": created, "settings": {"dayStart": start, "dayEnd": end},
         "days": days or {}}
    p = os.path.join(tmp, "growth.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f)
    return p


def main():
    tmp = tempfile.mkdtemp()
    win = {"start": "09:00", "end": "22:00"}
    today = "2026-10-28"
    slots = plan_day(today, 1792999742652, win)
    first = slots[0]["at"]

    # 1. 首个发布时刻：应发一次提醒
    save = make_save(tmp, days={})
    sent = []
    n = poll_once(save, set(), notify=lambda t, m: sent.append((t, m)),
                  now=datetime(2026, 10, 28, first // 60, first % 60 + 1))
    A("到点会提醒", n >= 1, n)
    A("提醒内容含发布时刻", any("发布时刻" in m for _, m in sent), sent)

    # 2. 同一时刻再跑：不应重复提醒
    notified = set()
    sent2 = []
    now = datetime(2026, 10, 28, first // 60, first % 60 + 1)
    poll_once(save, notified, notify=lambda t, m: sent2.append(m), now=now)
    c1 = len(sent2)
    poll_once(save, notified, notify=lambda t, m: sent2.append(m), now=now)
    A("同一槽位不重复提醒", len(sent2) == c1, f"{c1} -> {len(sent2)}")

    # 3. 面板已处理（状态非 waiting）→ 静默
    save2 = make_save(tmp, days={today: {"slots": [{"at": first, "status": "pending"}]}})
    sent3 = []
    poll_once(save2, set(), notify=lambda t, m: sent3.append(m),
              now=datetime(2026, 10, 28, first // 60, first % 60 + 1))
    A("面板已发布的槽位不打扰", not any("发布时刻" in m for m in sent3), sent3)

    # 4. 突发任务超 2 小时 → 不再打扰
    #    注意：10-28 当天没有 burst 槽位，必须换一个有 burst 的日期（10-30 有）
    burst_day = "2026-10-30"
    b_slots = plan_day(burst_day, 1792999742652, win)
    bursts = [s for s in b_slots if s["kind"] == "burst"]
    A("测试日期确实含突发槽位", len(bursts) > 0, b_slots)
    if bursts:
        b = bursts[0]["at"]
        hh, mm = (b // 60 + 3) % 24, b % 60
        save4 = make_save(tmp, days={})
        sent4 = []
        poll_once(save4, set(), notify=lambda t, m: sent4.append(m),
                  now=datetime(2026, 10, 30, min(23, hh), mm))
        A("突发超窗不再提醒", not any("突发" in m for m in sent4), sent4)

        # 对照：窗口内（发布后 10 分钟）应当提醒
        save4b = make_save(tmp, days={})
        sent4b = []
        poll_once(save4b, set(), notify=lambda t, m: sent4b.append(m),
                  now=datetime(2026, 10, 30, (b + 10) // 60, (b + 10) % 60))
        A("突发窗口内仍会提醒", any("突发" in m for m in sent4b), sent4b)

    # 5. notified 跨天清理：旧键会被丢弃
    notified = {("2026-10-20", 600, "side"), ("2026-10-27", 600, "side")}
    poll_once(make_save(tmp, days={}), notified, notify=lambda t, m: None,
              now=datetime(2026, 10, 28, 23, 0))
    A("跨天后清理过期键", ("2026-10-20", 600, "side") not in notified, sorted(notified)[:3])
    A("保留昨天的键", ("2026-10-27", 600, "side") in notified, sorted(notified))

    # 6. 今日全部完成 → 鼓励提醒（每天一次）
    all_done = {today: {"slots": [{"at": slots[0]["at"], "status": "done"},
                                  {"at": slots[1]["at"], "status": "done"}]}}
    save6 = make_save(tmp, days=all_done)
    sent6 = []
    poll_once(save6, set(), notify=lambda t, m: sent6.append(m),
              now=datetime(2026, 10, 28, 22, 30))
    A("今日全清会发鼓励", any("全部完成" in m for m in sent6), sent6)
    n2 = set()
    sent6b = []
    poll_once(save6, n2, notify=lambda t, m: sent6b.append(m), now=datetime(2026, 10, 28, 22, 30))
    poll_once(save6, n2, notify=lambda t, m: sent6b.append(m), now=datetime(2026, 10, 28, 22, 31))
    A("全清鼓励每天只发一次", sum(1 for m in sent6b if "全部完成" in m) == 1, sent6b)

    # 7. 存档不存在 → 安全返回
    A("无存档时安全返回", poll_once(os.path.join(tmp, "nope.json"), set(),
                                    notify=lambda t, m: None) == 0)

    # 8. 一轮里多个槽位同时到点（睡眠唤醒/关机一天后回来）→ 合并成一条
    many_day = "2026-11-03"
    m_slots = plan_day(many_day, 1792999742652, win)
    last = m_slots[-1]["at"]
    save8 = make_save(tmp, days={})
    sent8 = []
    n8 = poll_once(save8, set(), notify=lambda t, m: sent8.append(m),
                   now=datetime(2026, 11, 3) + timedelta(minutes=last + 1))
    expect8 = [s for s in m_slots if not (s["kind"] == "burst" and last - s["at"] > 120)]
    A("测试日有多个到点槽位", len(expect8) >= 2, m_slots)
    A("多个槽位只弹一条", len(sent8) == 1, sent8)
    A("合并提醒含次数", any("次发布时刻" in m for m in sent8), sent8)
    A("合并提醒覆盖所有到点槽位", n8 == len(expect8), "{} vs {}".format(n8, len(expect8)))

    # 9. 措辞：轮询间隔大（电脑睡过）时要说明会重新计时，正常间隔不啰嗦
    A("单条+离开过→说明重新计时", "重新计时" in remind_text([{"at": 600, "kind": "side"}], 180))
    A("合并+离开过→说明补救", "重新计时" in remind_text(
        [{"at": 600, "kind": "side"}, {"at": 700, "kind": "burst"}], 240))
    A("正常间隔不啰嗦", "重新计时" not in remind_text([{"at": 600, "kind": "side"}], 1))
    A("合并提醒统计突发数", "1 个突发" in remind_text(
        [{"at": 600, "kind": "side"}, {"at": 700, "kind": "burst"}], 1))

    # 10. 跨进程重启不重复提醒（notified 落盘）。
    #     只放内存时，托盘每次重启都会把同一条再弹一遍——常驻服务最容易踩的坑。
    import shutil
    tmp2 = tempfile.mkdtemp()
    save2 = make_save(tmp2)
    at_pub = datetime(2026, 10, 29, 10, 3)
    sent10 = []
    n10a = poll_once(save2, notify=lambda t, m: sent10.append(m), now=at_pub, persist=True)
    A("首次启动会提醒", n10a >= 1, n10a)
    A("已通知键写入磁盘", os.path.exists(os.path.join(tmp2, "notified.json")))
    sent10b = []
    n10b = poll_once(save2, notify=lambda t, m: sent10b.append(m), now=at_pub, persist=True)
    A("重启后不重复提醒", n10b == 0, "{} 条重复".format(n10b))
    A("重启后不再弹同一条", not sent10b, sent10b)

    print("\n通知逻辑测试通过 ✓" if not fails else f"\n{fails} 项失败 ✗")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
