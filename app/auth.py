# -*- coding: utf-8 -*-
"""账号系统：注册/登录，本地 SQLite 存储，PBKDF2 加盐口令，token 会话。
以后迁云只需把 DB 换成云数据库即可。"""
import hashlib
import os
import secrets
import sqlite3
import time

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")


def _conn():
    os.makedirs(DATA_DIR, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


ADMIN_USER = "Mornia"
ADMIN_PWD = "mornia"


def init_db():
    with _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            pwd_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            created REAL NOT NULL)""")
        # 旧库迁移：补 is_admin 列
        cols = [r[1] for r in c.execute("PRAGMA table_info(users)").fetchall()]
        if "is_admin" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
        if "last_seen" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN last_seen REAL DEFAULT 0")
        c.execute("""CREATE TABLE IF NOT EXISTS sessions(
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created REAL NOT NULL)""")
        # 每个用户的阅读进度
        c.execute("""CREATE TABLE IF NOT EXISTS progress(
            user_id INTEGER NOT NULL,
            book_id TEXT NOT NULL,
            sentence_index INTEGER DEFAULT 0,
            updated REAL,
            PRIMARY KEY(user_id, book_id))""")
        # 旧库迁移：进度补 chapter_index 列
        pcols = [r[1] for r in c.execute("PRAGMA table_info(progress)").fetchall()]
        if "chapter_index" not in pcols:
            c.execute("ALTER TABLE progress ADD COLUMN chapter_index INTEGER DEFAULT 0")
        # 内置唯一管理员账户
        a = c.execute("SELECT id FROM users WHERE username=?", (ADMIN_USER,)).fetchone()
        if not a:
            salt = secrets.token_hex(16)
            c.execute("INSERT INTO users(username,pwd_hash,salt,is_admin,created) VALUES(?,?,?,1,?)",
                      (ADMIN_USER, _hash(ADMIN_PWD, salt), salt, time.time()))
        else:
            c.execute("UPDATE users SET is_admin=1 WHERE username=?", (ADMIN_USER,))


def _hash(pwd, salt):
    return hashlib.pbkdf2_hmac("sha256", pwd.encode(), salt.encode(), 100000).hex()


def register(username, password):
    username = (username or "").strip()
    if not username or not password:
        raise ValueError("用户名和密码不能为空")
    if username.lower() == ADMIN_USER.lower():
        raise ValueError("该用户名为系统保留")
    salt = secrets.token_hex(16)
    try:
        with _conn() as c:
            c.execute("INSERT INTO users(username,pwd_hash,salt,created) VALUES(?,?,?,?)",
                      (username, _hash(password, salt), salt, time.time()))
    except sqlite3.IntegrityError:
        raise ValueError("用户名已存在")
    return login(username, password)


def login(username, password):
    with _conn() as c:
        u = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if not u or _hash(password, u["salt"]) != u["pwd_hash"]:
            raise ValueError("用户名或密码错误")
        token = secrets.token_hex(24)
        c.execute("INSERT INTO sessions(token,user_id,created) VALUES(?,?,?)",
                  (token, u["id"], time.time()))
        return {"token": token, "username": u["username"]}


def user_from_token(token):
    if not token:
        return None
    with _conn() as c:
        r = c.execute("""SELECT u.id,u.username,u.is_admin FROM sessions s
                         JOIN users u ON u.id=s.user_id WHERE s.token=?""", (token,)).fetchone()
        if not r:
            return None
        c.execute("UPDATE users SET last_seen=? WHERE id=?", (time.time(), r["id"]))  # 刷新在线时间
        return dict(r)


def uid_of(uid):
    return "U%06d" % uid


def _parse_uid(q):
    s = (q or "").strip().lstrip("Uu")
    try:
        return int(s)
    except ValueError:
        return -1


def list_users(page=1, page_size=10, q=""):
    page = max(1, int(page)); off = (page - 1) * page_size
    where, params = "", []
    if q:
        where = "WHERE u.username LIKE ? OR u.id=?"
        params = ["%" + q + "%", _parse_uid(q)]
    with _conn() as c:
        total = c.execute(f"SELECT COUNT(*) n FROM users u {where}", params).fetchone()["n"]
        rows = c.execute(f"""SELECT u.id,u.username,u.is_admin,u.created,u.last_seen,
            (SELECT COUNT(*) FROM progress p WHERE p.user_id=u.id) AS books,
            (SELECT book_id FROM progress p WHERE p.user_id=u.id ORDER BY updated DESC LIMIT 1) AS last_book,
            (SELECT sentence_index FROM progress p WHERE p.user_id=u.id ORDER BY updated DESC LIMIT 1) AS last_idx,
            (SELECT updated FROM progress p WHERE p.user_id=u.id ORDER BY updated DESC LIMIT 1) AS last_at
            FROM users u {where} ORDER BY u.id LIMIT ? OFFSET ?""",
            params + [page_size, off]).fetchall()
        users = [dict(r) for r in rows]
        for u in users:
            u["uid"] = uid_of(u["id"])
        pages = max(1, (total + page_size - 1) // page_size)
        return {"users": users, "total": total, "page": page, "pages": pages, "page_size": page_size}


def delete_user(uid):
    with _conn() as c:
        u = c.execute("SELECT username,is_admin FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            raise ValueError("用户不存在")
        if u["is_admin"]:
            raise ValueError("不能删除管理员账户")
        c.execute("DELETE FROM users WHERE id=?", (uid,))
        c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        c.execute("DELETE FROM progress WHERE user_id=?", (uid,))


def reset_password(uid, new_pwd):
    salt = secrets.token_hex(16)
    with _conn() as c:
        c.execute("UPDATE users SET pwd_hash=?,salt=? WHERE id=?", (_hash(new_pwd, salt), salt, uid))


def logout(token):
    with _conn() as c:
        c.execute("DELETE FROM sessions WHERE token=?", (token,))


def get_progress(user_id, book_id):
    with _conn() as c:
        r = c.execute("SELECT chapter_index,sentence_index FROM progress WHERE user_id=? AND book_id=?",
                      (user_id, book_id)).fetchone()
        if not r:
            return {"chapter": 0, "sentence": 0}
        return {"chapter": r["chapter_index"] or 0, "sentence": r["sentence_index"] or 0}


def set_progress(user_id, book_id, chapter, idx):
    with _conn() as c:
        c.execute("""INSERT INTO progress(user_id,book_id,chapter_index,sentence_index,updated)
                     VALUES(?,?,?,?,?) ON CONFLICT(user_id,book_id)
                     DO UPDATE SET chapter_index=excluded.chapter_index,
                       sentence_index=excluded.sentence_index,updated=excluded.updated""",
                  (user_id, book_id, chapter, idx, time.time()))
