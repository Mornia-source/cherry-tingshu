# -*- coding: utf-8 -*-
"""
本地听书工具
两种声音引擎：
  edge       —— 微软在线女声，免费、快、不吃显卡（默认，无需启动任何服务）
  gptsovits  —— 本地角色声线（女开拓者等），需先双击 start_api.bat 启动语音接口

用法：
    python listen.py 书.txt                                 # edge 引擎朗读
    python listen.py ebook/堂吉诃德节选.txt --engine gptsovits   # 用开拓者声线
    python listen.py 书.epub --voice 晓晓                     # edge 换声线
    python listen.py 书.txt --engine gptsovits --voice 开拓者   # 指定角色（见 config.json）
    python listen.py --voices                                # 列出 edge 声线
    python listen.py 书.txt --no-play                         # 只生成不播放

生成的音频保存在 output/，按章节切分，已生成的会跳过（断点续传）。
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import edge_tts

ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(ROOT, "output")

# ---- edge-tts 自带中文声线 ----
EDGE_VOICES = {
    "晓晓": "zh-CN-XiaoxiaoNeural",
    "晓伊": "zh-CN-XiaoyiNeural",
    "晓辰": "zh-CN-XiaochenNeural",
    "云希": "zh-CN-YunxiNeural",
    "辽宁小北": "zh-CN-liaoning-XiaobeiNeural",
}


# ========== 读取电子书 ==========
def read_txt(path):
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    raise RuntimeError("无法识别文本编码")


def read_epub(path):
    from ebooklib import epub, ITEM_DOCUMENT
    from bs4 import BeautifulSoup
    book = epub.read_epub(path)
    parts = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        t = soup.get_text("\n")
        if t.strip():
            parts.append(t)
    return "\n".join(parts)


def load_book(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".txt":
        return read_txt(path)
    if ext == ".epub":
        return read_epub(path)
    raise RuntimeError(f"暂不支持的格式：{ext}")


def split_chapters(text):
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    pat = re.compile(r"(第\s*[0-9一二三四五六七八九十百千]+\s*[章节回卷集][^\n]*)")
    ms = list(pat.finditer(text))
    if not ms:
        return [("全文", text)]
    out = []
    for i, m in enumerate(ms):
        start = m.start()
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        out.append((m.group(1).strip(), text[start:end].strip()))
    return out


def safe_name(name, idx, ext):
    name = re.sub(r'[\\/:*?"<>|]', "_", name)[:40]
    return f"{idx:03d}_{name}.{ext}"


# ========== 引擎：edge-tts ==========
async def edge_synth(text, voice, out_path, rate, volume):
    c = edge_tts.Communicate(text, voice, rate=rate, volume=volume)
    await c.save(out_path)


# ========== 引擎：GPT-SoVITS 本地 API ==========
def load_config():
    with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def abspath(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def gptsovits_setup(cfg, voice_name):
    """检查接口存活并加载角色权重。返回该角色配置。"""
    api = cfg["api"]
    if voice_name not in cfg["voices"]:
        raise RuntimeError(f"config.json 里没有声线 '{voice_name}'，可选：{list(cfg['voices'])}")
    v = cfg["voices"][voice_name]

    # 等待接口就绪（返回 HTTP 状态码即说明服务在线，哪怕是 404/400）
    print(f"连接语音接口 {api} ...")
    for _ in range(60):
        try:
            urllib.request.urlopen(api + "/", timeout=2)
            break
        except urllib.error.HTTPError:
            break  # 有响应=服务在线
        except Exception:
            time.sleep(2)
    else:
        raise RuntimeError("连不上语音接口。请先双击 start_api.bat，看到 'startup complete' 再运行本程序。")

    # 加载角色的两个权重
    for ep, key in (("/set_gpt_weights", "gpt"), ("/set_sovits_weights", "sovits")):
        url = api + ep + "?" + urllib.parse.urlencode({"weights_path": abspath(v[key])})
        with urllib.request.urlopen(url, timeout=120) as r:
            if r.status != 200:
                raise RuntimeError(f"加载权重失败：{v[key]}")
    print(f"已加载角色声线：{voice_name}")
    return v


def gptsovits_synth(cfg, v, text, out_path, speed):
    payload = {
        "text": text,
        "text_lang": "zh",
        "ref_audio_path": abspath(v["ref_audio"]),
        "prompt_text": v["prompt_text"],
        "prompt_lang": v.get("prompt_lang", "zh"),
        "text_split_method": "cut5",
        "speed_factor": speed,
        "batch_size": 4,
        "media_type": "wav",
        "streaming_mode": False,
    }
    req = urllib.request.Request(
        cfg["api"] + "/tts",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        if r.status != 200:
            raise RuntimeError(f"合成失败：{r.read()[:200]}")
        data = r.read()
    with open(out_path, "wb") as f:
        f.write(data)


# ========== 播放 ==========
def play(path):
    import subprocess
    ps = (
        "Add-Type -AssemblyName presentationCore;"
        "$p=New-Object System.Windows.Media.MediaPlayer;"
        f"$p.Open([uri]'{path}');"
        "Start-Sleep -Milliseconds 400;$p.Play();"
        "while($p.NaturalDuration.HasTimeSpan -eq $false){Start-Sleep -Milliseconds 200};"
        "$d=$p.NaturalDuration.TimeSpan.TotalSeconds;"
        "Start-Sleep -Seconds ([math]::Ceiling($d));$p.Close()"
    )
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps])


def list_voices():
    print("edge 引擎中文声线：")
    for cn, en in EDGE_VOICES.items():
        print(f"  {cn:6}  {en}")
    print("\ngptsovits 引擎角色声线（见 config.json）：")
    try:
        for name in load_config()["voices"]:
            print(f"  {name}")
    except Exception:
        pass


async def main():
    ap = argparse.ArgumentParser(description="本地听书工具")
    ap.add_argument("book", nargs="?", help="电子书路径 (.txt/.epub)")
    ap.add_argument("--engine", choices=["edge", "gptsovits"], default="edge")
    ap.add_argument("--voice", default=None, help="声线；edge默认晓伊，gptsovits默认开拓者")
    ap.add_argument("--rate", default="+0%", help="edge 语速，如 +20%")
    ap.add_argument("--volume", default="+0%", help="edge 音量")
    ap.add_argument("--speed", type=float, default=1.0, help="gptsovits 语速倍率")
    ap.add_argument("--no-play", action="store_true")
    ap.add_argument("--voices", action="store_true")
    args = ap.parse_args()

    if args.voices or not args.book:
        list_voices()
        return

    text = load_book(args.book)
    chapters = split_chapters(text)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print(f"共 {len(chapters)} 章，引擎：{args.engine}")

    # 引擎准备
    if args.engine == "gptsovits":
        cfg = load_config()
        voice_name = args.voice or next(iter(cfg["voices"]))
        v = gptsovits_setup(cfg, voice_name)
        ext = "wav"
    else:
        voice = EDGE_VOICES.get(args.voice or "晓伊", args.voice or "zh-CN-XiaoyiNeural")
        ext = "mp3"

    for idx, (title, body) in enumerate(chapters, 1):
        out_path = os.path.join(OUTPUT_DIR, safe_name(title, idx, ext))
        if os.path.exists(out_path):
            print(f"[{idx}/{len(chapters)}] 已存在，跳过：{title}")
        else:
            print(f"[{idx}/{len(chapters)}] 合成中：{title}")
            try:
                if args.engine == "gptsovits":
                    gptsovits_synth(cfg, v, body, out_path, args.speed)
                else:
                    await edge_synth(body, voice, out_path, args.rate, args.volume)
            except Exception as e:
                print(f"    失败：{e}")
                continue
        if not args.no_play:
            print("    ▶ 朗读中（Ctrl+C 停止整本）")
            play(out_path)

    print(f"完成。音频在：{OUTPUT_DIR}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已停止。")
