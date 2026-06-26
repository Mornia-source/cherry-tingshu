// ========== 设置页 + 训练工作台 ==========
let trainTimer = null, pgTimer = null, trainReady = false;

// ---------- 设置 ----------
const ENGINE_LABEL = { "gpt-sovits": "GPT-SoVITS", "indextts": "IndexTTS" };
async function loadSettings() {
  renderAccentSwatches();
  loadProfile();
  const data = await api("/api/admin/models").catch(() => null);
  if (data) {
    renderEngines(data.engines || {});
    $("#model-select").innerHTML = data.configured.map(v =>
      `<option value="${v.name}" ${v.name === data.current ? "selected" : ""}>${v.name}（${ENGINE_LABEL[v.engine] || v.engine}）${v.name === data.current ? " · 当前" : ""}</option>`).join("")
      || '<option value="">（暂无模型）</option>';
    $("#model-status").innerHTML = data.api_alive
      ? '<span class="tag-ok"><i class="fas fa-circle" style="font-size:8px"></i> GPT-SoVITS 在线</span>'
      : '<span class="tag-no"><i class="fas fa-circle" style="font-size:8px"></i> GPT-SoVITS 离线，请运行 start_api.bat</span>';
    renderConfiguredVoices(data.configured || []);
  }
}
function renderEngines(engines) {
  const box = $("#engine-list"); if (!box) return;
  box.innerHTML = "";
  Object.keys(engines).forEach(key => {
    const e = engines[key];
    const row = document.createElement("div"); row.className = "engine-row";
    const rootPlaceholder = key === "indextts"
      ? "IndexTTS 根目录，如 D:\\index-tts"
      : "GPT-SoVITS 根目录（含 api_v2.py），留空则自动探测项目目录";
    const rootField = `
      <input class="input grow eng-root" value="${e.root || ""}" placeholder="${rootPlaceholder}" style="margin-top:6px">`;
    const starting = !!e.starting && !e.alive;
    const stateText = starting ? "启动中…" : (e.alive ? "在线" : "离线");
    const stateCls = starting ? "starting" : (e.alive ? "on" : "off");
    row.innerHTML = `
      <div class="engine-head">
        <span class="engine-name">${e.label || key}</span>
        <span class="eng-control">
          <span class="eng-state ${stateCls}">${stateText}</span>
          <button class="engine-switch ${e.alive ? "on" : ""} ${starting ? "starting" : ""}"
                  role="switch" aria-checked="${e.alive}" title="${e.alive ? "点击停止" : "点击启动"}">
            <span class="knob"></span>
          </button>
        </span>
      </div>
      <div class="row-inline">
        <input class="input grow eng-api" value="${e.api || ""}" placeholder="http://127.0.0.1:9881 或 http://云服务器IP:端口">
        <button class="btn eng-save"><i class="fas fa-floppy-disk"></i> 保存</button>
      </div>
      ${rootField}`;
    row.querySelector(".eng-save").onclick = async () => {
      const api2 = row.querySelector(".eng-api").value.trim();
      const rootEl = row.querySelector(".eng-root");
      const form = { engine: key, api: api2 };
      if (rootEl) form.root = rootEl.value.trim();
      try { await api("/api/admin/engine", { method: "POST", form: toForm(form) }); await loadSettings(); await loadVoices(); }
      catch (err) { Dlg.alert("保存失败：" + err.message); }
    };
    row.querySelector(".engine-switch").onclick = () => {
      if (starting) return;
      if (e.alive) stopEngine(key); else startEngine(key, engines);
    };
    box.appendChild(row);
  });
  // 刷新后若仍有引擎处于“启动中”，自动恢复轮询直到其上线
  if (!engPollTimer) {
    const s = Object.keys(engines).find(k => engines[k].starting && !engines[k].alive);
    if (s) pollEngines(s, true);
  }
}
let engPollTimer = null;
const engStarting = {};
async function startEngine(key, engines) {
  // 显存有限：一次只跑一个引擎。另一个在跑时，先停掉它再启动本引擎。
  const other = key === "gpt-sovits" ? "indextts" : "gpt-sovits";
  if (engines[other] && engines[other].alive) {
    const ok = await Dlg.confirm(
      `显存有限，两个引擎不能同时运行（会导致整机卡顿、合不出声）。\n将先停止「${ENGINE_LABEL[other]}」，再启动「${ENGINE_LABEL[key]}」。`,
      { title: "显存不足", okText: `停止${ENGINE_LABEL[other]}并启动`, cancelText: "取消" });
    if (!ok) return;
    await stopEngine(other);
    await new Promise(r => setTimeout(r, 2500));  // 等显存释放
  }
  try {
    const r = await api("/api/admin/engine/start", { method: "POST", form: toForm({ engine: key }) });
    if (r.ok === false) { Dlg.alert(r.error || "启动失败"); return; }
  } catch (e) { Dlg.alert("启动失败：" + e.message); return; }
  // 后端已记录“启动中”，立即刷新一次让状态立刻显示（刷新页面也不会丢）
  const data = await api("/api/admin/engines").catch(() => null);
  if (data) renderEngines(data.engines || {});
  pollEngines(key, true);  // 轮询直到在线
}
async function stopEngine(key) {
  try { await api("/api/admin/engine/stop", { method: "POST", form: toForm({ engine: key }) }); }
  catch (e) { Dlg.alert("停止失败：" + e.message); return; }
  setTimeout(loadSettings, 800);
}
function pollEngines(key, expectOnline) {
  if (engPollTimer) clearInterval(engPollTimer);
  let n = 0;
  engPollTimer = setInterval(async () => {
    n++;
    const data = await api("/api/admin/engines").catch(() => null);
    if (data) renderEngines(data.engines || {});
    const alive = data && data.engines[key] && data.engines[key].alive;
    if (alive === expectOnline || n > 90) {
      clearInterval(engPollTimer); engPollTimer = null;
      if (data) renderEngines(data.engines || {});
      loadVoices();
    }
  }, 2000);
}
let voiceAdminItems = [];
let voiceAdminPage = 1;
const VOICE_PAGE_SIZE = 3;
function renderConfiguredVoices(voices) {
  if (voices) { voiceAdminItems = voices; }
  const box = $("#configured-voices"); if (!box) return;
  const search = $("#voice-search");
  if (search && !search._wired) {
    search._wired = true;
    search.oninput = () => { voiceAdminPage = 1; renderConfiguredVoices(); };
  }
  const pager = $("#voice-pager");
  const q = ((search || {}).value || "").trim().toLowerCase();
  let items = voiceAdminItems;
  if (q) {
    items = items.filter(v =>
      (v.name || "").toLowerCase().includes(q) ||
      (ENGINE_LABEL[v.engine] || v.engine || "").toLowerCase().includes(q));
  }
  if (!items.length) {
    box.innerHTML = q ? '<p class="hint">没有匹配的角色模型。</p>' : "";
    if (pager) pager.innerHTML = "";
    return;
  }
  const pages = Math.ceil(items.length / VOICE_PAGE_SIZE);
  if (voiceAdminPage > pages) voiceAdminPage = pages;
  const start = (voiceAdminPage - 1) * VOICE_PAGE_SIZE;
  const pageItems = items.slice(start, start + VOICE_PAGE_SIZE);

  box.innerHTML = "";
  for (const v of pageItems) {
    const row = document.createElement("div"); row.className = "model-row";
    row.innerHTML = `<span><i class="fas fa-user-tag"></i> ${v.name} <span class="hint">${ENGINE_LABEL[v.engine] || v.engine}</span></span>
      <span class="row-inline">
        <button class="btn voice-edit"><i class="fas fa-pen"></i> 编辑</button>
        <button class="btn voice-del" style="color:var(--danger)"><i class="fas fa-trash"></i> 删除</button>
      </span>`;
    row.querySelector(".voice-edit").onclick = () => editVoice(v, true);
    row.querySelector(".voice-del").onclick = () => deleteVoice(v.name);
    box.appendChild(row);
  }
  if (!pager) return;
  if (pages <= 1) { pager.innerHTML = `<span class="cur">共 ${items.length} 个</span>`; return; }
  pager.innerHTML = `
    <button class="btn" ${voiceAdminPage <= 1 ? "disabled" : ""} id="vp-prev"><i class="fas fa-chevron-left"></i></button>
    <span class="cur">第 ${voiceAdminPage} / ${pages} 页 · 共 ${items.length} 个</span>
    <button class="btn" ${voiceAdminPage >= pages ? "disabled" : ""} id="vp-next"><i class="fas fa-chevron-right"></i></button>`;
  if (voiceAdminPage > 1) $("#vp-prev").onclick = () => { voiceAdminPage--; renderConfiguredVoices(); };
  if (voiceAdminPage < pages) $("#vp-next").onclick = () => { voiceAdminPage++; renderConfiguredVoices(); };
}
const LANG_OPTS = [
  { value: "zh", label: "中文" }, { value: "ja", label: "日语" },
  { value: "en", label: "英语" }, { value: "auto", label: "自动 / 多语种" },
];
// 统一的添加/编辑角色模型对话框（自适应任意文件名、引擎、语言）
async function editVoice(prefill, isEdit) {
  const e = prefill || { engine: "gpt-sovits", prompt_lang: "zh" };
  const vals = await Dlg.form({
    title: isEdit ? "编辑角色模型" : "添加角色模型",
    okText: isEdit ? "保存" : "添加",
    fields: [
      { key: "name", label: "名称", value: e.name || "", placeholder: "如：洛琪希" },
      { key: "engine", label: "引擎", type: "select", value: e.engine || "gpt-sovits",
        options: [{ value: "gpt-sovits", label: "GPT-SoVITS（需 .ckpt/.pth 权重）" }, { value: "indextts", label: "IndexTTS（免训练，只需参考音频）" }] },
      { key: "gpt", label: "GPT 权重 (.ckpt)", value: e.gpt || "", placeholder: "model/洛琪希/Roxy_Pro.ckpt", show: v => v.engine === "gpt-sovits" },
      { key: "sovits", label: "SoVITS 权重 (.pth)", value: e.sovits || "", placeholder: "model/洛琪希/Roxy_Pro.pth", show: v => v.engine === "gpt-sovits" },
      { key: "ref_audio", label: "参考音频路径", value: e.ref_audio || "", placeholder: "一段清晰人声音频的完整路径（建议 3-10 秒）" },
      { key: "prompt_text", label: "参考音频对应的文字", type: "textarea", value: e.prompt_text || "", placeholder: "必须与参考音频里说的内容完全一致" },
      { key: "prompt_lang", label: "参考音频语言", type: "select", value: e.prompt_lang || "zh", options: LANG_OPTS,
        hint: "参考音频是什么语言就选什么（如日语模型选日语）；朗读的书仍按中文处理。" },
    ],
  });
  if (!vals) return;
  if (!vals.name) return Dlg.alert("请填写名称");
  if (vals.engine === "gpt-sovits" && (!vals.gpt || !vals.sovits)) return Dlg.alert("GPT-SoVITS 需要 .ckpt 和 .pth 两个权重文件路径");
  if (!vals.ref_audio || !vals.prompt_text) return Dlg.alert("请填写参考音频路径和它对应的文字");
  try {
    const form = { name: vals.name, engine: vals.engine, ref_audio: vals.ref_audio,
      prompt_text: vals.prompt_text, prompt_lang: vals.prompt_lang, gpt: vals.gpt, sovits: vals.sovits };
    if (isEdit) form.old_name = e.name;
    await api("/api/admin/add_voice", { method: "POST", form: toForm(form) });
    await loadSettings(); await loadVoices();
  } catch (err) { Dlg.alert("保存失败：" + err.message); }
}
async function deleteVoice(name) {
  const ok = await Dlg.confirm(`确定删除角色模型「${name}」吗？\n仅从配置中移除，不会删除磁盘上的模型文件。`,
    { title: "删除角色模型", danger: true, okText: "删除" });
  if (!ok) return;
  try { await api("/api/admin/delete_voice", { method: "POST", form: toForm({ name }) }); await loadSettings(); await loadVoices(); }
  catch (e) { Dlg.alert("删除失败：" + e.message); }
}
async function useModel() {
  const voice = $("#model-select").value; if (!voice) return;
  try { await api("/api/admin/select", { method: "POST", form: toForm({ voice }) }); await loadSettings(); await loadVoices(); Dlg.alert("已切换当前朗读模型：" + voice); }
  catch (e) { Dlg.alert("切换失败：" + e.message + "（语音引擎是否已启动？）"); }
}

