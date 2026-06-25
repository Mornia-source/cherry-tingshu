# -*- coding: utf-8 -*-
"""听书 Web App 后端主入口（FastAPI）。
启动：python -m uvicorn app.server:app --host 127.0.0.1 --port 8000
"""
import io
import os

from fastapi import FastAPI, Form, Header, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import auth, books, tts, admin, pregen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "web")

app = FastAPI(title="本地听书")
auth.init_db()


def _migrate_legacy_bids():
    """book_id 从“完整路径哈希”改为“文件名哈希”后的一次性迁移：
    把旧 bid 命名的预生成目录、封面、阅读进度改成新 bid。可重复安全执行。"""
    import shutil
    import sqlite3
    try:
        files = [f for f in os.listdir(books.EBOOK_DIR)
                 if os.path.isfile(os.path.join(books.EBOOK_DIR, f))]
    except Exception:
        return
    # 旧版可能用过的完整路径前缀（搬家前的位置等）
    old_roots = [books.EBOOK_DIR, r"D:\eBookSVC\ebook"]
    moved = 0
    for name in files:
        new_bid = books.book_id(os.path.join(books.EBOOK_DIR, name))
        legacy_bids = {books._legacy_book_id_fullpath(os.path.join(r, name)) for r in old_roots}
        legacy_bids.discard(new_bid)
        for old_bid in legacy_bids:
            # 预生成目录
            src = os.path.join(pregen.PREGEN_DIR, old_bid)
            dst = os.path.join(pregen.PREGEN_DIR, new_bid)
            if os.path.isdir(src):
                if not os.path.isdir(dst):
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.move(src, dst); moved += 1
                else:
                    for sub in os.listdir(src):
                        s2, d2 = os.path.join(src, sub), os.path.join(dst, sub)
                        if not os.path.exists(d2):
                            shutil.move(s2, d2)
                    shutil.rmtree(src, ignore_errors=True); moved += 1
            # 封面
            oc = os.path.join(books.COVER_DIR, old_bid + ".png")
            nc = os.path.join(books.COVER_DIR, new_bid + ".png")
            if os.path.exists(oc) and not os.path.exists(nc):
                try:
                    shutil.move(oc, nc)
                except Exception:
                    pass
            # 阅读进度
            try:
                c = sqlite3.connect(auth.DB_PATH)
                c.execute("UPDATE OR IGNORE progress SET book_id=? WHERE book_id=?", (new_bid, old_bid))
                c.commit(); c.close()
            except Exception:
                pass
    if moved:
        print(f"[迁移] 已将 {moved} 个预生成目录归位到按书名的新 bid")


_migrate_legacy_bids()

# 简单的解析结果缓存，避免每次翻页重解析
_book_cache = {}


def require_user(token):
    u = auth.user_from_token(token)
    if not u:
        raise HTTPException(401, "未登录")
    return u


def require_admin(token):
    u = require_user(token)
    if not u.get("is_admin"):
        raise HTTPException(403, "需要管理员权限")
    return u


# ---------------- 账号 ----------------
@app.post("/api/register")
def api_register(username: str = Form(...), password: str = Form(...)):
    try:
        return auth.register(username, password)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/login")
def api_login(username: str = Form(...), password: str = Form(...)):
    try:
        return auth.login(username, password)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/logout")
def api_logout(authorization: str = Header(None)):
    auth.logout(authorization)
    return {"ok": True}


AVATAR_DIR = os.path.join(ROOT, "data", "avatars")


def _avatar_url(uid):
    return f"/api/avatar/{uid}" if os.path.exists(os.path.join(AVATAR_DIR, f"{uid}.png")) else None


@app.get("/api/me")
def api_me(authorization: str = Header(None)):
    u = require_user(authorization)
    u["uid"] = auth.uid_of(u["id"])
    u["avatar"] = _avatar_url(u["id"])
    return u


@app.post("/api/avatar")
async def api_avatar(authorization: str = Header(None), file: UploadFile = File(...)):
    u = require_user(authorization)
    os.makedirs(AVATAR_DIR, exist_ok=True)
    with open(os.path.join(AVATAR_DIR, f"{u['id']}.png"), "wb") as f:
        f.write(await file.read())
    return {"ok": True, "avatar": f"/api/avatar/{u['id']}"}


