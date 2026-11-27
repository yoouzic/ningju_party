#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""21届凝聚力晚会互动系统服务端（Python 标准库，零外部依赖）

对应《21届凝聚力晚会游戏互动与抽奖说明.docx》三个环节：
  ① 摇一摇拼手速：主持人后台统一开赛，服务端累计有效步数并权威计时，
     按到达终点先后锁定前 10 名，发放额外刮刮乐 + 小礼物。
  ② 线上答题竞速：服务端下发题目与计时，按「正确数降序、用时升序」排名。
  ③ 幸运大抽奖：刮刮乐编号 000-199、双抽奖箱（百位 0/1，十位个位 0-9 有放回）、
     幸运转盘 6 种奖品等概率且不放回；库存与每种上限后台可配置，现场再定。

所有业务判定都在服务端；客户端只负责呈现与上报操作，不能直接提交分数或名次。
"""
from __future__ import annotations

import argparse
import base64
import functools
import hashlib
import hmac
import io
import json
import os
import random
import secrets
import socket
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, "pixel_rush.db")
BASE_PATH = os.environ.get("PIXEL_RUSH_BASE", "").strip().rstrip("/")
if ":" in BASE_PATH or "\\" in BASE_PATH or " " in BASE_PATH:
    BASE_PATH = ""
API_PREFIX = "/api/" if BASE_PATH else "/pixel-rush/api/"
DB_LOCK = threading.RLock()

TOP_N_DEFAULT = 10
DURATION_DEFAULT = 45
TARGET_STEPS_DEFAULT = 480
MAX_RATE = 14.0
CARD_TOTAL = 200
GIFT_TOTAL = 20

PRIZE_DEFAULTS = [
    ("护眼LED小台灯", 3, 3), ("U型旅行护颈枕", 3, 3), ("充电宝", 3, 3),
    ("多功能电子钟", 3, 3), ("可爱玩偶", 3, 3), ("精美保温杯", 3, 3),
]
QUIZ_SAMPLE = [
    ("单选", "1 + 1 = ?", ["1", "2", "3", "4"], "2"),
    ("单选", "一天有多少小时？", ["12", "24", "36", "48"], "24"),
    ("单选", "下列哪个是偶数？", ["3", "5", "8", "11"], "8"),
    ("单选", "水的化学式是？", ["CO2", "H2O", "O2", "NaCl"], "H2O"),
    ("单选", "一周有几天？", ["5", "6", "7", "8"], "7"),
    ("单选", "10 的平方是？", ["10", "20", "100", "1000"], "100"),
    ("多选", "下列哪些是质数？", ["2", "4", "7", "9"], "2|7"),
    ("多选", "下列哪些颜色属于光的三原色？", ["红", "绿", "蓝", "黄"], "红|绿|蓝"),
    ("单选", "《西游记》中孙悟空使用的兵器是？", ["九齿钉耙", "如意金箍棒", "青龙偃月刀", "方天画戟"], "如意金箍棒"),
    ("单选", "下列哪个数最大？", ["0.5", "0.05", "0.51", "0.15"], "0.51"),
]


def strip_base(path):
    if BASE_PATH and (path == BASE_PATH or path.startswith(BASE_PATH + "/")):
        return path[len(BASE_PATH):] or "/"
    return path


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=8000")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def tx():
    with DB_LOCK:
        conn = db()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def fetch(sql, args=(), one=False):
    with tx() as c:
        cur = c.execute(sql, args)
        rows = cur.fetchall() if cur.description else []
    return (rows[0] if rows else None) if one else rows


def get_setting(key, default=None):
    r = fetch("SELECT value FROM settings WHERE key = ?", (key,), one=True)
    return r["value"] if r else default


def set_setting(key, value):
    with tx() as c:
        c.execute("INSERT INTO settings(key,value) VALUES(?,?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def secret_bytes():
    s = get_setting("secret")
    if not s:
        s = secrets.token_hex(32)
        set_setting("secret", s)
    return bytes.fromhex(s)


def init_db():
    with tx() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS players(
            id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE, device TEXT,
            card_no TEXT, created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS cards(
            no TEXT PRIMARY KEY, owner_id TEXT, source TEXT, round_id INTEGER,
            assigned_at REAL, claimed_at REAL, gift_claimed_at REAL);
        CREATE TABLE IF NOT EXISTS rounds(
            id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, status TEXT NOT NULL,
            started_at REAL, ends_at REAL, config TEXT, created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS steps(
            round_id INTEGER NOT NULL, player_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
            last_at REAL, finished_at REAL, rank INTEGER,
            PRIMARY KEY(round_id, player_id));
        CREATE TABLE IF NOT EXISTS quiz_questions(
            id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL, order_no INTEGER,
            prompt TEXT, qtype TEXT, options TEXT, answer TEXT);
        CREATE TABLE IF NOT EXISTS quiz_attempts(
            id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL, player_id TEXT NOT NULL,
            answers TEXT, correct_count INTEGER, total_count INTEGER, elapsed_ms INTEGER,
            submitted_at REAL, rank INTEGER, UNIQUE(round_id, player_id));
        CREATE TABLE IF NOT EXISTS rewards(
            round_id INTEGER NOT NULL, player_id TEXT NOT NULL, rank INTEGER,
            card_no TEXT, gift INTEGER DEFAULT 1, claimed_at REAL, gift_claimed_at REAL,
            PRIMARY KEY(round_id, player_id));
        CREATE TABLE IF NOT EXISTS prizes(
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, stock_total INTEGER,
            per_kind_limit INTEGER, enabled INTEGER DEFAULT 1, sort_no INTEGER);
        CREATE TABLE IF NOT EXISTS draws(
            id INTEGER PRIMARY KEY AUTOINCREMENT, card_no TEXT, player_id TEXT, balls TEXT,
            prize_id INTEGER, drawn_at REAL, note TEXT);
        CREATE TABLE IF NOT EXISTS audit(
            id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, detail TEXT, at REAL);
        """)
        for i in range(CARD_TOTAL):
            c.execute("INSERT OR IGNORE INTO cards(no) VALUES(?)", ("%03d" % i,))
        if not c.execute("SELECT 1 FROM prizes LIMIT 1").fetchone():
            for idx, (name, stock, limit) in enumerate(PRIZE_DEFAULTS):
                c.execute("INSERT INTO prizes(name,stock_total,per_kind_limit,enabled,sort_no) "
                          "VALUES(?,?,?,1,?)", (name, stock, limit, idx))
        if not c.execute("SELECT 1 FROM quiz_questions WHERE round_id=0 LIMIT 1").fetchone():
            for idx, (qtype, prompt, opts, ans) in enumerate(QUIZ_SAMPLE, 1):
                c.execute("INSERT INTO quiz_questions(round_id,order_no,prompt,qtype,options,answer) "
                          "VALUES(0,?,?,?,?,?)", (idx, prompt, qtype, json.dumps(opts, ensure_ascii=False), ans))
    defaults = {
        "top_n": TOP_N_DEFAULT, "duration": DURATION_DEFAULT, "target_steps": TARGET_STEPS_DEFAULT,
        "gift_total": GIFT_TOTAL, "max_rate": MAX_RATE,
    }
    for k, v in defaults.items():
        if get_setting(k) is None:
            set_setting(k, v)
    secret_bytes()
    pwd = os.environ.get("PIXEL_RUSH_ADMIN_PASSWORD")
    if get_setting("admin_pwd_hash") is None:
        if not pwd:
            pwd = secrets.token_urlsafe(10)
            print("  [重要] 未设置 PIXEL_RUSH_ADMIN_PASSWORD，已生成随机管理口令：" + pwd)
        set_setting("admin_pwd_hash", hashlib.sha256((secret_bytes().hex() + pwd).encode()).hexdigest())
    return pwd