async function discoverModels() {
  const data = await api("/api/admin/models");
  const box = $("#admin-discovered"); const list = data.discovered || [];
  if (!list.length) { box.innerHTML = '<p class="hint">model 目录下未发现含 .ckpt/.pth 的模型文件夹。</p>'; return; }
  box.innerHTML = "";
  for (const m of list) {
    const configured = data.configured.some(c => c.name === m.name);
    const hasModel = !!(m.gpt && m.sovits);
    const row = document.createElement("div"); row.className = "model-row";
    row.innerHTML = `<span><i class="fas fa-folder"></i> ${m.name} ${hasModel ? '<span class="tag-ok">找到权重</span>' : '<span class="tag-no">缺.ckpt/.pth</span>'}${m.refs && m.refs.length ? ` <span class="hint">${m.refs.length}个参考音频</span>` : ""}</span>
      <button class="btn ${configured ? "" : "primary"}"><i class="fas fa-plus"></i> ${configured ? "再加一个" : "加入"}</button>`;
    row.querySelector("button").onclick = () => editVoice({
      name: configured ? m.name + "-2" : m.name, engine: "gpt-sovits",
      gpt: m.gpt || "", sovits: m.sovits || "", ref_audio: m.ref_audio || "", prompt_lang: "zh",
    }, false);
    box.appendChild(row);
  }
}

