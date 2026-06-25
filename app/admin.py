# -*- coding: utf-8 -*-
"""后台/训练：驱动 GPT-SoVITS 官方脚本，全部以子进程后台运行（不弹命令行窗口），
日志实时回传前端训练UI。目录自动识别 GPT-SoVITS-v2pro*。"""
import glob
import os
import subprocess
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _configured_gsv_root():
    """读取网页里设置的 GPT-SoVITS 根目录（config.json engines.gpt-sovits.root）。"""
    try:
        import json
        cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
        return (cfg.get("engines") or {}).get("gpt-sovits", {}).get("root", "")
    except Exception:
        return ""


def _find_gsv():
    # 1) 优先用网页里手动设置的根目录（方便别人 clone 后自定义位置）
    root = _configured_gsv_root()
    if root and os.path.isdir(root):
        return root
    # 2) 否则在项目目录下自动探测 GPT-SoVITS* 目录
    cands = sorted([c for c in glob.glob(os.path.join(ROOT, "GPT-SoVITS*")) if os.path.isdir(c)], key=len)
    for c in cands:  # 优先含 api_v2.py 的目录
        if os.path.exists(os.path.join(c, "api_v2.py")):
            return c
    return cands[0] if cands else os.path.join(ROOT, "GPT-SoVITS")


GSV_DIR = _find_gsv()
RUNTIME_PY = os.path.join(GSV_DIR, "runtime", "python.exe")

_tasks = {}  # name -> {status, log, started}


def _abs(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def task_status():
    return _tasks


# ---------------- 引擎进程启停（网页控制） ----------------
ENGINE_PORT = {"gpt-sovits": 9880, "indextts": 9881}
ENGINE_BAT = {"gpt-sovits": "start_api.bat", "indextts": "start_indextts.bat"}
_starting = {}  # name -> 发起启动的时间戳；用于“启动中”状态跨刷新保持
_STARTING_TIMEOUT = 180  # 超过这么久仍未在线，视为启动失败，停止显示“启动中”


def is_starting(name, alive):
    """该引擎是否处于“启动中”。在线或超时则自动清除该状态。"""
    t = _starting.get(name)
    if t is None:
        return False
    if alive or (time.time() - t) > _STARTING_TIMEOUT:
        _starting.pop(name, None)
        return False
    return True


def _pids_on_port(port):
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True).stdout
    except Exception:
        return set()
    pids = set()
    for line in out.splitlines():
        if f":{port} " in line and "LISTENING" in line.upper():
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    return pids


def start_engine(name):
    if name not in ENGINE_PORT:
        return {"ok": False, "error": "未知引擎"}
    if _pids_on_port(ENGINE_PORT[name]):
        return {"ok": True, "msg": "已在运行"}
    NEW_CONSOLE = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)

    if name == "gpt-sovits":
        # 直接用 GPT-SoVITS 自带 runtime python 启动，不依赖系统 python；
        # cmd /k 保持窗口（报错可见，不再一闪而过）。
        gsv = _find_gsv()
        if not (gsv and os.path.exists(os.path.join(gsv, "api_v2.py"))):
            return {"ok": False, "error": "未找到 GPT-SoVITS，请先在『设置-语音引擎』里填写其根目录"}
        runtime_py = os.path.join(gsv, "runtime", "python.exe")
        py = runtime_py if os.path.exists(runtime_py) else "python"
        cmd = (f'cd /d "{gsv}" && "{py}" -I api_v2.py -a 127.0.0.1 -p 9880 '
               f'-c GPT_SoVITS/configs/tts_infer.yaml')
        try:
            subprocess.Popen(["cmd", "/k", cmd], creationflags=NEW_CONSOLE)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        _starting[name] = time.time()
        return {"ok": True, "msg": "启动中，模型加载需 1-2 分钟"}

    # IndexTTS：用其 .bat（内部走 uv 环境）
    bat = os.path.join(ROOT, ENGINE_BAT[name])
    if not os.path.exists(bat):
        return {"ok": False, "error": f"找不到启动脚本 {ENGINE_BAT[name]}"}
    try:
        os.startfile(bat)
    except Exception:
        try:
            subprocess.Popen(["cmd", "/c", "start", "", bat], cwd=ROOT,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except Exception as e:
            return {"ok": False, "error": str(e)}
    _starting[name] = time.time()
    return {"ok": True, "msg": "启动中，模型加载需 1-2 分钟"}


def stop_engine(name):
    if name not in ENGINE_PORT:
        return {"ok": False, "error": "未知引擎"}
    _starting.pop(name, None)
    pids = _pids_on_port(ENGINE_PORT[name])
    if not pids:
        return {"ok": True, "msg": "未在运行"}
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", pid], capture_output=True)
        except Exception:
            pass
    return {"ok": True, "msg": "已停止"}


def _run_bg(name, args, cwd=None, extra_env=None):
    _tasks[name] = {"status": "running", "log": "", "started": time.time()}

    def worker():
        try:
            env = dict(os.environ)
            env["PATH"] = os.path.join(GSV_DIR, "runtime") + os.pathsep + env.get("PATH", "")
            env["PYTHONIOENCODING"] = "utf-8"
            if extra_env:
                env.update(extra_env)
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            p = subprocess.Popen(args, cwd=cwd or GSV_DIR, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="ignore",
                                 creationflags=flags)
            lines = []
            for line in p.stdout:
                lines.append(line)
                _tasks[name]["log"] = "".join(lines[-300:])
            p.wait()
            _tasks[name]["status"] = "done" if p.returncode == 0 else f"failed({p.returncode})"
        except Exception as e:
            _tasks[name]["status"] = "error"
            _tasks[name]["log"] += f"\n[异常] {e}"

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "task": name}


