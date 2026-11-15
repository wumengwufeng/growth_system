"""server.py 存档冲突检测的行为测试（不需要联网、不启动 Magpie）。

起一个临时目录里的 ThreadingHTTPServer，复用 server.py 的 Handler，验证：
1. GET /api/save 返回 X-Save-Mtime
2. 首次 POST（无 X-Save-Mtime）正常落盘并回 mtime
3. 用过期 mtime POST → 409，且磁盘内容未被覆盖
4. 用最新 mtime POST → 200 并更新
运行：python tests/save_conflict.py
"""
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import http.server

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

fails = 0


def A(name, cond):
    global fails
    print(("ok: " if cond else "FAIL: ") + name)
    if not cond:
        fails += 1


def main():
    tmp = tempfile.mkdtemp(prefix="growth_save_")
    os.makedirs(os.path.join(tmp, "data"), exist_ok=True)
    server.DATA_FILE = os.path.join(tmp, "data", "growth.json")
    server.HERE = tmp

    handler = lambda *a, **kw: server.Handler(*a, directory=tmp, **kw)  # noqa: E731
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def req(method, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        c.request(method, "/api/save", body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data

    A("磁盘空时 GET 返回 404", req("GET")[0] == 404)

    first = json.dumps({"player": {"name": "A"}, "updatedAt": 100}).encode()
    st, hd, _ = req("POST", first, {"Content-Type": "application/json"})
    A("首次 POST 落盘 200", st == 200)
    m1 = hd.get("X-Save-Mtime")
    A("响应带 X-Save-Mtime", m1 is not None)

    st, hd, _ = req("GET")
    A("GET 返回 mtime 头", hd.get("X-Save-Mtime") is not None)
    A("GET 内容为刚写入的", json.loads(req("GET")[2])["player"]["name"] == "A")

    stale = json.dumps({"player": {"name": "B"}, "updatedAt": 200}).encode()
    st, hd, data = req("POST", stale, {"Content-Type": "application/json", "X-Save-Mtime": "1.0"})
    A("过期 mtime → 409", st == 409)
    A("409 返回磁盘当前内容供合并", json.loads(data)["player"]["name"] == "A")
    A("409 时磁盘未被覆盖", json.loads(open(server.DATA_FILE, encoding="utf-8").read())["player"]["name"] == "A")

    st, hd, _ = req("POST", stale, {"Content-Type": "application/json", "X-Save-Mtime": m1})
    A("最新 mtime → 200 覆盖成功", st == 200)
    A("覆盖后磁盘为新内容", json.loads(open(server.DATA_FILE, encoding="utf-8").read())["player"]["name"] == "B")

    st, _, _ = req("POST", b"{bad json", {"Content-Type": "application/json"})
    A("非法 JSON → 400", st == 400)

    srv.shutdown()
    print("\n存档冲突检测通过 ✓" if not fails else "\n%d 项失败 ✗" % fails)
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