// ---------- 管理员：账号总览（头像/在读/权限/分页/搜索） ----------
let adminPage = 1, adminQuery = "";
function fmtTime(ts) {
  if (!ts) return "从未";
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 60) return "刚刚"; if (d < 3600) return Math.floor(d / 60) + "分钟前";
  if (d < 86400) return Math.floor(d / 3600) + "小时前"; return Math.floor(d / 86400) + "天前";
}
async function loadUsers(page = adminPage) {
  adminPage = page;
  const data = await api(`/api/admin/users?page=${page}&q=${encodeURIComponent(adminQuery)}`).catch(() => null);
  const grid = $("#user-grid"); if (!data) { grid.innerHTML = '<p class="hint">无权限</p>'; return; }
  if (!data.users.length) { grid.innerHTML = '<p class="hint">没有匹配的账号。</p>'; $("#user-pager").innerHTML = ""; return; }
  grid.innerHTML = "";
  for (const u of data.users) {
    const avatar = u.avatar ? `<img class="uc-avatar" src="${u.avatar}">` : `<div class="uc-avatar ph">${(u.username || "?")[0].toUpperCase()}</div>`;
    const card = document.createElement("div"); card.className = "user-card";
    card.innerHTML = `
      <div class="user-card-top">${avatar}
        <div style="min-width:0;flex:1">
          <div class="uc-name">${u.username} ${u.is_admin ? '<i class="fas fa-crown" style="color:var(--primary)"></i>' : ""}
            <span class="grp ${u.is_admin ? "admin" : "user"}">${u.group}</span></div>
          <div class="uc-uid">${u.uid}</div>
        </div></div>
      <div class="uc-meta">
        <div><span class="online-dot ${u.online ? "on" : "off"}"></span> ${u.online ? "在读" : "离线"} · 活跃 ${fmtTime(u.last_at)}</div>
        <div>在读：<span class="reading">${u.reading ? u.reading : "—"}</span></div>
        <div>阅读进度：${u.books} 本</div>
      </div>
      ${u.is_admin ? "" : `<div class="uc-actions">
        <button class="btn" data-reset="${u.id}"><i class="fas fa-key"></i> 改密</button>
        <button class="btn" data-del="${u.id}" style="color:var(--danger)"><i class="fas fa-trash"></i> 删除</button></div>`}`;
    grid.appendChild(card);
  }
  grid.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("确认删除该账号及其数据？")) return;
    await api("/api/admin/users/delete", { method: "POST", form: toForm({ uid: b.dataset.del }) }); await loadUsers();
  });
  grid.querySelectorAll("[data-reset]").forEach(b => b.onclick = async () => {
    const pwd = prompt("输入该账号的新密码："); if (!pwd) return;
    await api("/api/admin/users/reset", { method: "POST", form: toForm({ uid: b.dataset.reset, password: pwd }) }); alert("已重置");
  });
  renderPager(data.page, data.pages, data.total);
}
function renderPager(page, pages, total) {
  const box = $("#user-pager");
  if (pages <= 1) { box.innerHTML = `<span class="cur">共 ${total} 个账号</span>`; return; }
  box.innerHTML = `
    <button class="btn" ${page <= 1 ? "disabled" : ""} id="pg-prev"><i class="fas fa-chevron-left"></i></button>
    <span class="cur">第 ${page} / ${pages} 页 · 共 ${total} 个</span>
    <button class="btn" ${page >= pages ? "disabled" : ""} id="pg-next"><i class="fas fa-chevron-right"></i></button>`;
  if (page > 1) $("#pg-prev").onclick = () => loadUsers(page - 1);
  if (page < pages) $("#pg-next").onclick = () => loadUsers(page + 1);
}