# ---------- 数据处理 ----------
def slice_audio(input_dir, output_dir):
    slicer = os.path.join(GSV_DIR, "tools", "slice_audio.py")
    if not os.path.exists(slicer):
        return {"ok": False, "error": "未找到 slice_audio.py"}
    inp, outp = _abs(input_dir), _abs(output_dir)
    os.makedirs(outp, exist_ok=True)
    args = [RUNTIME_PY, "-I", slicer, inp, outp, "-34", "4000", "300", "10", "500", "0.9", "0.25", "1"]
    return _run_bg("切分", args)


def list_gpus():
    """检测可用 GPU（nvidia-smi）。"""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
            text=True, encoding="utf-8", errors="ignore",
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0))
        gpus = []
        for line in out.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                gpus.append({"index": parts[0], "name": parts[1], "mem": parts[2] + " MB"})
        return gpus or [{"index": "0", "name": "GPU 0", "mem": ""}]
    except Exception:
        return [{"index": "0", "name": "默认 GPU(0) / CPU", "mem": ""}]


def run_asr(input_dir, output_dir, lang="zh"):
    """语音识别打标，生成 .list 标注文件。优先 funasr(中文)。"""
    asr = os.path.join(GSV_DIR, "tools", "asr", "funasr_asr.py")
    if not os.path.exists(asr):
        return {"ok": False, "error": "未找到 funasr_asr.py"}
    inp, outp = _abs(input_dir), _abs(output_dir)
    os.makedirs(outp, exist_ok=True)
    args = [RUNTIME_PY, "-I", asr, "-i", inp, "-o", outp]
    return _run_bg("打标(ASR)", args)


# ---------- 训练（驱动官方 webui 的处理函数式脚本）----------
_PRE = os.path.join(GSV_DIR, "GPT_SoVITS", "pretrained_models")


def run_format(exp_name, list_file, wav_dir, gpu="0"):
    """数据格式化(一键三连)：文本/HuBERT/语义 特征提取，依次执行三个脚本。"""
    if not exp_name:
        return {"ok": False, "error": "请填写实验名"}
    logdir = os.path.join(GSV_DIR, "logs", exp_name)
    os.makedirs(logdir, exist_ok=True)
    base = {"inp_text": _abs(list_file), "inp_wav_dir": _abs(wav_dir), "exp_name": exp_name,
            "i_part": "0", "all_parts": "1", "opt_dir": logdir, "is_half": "True",
            "CUDA_VISIBLE_DEVICES": gpu}
    prep = os.path.join(GSV_DIR, "GPT_SoVITS", "prepare_datasets")
    steps = [
        ("1-get-text.py", {**base, "bert_pretrained_dir": os.path.join(_PRE, "chinese-roberta-wwm-ext-large")}),
        ("2-get-hubert-wav32k.py", {**base, "cnhubert_base_dir": os.path.join(_PRE, "chinese-hubert-base")}),
        ("3-get-semantic.py", {**base, "pretrained_s2G": os.path.join(_PRE, "gsv-v2final-pretrained", "s2G2333k.pth"),
                               "s2config_path": os.path.join(GSV_DIR, "GPT_SoVITS", "configs", "s2.json")}),
    ]
    name = f"格式化[{exp_name}]"
    _tasks[name] = {"status": "running", "log": "", "started": time.time()}

    def chain():
        env0 = dict(os.environ)
        env0["PATH"] = os.path.join(GSV_DIR, "runtime") + os.pathsep + env0.get("PATH", "")
        env0["PYTHONIOENCODING"] = "utf-8"
        alllog = []
        for script, env in steps:
            env_full = {**env0, **{k: str(v) for k, v in env.items()}}
            allog_head = f"\n===== 执行 {script} =====\n"
            allog = allog_head
            _tasks[name]["log"] += allog_head
            try:
                p = subprocess.Popen([RUNTIME_PY, "-I", os.path.join(prep, script)], cwd=GSV_DIR, env=env_full,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     encoding="utf-8", errors="ignore",
                                     creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0))
                for line in p.stdout:
                    _tasks[name]["log"] += line
                    _tasks[name]["log"] = _tasks[name]["log"][-8000:]
                p.wait()
                if p.returncode != 0:
                    _tasks[name]["status"] = f"failed@{script}"
                    return
            except Exception as e:
                _tasks[name]["status"] = "error"
                _tasks[name]["log"] += f"\n[异常] {e}"
                return
        _tasks[name]["status"] = "done"

    threading.Thread(target=chain, daemon=True).start()
    return {"ok": True, "task": name}


