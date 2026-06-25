# -*- coding: utf-8 -*-
"""章节音频预生成：提前把某书某章逐句合成并缓存到本地，听书时直接秒播。
缓存键： data/pregen/{bid}/{chapter}/{voice}__{speed}/  下 0.wav,1.wav...  + meta.json
"""
import json
import os
import threading
import time

from . import tts, books

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREGEN_DIR = os.path.join(ROOT, "data", "pregen")

_jobs = {}  # key -> {status, done, total, error}


def _key(bid, chapter, voice, speed):
    return f"{bid}/{chapter}/{voice}__{speed}"


def cache_dir(bid, chapter, voice, speed):
    return os.path.join(PREGEN_DIR, bid, str(chapter), f"{voice}__{speed}")


def status_of(bid, chapter, voice, speed):
    """返回该章预生成状态：none / partial / ready / running。"""
    key = _key(bid, chapter, voice, speed)
    if key in _jobs and _jobs[key]["status"] == "running":
        return {"state": "running", **_jobs[key]}
    d = cache_dir(bid, chapter, voice, speed)
    meta_p = os.path.join(d, "meta.json")
    if os.path.exists(meta_p):
        meta = json.load(open(meta_p, encoding="utf-8"))
        have = len([f for f in os.listdir(d) if f.endswith(".wav")])
        if have >= meta["total"]:
            return {"state": "ready", "done": have, "total": meta["total"]}
        return {"state": "partial", "done": have, "total": meta["total"]}
    return {"state": "none"}


def get_audio_path(bid, chapter, voice, speed, idx):
    p = os.path.join(cache_dir(bid, chapter, voice, speed), f"{idx}.wav")
    return p if os.path.exists(p) else None


def start(bid, chapter, voice, speed):
    key = _key(bid, chapter, voice, speed)
    if key in _jobs and _jobs[key]["status"] == "running":
        return {"ok": True, "msg": "已在生成中", "key": key}

    path = books.find_path(bid)
    if not path:
        return {"ok": False, "error": "书不存在"}
    data = books.parse_book(path)
    if chapter < 0 or chapter >= len(data["chapters"]):
        return {"ok": False, "error": "章节越界"}
    sentences = data["chapters"][chapter]["sentences"]
    d = cache_dir(bid, chapter, voice, speed)
    os.makedirs(d, exist_ok=True)
    # 写入书名与章节名，便于导出后在别的机器上按书名自动识别归位
    book_title = os.path.splitext(os.path.basename(path))[0]
    ch_title = data["chapters"][chapter].get("title") or f"第{chapter + 1}节"
    json.dump({"total": len(sentences), "voice": voice, "speed": speed,
               "book_title": book_title, "chapter_title": ch_title},
              open(os.path.join(d, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False)

    # 已存在的 wav 视为已完成（断点续传：从上次中断处继续）
    have0 = len([f for f in os.listdir(d) if f.endswith(".wav")])
    _jobs[key] = {"status": "running", "done": have0, "total": len(sentences),
                  "error": None, "skipped": []}

    def worker():
        for i, s in enumerate(sentences):
            if _jobs[key].get("cancel"):
                _jobs[key]["status"] = "stopped"
                return
            out = os.path.join(d, f"{i}.wav")
            if os.path.exists(out):
                _jobs[key]["done"] = max(_jobs[key]["done"], i + 1)
                continue
            try:
                wav = tts.synth_sentence(s, voice, float(speed))
            except Exception as e:
                # 单句失败（如引擎对该句报错）：写静音占位保持索引对齐，继续后续句子
                wav = tts._silence_wav()
                _jobs[key]["skipped"].append({"idx": i, "error": str(e)})
            with open(out, "wb") as f:
                f.write(wav)
            _jobs[key]["done"] = i + 1
        _jobs[key]["status"] = "done"

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "key": key, "total": len(sentences)}


def cancel(bid, chapter, voice, speed):
    """停止某章正在进行的预生成（已生成的句子保留，可后续断点续传）。"""
    key = _key(bid, chapter, voice, speed)
    job = _jobs.get(key)
    if job and job.get("status") == "running":
        job["cancel"] = True
        return {"ok": True, "done": job.get("done", 0)}
    return {"ok": False, "error": "该章当前没有正在进行的预生成"}


def running_bids():
    """返回当前正在预生成的书 id 集合（key 形如 bid/chapter/voice__speed）。"""
    return {k.split("/")[0] for k, v in _jobs.items() if v.get("status") == "running"}


def delete_book(bid):
    """删除某本书的全部预生成音频。"""
    import shutil
    d = os.path.join(PREGEN_DIR, bid)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


def delete(bid, chapter, voice, speed):
    import shutil
    d = cache_dir(bid, chapter, voice, speed)
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)
        return {"ok": True}
    return {"ok": False, "error": "缓存不存在"}