// ---------- 管理员：本地预训练音频管理 ----------
let pgAdminItems = [];
let pgAdminPage = 1;
const PG_PAGE_SIZE = 8;
async function loadPregenAdmin() {
  const data = await api("/api/pregen/list").catch(() => ({ items: [] }));
  pgAdminItems = data.items || [];
  pgAdminPage = 1;
  const search = $("#pregen-search");
  if (search && !search._wired) {
    search._wired = true;
    search.oninput = () => { pgAdminPage = 1; renderPregenAdmin(); };
  }
  renderPregenAdmin();
}
function renderPregenAdmin() {
  const box = $("#pregen-admin"), pager = $("#pregen-pager");
  const q = (($("#pregen-search") || {}).value || "").trim().toLowerCase();
  let items = pgAdminItems;
  if (q) {
    items = items.filter(it =>
      (it.book_title || "").toLowerCase().includes(q) ||
      (it.chapter_title || "").toLowerCase().includes(q) ||
      (it.voice || "").toLowerCase().includes(q));
  }
  if (!items.length) {
    box.innerHTML = `<p class="hint">${q ? "没有匹配的记录。" : "暂无预生成音频。"}</p>`;
    if (pager) pager.innerHTML = "";
    return;
  }
  const pages = Math.ceil(items.length / PG_PAGE_SIZE);
  if (pgAdminPage > pages) pgAdminPage = pages;
  const start = (pgAdminPage - 1) * PG_PAGE_SIZE;
  const pageItems = items.slice(start, start + PG_PAGE_SIZE);

  box.innerHTML = "";
  let lastBook = null;
  for (const it of pageItems) {
    // 同一本书只在变化时显示一次书名分组标题
    if (it.book_title !== lastBook) {
      lastBook = it.book_title;
      const h = document.createElement("div"); h.className = "pg-book-head";
      h.innerHTML = `<i class="fas fa-book"></i> ${it.book_title}`;
      box.appendChild(h);
    }
    const row = document.createElement("div"); row.className = "model-row pg-row";
    row.innerHTML = `<span><i class="fas fa-compact-disc"></i> ${it.chapter_title} · ${it.voice} · ${it.speed}× <span class="hint">(${it.done}/${it.total})</span></span>
      <span class="row-inline">
        <button class="btn pg-export-mobile" title="导出可在手机App导入的听书包(含文本+音频)"><i class="fas fa-mobile-screen"></i> 手机包</button>
        <button class="btn pg-export-one"><i class="fas fa-file-export"></i> 导出</button>
        <button class="btn pg-del" style="color:var(--danger)"><i class="fas fa-trash"></i> 删除</button>
      </span>`;
    row.querySelector(".pg-export-mobile").onclick = () => exportMobilePack(it);
    row.querySelector(".pg-export-one").onclick = () => exportPregenOne(it);
    row.querySelector(".pg-del").onclick = async () => {
      if (!confirm(`删除《${it.book_title}》${it.chapter_title} 的预生成音频？`)) return;
      await api("/api/pregen/delete", { method: "POST", form: toForm({ bid: it.bid, chapter: it.chapter, voice: it.voice, speed: it.speed }) });
      await loadPregenAdmin();
    };
    box.appendChild(row);
  }
  // 分页控件
  if (!pager) return;
  if (pages <= 1) { pager.innerHTML = `<span class="cur">共 ${items.length} 条</span>`; return; }
  pager.innerHTML = `
    <button class="btn" ${pgAdminPage <= 1 ? "disabled" : ""} id="pg-a-prev"><i class="fas fa-chevron-left"></i></button>
    <span class="cur">第 ${pgAdminPage} / ${pages} 页 · 共 ${items.length} 条</span>
    <button class="btn" ${pgAdminPage >= pages ? "disabled" : ""} id="pg-a-next"><i class="fas fa-chevron-right"></i></button>`;
  if (pgAdminPage > 1) $("#pg-a-prev").onclick = () => { pgAdminPage--; renderPregenAdmin(); };
  if (pgAdminPage < pages) $("#pg-a-next").onclick = () => { pgAdminPage++; renderPregenAdmin(); };
}

