# -*- coding: utf-8 -*-
"""书籍解析：扫描书架、统一解析 txt/epub/pdf 为 章节->句子 结构、提取封面。
纯图片 PDF 会被检测并标记为不可转换。"""
import hashlib
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EBOOK_DIR = os.path.join(ROOT, "ebook")
COVER_DIR = os.path.join(ROOT, "data", "covers")
SUPPORTED = (".txt", ".epub", ".pdf")


def book_id(path):
    return hashlib.md5(path.encode("utf-8")).hexdigest()[:16]


# ---------------- 书架扫描 ----------------
def scan_books():
    os.makedirs(EBOOK_DIR, exist_ok=True)
    os.makedirs(COVER_DIR, exist_ok=True)
    books = []
    for name in sorted(os.listdir(EBOOK_DIR)):
        path = os.path.join(EBOOK_DIR, name)
        ext = os.path.splitext(name)[1].lower()
        if not os.path.isfile(path) or ext not in SUPPORTED:
            continue
        bid = book_id(path)
        cover = ensure_cover(path, ext, bid)
        books.append({
            "id": bid,
            "title": os.path.splitext(name)[0],
            "filename": name,
            "format": ext.lstrip("."),
            "size": os.path.getsize(path),
            "cover": f"/api/cover/{bid}" if cover else None,
        })
    return books


def find_path(bid):
    for name in os.listdir(EBOOK_DIR):
        p = os.path.join(EBOOK_DIR, name)
        if os.path.isfile(p) and book_id(p) == bid:
            return p
    return None


# ---------------- 封面提取 ----------------
def ensure_cover(path, ext, bid):
    out = os.path.join(COVER_DIR, bid + ".png")
    if os.path.exists(out):
        return out
    try:
        if ext == ".pdf":
            import fitz
            doc = fitz.open(path)
            if doc.page_count:
                pix = doc[0].get_pixmap(matrix=fitz.Matrix(1.2, 1.2))
                pix.save(out)
                doc.close()
                return out
            doc.close()
        elif ext == ".epub":
            from ebooklib import epub
            book = epub.read_epub(path)
            for item in book.get_items():
                if "cover" in (item.get_name() or "").lower() and item.get_type() == 1:
                    with open(out, "wb") as f:
                        f.write(item.get_content())
                    return out
            # 退而求其次：第一张图片
            from ebooklib import ITEM_IMAGE
            for item in book.get_items_of_type(ITEM_IMAGE):
                with open(out, "wb") as f:
                    f.write(item.get_content())
                return out
    except Exception:
        return None
    return None


# ---------------- 句子切分 ----------------
SENT_END = re.compile(r"(?<=[。！？!?\.\…])")


def split_sentences(text):
    return _split_with_paras(text)[0]


def _split_with_paras(text):
    """切句并记录段落起始：返回 (sentences, para_starts)。
    para_starts 是每个自然段第一句在 sentences 中的下标，用于阅读器分段缩进。"""
    text = re.sub(r"[ \t]+", " ", text)
    out, starts = [], []
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        first = True
        buf = ""
        def _emit(s):
            nonlocal first
            s = s.strip()
            if not s:
                return
            if first:
                starts.append(len(out))
                first = False
            out.append(s)
        for ch in para:
            buf += ch
            if ch in "。！？!?…":
                _emit(buf)
                buf = ""
        _emit(buf)
    return out, starts


CHAP_PAT = re.compile(r"^\s*(第\s*[0-9一二三四五六七八九十百千]+\s*[章节回卷集][^\n]*)\s*$", re.M)


def to_chapters(text):
    """返回 [{title, sentences:[...]}]"""
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    ms = list(CHAP_PAT.finditer(text))
    chapters = []

    def _mk(title, body):
        sents, starts = _split_with_paras(body)
        return {"title": title, "sentences": sents, "para_starts": starts}

    if not ms:
        chapters.append(_mk("全文", text))
    else:
        if ms[0].start() > 0:
            head = text[:ms[0].start()].strip()
            if head:
                chapters.append(_mk("前言", head))
        for i, m in enumerate(ms):
            start = m.start()
            end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
            title = m.group(1).strip()
            body = text[m.end():end].strip()
            chapters.append(_mk(title, body))
    return chapters


# ---------------- 各格式取文本 ----------------
def extract_txt(path):
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    raise RuntimeError("无法识别文本编码")


def extract_epub(path):
    from ebooklib import epub, ITEM_DOCUMENT
    from bs4 import BeautifulSoup
    book = epub.read_epub(path)
    parts = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        for br in soup.find_all(["p", "br", "div", "h1", "h2", "h3"]):
            br.append("\n")
        t = soup.get_text()
        if t.strip():
            parts.append(t)
    return "\n".join(parts)


def epub_chapters(path):
    """按 epub 文档项（spine）拆分章节，标题取文档内首个标题标签。
    返回 [{title, sentences}]；若结构太碎则返回 None 交由通用流程处理。"""
    from ebooklib import epub, ITEM_DOCUMENT
    from bs4 import BeautifulSoup
    book = epub.read_epub(path)
    chapters = []
    for n, item in enumerate(book.get_items_of_type(ITEM_DOCUMENT), 1):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        # 标题：优先 h1/h2/h3/title，否则按序号兜底
        title = None
        for tag in ("h1", "h2", "h3", "title"):
            el = soup.find(tag)
            if el and el.get_text().strip():
                title = el.get_text().strip()
                break
        for br in soup.find_all(["p", "br", "div", "h1", "h2", "h3", "li"]):
            br.append("\n")
        body = soup.get_text()
        sents, starts = _split_with_paras(body)
        if not sents:
            continue  # 跳过封面页/导航页等空文档
        chapters.append({"title": title or f"第 {len(chapters) + 1} 节",
                         "sentences": sents, "para_starts": starts})
    # 只解析出 1 章且很可能是“整本合一” → 退回通用文本流程做章节正则识别
    if len(chapters) <= 1:
        return None
    return chapters


def pdf_is_text(path, sample_pages=5):
    """检测 PDF 是否含可提取文字（纯图片扫描件返回 False）。"""
    import fitz
    doc = fitz.open(path)
    chars = 0
    for i in range(min(sample_pages, doc.page_count)):
        chars += len(doc[i].get_text().strip())
    doc.close()
    return chars > 20  # 抽样页几乎无文字 => 纯图片


def extract_pdf(path):
    import fitz
    doc = fitz.open(path)
    parts = []
    for page in doc:
        parts.append(page.get_text("text"))
    doc.close()
    return "\n".join(parts)


# ---------------- 统一入口 ----------------
def parse_book(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".epub":
        # 优先按 epub 自身文档结构分章
        chs = epub_chapters(path)
        if chs:
            total = sum(len(c["sentences"]) for c in chs)
            return {"chapters": chs, "total_sentences": total}
        text = extract_epub(path)
        chapters = to_chapters(text)
        total = sum(len(c["sentences"]) for c in chapters)
        return {"chapters": chapters, "total_sentences": total}
    if ext == ".txt":
        text = extract_txt(path)
    elif ext == ".pdf":
        if not pdf_is_text(path):
            raise ValueError("纯图片 PDF（扫描件）无法转换为电子书：未检测到可提取文字。")
        text = extract_pdf(path)
    else:
        raise ValueError(f"不支持的格式：{ext}")
    chapters = to_chapters(text)
    total = sum(len(c["sentences"]) for c in chapters)
    return {"chapters": chapters, "total_sentences": total}
