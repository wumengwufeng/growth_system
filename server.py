"""宿主成长系统启动器：静态文件 + 同源代理（绕开 Magpie 网关无 CORS 的限制）
+ 磁盘存档（/api/save：POST 落盘 / GET 读取，供前端自动备份与清缓存后恢复）
+ 每日自动备份（data/backups/ 里留最近 7 份 growth-YYYY-MM-DD.json）。"""
import http.server
import json
import os
import shutil
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

# Windows 控制台默认 GBK：提示语里的 ⚠/✓ 之类会让 print 抛 UnicodeEncodeError
# （曾经把"自动换端口"的提示本身变成崩溃）。启动就把输出切成 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

APP_ID = "growth_system"          # /api/ping 的身份标识，用来判断端口上跑的是不是本系统
PORT = int(os.environ.get("GROWTH_PORT") or 8765)
TARGET = "http://127.0.0.1:3425"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "data", "growth.json")
HOP_HEADERS = ("content-type", "authorization", "accept")
MAX_SAVE_BYTES = 5_000_000
BACKUP_KEEP = 7                                      # 最多保留最近 7 份（按文件名日期排）
_backup_lock = threading.Lock()                      # ThreadingHTTPServer 并发保存时防当天备份写坏


def log_backup(msg):
    """备份环节的日志：本文件没有独立的日志文件，与现有做法一致走 print。

    桌面版（宿主成长系统.pyw）会把 stdout 接到 data/stderr.log，所以 pythonw 下
    这些行也能留下排障线索；print 本身再套一层兜底，保证日志永不反过来炸流程。
    """
    try:
        print("[backup] " + msg)
    except Exception:
        pass


def daily_backup(today=None):
    """把当前 data/growth.json 复制一份到 data/backups/growth-YYYY-MM-DD.json。

    幂等：当天已有备份就直接返回（同一天反复保存不会反复备份）。
    顺手清理旧备份，只留最近 BACKUP_KEEP 份。任何异常都在这里吞掉并写日志，
    绝不往 /api/save 的主流程抛。
    """
    try:
        date = today or time.strftime("%Y-%m-%d")
        with _backup_lock:
            if not os.path.exists(DATA_FILE):
                return False  # 还没有任何存档（首次启动），没东西可备
            # 备份目录随 HERE 走（而非 import 时定死）：tests 会把 HERE 指到临时目录，
            # 这样测试里产生的备份也落在临时目录，不会污染真实 data/backups/
            backup_dir = os.path.join(os.path.dirname(DATA_FILE), "backups")
            os.makedirs(backup_dir, exist_ok=True)
            dest = os.path.join(backup_dir, "growth-%s.json" % date)
            if not os.path.exists(dest):
                # 与 /api/save 落盘同一套「临时文件 + 原子替换」写法，避免备份写一半被读到
                tmp = dest + ".tmp"
                shutil.copyfile(DATA_FILE, tmp)
                os.replace(tmp, dest)
                log_backup("已备份 %s" % dest)
            # 清理：只认本功能的命名格式，按文件名（即日期）排序，超出的旧份删掉
            # （[: -7] 在总数不足 7 时自然得到空列表，不会误删）
            backups = sorted(
                f for f in os.listdir(backup_dir)
                if f.startswith("growth-") and f.endswith(".json")
                and len(f) == len("growth-YYYY-MM-DD.json")
            )
            for old in backups[:-BACKUP_KEEP]:
                try:
                    os.remove(os.path.join(backup_dir, old))
                    log_backup("清理旧备份 %s" % old)
                except OSError as e:
                    log_backup("清理 %s 失败：%s" % (old, e))
            return True
    except Exception as e:  # 备份是锦上添花：坏了只记日志，不许影响保存主流程
        log_backup("备份失败（已忽略）：%s" % e)
        return False