@app.get("/api/avatar/{uid}")
def api_get_avatar(uid: int):
    p = os.path.join(AVATAR_DIR, f"{uid}.png")
    if os.path.exists(p):
        return FileResponse(p)
    raise HTTPException(404, "无头像")


# ---------------- 书架 ----------------
@app.get("/api/books")
def api_books(authorization: str = Header(None)):
    require_user(authorization)
    return {"books": books.scan_books()}


@app.get("/api/cover/{bid}")
def api_cover(bid: str):
    p = os.path.join(books.COVER_DIR, bid + ".png")
    if os.path.exists(p):
        return FileResponse(p)
    raise HTTPException(404, "无封面")


@app.get("/api/books/status")
def api_books_status(authorization: str = Header(None)):
    """每本书的预生成（训练）状态：none/partial/done/running，用于书架角标。"""
    require_user(authorization)
    items = pregen.list_all()
    running = pregen.running_bids()
    by_bid = {}
    for it in items:
        by_bid.setdefault(it["bid"], []).append(it)
    out = {}
    for b in books.scan_books():
        bid = b["id"]
        its = by_bid.get(bid, [])
        # 按章取该章最大已生成句数（同章多声线/语速去重，避免计数虚高）
        best = {}
        for it in its:
            best[it["chapter"]] = max(best.get(it["chapter"], 0), min(it["done"], it["total"] or 0))
        try:
            path = books.find_path(bid)
            if bid not in _book_cache:
                _book_cache[bid] = books.parse_book(path)
            total_sent = _book_cache[bid]["total_sentences"] or 0
        except Exception:
            total_sent = 0
        generated = sum(best.values())
        percent = int(round(100 * generated / total_sent)) if total_sent else 0
        if bid in running:
            state = "running"
        elif generated <= 0:
            state = "none"
        elif total_sent and generated >= total_sent:
            state, percent = "done", 100
        else:
            state = "partial"
        out[bid] = {"state": state, "percent": percent}
    return out


@app.post("/api/books/delete")
def api_books_delete(bid: str = Form(...), authorization: str = Header(None)):
    require_user(authorization)
    path = books.find_path(bid)
    if not path:
        raise HTTPException(404, "书不存在")
    try:
        os.remove(path)
    except OSError as e:
        raise HTTPException(500, f"删除失败：{e}")
    # 连带清理封面、缓存、预生成音频
    cover = os.path.join(books.COVER_DIR, bid + ".png")
    if os.path.exists(cover):
        os.remove(cover)
    _book_cache.pop(bid, None)
    pregen.delete_book(bid)
    return {"ok": True}


@app.post("/api/upload")
async def api_upload(authorization: str = Header(None), file: UploadFile = File(...)):
    require_user(authorization)
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in books.SUPPORTED:
        raise HTTPException(400, "仅支持 txt/epub/pdf")
    os.makedirs(books.EBOOK_DIR, exist_ok=True)
    dest = os.path.join(books.EBOOK_DIR, file.filename)
    with open(dest, "wb") as f:
        f.write(await file.read())
    return {"ok": True, "filename": file.filename}


# ---------------- 阅读 ----------------
@app.get("/api/book/{bid}")
def api_book(bid: str, authorization: str = Header(None)):
    u = require_user(authorization)
    path = books.find_path(bid)
    if not path:
        raise HTTPException(404, "书不存在")
    if bid not in _book_cache:
        try:
            _book_cache[bid] = books.parse_book(path)
        except ValueError as e:
            raise HTTPException(422, str(e))
    data = _book_cache[bid]
    return {
        "id": bid,
        "title": os.path.splitext(os.path.basename(path))[0],
        "chapters": [{"title": c["title"], "count": len(c["sentences"])} for c in data["chapters"]],
        "total_sentences": data["total_sentences"],
        "progress": auth.get_progress(u["id"], bid),
    }