def log(action, detail=""):
    with tx() as c:
        c.execute("INSERT INTO audit(action,detail,at) VALUES(?,?,?)", (action, detail, time.time()))


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def make_token(payload):
    body = b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = b64(hmac.new(secret_bytes(), body.encode(), hashlib.sha256).digest())
    return body + "." + sig


def parse_token(token):
    if not token or "." not in token:
        return None
    body, sig = token.split(".", 1)
    want = b64(hmac.new(secret_bytes(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, want):
        return None
    try:
        return json.loads(unb64(body).decode())
    except Exception:
        return None


def auth_of(handler, payload=None, kind="player"):
    token = ""
    hdr = handler.headers.get("Authorization") or ""
    if hdr.startswith("Bearer "):
        token = hdr[7:].strip()
    if not token and isinstance(payload, dict):
        token = payload.get("token") or ""
    info = parse_token(token)
    if not info or info.get("k") != kind:
        return None
    return info


def public_int(key, default):
    try:
        return int(float(get_setting(key, default)))
    except (TypeError, ValueError):
        return default


def current_round():
    r = fetch("SELECT * FROM rounds WHERE status='running' ORDER BY id DESC LIMIT 1", one=True)
    if r:
        return r
    return fetch("SELECT * FROM rounds ORDER BY id DESC LIMIT 1", one=True)


def round_view(r):
    if not r:
        return None
    now = time.time()
    return {
        "id": r["id"], "kind": r["kind"], "status": r["status"],
        "started_at": r["started_at"], "ends_at": r["ends_at"],
        "seconds_left": max(0, int((r["ends_at"] or now) - now)),
        "duration": public_int("duration", DURATION_DEFAULT),
        "target_steps": public_int("target_steps", TARGET_STEPS_DEFAULT),
        "top_n": public_int("top_n", TOP_N_DEFAULT),
    }


def assign_card(player_id, source, round_id=None):
    with tx() as c:
        row = c.execute("SELECT no FROM cards WHERE owner_id IS NULL ORDER BY no LIMIT 1").fetchone()
        if not row:
            return None
        no = row["no"]
        c.execute("UPDATE cards SET owner_id=?,source=?,round_id=?,assigned_at=? WHERE no=?",
                  (player_id, source, round_id, time.time(), no))
        if source == "base":
            c.execute("UPDATE players SET card_no=? WHERE id=?", (no, player_id))
    return no


def rank_rows(kind, round_id):
    if kind == "shake":
        rows = fetch("SELECT s.player_id, p.name, s.rank, s.finished_at, s.count "
                     "FROM steps s JOIN players p ON p.id=s.player_id "
                     "WHERE s.round_id=? AND s.finished_at IS NOT NULL "
                     "ORDER BY s.finished_at ASC, s.player_id ASC", (round_id,))
        return [{"name": r["name"], "player_id": r["player_id"], "rank": r["rank"] or i + 1,
                 "score": r["count"], "elapsed": round((r["finished_at"] or 0) * 1000)} for i, r in enumerate(rows)]
    rows = fetch("SELECT a.player_id, p.name, a.correct_count, a.total_count, a.elapsed_ms, a.rank "
                 "FROM quiz_attempts a JOIN players p ON p.id=a.player_id WHERE a.round_id=? "
                 "ORDER BY a.correct_count DESC, a.elapsed_ms ASC, a.submitted_at ASC", (round_id,))
    return [{"name": r["name"], "player_id": r["player_id"], "rank": r["rank"] or i + 1,
             "score": int(r["correct_count"] or 0), "elapsed": int(r["elapsed_ms"] or 0),
             "total": int(r["total_count"] or 0)} for i, r in enumerate(rows)]


def close_round(round_id):
    r = fetch("SELECT * FROM rounds WHERE id=?", (round_id,), one=True)
    if not r or r["status"] != "running":
        return {"error": "轮次不在进行中"}, 409
    kind = r["kind"]
    with tx() as c:
        c.execute("UPDATE rounds SET status='closed', ends_at=? WHERE id=?", (time.time(), round_id))
    ranked = rank_rows(kind, round_id)
    top_n = public_int("top_n", TOP_N_DEFAULT)
    awarded = 0
    with tx() as c:
        for i, item in enumerate(ranked, 1):
            table = "steps" if kind == "shake" else "quiz_attempts"
            c.execute("UPDATE %s SET rank=? WHERE round_id=? AND player_id=?" % table,
                      (i, round_id, item["player_id"]))
            if i <= top_n:
                card = c.execute("SELECT no FROM cards WHERE owner_id IS NULL ORDER BY no LIMIT 1").fetchone()
                card_no = card["no"] if card else None
                if card_no:
                    c.execute("UPDATE cards SET owner_id=?,source='reward',round_id=?,assigned_at=? WHERE no=?",
                              (item["player_id"], round_id, time.time(), card_no))
                c.execute("INSERT OR REPLACE INTO rewards(round_id,player_id,rank,card_no,gift) "
                          "VALUES(?,?,?,?,1)", (round_id, item["player_id"], i, card_no))
                awarded += 1
    log("close_round", json.dumps({"round_id": round_id, "kind": kind, "awarded": awarded}, ensure_ascii=False))
    return {"round_id": round_id, "ranked": len(ranked), "awarded": awarded,
            "top": ranked[:top_n]}, 200


def open_round(kind, duration=None, title=""):
    if kind not in ("shake", "quiz"):
        return {"error": "未知环节"}, 400
    for r in fetch("SELECT id FROM rounds WHERE status='running'"):
        close_round(r["id"])
    dur = int(duration or public_int("duration", DURATION_DEFAULT))
    now = time.time()
    with tx() as c:
        cur = c.execute("INSERT INTO rounds(kind,status,started_at,ends_at,config,created_at) "
                        "VALUES(?,?,?,?,?,?)",
                        (kind, "running", now, now + dur,
                         json.dumps({"title": title, "duration": dur}, ensure_ascii=False), now))
        rid = cur.lastrowid
        if kind == "quiz":
            for q in c.execute("SELECT * FROM quiz_questions WHERE round_id=0 ORDER BY order_no").fetchall():
                c.execute("INSERT INTO quiz_questions(round_id,order_no,prompt,qtype,options,answer) "
                          "VALUES(?,?,?,?,?,?)",
                          (rid, q["order_no"], q["prompt"], q["qtype"], q["options"], q["answer"]))
    log("open_round", json.dumps({"round_id": rid, "kind": kind, "duration": dur}, ensure_ascii=False))
    return {"round_id": rid, "kind": kind, "status": "running", "duration": dur}, 200


def board_payload(kind=None):
    r = current_round()
    k = kind or (r["kind"] if r else "shake")
    rid = r["id"] if r else 0
    rows = rank_rows(k, rid) if rid else []
    return {"kind": k, "round": round_view(r), "entries": rows[:50], "total": len(rows)}


def status_payload(handler):
    r = current_round()
    players = fetch("SELECT COUNT(*) AS n FROM players", one=True)["n"]
    cards_used = fetch("SELECT COUNT(*) AS n FROM cards WHERE owner_id IS NOT NULL", one=True)["n"]
    rewards = fetch("SELECT COUNT(*) AS n FROM rewards", one=True)["n"]
    draws = fetch("SELECT d.card_no, p.name AS player, pr.name AS prize, d.drawn_at, d.balls "
                  "FROM draws d LEFT JOIN players p ON p.id=d.player_id "
                  "LEFT JOIN prizes pr ON pr.id=d.prize_id ORDER BY d.id DESC LIMIT 12")
    me = None
    info = auth_of(handler, kind="player")
    if info:
        p = fetch("SELECT * FROM players WHERE id=?", (info.get("p"),), one=True)
        if p:
            me = {"id": p["id"], "name": p["name"], "code": p["code"], "card_no": p["card_no"]}
    return {
        "server_time": time.time(),
        "round": round_view(r),
        "board": board_payload(r["kind"] if r else "shake"),
        "stats": {"players": players, "cards_used": cards_used, "cards_total": CARD_TOTAL,
                  "rewards": rewards, "gift_total": public_int("gift_total", GIFT_TOTAL)},
        "draws": [dict(x) for x in draws],
        "me": me,
        "pages": {"shake": "/", "quiz": "/quiz.html", "board": "/board.html", "admin": "/admin.html"},
        "settings": {"top_n": public_int("top_n", TOP_N_DEFAULT),
                     "duration": public_int("duration", DURATION_DEFAULT),
                     "target_steps": public_int("target_steps", TARGET_STEPS_DEFAULT)},
    }


def admin_state():
    r = current_round()
    prizes = [dict(x) for x in fetch(
        "SELECT p.*, (SELECT COUNT(*) FROM draws d WHERE d.prize_id=p.id) AS used "
        "FROM prizes p ORDER BY sort_no")]
    questions = [dict(x) for x in fetch("SELECT * FROM quiz_questions WHERE round_id=0 ORDER BY order_no")]
    for q in questions:
        try:
            q["options"] = json.loads(q["options"])
        except Exception:
            q["options"] = []
        q.pop("round_id", None)
        q.pop("id", None)
    draws = [dict(x) for x in fetch(
        "SELECT d.id, d.card_no, p.name AS player, pr.name AS prize, d.balls, d.drawn_at "
        "FROM draws d LEFT JOIN players p ON p.id=d.player_id "
        "LEFT JOIN prizes pr ON pr.id=d.prize_id ORDER BY d.id DESC LIMIT 50")]
    rewards = [dict(x) for x in fetch(
        "SELECT rw.*, p.name, p.card_no AS base_card FROM rewards rw "
        "JOIN players p ON p.id=rw.player_id ORDER BY rw.round_id DESC, rw.rank ASC")]
    settings = {}
    for k, d in [("top_n", TOP_N_DEFAULT), ("duration", DURATION_DEFAULT),
                 ("target_steps", TARGET_STEPS_DEFAULT), ("gift_total", GIFT_TOTAL), ("max_rate", MAX_RATE)]:
        try:
            settings[k] = int(float(get_setting(k, d)))
        except (TypeError, ValueError):
            settings[k] = d
    return {
        "round": round_view(r), "board": board_payload(r["kind"] if r else "shake"),
        "prizes": prizes, "questions": questions, "draws": draws, "rewards": rewards,
        "settings": settings,
        "stats": {"players": fetch("SELECT COUNT(*) n FROM players", one=True)["n"],
                  "cards_used": fetch("SELECT COUNT(*) n FROM cards WHERE owner_id IS NOT NULL", one=True)["n"],
                  "cards_total": CARD_TOTAL,
                  "draw_count": fetch("SELECT COUNT(*) n FROM draws", one=True)["n"]},
        "audit": [dict(x) for x in fetch("SELECT * FROM audit ORDER BY id DESC LIMIT 30")],
    }


def qr_svg(text):
    try:
        import segno
        q = segno.make(text, error="m")
        buf = io.BytesIO()
        q.save(buf, kind="svg", scale=6, border=2, dark="#2e222f", light="#fdf3e0", xmldecl=False, nl=False)
        return buf.getvalue().decode("utf-8")
    except Exception:
        return None


class Handler(SimpleHTTPRequestHandler):
    server_version = "NingjuParty/2.0"

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _raw(self, body, ctype, status=200):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return {}

    def _api_error(self, msg, status=400):
        return self._json({"error": msg}, status)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = strip_base(parsed.path)
        qs = parse_qs(parsed.query)
        if not path.startswith(API_PREFIX):
            if path == "/":
                path = "/index.html"
            if any(path.lower().endswith(ext) for ext in
                   (".db", ".py", ".pyc", ".service", ".conf", ".env", ".log", ".sqlite", ".sqlite3")):
                return self._api_error("forbidden", 403)
            self.path = path + (("?" + parsed.query) if parsed.query else "")
            return super().do_GET()
        route = path[len(API_PREFIX):]
        if route == "status":
            return self._json(status_payload(self))
        if route == "board":
            return self._json(board_payload((qs.get("kind") or [None])[0]))
        if route == "qrcode":
            url = (qs.get("url") or [""])[0]
            if not url.startswith(("http://", "https://")):
                return self._api_error("bad url", 400)
            svg = qr_svg(url)
            if not svg:
                return self._api_error("qr generator unavailable (install segno)", 503)
            return self._raw(svg, "image/svg+xml; charset=utf-8")
        if route == "quiz/questions":
            info = auth_of(self, kind="player")
            if not info:
                return self._api_error("未登录", 401)
            r = current_round()
            if not r or r["kind"] != "quiz":
                return self._api_error("当前不是答题环节", 409)
            rows = fetch("SELECT id,order_no,prompt,qtype,options FROM quiz_questions "
                         "WHERE round_id=? ORDER BY order_no", (r["id"],))
            out = []
            for x in rows:
                try:
                    opts = json.loads(x["options"])
                except Exception:
                    opts = []
                out.append({"id": x["id"], "order_no": x["order_no"], "prompt": x["prompt"],
                            "qtype": x["qtype"], "options": opts})
            return self._json({"round": round_view(r), "questions": out})
        if route == "admin/state":
            if not auth_of(self, kind="admin"):
                return self._api_error("需要管理员登录", 401)
            return self._json(admin_state())
        return self._api_error("not found", 404)

    def do_POST(self):
        path = strip_base(urlparse(self.path).path)
        if not path.startswith(API_PREFIX):
            return self._api_error("not found", 404)
        route = path[len(API_PREFIX):]
        payload = self._body()

        if route == "join":
            name = str(payload.get("name") or "").strip()[:12] or "信息员"
            code = str(payload.get("code") or "").strip()[:24]
            device = str(payload.get("device") or "").strip()[:40] or uuid.uuid4().hex[:10]
            pid = "p" + hashlib.sha256(("ningju|" + (code or device)).encode()).hexdigest()[:16]
            with tx() as c:
                row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
                if not row:
                    try:
                        c.execute("INSERT INTO players(id,name,code,device,created_at) VALUES(?,?,?,?,?)",
                                  (pid, name, code or None, device, time.time()))
                    except sqlite3.IntegrityError:
                        other = c.execute("SELECT * FROM players WHERE code=?", (code,)).fetchone()
                        if other:
                            pid = other["id"]
                row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
                need_card = not row["card_no"]
            if need_card:
                assign_card(pid, "base")
            p = fetch("SELECT * FROM players WHERE id=?", (pid,), one=True)
            return self._json({"token": make_token({"p": pid, "k": "player", "t": time.time()}),
                               "player": {"id": p["id"], "name": p["name"], "code": p["code"],
                                          "card_no": p["card_no"]},
                               "round": round_view(current_round())})

        if route == "step":
            info = auth_of(self, payload, "player")
            if not info:
                return self._api_error("未登录", 401)
            r = current_round()
            if not r or r["status"] != "running" or r["kind"] != "shake":
                return self._api_error("本环节未开始", 409)
            now = time.time()
            if now > (r["ends_at"] or 0) + 1:
                close_round(r["id"])
                return self._api_error("本环节已结束", 409)
            delta = max(0, min(int(payload.get("steps") or 0), 12))
            pid = info["p"]
            with tx() as c:
                row = c.execute("SELECT * FROM steps WHERE round_id=? AND player_id=?",
                                (r["id"], pid)).fetchone()
                count = int(row["count"]) if row else 0
                last_at = float(row["last_at"]) if row and row["last_at"] else r["started_at"]
                if row and row["finished_at"]:
                    return self._json({"progress": 100, "finished": True,
                                       "rank": row["rank"], "count": count})
                rate = float(get_setting("max_rate", MAX_RATE))
                allowed = max(0, int((now - last_at) * rate + 1))
                delta = min(delta, allowed, int(rate) + 2)
                count += delta
                c.execute("INSERT INTO steps(round_id,player_id,count,last_at) VALUES(?,?,?,?) "
                          "ON CONFLICT(round_id,player_id) DO UPDATE SET count=excluded.count,last_at=excluded.last_at",
                          (r["id"], pid, count, now))
            target = public_int("target_steps", TARGET_STEPS_DEFAULT)
            progress = min(100.0, count / target * 100.0)
            if count >= target:
                with tx() as c:
                    row = c.execute("SELECT finished_at,rank FROM steps WHERE round_id=? AND player_id=?",
                                    (r["id"], pid)).fetchone()
                    if not row["finished_at"]:
                        rank = c.execute("SELECT COUNT(*) n FROM steps WHERE round_id=? AND finished_at IS NOT NULL",
                                         (r["id"],)).fetchone()["n"] + 1
                        c.execute("UPDATE steps SET finished_at=?,rank=? WHERE round_id=? AND player_id=?",
                                  (now, rank, r["id"], pid))
                    else:
                        rank = row["rank"]
                return self._json({"progress": 100, "finished": True, "rank": rank, "count": count})
            return self._json({"progress": progress, "finished": False, "rank": None, "count": count})

        if route == "quiz/submit":
            info = auth_of(self, payload, "player")
            if not info:
                return self._api_error("未登录", 401)
            r = current_round()
            if not r or r["status"] != "running" or r["kind"] != "quiz":
                return self._api_error("答题环节未开始", 409)
            now = time.time()
            answers = payload.get("answers") or {}
            qs = fetch("SELECT id,answer,qtype FROM quiz_questions WHERE round_id=?", (r["id"],))
            correct, total = 0, len(qs)
            for q in qs:
                given = str(answers.get(str(q["id"])) or "").strip()
                if not given:
                    continue
                if str(q["qtype"]) == "多选":
                    a = set(str(q["answer"]).split("|"))
                    b = set(x for x in given.split("|") if x)
                else:
                    a, b = {str(q["answer"])}, {given}
                if a == b:
                    correct += 1
            elapsed_ms = max(0, int((now - r["started_at"]) * 1000))
            pid = info["p"]
            with tx() as c:
                c.execute("INSERT INTO quiz_attempts(round_id,player_id,answers,correct_count,total_count,"
                          "elapsed_ms,submitted_at) VALUES(?,?,?,?,?,?,?) "
                          "ON CONFLICT(round_id,player_id) DO UPDATE SET answers=excluded.answers,"
                          "correct_count=excluded.correct_count,total_count=excluded.total_count,"
                          "elapsed_ms=excluded.elapsed_ms,submitted_at=excluded.submitted_at",
                          (r["id"], pid, json.dumps(answers, ensure_ascii=False), correct, total,
                           elapsed_ms, now))
            log("quiz_submit", json.dumps({"round": r["id"], "player": pid, "correct": correct}, ensure_ascii=False))
            return self._json({"correct": correct, "total": total, "elapsed_ms": elapsed_ms,
                               "round": round_view(r)})

        if route == "admin/login":
            pwd = str(payload.get("password") or "")
            want = get_setting("admin_pwd_hash", "")
            got = hashlib.sha256((secret_bytes().hex() + pwd).encode()).hexdigest()
            if not hmac.compare_digest(got, want):
                return self._api_error("口令错误", 401)
            return self._json({"token": make_token({"p": "admin", "k": "admin", "t": time.time()})})

        if not route.startswith("admin/"):
            return self._api_error("not found", 404)
        if not auth_of(self, payload, "admin"):
            return self._api_error("需要管理员登录", 401)

        if route == "admin/round/open":
            result, st = open_round(str(payload.get("kind") or ""), payload.get("duration"),
                                    str(payload.get("title") or ""))
            return self._json(result, st)
        if route == "admin/round/close":
            rid = int(payload.get("round_id") or (current_round() or {"id": 0})["id"])
            result, st = close_round(rid)
            return self._json(result, st)
        if route == "admin/round/void":
            rid = int(payload.get("round_id") or 0)
            with tx() as c:
                c.execute("DELETE FROM steps WHERE round_id=?", (rid,))
                c.execute("DELETE FROM quiz_attempts WHERE round_id=?", (rid,))
                c.execute("DELETE FROM rewards WHERE round_id=?", (rid,))
                c.execute("UPDATE rounds SET status='void' WHERE id=?", (rid,))
            log("void_round", str(rid))
            return self._json({"ok": True, "round_id": rid})
        if route == "admin/settings":
            allowed = {"top_n", "duration", "target_steps", "gift_total", "max_rate"}
            changed = {}
            for k, v in (payload.get("settings") or {}).items():
                if k in allowed:
                    set_setting(k, int(v))
                    changed[k] = int(v)
            log("settings", json.dumps(changed, ensure_ascii=False))
            return self._json({"ok": True, "changed": changed})
        if route == "admin/prizes":
            items = payload.get("prizes") or []
            with tx() as c:
                for i, p in enumerate(items):
                    c.execute("UPDATE prizes SET name=?,stock_total=?,per_kind_limit=?,enabled=?,sort_no=? WHERE id=?",
                              (str(p.get("name") or "奖品"), int(p.get("stock_total") or 0),
                               int(p.get("per_kind_limit") or 0), 1 if p.get("enabled", True) else 0,
                               i, int(p.get("id") or 0)))
            log("prizes", json.dumps(items, ensure_ascii=False))
            return self._json({"ok": True})
        if route == "admin/questions":
            items = payload.get("questions") or []
            with tx() as c:
                c.execute("DELETE FROM quiz_questions WHERE round_id=0")
                for i, q in enumerate(items, 1):
                    ans = q.get("answer") or ""
                    if isinstance(ans, list):
                        ans = "|".join(str(x) for x in ans)
                    c.execute("INSERT INTO quiz_questions(round_id,order_no,prompt,qtype,options,answer) "
                              "VALUES(0,?,?,?,?,?)",
                              (i, str(q.get("prompt") or ""), str(q.get("qtype") or "单选"),
                               json.dumps(q.get("options") or [], ensure_ascii=False), str(ans)))
            log("questions", "%d 题" % len(items))
            return self._json({"ok": True, "count": len(items)})
        if route == "admin/claim":
            rid = int(payload.get("round_id") or 0)
            pid = str(payload.get("player_id") or "")
            what = str(payload.get("kind") or "card")
            col = "claimed_at" if what == "card" else "gift_claimed_at"
            with tx() as c:
                c.execute("UPDATE rewards SET %s=? WHERE round_id=? AND player_id=?" % col,
                          (time.time(), rid, pid))
                row = c.execute("SELECT card_no FROM rewards WHERE round_id=? AND player_id=?",
                                (rid, pid)).fetchone()
                if row and row["card_no"] and what == "card":
                    c.execute("UPDATE cards SET claimed_at=? WHERE no=?", (time.time(), row["card_no"]))
            log("claim", json.dumps({"round": rid, "player": pid, "kind": what}, ensure_ascii=False))
            return self._json({"ok": True})
        if route == "admin/draw/number":
            cards = {r["no"]: r["owner_id"] for r in fetch("SELECT no,owner_id FROM cards")}
            used = {r["card_no"] for r in fetch("SELECT card_no FROM draws")}
            for _ in range(60):
                h = random.choice([0, 1])
                t = random.randint(0, 9)
                o = random.randint(0, 9)
                no = "%d%d%d" % (h, t, o)
                if cards.get(no) and no not in used:
                    owner = cards[no]
                    p = fetch("SELECT name FROM players WHERE id=?", (owner,), one=True)
                    with tx() as c:
                        c.execute("INSERT INTO draws(card_no,player_id,balls,drawn_at,note) VALUES(?,?,?,?,?)",
                                  (no, owner, json.dumps({"百位": h, "十位": t, "个位": o}),
                                   time.time(), "抽号"))
                    log("draw_number", json.dumps({"card_no": no, "player": owner}, ensure_ascii=False))
                    return self._json({"card_no": no, "player": p["name"] if p else "未知",
                                       "balls": {"百位": h, "十位": t, "个位": o}})
            return self._api_error("连续 60 次未抽到有效编号，请检查刮刮乐发放情况", 409)
        if route == "admin/draw/spin":
            no = str(payload.get("card_no") or "")
            d = fetch("SELECT * FROM draws WHERE card_no=? AND prize_id IS NULL ORDER BY id DESC LIMIT 1",
                      (no,), one=True)
            if not d:
                return self._api_error("该编号尚未抽中或已开奖", 409)
            eligible = []
            for p in fetch("SELECT * FROM prizes WHERE enabled=1 ORDER BY sort_no"):
                used = fetch("SELECT COUNT(*) n FROM draws WHERE prize_id=?", (p["id"],), one=True)["n"]
                if used < int(p["stock_total"]) and used < int(p["per_kind_limit"]):
                    eligible.append(p)
            if not eligible:
                return self._api_error("奖品已抽完", 409)
            prize = random.choice(eligible)
            with tx() as c:
                c.execute("UPDATE draws SET prize_id=?,drawn_at=?,note=? WHERE id=?",
                          (prize["id"], time.time(), "开奖", d["id"]))
            p = fetch("SELECT name FROM players WHERE id=?", (d["player_id"],), one=True)
            log("draw_spin", json.dumps({"card_no": no, "prize": prize["name"]}, ensure_ascii=False))
            return self._json({"card_no": no, "player": p["name"] if p else "未知",
                               "prize": prize["name"], "prize_id": prize["id"]})
        if route == "admin/draw/reset":
            with tx() as c:
                c.execute("DELETE FROM draws")
            log("draw_reset", "")
            return self._json({"ok": True})
        return self._api_error("not found", 404)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/api/" in msg or not msg.startswith('"GET '):
            super().log_message(fmt, *args)


def lan_addresses():
    found = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            found.add(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM):
            found.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in found if not a.startswith("127."))


def main():
    ap = argparse.ArgumentParser(description="21届凝聚力晚会互动系统服务端")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8001)
    args = ap.parse_args()
    pwd = init_db()
    handler = functools.partial(Handler, directory=ROOT)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print("=" * 70)
    print("  21届凝聚力晚会 · 互动系统  |  ① 摇一摇 ② 答题竞速 ③ 幸运大抽奖")
    print("  数据库:", DB_PATH)
    print("  路径前缀:", BASE_PATH or "无（直连模式）")
    if pwd:
        print("  管理口令:", pwd)
    print("  玩家页: http://127.0.0.1:%d/   答题页: /quiz.html" % args.port)
    print("  大屏页: /board.html          控制台: /admin.html")
    for ip in lan_addresses():
        print("  局域网: http://%s:%d/" % (ip, args.port))
    print("=" * 70)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