def is_port_free(port, host="127.0.0.1"):
    """端口是否能被绑定。用 SO_EXCLUSIVEADDRUSE 的近似做法（直接尝试 bind）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def probe_port(port, host="127.0.0.1", timeout=1.5):
    """探测端口上跑的是谁：'ours' / 'other' / 'free'。

    只看端口是否被占用是不够的——别的项目（比如本机另一个 Web 应用）占了同一端口时，
    桌面版会把别人的页面当成本系统打开。所以真问一句 /api/ping。
    """
    if is_port_free(port, host):
        return "free"
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/ping", timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        return "ours" if data.get("app") == APP_ID else "other"
    except Exception:
        return "other"


def find_free_port(preferred, host="127.0.0.1", limit=50):
    """从 preferred 起找一个空闲端口；期间跳过被占用的。"""
    for p in range(preferred, preferred + limit):
        if is_port_free(p, host):
            return p
    raise OSError(f"从 {preferred} 起连续 {limit} 个端口都被占用")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # 本地应用：改版即生效，杜绝旧 UI 缓存
        super().end_headers()

    def _send(self, code, body, extra_headers=None):
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 页面已关闭/刷新：客户端断开不是错误，别在控制台刷 traceback

    def _proxy(self, method):
        url = TARGET + self.path[len("/api"):]  # /api/v1/x -> /v1/x
        data = self.rfile.read(int(self.headers.get("Content-Length", 0))) if method == "POST" else None
        headers = {k: v for k, v in self.headers.items() if k.lower() in HOP_HEADERS}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                self._send(r.status, r.read())
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read())
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._send(502, json.dumps({"error": str(e)}).encode())

    def _handle_save(self, method):
        if method == "GET":
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, "rb") as f:
                    body = f.read()
                self._send(200, body, {"X-Save-Mtime": str(os.path.getmtime(DATA_FILE))})
            else:
                self._send(404, b'{"error":"no_save"}')
            return
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_SAVE_BYTES:
            self._send(413, b'{"error":"too_large"}')
            return
        body = self.rfile.read(length) if length else b""
        try:
            json.loads(body)  # 只收合法 JSON
        except Exception:
            self._send(400, b'{"error":"bad_json"}')
            return
        # 冲突检测：客户端带上它上次看到的 mtime，若磁盘已被别处（另一个窗口/浏览器版）改写
        # 就拒绝覆盖（409），把当前磁盘状态交还前端去合并，避免双开互踩丢档。
        base = self.headers.get("X-Save-Mtime")
        cur = os.path.getmtime(DATA_FILE) if os.path.exists(DATA_FILE) else None
        if base and cur is not None and base.strip() != "" and abs(float(base) - cur) > 1e-6:
            with open(DATA_FILE, "rb") as f:
                current = f.read()
            self._send(409, current, {"X-Save-Mtime": str(cur)})
            return
        os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
        tmp = DATA_FILE + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, DATA_FILE)  # 原子替换，避免写一半被读
        daily_backup()  # 每日备份：幂等，当天已有则跳过；内部自带兜底，失败不影响本次保存响应
        self._send(200, b'{"ok":true}', {"X-Save-Mtime": str(os.path.getmtime(DATA_FILE))})

    def do_GET(self):
        if self.path.startswith("/api/ping"):
            body = json.dumps({"app": APP_ID, "version": 1}).encode()
            self._send(200, body)
        elif self.path.startswith("/api/save"):
            self._handle_save("GET")
        elif self.path.startswith("/api/"):
            self._proxy("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/save"):
            self._handle_save("POST")
        elif self.path.startswith("/api/"):
            self._proxy("POST")
        else:
            self.send_error(404)

    def log_message(self, *a):  # 静音静态文件日志，代理报错仍会打印
        pass


if __name__ == "__main__":
    os.chdir(HERE)
    state = probe_port(PORT)
    if state == "ours":
        print(f"宿主成长系统已经在运行：http://127.0.0.1:{PORT}  （直接刷新浏览器即可）")
        sys.exit(0)
    if state == "other":
        alt = find_free_port(PORT + 1)
        print(f"⚠ 端口 {PORT} 已被其他程序占用，本系统改用 {alt}。")
        print(f"  如果那个程序不需要，关掉它后重新启动即可回到 {PORT}。")
        PORT = alt
    try:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print(f"无法在端口 {PORT} 启动服务：{e}")
        sys.exit(1)
    # 把实际端口写出来，供 启动系统.bat 打开正确的地址
    try:
        os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
        with open(os.path.join(HERE, "data", "port.txt"), "w", encoding="utf-8") as f:
            f.write(str(PORT))
    except OSError:
        pass
    print(f"宿主成长系统已启动：http://127.0.0.1:{PORT}  （Ctrl+C 退出）")
    daily_backup()  # 启动时补一次当日备份检查：上次运行可能是昨天，今天还没备过
    srv.serve_forever()