@app.get("/api/book/{bid}/chapter/{idx}")
def api_chapter(bid: str, idx: int, authorization: str = Header(None)):
    require_user(authorization)
    if bid not in _book_cache:
        path = books.find_path(bid)
        if not path:
            raise HTTPException(404, "书不存在")
        _book_cache[bid] = books.parse_book(path)
    chs = _book_cache[bid]["chapters"]
    if idx < 0 or idx >= len(chs):
        raise HTTPException(404, "章节越界")
    return {"title": chs[idx]["title"], "sentences": chs[idx]["sentences"],
            "para_starts": chs[idx].get("para_starts", [])}


@app.post("/api/progress/{bid}")
def api_progress(bid: str, sentence_index: int = Form(...), chapter_index: int = Form(0),
                 authorization: str = Header(None)):
    u = require_user(authorization)
    auth.set_progress(u["id"], bid, chapter_index, sentence_index)
    return {"ok": True}


# ---------------- 朗读 ----------------
@app.get("/api/voices")
def api_voices(authorization: str = Header(None)):
    require_user(authorization)
    return {"voices": tts.list_voices(), "current": tts.current_voice(),
            "api_alive": tts.api_alive(), "engines": _engines_with_starting()}


@app.post("/api/tts")
def api_tts(text: str = Form(...), voice: str = Form(...), speed: float = Form(1.0),
            authorization: str = Header(None)):
    require_user(authorization)
    try:
        wav = tts.synth_sentence(text, voice, speed)
    except Exception as e:
        raise HTTPException(500, f"合成失败：{e}")
    return Response(content=wav, media_type="audio/wav")


# ---------------- 后台管理 ----------------
@app.get("/api/admin/models")
def api_admin_models(authorization: str = Header(None)):
    require_user(authorization)
    return {"configured": tts.list_voices(), "discovered": tts.discover_models(),
            "api_alive": tts.api_alive(), "current": tts.current_voice(),
            "engines": tts.engines_status()}


def _engines_with_starting():
    """引擎状态附带“启动中”标记（后端记录，刷新不丢）。"""
    engines = tts.engines_status()
    for name, e in engines.items():
        e["starting"] = admin.is_starting(name, e.get("alive"))
    return engines


@app.get("/api/admin/engines")
def api_admin_engines(authorization: str = Header(None)):
    require_user(authorization)
    return {"engines": _engines_with_starting()}


@app.post("/api/admin/engine")
def api_admin_engine(engine: str = Form(...), api: str = Form(...),
                     root: str = Form(None), authorization: str = Header(None)):
    """图形界面：保存某引擎(gpt-sovits/indextts)的服务端点与根目录。"""
    require_admin(authorization)
    tts.set_engine_api(engine, api, root)
    return {"ok": True, "engines": tts.engines_status()}


@app.post("/api/admin/engine/start")
def api_admin_engine_start(engine: str = Form(...), authorization: str = Header(None)):
    require_admin(authorization)
    return admin.start_engine(engine)


@app.post("/api/admin/engine/stop")
def api_admin_engine_stop(engine: str = Form(...), authorization: str = Header(None)):
    require_admin(authorization)
    return admin.stop_engine(engine)


@app.post("/api/admin/add_voice")
def api_add_voice(name: str = Form(...), ref_audio: str = Form(...),
                  prompt_text: str = Form(...), engine: str = Form("gpt-sovits"),
                  gpt: str = Form(""), sovits: str = Form(""),
                  prompt_lang: str = Form("zh"), old_name: str = Form(""),
                  authorization: str = Header(None)):
    """新增或编辑一个角色模型（自适应：任意文件名、可选语言）。old_name 非空表示编辑。"""
    require_admin(authorization)
    name = name.strip()
    if not name:
        raise HTTPException(400, "请填写名称")
    cfg = tts.load_config()
    v = {"engine": engine, "ref_audio": ref_audio,
         "prompt_text": prompt_text, "prompt_lang": (prompt_lang or "zh")}
    if engine == "gpt-sovits":
        if not gpt or not sovits:
            raise HTTPException(400, "GPT-SoVITS 声线需要 .ckpt 与 .pth 权重文件")
        v["gpt"], v["sovits"] = gpt, sovits
    # 编辑时若改了名字，先删旧键并保持顺序
    if old_name and old_name != name and old_name in cfg["voices"]:
        cfg["voices"] = {(name if k == old_name else k): (v if k == old_name else val)
                         for k, val in cfg["voices"].items()}
    else:
        if old_name and old_name != name:
            cfg["voices"].pop(old_name, None)
        cfg["voices"][name] = v
    tts.save_config(cfg)
    return {"ok": True}


