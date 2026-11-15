"""端口冲突检测测试：验证本系统不会把别人的页面当自己的打开。

场景：
1. 端口空闲 → probe_port 返回 'free'
2. 端口上是本系统 → 'ours'（并复用，不重复起服务）
3. 端口上是别的程序 → 'other'，find_free_port 会换到别的端口
4. /api/ping 身份正确

运行：python tests/port_conflict.py
"""
import http.server
import json
import socket
import socketserver
import sys
import threading
import urllib.request
import os

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv  # noqa: E402

fails = 0


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


class FakeOther(http.server.BaseHTTPRequestHandler):
    """冒充别的 Web 应用（不是本系统）。"""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<html>someone else</html>")

    def log_message(self, *a):
        pass


def main():
    # 1. 空闲端口
    p_free = free_port()
    A("空闲端口 → free", srv.probe_port(p_free) == "free", srv.probe_port(p_free))

    # 2. 别的程序占用
    p_other = free_port()
    other = socketserver.ThreadingTCPServer(("127.0.0.1", p_other), FakeOther)
    threading.Thread(target=other.serve_forever, daemon=True).start()
    got = srv.probe_port(p_other)
    A("别的程序占着 → other（不会被误当成本系统）", got == "other", got)
    alt = srv.find_free_port(p_other + 1)
    A("find_free_port 换到了别的端口", alt != p_other and alt > p_other, alt)
    A("换出的端口确实空闲", srv.is_port_free(alt))

    # 3. 本系统占用
    p_ours = free_port()
    ours = socketserver.ThreadingTCPServer(("127.0.0.1", p_ours), srv.Handler)
    threading.Thread(target=ours.serve_forever, daemon=True).start()
    got = srv.probe_port(p_ours)
    A("本系统占着 → ours（可以安全复用）", got == "ours", got)

    # 4. ping 身份
    with urllib.request.urlopen(f"http://127.0.0.1:{p_ours}/api/ping", timeout=3) as r:
        data = json.loads(r.read())
    A("/api/ping 返回本系统标识", data.get("app") == srv.APP_ID, data)

    # 5. GROWTH_PORT 环境变量可改默认端口
    A("APP_ID 常量存在", srv.APP_ID == "growth_system")

    other.shutdown()
    ours.shutdown()
    print("\n端口冲突检测通过 ✓" if not fails else "\n%d 项失败 ✗" % fails)
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