def run_train_sovits(exp_name, p):
    """训练 SoVITS(s2)。写一份训练配置后启动 s2_train.py。"""
    import json
    if not exp_name:
        return {"ok": False, "error": "请填写实验名"}
    logdir = os.path.join(GSV_DIR, "logs", exp_name)
    s2base = os.path.join(GSV_DIR, "GPT_SoVITS", "configs", "s2.json")
    if not os.path.exists(s2base):
        return {"ok": False, "error": "缺少 s2.json 基础配置"}
    cfg = json.load(open(s2base, encoding="utf-8"))
    cfg["train"].update({"batch_size": p["batch_size"], "epochs": p["total_epoch"],
                         "text_low_lr_rate": p["text_low_lr_rate"], "save_every_epoch": p["save_every_epoch"],
                         "if_save_latest": p["if_save_latest"], "if_save_every_weights": p["if_save_every_weights"],
                         "gpu_numbers": p["gpu"], "pretrained_s2G": os.path.join(_PRE, "gsv-v2final-pretrained", "s2G2333k.pth"),
                         "pretrained_s2D": os.path.join(_PRE, "gsv-v2final-pretrained", "s2D2333k.pth")})
    cfg["data"] = cfg.get("data", {}); cfg["data"]["exp_dir"] = logdir
    cfg["s2_ckpt_dir"] = logdir; cfg["name"] = exp_name
    os.makedirs(os.path.join(GSV_DIR, "TEMP"), exist_ok=True)
    cfgp = os.path.join(GSV_DIR, "TEMP", f"s2_{exp_name}.json")
    json.dump(cfg, open(cfgp, "w", encoding="utf-8"), ensure_ascii=False)
    script = os.path.join(GSV_DIR, "GPT_SoVITS", "s2_train.py")
    return _run_bg(f"训练SoVITS[{exp_name}]", [RUNTIME_PY, "-I", script, "--config", cfgp],
                   extra_env={"CUDA_VISIBLE_DEVICES": p["gpu"]})


def run_train_gpt(exp_name, p):
    """训练 GPT(s1)。"""
    if not exp_name:
        return {"ok": False, "error": "请填写实验名"}
    s1base = os.path.join(GSV_DIR, "GPT_SoVITS", "configs", "s1longer-v2.yaml")
    if not os.path.exists(s1base):
        s1base = os.path.join(GSV_DIR, "GPT_SoVITS", "configs", "s1longer.yaml")
    if not os.path.exists(s1base):
        return {"ok": False, "error": "缺少 GPT 训练基础配置(s1longer*.yaml)"}
    script = os.path.join(GSV_DIR, "GPT_SoVITS", "s1_train.py")
    env = {"CUDA_VISIBLE_DEVICES": p["gpu"], "exp_name": exp_name,
           "batch_size": str(p["batch_size"]), "total_epoch": str(p["total_epoch"]),
           "save_every_epoch": str(p["save_every_epoch"]), "if_dpo": str(p["if_dpo"]),
           "if_save_latest": str(p["if_save_latest"]), "if_save_every_weights": str(p["if_save_every_weights"])}
    return _run_bg(f"训练GPT[{exp_name}]", [RUNTIME_PY, "-I", script, "--config_file", s1base], extra_env=env)