// 浏览器原生下载（边下边写盘，不把整包读进内存，避免大文件 Failed to fetch）
function nativeDownload(url, filename) {
  const sep = url.includes("?") ? "&" : "?";
  const a = document.createElement("a");
  a.href = url + sep + "tok=" + encodeURIComponent(App.token || "");
  if (filename) a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}
function exportPregen() {
  nativeDownload("/api/pregen/export", "樱桃听书-预生成音频库.zip");
}
function exportMobilePack(it) {
  const q = `bid=${it.bid}&chapter=${it.chapter}&voice=${encodeURIComponent(it.voice)}&speed=${it.speed}`;
  nativeDownload("/api/pregen/export_mobile?" + q, `${it.book_title || it.bid}-${it.chapter_title || ""}-${it.voice}.tsp.zip`);
}
function exportPregenOne(it) {
  const q = `bid=${it.bid}&chapter=${it.chapter}&voice=${encodeURIComponent(it.voice)}&speed=${it.speed}`;
  nativeDownload("/api/pregen/export_one?" + q, `预生成-${it.book_title || it.bid}-${it.chapter_title || ("第" + (it.chapter + 1) + "节")}.zip`);
}
async function importPregen(file) {
  const f = new FormData(); f.append("file", file);
  try {
    const r = await api("/api/pregen/import", { method: "POST", form: f });
    if (r.ok === false) { alert(r.error || "导入失败"); return; }
    alert(`导入成功，现有 ${r.count} 个预生成章节`);
    await loadPregenAdmin();
  } catch (e) { alert("导入失败：" + e.message); }
}

