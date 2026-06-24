# -*- coding: utf-8 -*-
"""TTS 代理：把句子转给本地 GPT-SoVITS(9880) 合成，并管理可用角色模型。
模型清单来自 config.json 的 voices；也支持扫描 model/ 目录自动发现。"""
import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

_synth_lock = threading.Lock()  # 串行化合成，避免并发请求压垮 GPT-SoVITS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
MODEL_DIR = os.path.join(ROOT, "model")

_state = {"loaded_voice": None}

# 至少含一个可朗读字符（中文/日文假名/字母/数字）才送去合成，
# 否则纯标点/符号/空白会让 GPT-SoVITS 返回 400。
_SPEAKABLE = re.compile(r"[一-鿿぀-ヿ0-9A-Za-z]")


def _is_speakable(text):
    return bool(text and _SPEAKABLE.search(text))


def _silence_wav(ms=200):
    """生成一段静音 wav 字节，用于占位不可朗读的句子，保持索引对齐。"""
    import struct
    sr = 32000
    n = int(sr * ms / 1000)
    data = b"\x00\x00" * n
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    hdr += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(data))
    return hdr + data


_DEFAULT_CONFIG = {
    "api": "http://127.0.0.1:9880",
    "voices": {},
    "engines": {
        "gpt-sovits": {"api": "http://127.0.0.1:9880", "root": ""},
        "indextts": {"api": "http://127.0.0.1:9881", "root": ""},
    },
}