def export_zip():
    """把整个预生成音频库打包成 zip，返回文件路径。"""
    import zipfile
    os.makedirs(PREGEN_DIR, exist_ok=True)
    out = os.path.join(ROOT, "data", "pregen_export.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(PREGEN_DIR):
            for f in files:
                fp = os.path.join(root, f)
                z.write(fp, os.path.relpath(fp, PREGEN_DIR))
    return out


def export_mobile_pack(bid, chapter, voice, speed):
    """导出『手机听书包』：自带逐句文本 + 对应音频 + manifest.json，
    供手机 App 离线阅读+收听（手机端不含任何引擎，只读这个包）。
    返回 (zip路径, 文件名) 或 (None, None)。"""
    import zipfile
    d = cache_dir(bid, chapter, voice, speed)
    if not os.path.isdir(d):
        return None, None
    path = books.find_path(bid)
    if not path:
        return None, None
    data = books.parse_book(path)
    if chapter < 0 or chapter >= len(data["chapters"]):
        return None, None
    ch = data["chapters"][chapter]
    sentences = ch["sentences"]
    book_title = os.path.splitext(os.path.basename(path))[0]
    ch_title = ch.get("title") or f"第{chapter + 1}节"

    # 只收录已生成的句子音频，建立 句子下标 -> 包内音频路径
    audio = []
    for i in range(len(sentences)):
        wav = os.path.join(d, f"{i}.wav")
        audio.append(f"audio/{i}.wav" if os.path.exists(wav) else None)

    manifest = {
        "format": "cherry-tingshu-pack-v1",
        "book": book_title,
        "book_id": bid,                       # 电子书稳定标识（按文件名），用于手机端按书归类
        "source": os.path.basename(path),     # 电子书源文件名
        "chapter": ch_title,
        "chapter_index": chapter,             # 该章在书中的序号，用于排序
        "total_chapters": len(data["chapters"]),
        "voice": voice,
        "speed": speed,
        "sentences": sentences,               # 只含该章逐句文本
        "para_starts": data["chapters"][chapter].get("para_starts", []),  # 段落首句下标，用于排版分段
        "audio": audio,
    }
    # 封面（若有）
    cover = os.path.join(books.COVER_DIR, bid + ".png")
    manifest["has_cover"] = os.path.exists(cover)

    safe = f"{book_title}-{ch_title}-{voice}".replace("/", "_").replace("\\", "_")
    out = os.path.join(ROOT, "data", f"mobilepack_{bid}_{chapter}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        if manifest["has_cover"]:
            z.write(cover, "cover.png")
        for i, rel in enumerate(audio):
            if rel:
                z.write(os.path.join(d, f"{i}.wav"), rel)
    return out, safe + ".tsp.zip"


def export_chapter_zip(bid, chapter, voice, speed):
    """单独导出某一章某声线的预生成音频，返回 zip 路径；不存在返回 None。"""
    import zipfile
    d = cache_dir(bid, chapter, voice, speed)
    if not os.path.isdir(d):
        return None
    out = os.path.join(ROOT, "data", f"pregen_{bid}_{chapter}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        # 保留 bid/chapter/voice__speed/ 相对结构，导入后能并回库
        for f in os.listdir(d):
            fp = os.path.join(d, f)
            if os.path.isfile(fp):
                z.write(fp, os.path.relpath(fp, PREGEN_DIR))
    return out


def _local_title_to_bid():
    """本机 书名(文件名去扩展) -> bid 的映射，用于导入时按书名归位。"""
    m = {}
    try:
        for name in os.listdir(books.EBOOK_DIR):
            p = os.path.join(books.EBOOK_DIR, name)
            if os.path.isfile(p):
                m[os.path.splitext(name)[0]] = books.book_id(p)
    except Exception:
        pass
    return m


def import_zip(data):
    """从 zip 字节导入预生成音频库。会读取每个集合 meta.json 里的 book_title，
    自动匹配到本机同名书籍的 bid 并归位（实现“换机/换路径后按书名识别”）。"""
    import io
    import shutil
    import tempfile
    import zipfile
    os.makedirs(PREGEN_DIR, exist_ok=True)
    title2bid = _local_title_to_bid()
    remapped = matched = 0
    tmp = tempfile.mkdtemp(prefix="pregen_imp_")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            z.extractall(tmp)
    except zipfile.BadZipFile:
        shutil.rmtree(tmp, ignore_errors=True)
        return {"ok": False, "error": "不是有效的 zip 文件"}

    try:
        for bid in os.listdir(tmp):
            src_b = os.path.join(tmp, bid)
            if not os.path.isdir(src_b):
                continue
            for ch in os.listdir(src_b):
                src_c = os.path.join(src_b, ch)
                if not os.path.isdir(src_c):
                    continue
                for vk in os.listdir(src_c):
                    src = os.path.join(src_c, vk)
                    if not os.path.isdir(src):
                        continue
                    # 优先用 meta 里的书名匹配本机书籍，匹配到则用本机 bid
                    target_bid = bid
                    meta_p = os.path.join(src, "meta.json")
                    if os.path.exists(meta_p):
                        try:
                            bt = json.load(open(meta_p, encoding="utf-8")).get("book_title")
                            if bt and bt in title2bid:
                                target_bid = title2bid[bt]
                                if target_bid != bid:
                                    remapped += 1
                                matched += 1
                        except Exception:
                            pass
                    dst = os.path.join(PREGEN_DIR, target_bid, ch, vk)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    if os.path.exists(dst):
                        shutil.rmtree(dst, ignore_errors=True)
                    shutil.move(src, dst)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {"ok": True, "count": len(list_all()), "matched": matched, "remapped": remapped}


def _book_info(bid, cache):
    """返回 (书名, {章节序号: 章节名})，按 bid 缓存避免重复解析。"""
    if bid in cache:
        return cache[bid]
    title, chapters = bid, {}
    try:
        path = books.find_path(bid)
        if path:
            title = os.path.splitext(os.path.basename(path))[0] or bid
            data = books.parse_book(path)
            chapters = {i: (c.get("title") or f"第{i + 1}节")
                        for i, c in enumerate(data.get("chapters", []))}
    except Exception:
        pass
    cache[bid] = (title, chapters)
    return cache[bid]


def list_all():
    """列出所有已预生成的章节，用于设置页管理（带书名与真实章节名）。"""
    out = []
    if not os.path.isdir(PREGEN_DIR):
        return out
    book_cache = {}
    for bid in os.listdir(PREGEN_DIR):
        bpath = os.path.join(PREGEN_DIR, bid)
        if not os.path.isdir(bpath):
            continue
        for ch in os.listdir(bpath):
            cpath = os.path.join(bpath, ch)
            if not (os.path.isdir(cpath) and ch.isdigit()):
                continue
            for vk in os.listdir(cpath):
                d = os.path.join(cpath, vk)
                meta_p = os.path.join(d, "meta.json")
                if not os.path.exists(meta_p):
                    continue
                have = len([f for f in os.listdir(d) if f.endswith(".wav")])
                if have == 0:
                    continue  # 跳过中断后无任何音频的空残留，避免章节数虚高
                meta = json.load(open(meta_p, encoding="utf-8"))
                book_title, ch_titles = _book_info(bid, book_cache)
                cidx = int(ch)
                # 本机找不到书(book_title==bid)时，回退用 meta 里存的书名/章节名
                if book_title == bid and meta.get("book_title"):
                    book_title = meta["book_title"]
                ch_title = ch_titles.get(cidx) or meta.get("chapter_title") or f"第{cidx + 1}节"
                out.append({"bid": bid, "chapter": cidx,
                            "book_title": book_title,
                            "chapter_title": ch_title,
                            "voice": meta.get("voice"),
                            "speed": meta.get("speed"), "done": have, "total": meta["total"]})
    # 按书名、再按章节序号排序，便于前端按书分组
    out.sort(key=lambda x: (x["book_title"], x["chapter"]))
    return out