// ---------- 训练工作台 ----------
async function loadTrain() {
  // GPU 列表
  if (!trainReady) {
    const g = await api("/api/admin/gpus").catch(() => ({ gpus: [{ index: "0", name: "GPU 0", mem: "" }] }));
    $("#t-gpu").innerHTML = g.gpus.map(x => `<option value="${x.index}">#${x.index} ${x.name} ${x.mem}</option>`).join("");
    trainReady = true;
  }
  pollTrain(); // 持久日志：进入即开始轮询，切换视图不重置
}
function switchTrainView(view) {
  $all(".tside-btn").forEach(b => b.classList.toggle("active", b.dataset.tview === view));
  $all(".tview").forEach(v => {
    const show = v.dataset.view === view;
    v.classList.toggle("hidden", !show);
    if (show) { v.classList.remove("entering"); void v.offsetWidth; v.classList.add("entering"); }
  });
}
async function runTrain(kind) {
  const gpu = $("#t-gpu").value || "0";
  let ep, form;
  if (kind === "slice") { ep = "/api/admin/slice"; form = toForm({ input_dir: $("#t-slice-in").value, output_dir: $("#t-slice-out").value }); }
  else if (kind === "asr") { ep = "/api/admin/asr"; form = toForm({ input_dir: $("#t-asr-in").value, output_dir: $("#t-asr-out").value }); }
  else if (kind === "format") { ep = "/api/admin/format"; form = toForm({ exp_name: $("#t-exp").value, list_file: $("#t-list").value, wav_dir: $("#t-wav").value, gpu }); }
  else if (kind === "train_sovits") {
    ep = "/api/admin/train_sovits";
    form = toForm({ exp_name: $("#s2-exp").value, gpu, batch_size: $("#s2-bs").value, total_epoch: $("#s2-ep").value,
      save_every_epoch: $("#s2-save").value, text_low_lr_rate: $("#s2-lr").value,
      if_save_latest: $("#s2-latest").checked, if_save_every_weights: $("#s2-every").checked });
  } else if (kind === "train_gpt") {
    ep = "/api/admin/train_gpt";
    form = toForm({ exp_name: $("#s1-exp").value, gpu, batch_size: $("#s1-bs").value, total_epoch: $("#s1-ep").value,
      save_every_epoch: $("#s1-save").value, if_dpo: $("#s1-dpo").checked,
      if_save_latest: $("#s1-latest").checked, if_save_every_weights: $("#s1-every").checked });
  }
  try {
    const r = await api(ep, { method: "POST", form });
    if (r.ok === false) { alert(r.error || "无法启动"); return; }
    switchTrainView("log"); pollTrain();
  } catch (e) { alert("启动失败：" + e.message); }
}
function pollTrain() {
  if (trainTimer) return; // 已在轮询则不重复，保证日志连续
  const tick = async () => {
    const data = await api("/api/admin/tasks").catch(() => null);
    if (!data) return;
    const t = data.tasks, keys = Object.keys(t);
    const el = $("#train-log"); if (!el) return;
    if (!keys.length) { el.textContent = "等待执行…"; return; }
    el.textContent = keys.map(k => `【${k}】状态：${t[k].status}\n${t[k].log || ""}`).join("\n\n");
  };
  tick(); trainTimer = setInterval(tick, 1500);
}

window.addEventListener("DOMContentLoaded", () => {
  $("#btn-model-use").onclick = useModel;
  $("#btn-discover").onclick = discoverModels;
  $("#btn-add-voice").onclick = () => editVoice(null, false);
  $all(".tside-btn").forEach(b => b.onclick = () => switchTrainView(b.dataset.tview));
  $all("[data-train]").forEach(b => b.onclick = () => runTrain(b.dataset.train));
  let st; $("#user-search").addEventListener("input", e => {
    clearTimeout(st); st = setTimeout(() => { adminQuery = e.target.value.trim(); loadUsers(1); }, 300);
  });
  $("#btn-pregen-export").onclick = exportPregen;
  $("#pregen-import-input").onchange = e => { if (e.target.files[0]) importPregen(e.target.files[0]); };
});
