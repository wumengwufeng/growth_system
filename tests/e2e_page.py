"""端到端验证：用无头 Edge + CDP 真正加载页面，捕获 console 报错并检查渲染结果。

为什么不用 --dump-dom：页面里有 setInterval 常驻定时器，dump-dom 会一直等页面"稳定"直到超时。
这里改为：起本地服务 → 起无头浏览器 → 通过 CDP 执行 JS 读取真实 DOM 状态与 console 报错。

运行：python tests/e2e_page.py
"""
import atexit
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import http.server
import socketserver

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv  # noqa: E402

fails = 0


# ---- 运行期临时资源（浏览器 profile / 隔离存档）--------------------------------
# 历史包袱：早期的 e2e 每次都在 %TEMP% 留下一整套 Chromium profile（25~600MB），
# 而且 proc.terminate() 杀不掉 Edge 的子进程树；断言一失败就提前退出，连这行都跑不到。
# 于是跑几十轮 = 几个 GB 垃圾，全堆在 C 盘。现在：临时目录默认落在项目内 .tmp/e2e（不占系统盘），
# 退出时（含异常/被杀之外的所有退出路径）无条件杀进程树 + 删目录，开跑前先扫上一轮残留。
_cleanup_paths = []
_cleanup_procs = []
_cleanup_profiles = []


def _project_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _scratch_root():
    base = os.environ.get("GROWTH_E2E_TMP") or os.path.join(_project_root(), ".tmp", "e2e")
    os.makedirs(base, exist_ok=True)
    return base


def _shot_dir():
    """截图目录：惰性创建 —— 模块级不落盘，import 本文件不该有任何副作用。"""
    d = os.path.join(_scratch_root(), "shots")
    os.makedirs(d, exist_ok=True)
    return d