def load_config():
    # 缺失时（如他人首次 clone 项目）自动从模板/默认创建，保证开箱即跑
    if not os.path.exists(CONFIG_PATH):
        example = os.path.join(ROOT, "config.example.json")
        if os.path.exists(example):
            import shutil
            shutil.copyfile(example, CONFIG_PATH)
        else:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(_DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def abspath(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


# ===== 多引擎支持：gpt-sovits / indextts 共存 =====
DEFAULT_ENGINES = {
    "gpt-sovits": {"api": "http://127.0.0.1:9880", "label": "GPT-SoVITS"},
    "indextts": {"api": "http://127.0.0.1:9881", "label": "IndexTTS"},
}


def engines_config():
    """返回引擎端点配置；兼容旧版只有 cfg['api'] 的情况。"""
    cfg = load_config()
    eng = dict(DEFAULT_ENGINES)
    for k, v in (cfg.get("engines") or {}).items():
        eng.setdefault(k, {}).update(v)
    # 旧字段 api 视为 gpt-sovits 端点
    if cfg.get("api"):
        eng["gpt-sovits"]["api"] = cfg["api"]
    if (cfg.get("engines") or {}).get("gpt-sovits", {}).get("api"):
        eng["gpt-sovits"]["api"] = cfg["engines"]["gpt-sovits"]["api"]
    return eng


def engine_api(engine):
    return engines_config().get(engine, {}).get("api") or DEFAULT_ENGINES["gpt-sovits"]["api"]


def engine_of(voice):
    return voice.get("engine", "gpt-sovits")


def voice_engine(voice_name):
    """返回某声线使用的引擎名。"""
    cfg = load_config()
    v = cfg.get("voices", {}).get(voice_name)
    return engine_of(v) if v else "gpt-sovits"


def voice_alive(voice_name):
    """该声线对应的引擎是否在线（IndexTTS 声线只需 IndexTTS 在线即可）。"""
    return api_alive(voice_engine(voice_name))


def set_engine_api(engine, api, root=None):
    """图形界面用：保存某引擎的服务端点；root 为该引擎本体/模型根目录（可选）。"""
    cfg = load_config()
    cfg.setdefault("engines", {})
    cfg["engines"].setdefault(engine, {})
    cfg["engines"][engine]["api"] = (api or "").strip().rstrip("/")
    if root is not None:
        cfg["engines"][engine]["root"] = (root or "").strip()
    if engine == "gpt-sovits":
        cfg["api"] = cfg["engines"][engine]["api"]  # 同步旧字段
    save_config(cfg)
    return engines_config()


def engine_root(engine):
    return (load_config().get("engines") or {}).get(engine, {}).get("root", "")


def list_voices():
    cfg = load_config()
    out = []
    for k, v in cfg.get("voices", {}).items():
        item = {"name": k, "engine": engine_of(v)}
        for kk in ("gpt", "sovits", "ref_audio", "prompt_text"):
            if kk in v:
                item[kk] = v[kk]
        out.append(item)
    return out


def api_alive(api=None):
    """兼容旧调用：默认探测 gpt-sovits。传 engine 名或完整 url 都可。"""
    if api in DEFAULT_ENGINES or (api and not api.startswith("http")):
        api = engine_api(api)
    if not api:
        api = engine_api("gpt-sovits")
    try:
        urllib.request.urlopen(api + "/", timeout=2)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def engines_status():
    """图形界面用：每个引擎在线与否 + 端点。"""
    eng = engines_config()
    return {k: {"label": v.get("label", k), "api": v.get("api"),
                "root": v.get("root", ""), "alive": api_alive(v.get("api"))}
            for k, v in eng.items()}


def load_voice(voice_name):
    """加载角色权重到 GPT-SoVITS。"""
    cfg = load_config()
    if voice_name not in cfg["voices"]:
        raise ValueError(f"未知角色：{voice_name}")
    v = cfg["voices"][voice_name]
    api = engine_api("gpt-sovits")
    for ep, key in (("/set_gpt_weights", "gpt"), ("/set_sovits_weights", "sovits")):
        url = api + ep + "?" + urllib.parse.urlencode({"weights_path": abspath(v[key])})
        with urllib.request.urlopen(url, timeout=120) as r:
            if r.status != 200:
                raise RuntimeError(f"加载权重失败：{key}")
    _state["loaded_voice"] = voice_name
    return v


def current_voice():
    return _state["loaded_voice"]


def rename_voice(old, new):
    """重命名已配置的角色声线。"""
    new = (new or "").strip()
    cfg = load_config()
    voices = cfg.get("voices", {})
    if old not in voices:
        raise ValueError("声线不存在")
    if not new:
        raise ValueError("新名称不能为空")
    if new == old:
        return
    if new in voices:
        raise ValueError("该名称已被占用")
    # 保持原有顺序重建字典
    cfg["voices"] = {(new if k == old else k): v for k, v in voices.items()}
    save_config(cfg)
    if _state.get("loaded_voice") == old:
        _state["loaded_voice"] = new


def synth_sentence(text, voice_name, speed=1.0):
    """合成一句，返回 wav 字节。会按需切换模型。全程串行，避免并发。"""
    with _synth_lock:
        return _synth_locked(text, voice_name, speed)


def _synth_locked(text, voice_name, speed):
    # 纯标点/空白句直接返回静音占位，避免引擎返回 400 中断
    if not _is_speakable(text):
        return _silence_wav()
    cfg = load_config()
    v = cfg["voices"][voice_name]
    engine = engine_of(v)
    if engine == "indextts":
        return _synth_indextts(text, v, speed)
    return _synth_gptsovits(text, voice_name, v, speed)


def _synth_gptsovits(text, voice_name, v, speed):
    if _state["loaded_voice"] != voice_name:
        load_voice(voice_name)
    payload = {
        "text": text, "text_lang": "zh",
        "ref_audio_path": abspath(v["ref_audio"]),
        "prompt_text": v["prompt_text"],
        "prompt_lang": v.get("prompt_lang", "zh"),
        # cut2：长句按标点再切分后拼接，缓解长句漏字/重复读
        "text_split_method": "cut2", "speed_factor": speed,
        "batch_size": 1, "media_type": "wav", "streaming_mode": False,
    }
    req = urllib.request.Request(engine_api("gpt-sovits") + "/tts",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        if r.status != 200:
            raise RuntimeError(r.read()[:200].decode("utf-8", "ignore"))
        return r.read()


def _synth_indextts(text, v, speed):
    """IndexTTS zero-shot 合成：只需参考音频 + 其文字，无需训练权重。
    请求体字段名按 index-tts API server 的约定，如你的部署不同可在此处调整。"""
    payload = {
        "text": text,
        "reference_audio": abspath(v["ref_audio"]),
        "prompt_text": v.get("prompt_text", ""),
        "speed": speed,
        "media_type": "wav",
    }
    req = urllib.request.Request(engine_api("indextts") + "/tts",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        if r.status != 200:
            raise RuntimeError(r.read()[:200].decode("utf-8", "ignore"))
        return r.read()


def discover_models():
    """扫描 model/ 目录，找出 .ckpt + .pth 成对的角色，方便一键加入 config。"""
    found = []
    if not os.path.isdir(MODEL_DIR):
        return found
    for name in os.listdir(MODEL_DIR):
        d = os.path.join(MODEL_DIR, name)
        if not os.path.isdir(d):
            continue
        ckpt = pth = ref = None
        for f in os.listdir(d):
            fp = os.path.join(d, f)
            if f.endswith(".ckpt"):
                ckpt = fp
            elif f.endswith(".pth"):
                pth = fp
        refdir = os.path.join(d, "参考音频")
        if os.path.isdir(refdir):
            wavs = [w for w in os.listdir(refdir) if w.lower().endswith(".wav")]
            if wavs:
                ref = os.path.join(refdir, wavs[0])
        found.append({"name": name, "gpt": ckpt, "sovits": pth, "ref_audio": ref,
                      "complete": bool(ckpt and pth and ref)})
    return found