@app.post("/api/admin/delete_voice")
def api_delete_voice(name: str = Form(...), authorization: str = Header(None)):
    require_admin(authorization)
    tts.delete_voice(name)
    return {"ok": True}


@app.post("/api/admin/rename_voice")
def api_rename_voice(old: str = Form(...), new: str = Form(...),
                     authorization: str = Header(None)):
    require_admin(authorization)
    try:
        tts.rename_voice(old, new)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/admin/select")
def api_select(voice: str = Form(...), authorization: str = Header(None)):
    require_user(authorization)
    try:
        tts.load_voice(voice)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "current": voice}


@app.post("/api/admin/slice")
def api_slice(authorization: str = Header(None), input_dir: str = Form(...),
              output_dir: str = Form("output/sliced")):
    require_user(authorization)
    return admin.slice_audio(input_dir, output_dir)


@app.post("/api/admin/asr")
def api_asr(authorization: str = Header(None), input_dir: str = Form(...),
            output_dir: str = Form("output/asr")):
    require_user(authorization)
    return admin.run_asr(input_dir, output_dir)


@app.post("/api/admin/train_sovits")
def api_train_sovits(authorization: str = Header(None), exp_name: str = Form(...),
                     gpu: str = Form("0"), batch_size: int = Form(4), total_epoch: int = Form(8),
                     text_low_lr_rate: float = Form(0.4), save_every_epoch: int = Form(4),
                     if_save_latest: bool = Form(True), if_save_every_weights: bool = Form(True)):
    require_user(authorization)
    return admin.run_train_sovits(exp_name, dict(gpu=gpu, batch_size=batch_size, total_epoch=total_epoch,
                                  text_low_lr_rate=text_low_lr_rate, save_every_epoch=save_every_epoch,
                                  if_save_latest=if_save_latest, if_save_every_weights=if_save_every_weights))


@app.post("/api/admin/train_gpt")
def api_train_gpt(authorization: str = Header(None), exp_name: str = Form(...),
                  gpu: str = Form("0"), batch_size: int = Form(4), total_epoch: int = Form(15),
                  save_every_epoch: int = Form(5), if_dpo: bool = Form(False),
                  if_save_latest: bool = Form(True), if_save_every_weights: bool = Form(True)):
    require_user(authorization)
    return admin.run_train_gpt(exp_name, dict(gpu=gpu, batch_size=batch_size, total_epoch=total_epoch,
                               save_every_epoch=save_every_epoch, if_dpo=if_dpo,
                               if_save_latest=if_save_latest, if_save_every_weights=if_save_every_weights))


@app.post("/api/admin/format")
def api_format(authorization: str = Header(None), exp_name: str = Form(...),
               list_file: str = Form(...), wav_dir: str = Form(...),
               gpu: str = Form("0")):
    require_user(authorization)
    return admin.run_format(exp_name, list_file, wav_dir, gpu)


@app.get("/api/admin/tasks")
def api_tasks(authorization: str = Header(None)):
    require_user(authorization)
    return {"tasks": admin.task_status()}


@app.get("/api/admin/gpus")
def api_gpus(authorization: str = Header(None)):
    require_user(authorization)
    return {"gpus": admin.list_gpus()}


# ---------------- 管理员：用户数据库 ----------------
@app.get("/api/admin/users")
def api_users(authorization: str = Header(None), page: int = 1, q: str = ""):
    require_admin(authorization)
    import time as _t
    data = auth.list_users(page=page, q=q)
    now = _t.time()
    for u in data["users"]:
        u["avatar"] = _avatar_url(u["id"])
        u["online"] = bool(u.get("last_seen") and now - u["last_seen"] < 120)
        if u.get("last_book"):
            p = books.find_path(u["last_book"])
            u["reading"] = os.path.splitext(os.path.basename(p))[0] if p else u["last_book"]
        else:
            u["reading"] = None
        u["group"] = "管理员" if u["is_admin"] else "普通用户"
    return data