def _kill_tree(proc):
    """连子进程一起收，光 terminate 根进程会留下无头浏览器。
    Windows 走 taskkill /T；其他平台退回 terminate + killpg，保持跨平台可用。"""
    if proc is None:
        return
    try:
        if proc.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            else:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except Exception:
                    proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _kill_by_profile(prof):
    """按 --user-data-dir 反查并强杀。
    实测 Edge 的启动器进程会先退出，taskkill /T 打的是空 PID，真正持文件锁的
    是它派生的一堆 renderer/utility，只能靠命令行里的 profile 路径把它们捞出来。"""
    if not prof or os.name != "nt":
        return
    needle = prof.replace("'", "''")
    ps = ("$p='" + needle + "';"
          "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | "
          "Where-Object { $_.Name -in @('msedge.exe','chrome.exe','chromium.exe') "
          "-and $_.CommandLine -and $_.CommandLine.Contains($p) } | "
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    try:
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    except Exception:
        pass


def _rmtree(path):
    """浏览器退出后文件句柄要松一会儿，重试几次再放弃。"""
    if not path or not os.path.isdir(path):
        return True
    for _ in range(10):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return True
        time.sleep(0.5)
    return False


def cleanup():
    """先杀进程再删目录，顺序不能反；可重复调用。"""
    for p in list(_cleanup_procs):
        _kill_tree(p)
    _cleanup_procs.clear()
    for prof in list(_cleanup_profiles):
        _kill_by_profile(prof)
    _cleanup_profiles.clear()
    left = [p for p in _cleanup_paths if not _rmtree(p)]
    _cleanup_paths.clear()
    for p in left:
        print("警告：临时目录没删掉（可能被占用）:", p)
    return not left


atexit.register(cleanup)


def sweep_stale(max_age_min=120):
    """清掉上一轮遗留的 growth_e2e_* 目录（崩溃/被 kill 那次的）。"""
    now = time.time()
    killed = 0
    freed = 0
    for root in (tempfile.gettempdir(), _scratch_root()):
        if not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            if not name.startswith("growth_e2e_"):
                continue
            path = os.path.join(root, name)
            try:
                if now - os.path.getmtime(path) < max_age_min * 60:
                    continue
                size = 0
                for dirpath, _dirnames, filenames in os.walk(path):
                    for fn in filenames:
                        try:
                            size += os.path.getsize(os.path.join(dirpath, fn))
                        except OSError:
                            pass
                if _rmtree(path):
                    killed += 1
                    freed += size
            except OSError:
                pass
    if killed:
        print("清理上一轮残留：%d 个临时 profile，释放 %.0f MB" % (killed, freed / 1048576.0))


def A(name, cond, extra=""):
    global fails
    print(("ok: " if cond else "FAIL: ") + name + (("  → " + str(extra)) if extra and not cond else ""))
    if not cond:
        fails += 1


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def find_browser():
    cands = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    return next((c for c in cands if os.path.exists(c)), None)


class CDP:
    def __init__(self, url):
        from http.client import HTTPConnection
        host, port = url.split("//", 1)[1].split("/")[0].split(":")
        self.c = HTTPConnection(host, int(port), timeout=30)
        self.ctr = 0

    def ws_handshake(self):
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        self.c.request("GET", "/devtools/page/" + self.pageid, headers={
            "Host": self.hostport, "Upgrade": "websocket", "Connection": "Upgrade",
            "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13"})
        return self.c.getresponse()

    def start(self):
        self.c.request("GET", "/json/version")
        r = self.c.getresponse()
        info = json.loads(r.read())
        return info


def conn_alive(sock):
    """探测 WebSocket 是否还活着：若有缓冲的 PONG/事件帧可读，说明还连着。"""
    sock.settimeout(0.2)
    try:
        sock.recv(65536)
        return True
    except socket.timeout:
        return True
    except (ConnectionResetError, OSError):
        return False


def main():
    port = free_port()
    cdp_port = free_port()
    # 隔离存档：E2E 会把页面真正跑起来（settle 会写 /api/save），绝不能污染 data/growth.json。
    sweep_stale()
    tmpdir = tempfile.mkdtemp(prefix="growth_e2e_data_", dir=_scratch_root())
    _cleanup_paths.append(tmpdir)
    os.makedirs(os.path.join(tmpdir, "data"), exist_ok=True)
    srv.DATA_FILE = os.path.join(tmpdir, "data", "growth.json")
    # 静态资源仍从项目根目录读，只是存档改到临时目录
    httpd = socketserver.ThreadingTCPServer(
        ("127.0.0.1", port),
        lambda *a, **kw: srv.Handler(*a, directory=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), **kw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    exe = find_browser()
    if not exe:
        print("跳过：未找到 Edge/Chrome")
        sys.exit(0)

    prof = tempfile.mkdtemp(prefix="growth_e2e_", dir=_scratch_root())
    _cleanup_paths.append(prof)
    _cleanup_profiles.append(prof)
    proc = subprocess.Popen([
        exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--user-data-dir=" + prof, "--remote-debugging-port=" + str(cdp_port), "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=(os.name != "nt"))
    _cleanup_procs.append(proc)

    # 等 CDP 就绪
    for _ in range(60):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/json/version" % cdp_port, timeout=1).read()
            break
        except Exception:
            time.sleep(0.5)

    # 只做一次 Page.navigate：/json/new 的返回值就是已经是这个页面的 tab，
    # 若再 navigate 一次，浏览器会销毁旧 target，WebSocket 随之中断（这正是之前偶发超时的原因）。
    nav_url = "http://127.0.0.1:%d/index.html" % port
    try:
        req = urllib.request.Request("http://127.0.0.1:%d/json/new?%s" % (cdp_port, nav_url), method="PUT")
        data = json.loads(urllib.request.urlopen(req, timeout=10).read())
        already_navigated = True
    except Exception:
        tabs = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % cdp_port, timeout=5).read())
        data = next(t for t in tabs if t.get("type") == "page")
        already_navigated = False
    ws_url = data["webSocketDebuggerUrl"]

    print("浏览器:", os.path.basename(exe))
    # 简单 WebSocket 客户端（不引入第三方库）
    import base64
    import struct
    from urllib.parse import urlparse

    u = urlparse(ws_url)
    sock = socket.create_connection((u.hostname, u.port), timeout=30)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
                  % (u.path, u.hostname + ":" + str(u.port), key)).encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += sock.recv(4096)
    A("WebSocket 握手成功", b"101" in resp.split(b"\r\n")[0])

    import struct

    def send(obj):
        payload = json.dumps(obj).encode()
        hdr = bytearray([0x81])
        n = len(payload)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        sock.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    buf = b""

    def recv_msg():
        nonlocal buf
        while True:
            # 先把缓冲区里已有的完整帧消费掉（浏览器会主动推事件，必须逐帧取）
            if len(buf) >= 2:
                ln = buf[1] & 0x7F
                off = 2
                if ln == 126 and len(buf) >= 4:
                    ln = struct.unpack(">H", buf[2:4])[0]; off = 4
                elif ln == 127 and len(buf) >= 10:
                    ln = struct.unpack(">Q", buf[2:10])[0]; off = 10
                elif ln >= 126:
                    ln = None
                if ln is not None and len(buf) >= off + ln:
                    payload = buf[off:off + ln]
                    buf = buf[off + ln:]
                    return json.loads(payload.decode("utf-8", "replace"))
            sock.settimeout(0.5)
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                raise TimeoutError("CDP 无响应")
            if not chunk:
                raise TimeoutError("WS 关闭")
            buf += chunk

    def cmd(method, params=None):
        nonlocal buf
        send({"id": 1, "method": method, "params": params or {}})
        deadline = time.time() + 20
        console = []
        while time.time() < deadline:
            try:
                m = recv_msg()
            except TimeoutError:
                raise TimeoutError(method)
            if m.get("method") == "Runtime.consoleAPICalled":
                args = [a.get("value") for a in m["params"].get("args", [])]
                console.append((m["params"].get("type"), args))
            elif m.get("method") == "Runtime.exceptionThrown":
                console.append(("exception", m["params"]["exceptionDetails"].get("text")))
            elif m.get("id") == 1:
                return m, console
        raise TimeoutError(method)

    cmd("Runtime.enable")
    cmd("Page.enable")
    if not already_navigated:
        cmd("Page.navigate", {"url": "http://127.0.0.1:%d/index.html" % port})
    time.sleep(3)  # 让 boot + settle + 渲染跑完

    def ev(expr, retries=3):
        """evaluate 偶发超时（浏览器冷启动/GC）：重试几次而不是直接判失败。"""
        last = None
        for i in range(retries):
            try:
                m, cons = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
                return m.get("result", {}).get("result", {}).get("value"), cons
            except (TimeoutError, OSError) as e:
                last = e
                time.sleep(1.5)
        raise last

    # 注意：必须用页面内的 ds() 取「本地日期」。早先这里用 new Date().toISOString()
    # 取的是 UTC 日期，在本地时间 00:00~08:00 之间会与本地日期差一天，
    # 导致这条断言在凌晨必然失败（应用本身没问题）。
    state, errors = ev("JSON.stringify({ready:!!window.GROWTH, tasks:document.querySelectorAll('.task-card').length, attrs:document.querySelectorAll('.attr').length, ring:document.getElementById('ringPct').textContent, logRows:document.querySelectorAll('.log-row').length, today:ds(new Date()), hasDay:!!(window.GROWTH&&GROWTH.S.days[ds(new Date())])})")
    st = json.loads(state) if state else {}
    print("页面状态:", st)

    A("boot 完成（GROWTH 已挂载）", st.get("ready"))
    A("四维属性已渲染", st.get("attrs") == 4, st.get("attrs"))
    A("成长环已渲染", st.get("ring") is not None)
    A("今日 day 记录已建立", st.get("hasDay"), st)

    # ── 回归：今日计划里还有未发布任务时，成长环不能显示 100% ──
    # 老板 2026-11-16 实际撞到的画面：计划 2 个任务，做完 1 个、另 1 个还没到点发布，
    # 环显示 100%「今日成长环 1/1」，下方同时写着「今日 1 个任务尚未发布」。
    # 分母只数「已发布」→ 已发布的都做完了就等于 100%，但今天并没有收工。
    # 发布中的 AI 调用没结束前 renderTasks 会早退（generating），先等它落定，
    # 否则下面测的是"正在推演"的中间态，不是稳态
    for _ in range(90):
        g, _ = ev("typeof generating!=='undefined' ? !!generating : false")
        if g is False:
            break
        time.sleep(0.5)

    def ring_case(statuses):
        expr = """(()=>{
          const k=ds(new Date());
          const keep=S.days[k];
          const t={title:'A',desc:'',category:'体质',difficulty:1,minutes:10,kind:'side'};
          S.days[k]={slots:%s, tzOffset:(keep&&keep.tzOffset)};
          renderHero(); renderTasks();
          const out={pct:document.getElementById('ringPct').textContent,
            cap:document.getElementById('ringCap').textContent,
            prog:document.getElementById('tProgress').textContent,
            // 环内文字不能撑出 240px 的环（内圈直径约 186px），否则会压在描边上
            capW:Math.round(document.getElementById('ringCap').getBoundingClientRect().width)};
          S.days[k]=keep; renderHero(); renderTasks();
          return JSON.stringify(out);
        })()""" % json.dumps(statuses)
        v, _ = ev(expr)
        return json.loads(v) if v else {}

    waiting_slot = {"at": 1134, "kind": "side", "status": "waiting", "task": None, "issuedAt": 0, "deadline": 0}
    done_slot = {"at": 600, "kind": "side", "status": "done", "settledAt": 1,
                 "task": {"title": "A", "desc": "", "category": "体质", "difficulty": 1, "minutes": 10, "kind": "side"}}
    half = ring_case([done_slot, waiting_slot])
    A("有未发布任务时成长环不是 100%", half.get("pct") == "50%", half)
    A("有未发布任务时环内标注待发布", "1/2" in (half.get("cap") or "") and "待发布" in (half.get("cap") or ""), half.get("cap"))
    A("有未发布任务时今日进度不是 1/1", (half.get("prog") or "").startswith("今日 1/2"), half.get("prog"))
    A("环内文案不溢出内圈", (half.get("capW") or 999) <= 180, half.get("capW"))

    full = ring_case([done_slot, dict(done_slot, at=1134)])
    A("全部做完才显示 100%", full.get("pct") == "100%" and "待发布" not in (full.get("cap") or ""), full)
    A("全部做完今日进度为 2/2", (full.get("prog") or "").startswith("今日 2/2"), full.get("prog"))

    # 自检
    ok, _ = ev("GROWTH.selftest()")
    A("页内 GROWTH.selftest() 通过", ok is True, ok)

    # 手动跑一轮 settle，确认没有未捕获异常
    threw, cons = ev("(async()=>{ try{ await GROWTH.settle(); return 'ok' } catch(e){ return 'ERR:'+e.message } })()")
    A("页内 settle() 无异常", threw == "ok", threw)

    exc = [c for c in errors if c[0] == "exception"]
    A("页面无未捕获异常", not exc, exc[:2])

    console_errs = [c for c in errors if c[0] == "error"]
    A("console 无 error 级输出", not console_errs, console_errs[:2])

    # 主题切换冒烟
    th, _ = ev("(()=>{document.body.dataset.theme='dark';return getComputedStyle(document.body).getPropertyValue('--accent').trim()})()")
    A("深色主题 CSS 变量生效", th and th != "", th)

    # ── 新增功能在真实页面里的渲染检查 ──
    A("成就卡已渲染 14 项", (ev("document.querySelectorAll('.ach').length")[0] or 0) == 14)
    A("成就进度头有内容", bool(ev("document.getElementById('achHead').textContent")[0]))
    A("月度热力图已渲染格子", (ev("document.querySelectorAll('.heatmap rect').length")[0] or 0) > 80)
    A("商城进度条已渲染", (ev("document.querySelectorAll('.shop-prog').length")[0] or 0) >= 1)
    A("商城显示还差多少金币", bool(ev("(document.querySelector('.shop-note')||{}).textContent")[0]))
    A("热力图格子有 tooltip", (ev("document.querySelectorAll('.heatmap rect title').length")[0] or 0) > 80)

    # 主题 auto 跟随系统
    au, _ = ev("(()=>{S.settings.theme='auto';const r=applyTheme();return r})()")
    A("auto 主题解析为 light/dark", au in ("light", "dark"), au)

    # 分段推进按钮：造一个长任务 + 一个短任务，验证只有长任务出现该按钮
    diag, _ = ev("""(()=>{
      const t=new Date(); const k=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0');
      for(let i=1;i<9999;i++) clearInterval(i);
      // 本环境 Magpie 网关离线，可用性未知；但生成态只影响渲染分支，这里显式复位以测卡片渲染
      generating=false;
      S.days[k]={slots:[
        {at:600,kind:'side',status:'pending',task:{title:'长任务',desc:'',category:'智力',difficulty:2,minutes:40,kind:'side'},issuedAt:Date.now(),deadline:Date.now()+3600e3},
        {at:601,kind:'side',status:'pending',task:{title:'短任务',desc:'',category:'自律',difficulty:1,minutes:10,kind:'side'},issuedAt:Date.now(),deadline:Date.now()+3600e3}
      ]};
      let err=null;
      try{ renderTasks(); }catch(e){ err=String(e); }
      const html=document.getElementById('taskList').innerHTML;
      return JSON.stringify({key:k, err, cards:document.querySelectorAll('.task-card').length,
        splitBtnCount:(html.match(/data-act="partial"/g)||[]).length,
        hasLong:html.includes('长任务'), hasShort:html.includes('短任务')});
    })()""")
    print("诊断:", diag)
    split = diag
    sp = json.loads(split) if split else {}
    A("两张任务卡都渲染", sp.get("cards") == 2, sp)
    A("只有长任务出现「先做 10 分钟」", sp.get("splitBtnCount") == 1 and sp.get("hasShort") is True, sp)

    # 点一下「先做 10 分钟」，走完整链路：半奖 → partial → 卡片变「完成剩余」
    flow, _ = ev("""(()=>{
      window.confirm=()=>true;
      const btn=document.querySelector('[data-act="partial"]');
      if(!btn) return 'nobtn';
      btn.click();
      const html=document.getElementById('taskList').innerHTML;
      return JSON.stringify({partial: html.includes('已领半奖'), remain: html.includes('完成剩余'),
        coins:S.player.coins, statuses:Object.values(S.days).flatMap(d=>d.slots.map(s=>s.status))});
    })()""")
    fl = json.loads(flow) if flow and flow != 'nobtn' else {}
    A("点击后任务进入 partial", fl.get("partial") is True, flow)
    A("卡片显示「已领半奖」徽标与「完成剩余」按钮", fl.get("remain") is True, fl)
    A("状态机里有 partial", "partial" in (fl.get("statuses") or []), fl.get("statuses"))

    # ── 系统流机制在真实页面里的渲染 ──
    A("主线任务卡片已渲染", bool(ev("document.getElementById('mqTitle').textContent")[0]))
    A("主线进度条有宽度", ev("document.getElementById('mqBar').style.width")[0] is not None)
    A("主线进度文案含目标数", "/" in (ev("document.getElementById('mqProg').textContent")[0] or ""))
    A("设置页有语气下拉", ev("!!document.getElementById('sTone')")[0] is True)
    A("设置页有称号下拉", ev("!!document.getElementById('sTitle')")[0] is True)
    A("设置页有主线编辑框", ev("!!document.getElementById('mqEditTitle')&&!!document.getElementById('mqEditTarget')")[0] is True)
    A("四种语气都在下拉里", (ev("document.getElementById('sTone').options.length")[0] or 0) == 4)

    # 赐福：强制一个有加成的赐福，确认显示
    bl, _ = ev("""(()=>{
      blessingFor = () => ({id:'mind',name:'智慧恩泽',desc:'今日智力类任务奖励 ×1.5',mult:{智力:1.5}});
      renderBlessing();
      const el=document.getElementById('blessingBar');
      return JSON.stringify({hidden:el.hidden, text:el.textContent});
    })()""")
    bj = json.loads(bl) if bl else {}
    A("赐福条显示且有文案", bj.get("hidden") is False and "智慧恩泽" in (bj.get("text") or ""), bj)

    # 称号：解锁成就后下拉出现，穿戴后宿主面板显示
    ttl, _ = ev("""(()=>{
      S.achievements=['first','streak7'];
      bindSettings();
      const opts=[...document.getElementById('sTitle').options].map(o=>o.textContent);
      S.player.title='streak7';
      renderHero();
      const badge=document.getElementById('hTitle');
      return JSON.stringify({opts, badgeHidden:badge.hidden, badgeText:badge.textContent});
    })()""")
    tj = json.loads(ttl) if ttl else {}
    A("称号下拉只列已解锁的", len(tj.get("opts") or []) == 3, tj.get("opts"))
    A("穿戴称号后宿主面板显示", tj.get("badgeHidden") is False and tj.get("badgeText") == "七日守约", tj)

    # 稀有度徽标：史诗/稀有显示，普通不显示
    rar, _ = ev("""(()=>{
      const t=new Date(); const k=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0');
      for(let i=1;i<9999;i++) clearInterval(i);
      generating=false;
      S.days[k]={slots:[
        {at:600,kind:'side',status:'pending',task:{title:'史诗任务',desc:'',category:'智力',difficulty:3,minutes:40,kind:'side',rarity:'epic'},issuedAt:Date.now(),deadline:Date.now()+3600e3},
        {at:601,kind:'side',status:'pending',task:{title:'稀有任务',desc:'',category:'自律',difficulty:2,minutes:30,kind:'side',rarity:'rare'},issuedAt:Date.now(),deadline:Date.now()+3600e3},
        {at:602,kind:'side',status:'pending',task:{title:'普通任务',desc:'',category:'体质',difficulty:1,minutes:10,kind:'side',rarity:'common'},issuedAt:Date.now(),deadline:Date.now()+3600e3}
      ]};
      renderTasks();
      const html=document.getElementById('taskList').innerHTML;
      return JSON.stringify({epic:html.includes('chip-epic'), rare:html.includes('chip-rare'),
        epicName:html.includes('史诗'), rareName:html.includes('稀有'), cards:document.querySelectorAll('.task-card').length});
    })()""")
    rj = json.loads(rar) if rar else {}
    A("史诗/稀有徽标渲染", rj.get("epic") is True and rj.get("rare") is True, rj)
    A("三张任务卡都在", rj.get("cards") == 3, rj)
    # ── 属性等级反馈 ──
    rk, _ = ev("""(()=>{
      renderHero();
      const rows=[...document.querySelectorAll('#hAttrs .attr')];
      const gaps=[...document.querySelectorAll('#hAttrs .attr-gap')].map(e=>e.textContent);
      return JSON.stringify({rows:rows.length, gaps, hasGapText:gaps.some(g=>g.includes('还差')||g.includes('顶端'))});
    })()""")
    rkj = json.loads(rk) if rk else {}
    A("四维都渲染了距下一级提示", rkj.get("rows") == 4 and rkj.get("hasGapText") is True, rkj)

    # 跨级高亮：写入一条 24 小时内的突破记录，属性条应带 rank-up
    up, _ = ev("""(()=>{
      S.rankUps=[{cat:'智力', rank:'D', value:96, t:Date.now()}];
      renderHero();
      const el=document.querySelector('#hAttrs .attr.rank-up');
      return JSON.stringify({highlighted: !!el, rankUpsLen:(S.rankUps||[]).length});
    })()""")
    upj = json.loads(up) if up else {}
    A("近期突破的属性有高亮", upj.get("highlighted") is True, upj)

    # 数据页「属性突破」记录
    tl, _ = ev("""(()=>{
      showPage('data');
      renderRankTimeline();
      const box=document.getElementById('rankList');
      const rows=box.querySelectorAll('.rank-row').length;
      return JSON.stringify({rows, text:box.textContent.slice(0,80)});
    })()""")
    tlj = json.loads(tl) if tl else {}
    A("突破记录卡渲染出条目", tlj.get("rows") == 1, tlj)
    A("突破记录含等级与维度", "D 级" in (tlj.get("text") or "") and "智力" in (tlj.get("text") or ""), tlj)

    # 空态文案
    empty, _ = ev("""(()=>{
      S.rankUps=[];
      renderRankTimeline();
      return document.getElementById('rankList').textContent;
    })()""")
    A("无记录时显示引导文案", "还没有属性突破" in (empty or ""), empty)

    # ── 周报结构化指标 ──
    rep, _ = ev("""(()=>{
      S.days[Object.keys(S.days).sort().pop()] = {slots:[
        {at:600,kind:'side',status:'done',settledAt:1,task:{title:'甲',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side',rarity:'common'}},
        {at:601,kind:'side',status:'expired',settledAt:1,task:{title:'乙',desc:'',category:'体质',difficulty:2,minutes:30,kind:'side',rarity:'common'}}
      ]};
      const m = weekMetrics(S, ds(new Date()), 7);
      S.lastReport = {t:Date.now(), text:'测试周报正文', metrics:m, source:'local'};
      renderData();
      const box = document.getElementById('reportBox');
      const cells = box.querySelectorAll('.rm-cell').length;
      const rows = box.querySelectorAll('.rep-row').length;
      return JSON.stringify({cells, rows, text:box.textContent.slice(0,200),
        hasRate:box.textContent.includes('%'), hasOffline:box.textContent.includes('离线生成'),
        hasWeak:box.textContent.includes('最需补强')});
    })()""")
    rj2 = json.loads(rep) if rep else {}
    A("周报渲染 4 个指标格", rj2.get("cells") == 4, rj2.get("cells"))
    A("周报渲染属性/投入/区间行", rj2.get("rows") >= 3, rj2.get("rows"))
    A("周报含完成率百分比", rj2.get("hasRate") is True)
    A("离线生成有标注", rj2.get("hasOffline") is True, rj2.get("text"))
    A("周报显示最需补强维度", rj2.get("hasWeak") is True)

    # 结构化指标必须与本地算法一致，不能是 AI 编的
    chk, _ = ev("""(()=>{
      const m = weekMetrics(S, ds(new Date()), 7);
      const box = document.getElementById('reportBox').textContent;
      return JSON.stringify({done:m.cur.done, rate:m.cur.rate, inText:box.includes(String(m.cur.rate)+'%')});
    })()""")
    cj = json.loads(chk) if chk else {}
    A("周报数字与本地算法一致", cj.get("inText") is True, cj)

    # 空周报引导
    emp2, _ = ev("(()=>{ S.lastReport=null; renderData(); return document.getElementById('reportBox').textContent; })()")
    A("无周报时显示引导", "还没有周报" in (emp2 or ""), (emp2 or "")[:40])

    # ── 周报建议一键落地 ──
    act, _ = ev("""(()=>{
      S.player.attrs={体质:2,智力:60,精神:10,自律:10};
      S.taskPool=[];
      const m=weekMetrics(S, ds(new Date()), 7);
      S.lastReport={t:Date.now(), text:'测试', metrics:m, source:'ai'};
      renderData();
      const btn=document.querySelector('[data-act="reportToPool"]');
      if(!btn) return JSON.stringify({nobtn:true});
      const label=btn.textContent;
      btn.click();
      return JSON.stringify({label, poolLen:S.taskPool.length,
        cats:S.taskPool.map(t=>t.category), titles:S.taskPool.map(t=>t.title),
        logged:S.log.some(l=>l.txt.includes('根据周报建议'))});
    })()""")
    aj = json.loads(act) if act else {}
    A("周报有「加入任务池」按钮", aj.get("nobtn") is not True, aj)
    A("按钮文案点名薄弱维度", "体质" in (aj.get("label") or ""), aj.get("label"))
    A("点击后任务池确实增加", (aj.get("poolLen") or 0) == 3, aj.get("poolLen"))
    A("加入的任务都是薄弱维度", all(c == "体质" for c in (aj.get("cats") or ["x"])), aj.get("cats"))
    A("落地动作写入系统公告", aj.get("logged") is True, aj)

    # 重复点击不应灌入重复任务
    dup, _ = ev("""(()=>{
      const before=S.taskPool.length;
      document.querySelector('[data-act="reportToPool"]').click();
      return JSON.stringify({before, after:S.taskPool.length,
        uniq:new Set(S.taskPool.map(t=>t.title)).size});
    })()""")
    dj = json.loads(dup) if dup else {}
    A("重复点击不产生重复任务", dj.get("after") == dj.get("uniq"), dj)

    # ── 任务池采用情况 ──
    ps, _ = ev("""(()=>{
      S.taskPool=[{title:'拉伸10分钟',desc:'',category:'体质',difficulty:1,minutes:10},
                  {title:'读书20页',desc:'',category:'智力',difficulty:2,minutes:30}];
      const k=ds(new Date());
      S.days[k]={slots:[
        {at:600,kind:'side',status:'done',settledAt:1,task:{title:'拉伸 10 分钟（肩颈）',category:'体质',difficulty:1,minutes:10,fromPool:true}},
        {at:601,kind:'side',status:'expired',settledAt:1,task:{title:'AI自拟',category:'智力',difficulty:2,minutes:30,fromPool:false}}
      ]};
      renderData();
      const box=document.getElementById('poolStats');
      const cells=box.querySelectorAll('.rm-cell').length;
      const rows=box.querySelectorAll('.rank-row').length;
      return JSON.stringify({cells, rows, text:box.textContent.slice(0,160),
        hasRate:box.textContent.includes('采用率'), hasNever:box.textContent.includes('从未被采用')});
    })()""")
    psj = json.loads(ps) if ps else {}
    A("任务池统计渲染 3 个指标格", psj.get("cells") == 3, psj.get("cells"))
    A("任务池统计列出每条任务", (psj.get("rows") or 0) >= 1, psj.get("rows"))
    A("显示采用率", psj.get("hasRate") is True, psj.get("text"))
    A("标出从未采用的任务", psj.get("hasNever") is True, psj.get("text"))

    # 空池与无数据两种态
    e1, _ = ev("(()=>{S.taskPool=[];renderData();return document.getElementById('poolStats').textContent;})()")
    A("空任务池显示引导", "任务池是空的" in (e1 or ""), (e1 or "")[:40])
    e2, _ = ev("""(()=>{S.taskPool=[{title:'X',category:'体质',difficulty:1,minutes:10}];
      S.days={}; renderData(); return document.getElementById('poolStats').textContent;})()""")
    A("无已发布任务时说明原因", "还没有已发布的任务" in (e2 or ""), (e2 or "")[:44])

    # ── 救回额度透明化 ──
    q1, _ = ev("""(()=>{
      const k=ds(new Date());
      S.days[k]={slots:[
        {at:600,kind:'burst',status:'pending',issuedAt:Date.now(),deadline:Date.now()+3600e3,
         task:{title:'突发测试',desc:'',category:'智力',difficulty:2,minutes:20,kind:'burst'}},
        {at:610,kind:'side',status:'pending',issuedAt:Date.now(),deadline:Date.now()+3600e3,
         task:{title:'支线测试',desc:'',category:'自律',difficulty:1,minutes:10,kind:'side'}}
      ]};
      renderTasks();
      const box=document.getElementById('taskList');
      const note=box.querySelector('.quota-note');
      return JSON.stringify({has:!!note, text:note?note.textContent.trim():'',
        dots:note?note.querySelectorAll('.qdot').length:0,
        usedDots:note?note.querySelectorAll('.qdot.used').length:0,
        out:note?note.classList.contains('out'):false});
    })()""")
    qj = json.loads(q1) if q1 else {}
    A("有突发任务时显示额度条", qj.get("has") is True, qj.get("text"))
    A("额度初始 1/1", "1/1" in (qj.get("text") or ""), qj.get("text"))
    A("额度用圆点可视化", qj.get("dots") == 1 and qj.get("usedDots") == 0, qj)

    # 用掉额度 → 0/1 + 耗尽样式
    q2, _ = ev("""(()=>{
      const k=ds(new Date());
      S.days[k].rescueCount=1;
      renderTasks();
      const note=document.getElementById('taskList').querySelector('.quota-note');
      return JSON.stringify({text:note.textContent.trim(), out:note.classList.contains('out'),
        usedDots:note.querySelectorAll('.qdot.used').length});
    })()""")
    q2j = json.loads(q2) if q2 else {}
    A("额度用掉后显示 0/1", "0/1" in (q2j.get("text") or ""), q2j.get("text"))
    A("耗尽时加 out 样式", q2j.get("out") is True, q2j)
    A("耗尽提示措辞明确", "已用完" in (q2j.get("text") or ""), q2j.get("text"))

    # 无突发且未用额度 → 不显示（避免噪音）
    q3, _ = ev("""(()=>{
      const k=ds(new Date());
      S.days[k]={slots:[{at:600,kind:'side',status:'pending',issuedAt:Date.now(),
        deadline:Date.now()+3600e3,
        task:{title:'仅支线',desc:'',category:'自律',difficulty:1,minutes:10,kind:'side'}}]};
      renderTasks();
      return !!document.getElementById('taskList').querySelector('.quota-note');
    })()""")
    A("无突发且未用额度时不显示额度条", q3 is False, q3)

    # ── 周报补救复盘 ──
    rr, _ = ev("""(()=>{
      const k=ds(new Date());
      S.days[k]={slots:[{at:600,kind:'side',status:'done',settledAt:1,
        task:{title:'甲',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}}],
        rescue:{at:Date.now(),n:3,side:1,burst:1,grace:1,gapMin:95}, rescueCount:1};
      const m=weekMetrics(S, ds(new Date()), 7);
      S.lastReport={t:Date.now(), text:'测试正文', metrics:m, source:'ai'};
      renderData();
      const box=document.getElementById('reportBox');
      const insight=box.querySelector('.rescue-insight');
      return JSON.stringify({hasInsight:!!insight,
        level:insight?insight.className:'',
        text:box.textContent,
        hasRow:box.textContent.includes('补救复盘'),
        hasBurst:box.textContent.includes('突发救回'),
        hasQuota:box.textContent.includes('额度用光')});
    })()""")
    rrj = json.loads(rr) if rr else {}
    A("周报有补救复盘行", rrj.get("hasRow") is True, rrj.get("text", "")[:100])
    A("周报显示补救结论", rrj.get("hasInsight") is True)
    A("结论标注 warn 级别", "warn" in (rrj.get("level") or ""), rrj.get("level"))
    A("周报列出突发救回次数", rrj.get("hasBurst") is True)
    A("周报列出额度用光天数", rrj.get("hasQuota") is True)

    # 无错过 → ok 级结论
    rr2, _ = ev("""(()=>{
      const k=ds(new Date());
      S.days[k]={slots:[{at:600,kind:'side',status:'done',settledAt:1,
        task:{title:'乙',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}}]};
      const m=weekMetrics(S, ds(new Date()), 7);
      S.lastReport={t:Date.now(), text:'正文', metrics:m, source:'ai'};
      renderData();
      const ins=document.querySelector('.rescue-insight');
      return JSON.stringify({level:ins?ins.className:'', text:ins?ins.textContent:''});
    })()""")
    rr2j = json.loads(rr2) if rr2 else {}
    A("没错过时结论为 ok 级", "ok" in (rr2j.get("level") or ""), rr2j.get("level"))
    A("没错过时文案说明时段匹配", "匹配" in (rr2j.get("text") or ""), rr2j.get("text"))

    # ── 诊断 → 一键调活跃窗口 ──
    wf, _ = ev("""(()=>{
      const k=ds(new Date());
      const at=t=>new Date(k+'T'+t+':00').getTime();
      S.settings.dayStart='09:00'; S.settings.dayEnd='22:00';
      S.days[k]={slots:[
        {at:600,kind:'side',status:'done',settledAt:at('19:30'),
         task:{title:'甲',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}},
        {at:610,kind:'side',status:'done',settledAt:at('20:00'),
         task:{title:'乙',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}},
        {at:620,kind:'side',status:'done',settledAt:at('21:15'),
         task:{title:'丙',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}}
      ], rescue:{at:Date.now(),n:4,side:2,burst:1,grace:1,gapMin:185}, rescueCount:1};
      const m=weekMetrics(S, ds(new Date()), 7);
      S.lastReport={t:Date.now(), text:'正文', metrics:m, source:'ai'};
      renderData();
      const btn=document.querySelector('[data-act="applyWindow"]');
      return JSON.stringify({has:!!btn, label:btn?btn.textContent.trim():'',
        sugg:m.windowSuggestion, changed:m.windowSuggestion?m.windowSuggestion.changed:null});
    })()""")
    wfj = json.loads(wf) if wf else {}
    A("warn 时出现调整窗口按钮", wfj.get("has") is True, wfj.get("label"))
    A("按钮文案带建议时段", "–" in (wfj.get("label") or ""), wfj.get("label"))
    A("建议时段为晚间", (wfj.get("sugg") or {}).get("start", "") >= "18:00", wfj.get("sugg"))

    # 点击后设置真的变了
    ap, _ = ev("""(()=>{
      const before={s:S.settings.dayStart, e:S.settings.dayEnd};
      document.querySelector('[data-act="applyWindow"]').click();
      return JSON.stringify({before, after:{s:S.settings.dayStart, e:S.settings.dayEnd},
        logged:S.log.some(l=>l.txt.includes('活跃窗口')),
        inputStart:document.getElementById('sDayStart').value,
        inputEnd:document.getElementById('sDayEnd').value});
    })()""")
    apj = json.loads(ap) if ap else {}
    A("点击后设置被改写", apj.get("after") != apj.get("before"), f'{apj.get("before")} -> {apj.get("after")}')
    A("改动写入公告", apj.get("logged") is True)
    A("设置页输入框同步更新", (apj.get("inputStart") or "") == (apj.get("after") or {}).get("s"),
      f'{apj.get("inputStart")} vs {apj.get("after")}')

    # 已一致后按钮应消失（changed=false）
    gone, _ = ev("""(()=>{
      const m=weekMetrics(S, ds(new Date()), 7);
      S.lastReport={t:Date.now(), text:'正文', metrics:m, source:'ai'};
      renderData();
      return JSON.stringify({has:!!document.querySelector('[data-act="applyWindow"]'),
        changed:m.windowSuggestion?m.windowSuggestion.changed:null});
    })()""")
    gj = json.loads(gone) if gone else {}
    A("已一致后不再显示按钮", gj.get("has") is False and gj.get("changed") is False, gj)

    # toast 上限：连续弹 6 条，屏幕上最多留 3 条
    tst, _ = ev("""(()=>{
      document.getElementById('toastZone').innerHTML='';
      for(let i=0;i<6;i++) toast('测试'+i);
      return document.getElementById('toastZone').children.length;
    })()""")
    A("toast 最多同时 3 条", tst == 3, tst)

    shot_path = os.path.join(_shot_dir(), "growth_e2e_data_page.png")
    today_shot = os.path.join(_shot_dir(), "growth_e2e_today.png")
    try:
        ev("showPage('data')")
        cmd("Emulation.setDeviceMetricsOverride", {"width": 1120, "height": 1400, "deviceScaleFactor": 1, "mobile": False})
        time.sleep(0.6)
        m, _ = cmd("Page.captureScreenshot", {"format": "png"})
        import base64 as _b64
        open(shot_path, "wb").write(_b64.b64decode(m["result"]["data"]))
        # 今日页截图：主线 / 赐福 / 稀有度 / 称号都在这屏
        ev("showPage('today'); renderHero(); renderTasks(); renderBlessing();")
        time.sleep(0.6)
        m2, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(today_shot, "wb").write(_b64.b64decode(m2["result"]["data"]))
        # 额度条截图（两种状态并排：满额 / 耗尽）
        quota_shot = os.path.join(_shot_dir(), "growth_e2e_quota.png")
        ev("""(()=>{
          const k=ds(new Date());
          S.days[k]={slots:[
            {at:600,kind:'burst',status:'pending',issuedAt:Date.now(),deadline:Date.now()+3600e3,
             task:{title:'夜间深度阅读 40 分钟',desc:'',category:'智力',difficulty:3,minutes:40,kind:'burst'}},
            {at:610,kind:'side',status:'pending',issuedAt:Date.now(),deadline:Date.now()+3600e3,
             task:{title:'整理桌面 15 分钟',desc:'',category:'自律',difficulty:1,minutes:15,kind:'side'}}
          ]};
          showPage('today'); renderTasks();
          window.scrollTo(0,0);
        })()""")
        time.sleep(0.5)
        m6, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(quota_shot, "wb").write(_b64.b64decode(m6["result"]["data"]))
        print("额度条截图:", quota_shot)

        # 耗尽态截图
        quota_out_shot = os.path.join(_shot_dir(), "growth_e2e_quota_out.png")
        ev("""(()=>{
          const k=ds(new Date());
          S.days[k].rescueCount=1;
          showPage('today'); renderTasks();
          document.querySelector('.quota-note').scrollIntoView({block:'center'});
        })()""")
        time.sleep(0.4)
        m7, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(quota_out_shot, "wb").write(_b64.b64decode(m7["result"]["data"]))
        print("额度耗尽截图:", quota_out_shot)

        # 任务池采用情况截图
        pool_shot = os.path.join(_shot_dir(), "growth_e2e_pool.png")
        ev("""(()=>{
          S.taskPool=[{title:'拉伸10分钟',desc:'',category:'体质',difficulty:1,minutes:10},
                      {title:'读书20页',desc:'',category:'智力',difficulty:2,minutes:30},
                      {title:'写200字复盘',desc:'',category:'自律',difficulty:2,minutes:15}];
          S.taskPool.forEach(t=>t._st=1);
          const k=ds(new Date());
          S.days[k]={slots:[
            {at:600,kind:'side',status:'done',settledAt:1,task:{title:'拉伸 10 分钟（肩颈）',category:'体质',difficulty:1,minutes:10,fromPool:true}},
            {at:601,kind:'side',status:'done',settledAt:1,task:{title:'读书20页',category:'智力',difficulty:2,minutes:30,fromPool:true}},
            {at:602,kind:'side',status:'expired',settledAt:1,task:{title:'AI自拟的深度阅读',category:'智力',difficulty:2,minutes:30,fromPool:false}}
          ]};
          showPage('data'); renderData();
          document.getElementById('poolStats').scrollIntoView({block:'center'});
        })()""")
        time.sleep(0.5)
        m5, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(pool_shot, "wb").write(_b64.b64decode(m5["result"]["data"]))
        print("任务池截图:", pool_shot)

        # 诊断→修复按钮截图
        wfix_shot = os.path.join(_shot_dir(), "growth_e2e_window_fix.png")
        ev("""(()=>{
          const k=ds(new Date());
          const at=t=>new Date(k+'T'+t+':00').getTime();
          S.settings.dayStart='09:00'; S.settings.dayEnd='22:00';
          S.days[k]={slots:[
            {at:600,kind:'side',status:'done',settledAt:at('19:30'),
             task:{title:'读技术长文',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}},
            {at:610,kind:'side',status:'done',settledAt:at('20:10'),
             task:{title:'整理桌面',desc:'',category:'自律',difficulty:1,minutes:15,kind:'side'}},
            {at:620,kind:'side',status:'done',settledAt:at('21:15'),
             task:{title:'复盘今日',desc:'',category:'自律',difficulty:2,minutes:15,kind:'side'}}
          ], rescue:{at:Date.now(),n:4,side:2,burst:1,grace:1,gapMin:185}, rescueCount:1};
          const m=weekMetrics(S, ds(new Date()), 7);
          S.lastReport={t:Date.now(), source:'ai', metrics:m, text:
            '整体评价：本周完成率一般，理性面推进稳定。\\n' +
            '问题与盲区：有 2 天在离开期间错过了提醒，其中 1 天用光了救回额度。\\n' +
            '下周建议：把活跃窗口调整到你确实在看屏幕的时段。'};
          showPage('data'); renderData();
          document.getElementById('reportBox').scrollIntoView({block:'center'});
        })()""")
        time.sleep(0.5)
        m9, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(wfix_shot, "wb").write(_b64.b64decode(m9["result"]["data"]))
        print("窗口修复截图:", wfix_shot)

        # 周报补救复盘截图
        rescue_shot = os.path.join(_shot_dir(), "growth_e2e_rescue_review.png")
        ev("""(()=>{
          const k=ds(new Date());
          S.days[k]={slots:[
            {at:600,kind:'side',status:'done',settledAt:1,
             task:{title:'读技术长文',desc:'',category:'智力',difficulty:2,minutes:30,kind:'side'}},
            {at:610,kind:'side',status:'expired',settledAt:1,
             task:{title:'快走20分钟',desc:'',category:'体质',difficulty:2,minutes:20,kind:'side'}}
          ], rescue:{at:Date.now(),n:4,side:2,burst:1,grace:1,gapMin:185}, rescueCount:1};
          const m=weekMetrics(S, ds(new Date()), 7);
          S.lastReport={t:Date.now(), source:'ai', metrics:m, text:
            '整体评价：本周完成率一般，理性面推进稳定，但身体维度几乎没有动作。\\n' +
            '亮点：智力维度投入最多，做题时的专注度比上周更稳。\\n' +
            '问题与盲区：有 2 天在离开期间错过了提醒，其中 1 天用光了救回额度——这不是执行问题，是发布时段与你的作息错位。\\n' +
            '下周建议：① 把活跃窗口调整到你确实在看屏幕的时段；② 给体质排 2-3 个 10 分钟任务。'};
          showPage('data'); renderData();
          document.getElementById('reportBox').scrollIntoView({block:'center'});
        })()""")
        time.sleep(0.5)
        m8, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(rescue_shot, "wb").write(_b64.b64decode(m8["result"]["data"]))
        print("补救复盘截图:", rescue_shot)

        # 周报截图：滚动到周报卡
        rep_shot = os.path.join(_shot_dir(), "growth_e2e_report.png")
        ev("""(()=>{
          S.player.attrs={体质:2,智力:60,精神:10,自律:10};
          const m = weekMetrics(S, ds(new Date()), 7);
          S.lastReport = {t:Date.now(), source:'ai', metrics:m, text:
            '整体评价：本周你完成了大部分发布的任务，理性面推进明显，但身体维度几乎没有动作。\\n' +
            '亮点：智力维度投入最多，做题时的专注度比上周更稳。\\n' +
            '问题与盲区：有 1 个任务失效，说明发布时刻与你的精力高峰不匹配。\\n' +
            '下周建议：① 给体质排 2-3 个 10 分钟任务；② 把第一个任务放到早上。'};
          showPage('data'); renderData();
          document.getElementById('reportBox').scrollIntoView({block:'center'});
        })()""")
        time.sleep(0.5)
        m4, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(rep_shot, "wb").write(_b64.b64decode(m4["result"]["data"]))
        print("周报截图:", rep_shot)

        # 属性突破卡：滚到数据页底部单独截图（它在 1400px 视口外）
        rank_shot = os.path.join(_shot_dir(), "growth_e2e_rank.png")
        ev("""(()=>{ S.rankUps=[{cat:'智力',rank:'D',value:96,t:Date.now()},
                        {cat:'体质',rank:'E',value:42,t:Date.now()-86400000*2}];
                showPage('data'); renderRankTimeline();
                document.getElementById('rankList').scrollIntoView({block:'center'}); })()""")
        time.sleep(0.5)
        m3, _ = cmd("Page.captureScreenshot", {"format": "png"})
        open(rank_shot, "wb").write(_b64.b64decode(m3["result"]["data"]))
        print("截图:", shot_path, "|", today_shot, "|", rank_shot)
        # 热力图格子应为正方形（宽高比约 1，允许 0.2 误差）
        # 注意：上面截图把页面切到了「今日」，热力图在隐藏页里尺寸为 0，必须先切回数据页再量
        ev("showPage('data')")
        time.sleep(0.3)
        ratio, _ = ev("(()=>{const r=document.querySelector('.heatmap rect');const svg=document.querySelector('.heatmap');if(!r)return 0;const b=r.getBoundingClientRect();const s=svg.getBoundingClientRect();return JSON.stringify({cell:[+b.width.toFixed(1),+b.height.toFixed(1)],svg:[+s.width.toFixed(1),+s.height.toFixed(1)],vb:svg.getAttribute('viewBox')})})()")
        print("热力图尺寸诊断:", ratio)
        rr = json.loads(ratio) if ratio else {}
        cw, ch = rr.get("cell", [0, 1])
        A("热力图格子保持正方形", ch and abs(cw / ch - 1) < 0.2, rr)
    except Exception as e:
        print("截图跳过:", e)

    cleanup()
    httpd.shutdown()
    print("\n端到端页面验证通过 ✓" if not fails else "\n%d 项失败 ✗" % fails)
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
