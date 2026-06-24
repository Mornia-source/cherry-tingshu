# -*- coding: utf-8 -*-
"""IndexTTS 桥接服务：把 IndexTTS 的 Python 推理封装成 HTTP /tts 接口，
端口 9881，供「樱桃听书」直接调用（请求体字段与 app/tts.py 的 _synth_indextts 对齐）。

用法：
  1. 先在装好 IndexTTS 的那个 Python 环境里安装 fastapi/uvicorn：
       pip install fastapi uvicorn
  2. 把下面 MODEL_DIR / CFG_PATH 改成你下载的 IndexTTS 模型路径。
  3. 运行：python indextts_server.py
  4. 在「樱桃听书」设置页 → 语音引擎 → IndexTTS 端点填 http://127.0.0.1:9881 保存。

⚠️ 不同版本 IndexTTS 的推理函数名/参数略有差异，本脚本已做兼容尝试；
   若启动或合成报错，把完整报错发我，我据此微调（这是唯一需要按你实际版本对齐的地方）。
"""
import io
import os
import tempfile

import uvicorn
from fastapi import FastAPI
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

# ============ IndexTTS 路径 ============
# 优先级：环境变量 > 网页里「语音引擎」填的 IndexTTS 根目录(config.json) > 下面默认值
def _root_from_config():
    """读取本项目 config.json 中网页保存的 IndexTTS 根目录。"""
    try:
        import json
        cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          "config.json"), encoding="utf-8"))
        return (cfg.get("engines") or {}).get("indextts", {}).get("root", "")
    except Exception:
        return ""


_ROOT = os.environ.get("INDEXTTS_ROOT") or _root_from_config() or "D:/IndexTTS"


def _guess_model_dir(root):
    """在 IndexTTS 根目录下找模型目录（含 config.yaml）。"""
    for cand in (os.path.join(root, "checkpoints"), root):
        if os.path.exists(os.path.join(cand, "config.yaml")):
            return cand
    return os.path.join(root, "checkpoints")


MODEL_DIR = os.environ.get("INDEXTTS_MODEL_DIR") or _guess_model_dir(_ROOT)
CFG_PATH = os.environ.get("INDEXTTS_CFG") or os.path.join(MODEL_DIR, "config.yaml")
PORT = int(os.environ.get("INDEXTTS_PORT", "9881"))
# ======================================

app = FastAPI(title="IndexTTS 桥接服务")
_engine = {"tts": None, "infer_kw": None}


def _load_engine():
    """按版本兼容地加载 IndexTTS 引擎，只加载一次。"""
    if _engine["tts"] is not None:
        return _engine["tts"]
    tts = None
    # 优先尝试 IndexTTS2，再退回 IndexTTS(1.x)
    # use_fp16=True：8GB 显存(RTX 4060 Laptop)开半精度，省显存、更快、质量损失极小
    try:
        from indextts.infer_v2 import IndexTTS2
        tts = IndexTTS2(cfg_path=CFG_PATH, model_dir=MODEL_DIR,
                        use_fp16=True, use_cuda_kernel=False, use_deepspeed=False)
        _engine["infer_kw"] = "spk_audio_prompt"   # v2 参考音频参数名
    except Exception:
        from indextts.infer import IndexTTS
        tts = IndexTTS(model_dir=MODEL_DIR, cfg_path=CFG_PATH)
        _engine["infer_kw"] = "audio_prompt"       # v1 参考音频参数名
    _engine["tts"] = tts
    return tts


class TTSReq(BaseModel):
    text: str
    reference_audio: str
    prompt_text: str = ""
    speed: float = 1.0
    media_type: str = "wav"


@app.get("/")
def root():
    return {"ok": True, "engine": "indextts"}


@app.post("/tts")
def tts(req: TTSReq):
    try:
        engine = _load_engine()
    except Exception as e:
        return JSONResponse({"error": f"IndexTTS 加载失败：{e}"}, status_code=500)
    try:
        out_path = os.path.join(tempfile.gettempdir(), "indextts_out.wav")
        kw = {_engine["infer_kw"]: req.reference_audio,
              "text": req.text, "output_path": out_path}
        engine.infer(**kw)
        with open(out_path, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="audio/wav")
    except Exception as e:
        return JSONResponse({"error": f"合成失败：{e}"}, status_code=400)


if __name__ == "__main__":
    print(f"IndexTTS 桥接服务启动中… 端口 {PORT}")
    print(f"模型目录：{MODEL_DIR}")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