@app.post("/api/admin/users/delete")
def api_user_delete(uid: int = Form(...), authorization: str = Header(None)):
    require_admin(authorization)
    try:
        auth.delete_user(uid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/admin/users/reset")
def api_user_reset(uid: int = Form(...), password: str = Form(...), authorization: str = Header(None)):
    require_admin(authorization)
    auth.reset_password(uid, password)
    return {"ok": True}


# ---------------- 预生成 ----------------
@app.get("/api/pregen/status")
def api_pregen_status(bid: str, chapter: int, voice: str, speed: float,
                      authorization: str = Header(None)):
    require_user(authorization)
    return pregen.status_of(bid, chapter, voice, speed)


@app.post("/api/pregen/start")
def api_pregen_start(bid: str = Form(...), chapter: int = Form(...), voice: str = Form(...),
                     speed: float = Form(1.0), authorization: str = Header(None)):
    require_user(authorization)
    if not tts.voice_alive(voice):
        raise HTTPException(503, f"该声线对应的引擎未启动（{tts.voice_engine(voice)}）")
    return pregen.start(bid, chapter, voice, speed)


@app.post("/api/pregen/stop")
def api_pregen_stop(bid: str = Form(...), chapter: int = Form(...), voice: str = Form(...),
                    speed: float = Form(...), authorization: str = Header(None)):
    require_user(authorization)
    return pregen.cancel(bid, chapter, voice, speed)


@app.get("/api/pregen/audio/{bid}/{chapter}/{voice}/{speed}/{idx}")
def api_pregen_audio(bid: str, chapter: int, voice: str, speed: float, idx: int,
                     authorization: str = Header(None)):
    # 音频标签请求不便带 header，这里放宽鉴权（本机使用）
    p = pregen.get_audio_path(bid, chapter, voice, speed, idx)
    if not p:
        raise HTTPException(404, "未预生成")
    return FileResponse(p, media_type="audio/wav")


@app.get("/api/pregen/list")
def api_pregen_list(authorization: str = Header(None)):
    require_user(authorization)
    return {"items": pregen.list_all()}


@app.post("/api/pregen/delete")
def api_pregen_delete(bid: str = Form(...), chapter: int = Form(...), voice: str = Form(...),
                      speed: float = Form(...), authorization: str = Header(None)):
    require_admin(authorization)
    return pregen.delete(bid, chapter, voice, speed)


@app.get("/api/pregen/export")
def api_pregen_export(authorization: str = Header(None), tok: str = None):
    require_admin(authorization or tok)  # 支持 query 传 token，便于浏览器原生下载
    p = pregen.export_zip()
    return FileResponse(p, filename="樱桃听书-预生成音频库.zip", media_type="application/zip")


@app.get("/api/pregen/export_one")
def api_pregen_export_one(bid: str, chapter: int, voice: str, speed: float,
                          authorization: str = Header(None), tok: str = None):
    require_admin(authorization or tok)
    p = pregen.export_chapter_zip(bid, chapter, voice, speed)
    if not p:
        raise HTTPException(404, "该章缓存不存在")
    return FileResponse(p, filename=f"预生成-{bid}-第{chapter + 1}章.zip",
                        media_type="application/zip")


@app.get("/api/pregen/export_mobile")
def api_pregen_export_mobile(bid: str, chapter: int, voice: str, speed: float,
                             authorization: str = Header(None), tok: str = None):
    require_user(authorization or tok)
    p, fname = pregen.export_mobile_pack(bid, chapter, voice, speed)
    if not p:
        raise HTTPException(404, "该章缓存不存在或书已不在")
    return FileResponse(p, filename=fname, media_type="application/zip")


@app.post("/api/pregen/import")
async def api_pregen_import(authorization: str = Header(None), file: UploadFile = File(...)):
    require_admin(authorization)
    return pregen.import_zip(await file.read())


# ---------------- 前端静态资源 ----------------
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
