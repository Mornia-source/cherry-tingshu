// ========== 双页阅读器 + 朗读高亮 + 目录 + 个性化 ==========
const Reader = {
  book: null, chapterIdx: 0, sentences: [], paraStarts: new Set(), pages: [], spread: 0,
  cur: 0, activeIdx: -1, playing: false, audioCache: new Map(),
  fontSize: 19, lineHeight: 2.05, fontFamily: "var(--serif)", pause: 0.3,
};

// 阅读个性化
const RC_DEFAULT = { font: "var(--serif)", size: 19, line: 2.05, paper: "", text: "", pause: 0.3 };
function loadRC() {
  try { return Object.assign({}, RC_DEFAULT, JSON.parse(localStorage.getItem("readcfg") || "{}")); }
  catch (e) { return Object.assign({}, RC_DEFAULT); }
}
function saveRC(rc) { localStorage.setItem("readcfg", JSON.stringify(rc)); }
function applyRC(rc) {
  Reader.fontSize = rc.size; Reader.lineHeight = rc.line; Reader.fontFamily = rc.font; Reader.pause = rc.pause;
  const r = document.documentElement.style;
  if (rc.paper) r.setProperty("--read-paper", rc.paper); else r.removeProperty("--read-paper");
  if (rc.text) r.setProperty("--read-text", rc.text); else r.removeProperty("--read-text");
}

const PAPERS = ["", "#f5ecd7", "#e8f0e0", "#e9e6f0", "#fbe9e7", "#1a1a1a"];
const TEXTS = ["", "#2a2422", "#3a2f1a", "#1f3a2a", "#e8e2d8", "#c9c4bc"];

async function openBook(b) {
  stopReading();
  const meta = await api(`/api/book/${b.id}`).catch(e => { alert(e.message); return null; });
  if (!meta) return;
  Reader.book = meta;
  $("#reader-title").textContent = meta.title;
  applyRC(loadRC());
  if (App.currentVoice) $("#voice-select").value = App.currentVoice;  // 跟随当前选用模型
  if (typeof updateApiBadge === "function") updateApiBadge();
  showOnly("page-reader");
  $all(".nav-btn").forEach(x => x.classList.remove("active"));
  const pg = meta.progress || {};
  const ch = Math.min(pg.chapter || 0, Math.max(0, (meta.chapters.length - 1)));
  await loadChapter(ch, pg.sentence || 0);
  await refreshToc();
}

async function ensureLayout() {
  const probe = document.querySelector("#page-left .pg-inner");
  for (let k = 0; k < 60; k++) {
    if (probe.clientHeight > 40 && probe.clientWidth > 40) return;
    await new Promise(r => requestAnimationFrame(r));
  }
}
async function loadChapter(idx, startSent = 0) {
  Reader.chapterIdx = idx;
  const data = await api(`/api/book/${Reader.book.id}/chapter/${idx}`);
  Reader.sentences = data.sentences;
  Reader.paraStarts = new Set(data.para_starts || []);
  Reader.cur = Math.min(startSent, Math.max(0, data.sentences.length - 1));
  Reader.activeIdx = -1;  // 进入/切章默认不高亮，只定位到所在页
  await ensureLayout();
  paginate();
  renderSpread(Reader.sentences.length ? Math.floor(pageOf(Reader.cur) / 2) : 0);
  markTocCurrent();
  saveProgress();
}

// ----- 分页 -----
function paginate() {
  const probe = document.querySelector("#page-left .pg-inner");
  probe.style.fontSize = Reader.fontSize + "px";
  probe.style.lineHeight = Reader.lineHeight;
  probe.style.fontFamily = Reader.fontFamily;
  const w = probe.clientWidth, h = probe.clientHeight;
  const meas = document.createElement("div");
  Object.assign(meas.style, {
    position: "absolute", visibility: "hidden", left: "-9999px", top: "0",
    width: w + "px", height: h + "px", fontFamily: Reader.fontFamily,
    fontSize: Reader.fontSize + "px", lineHeight: Reader.lineHeight,
    textAlign: "justify", overflow: "hidden", boxSizing: "border-box",
  });
  document.body.appendChild(meas);
  const pages = []; let start = 0;
  for (let i = 0; i < Reader.sentences.length; i++) {
    const isPara = Reader.paraStarts.has(i);
    let br = null;
    if (isPara && i > start) { br = document.createElement("br"); meas.appendChild(br); }
    const span = document.createElement("span");
    span.textContent = Reader.sentences[i];
    if (isPara) span.className = "para-start";
    meas.appendChild(span);
    if (meas.scrollHeight > meas.clientHeight && i > start) {
      if (br) meas.removeChild(br);
      meas.removeChild(span); pages.push([start, i]); start = i;
      meas.innerHTML = ""; meas.appendChild(span);  // 新页首句不加换行
    }
  }
  if (start < Reader.sentences.length) pages.push([start, Reader.sentences.length]);
  document.body.removeChild(meas);
  Reader.pages = pages.length ? pages : [[0, 0]];
}
function pageOf(i) { for (let p = 0; p < Reader.pages.length; p++) if (i >= Reader.pages[p][0] && i < Reader.pages[p][1]) return p; return Reader.pages.length - 1; }

function renderSpread(idx) {
  Reader.spread = idx;
  fillPage("#page-left", Reader.pages[2 * idx], 2 * idx + 1, Reader.pages.length);
  fillPage("#page-right", Reader.pages[2 * idx + 1], 2 * idx + 2, Reader.pages.length);
  // 仅高亮“当前正在听”的那一句；翻页/进入不强制高亮
  if (Reader.activeIdx >= 0) {
    const a = document.querySelector(`#book .sent[data-idx="${Reader.activeIdx}"]`);
    if (a) a.classList.add("active");
  }
}
function fillPage(sel, range, pageNo, total) {
  const inner = document.querySelector(sel + " .pg-inner");
  const numEl = document.querySelector(sel + " .pg-num");
  inner.style.fontSize = Reader.fontSize + "px";
  inner.style.lineHeight = Reader.lineHeight;
  inner.style.fontFamily = Reader.fontFamily;
  inner.innerHTML = "";
  if (!range) { numEl.textContent = ""; return; }
  for (let i = range[0]; i < range[1]; i++) {
    if (Reader.paraStarts.has(i) && i > range[0]) inner.appendChild(document.createElement("br"));
    const span = document.createElement("span");
    span.className = "sent" + (Reader.paraStarts.has(i) ? " para-start" : "");
    span.dataset.idx = i; span.textContent = Reader.sentences[i];
    span.onclick = () => { Reader.cur = i; highlight(i); if (Reader.playing) { stopAudio(); playFrom(i); } };
    inner.appendChild(span);
  }
  numEl.textContent = `${pageNo} / ${total}`;
}
function highlight(i) {
  Reader.activeIdx = i;
  const sp = Math.floor(pageOf(i) / 2);
  if (sp !== Reader.spread) renderSpread(sp);
  $all("#book .sent").forEach(s => s.classList.remove("active"));
  const el = document.querySelector(`#book .sent[data-idx="${i}"]`); if (el) el.classList.add("active");
}
function repaginate() {
  if (!Reader.book || !Reader.sentences.length) return;
  paginate(); renderSpread(Math.floor(pageOf(Reader.cur) / 2)); highlight(Reader.cur);
}
function nextSpread() {
  const total = Math.ceil(Reader.pages.length / 2);
  if (Reader.spread + 1 < total) { Reader.cur = Reader.pages[2 * (Reader.spread + 1)][0]; renderSpread(Reader.spread + 1); saveProgress(); }
  else if (Reader.book && Reader.chapterIdx + 1 < Reader.book.chapters.length) { stopReading(); loadChapter(Reader.chapterIdx + 1, 0); }
}
function prevSpread() {
  if (Reader.spread > 0) { Reader.cur = Reader.pages[2 * (Reader.spread - 1)][0]; renderSpread(Reader.spread - 1); saveProgress(); }
  else if (Reader.chapterIdx > 0) { stopReading(); loadChapter(Reader.chapterIdx - 1, 0); }
}

// ----- 目录 -----
async function refreshToc() {
  if (!Reader.book) return;
  const data = await api("/api/pregen/list").catch(() => ({ items: [] }));
  const ready = new Set(data.items.filter(it => it.bid === Reader.book.id && it.done >= it.total).map(it => it.chapter));
  const box = $("#toc-list"); box.innerHTML = "";
  Reader.book.chapters.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = "toc-item" + (i === Reader.chapterIdx ? " current" : "");
    const ok = ready.has(i);
    item.innerHTML = `<span class="toc-dot" style="background:${ok ? "var(--accent)" : "var(--border)"}"></span>
      <span class="toc-name">${c.title}</span><span class="toc-cnt">${c.count}句</span>`;
    item.onclick = () => { stopReading(); loadChapter(i, 0); $("#toc-drawer").classList.remove("open"); };
    box.appendChild(item);
  });
}
function markTocCurrent() {
  $all("#toc-list .toc-item").forEach((el, i) => el.classList.toggle("current", i === Reader.chapterIdx));
}

// ----- 朗读（预生成优先） -----
async function fetchAudio(i) {
  if (Reader.audioCache.has(i)) return Reader.audioCache.get(i);
  const voice = $("#voice-select").value, speed = $("#speed-select").value;
  if (!voice) throw new Error("没有可用声线，请先在设置里配置/启动语音引擎");
  const purl = `/api/pregen/audio/${Reader.book.id}/${Reader.chapterIdx}/${encodeURIComponent(voice)}/${speed}/${i}`;
  try { const r = await fetch(purl); if (r.ok) { const u = URL.createObjectURL(await r.blob()); Reader.audioCache.set(i, u); return u; } } catch (e) {}
  const res = await api("/api/tts", { method: "POST", raw: true, form: toForm({ text: Reader.sentences[i], voice, speed }) });
  const u = URL.createObjectURL(await res.blob()); Reader.audioCache.set(i, u); return u;
}
async function playFrom(i) {
  if (i >= Reader.sentences.length) {
    if (Reader.chapterIdx + 1 < Reader.book.chapters.length) { await loadChapter(Reader.chapterIdx + 1, 0); return playFrom(0); }
    stopReading(); return;
  }
  Reader.cur = i; Reader.playing = true;
  $("#btn-play").innerHTML = '<i class="fas fa-stop"></i> 停止';
  highlight(i); saveProgress();
  let url; try { url = await fetchAudio(i); } catch (e) { alert("合成失败：" + e.message); stopReading(); return; }
  if (!Reader.playing) return;
  const player = $("#player"); player.src = url;
  if (i + 1 < Reader.sentences.length) fetchAudio(i + 1).catch(() => {});
  player.onended = () => {
    if (!Reader.playing) return;
    const wait = (Reader.pause || 0) * 1000;
    if (wait > 0) Reader._pauseTimer = setTimeout(() => { if (Reader.playing) playFrom(i + 1); }, wait);
    else playFrom(i + 1);
  };
  player.play();
}
function togglePlay() {
  if (Reader.playing) stopReading();
  else playFrom(Reader.cur || 0);
}
function stopAudio() { const p = $("#player"); p.pause(); p.removeAttribute("src"); p.onended = null; }
function stopReading() {
  Reader.playing = false; stopAudio();
  if (Reader._pauseTimer) { clearTimeout(Reader._pauseTimer); Reader._pauseTimer = null; }
  Reader.audioCache.forEach(u => URL.revokeObjectURL(u)); Reader.audioCache.clear();
  Reader.activeIdx = -1; $all("#book .sent.active").forEach(s => s.classList.remove("active"));
  const b = $("#btn-play"); if (b) b.innerHTML = '<i class="fas fa-play"></i> 播放';
}
function clearCache() { Reader.audioCache.forEach(u => URL.revokeObjectURL(u)); Reader.audioCache.clear(); }
function saveProgress() { if (Reader.book) api(`/api/progress/${Reader.book.id}`, { method: "POST", form: toForm({ sentence_index: Reader.cur, chapter_index: Reader.chapterIdx }) }).catch(() => {}); }

// ----- 预生成本章 -----
function resetPregenBtn() {
  const btn = $("#btn-pregen");
  btn.innerHTML = '<i class="fas fa-bolt"></i> 预生成'; btn.style.color = "var(--accent)";
}
async function pregenCurrent() {
  if (!Reader.book) return;
  // 生成中再次点击 = 停止
  if (Reader.pregen) { return stopPregen(); }
  const voice = $("#voice-select").value, speed = $("#speed-select").value;
  if (typeof voiceEngineAlive === "function" && !voiceEngineAlive(voice)) {
    alert(`该声线对应的引擎（${engineOfVoice(voice)}）未启动，请先在设置页启动它`); return;
  }
  const btn = $("#btn-pregen");
  try {
    await api("/api/pregen/start", { method: "POST", form: toForm({ bid: Reader.book.id, chapter: Reader.chapterIdx, voice, speed }) });
    const chTitle = Reader.book.chapters[Reader.chapterIdx].title;
    const ctx = { bid: Reader.book.id, chapter: Reader.chapterIdx, voice, speed };
    ctx.timer = setInterval(async () => {
      const s = await api(`/api/pregen/status?bid=${ctx.bid}&chapter=${ctx.chapter}&voice=${encodeURIComponent(voice)}&speed=${speed}`);
      if (s.state === "running") {
        btn.innerHTML = `<i class="fas fa-stop"></i> 停止 ${s.done || 0}/${s.total || "?"}`; btn.style.color = "var(--danger)";
      }
      if (s.state === "ready" || s.status === "done") {
        clearInterval(ctx.timer); Reader.pregen = null; resetPregenBtn();
        notify("预生成完成 ✅", `《${Reader.book.title}》· ${chTitle} 已生成好，可秒开收听`);
        clearCache(); refreshToc();
      } else if (s.state === "stopped") {
        clearInterval(ctx.timer); Reader.pregen = null; resetPregenBtn(); refreshToc();
      }
    }, 1000);
    Reader.pregen = ctx;
  } catch (e) { alert("预生成失败：" + e.message); }
}
async function stopPregen() {
  const ctx = Reader.pregen; if (!ctx) return;
  try {
    await api("/api/pregen/stop", { method: "POST", form: toForm({ bid: ctx.bid, chapter: ctx.chapter, voice: ctx.voice, speed: ctx.speed }) });
  } catch (e) {}
  if (ctx.timer) clearInterval(ctx.timer);
  Reader.pregen = null; resetPregenBtn(); refreshToc();
}

window.addEventListener("DOMContentLoaded", () => {
  $("#btn-play").onclick = togglePlay;
  $("#btn-pregen").onclick = pregenCurrent;
  $("#btn-prev-page").onclick = prevSpread;
  $("#btn-next-page").onclick = nextSpread;
  $("#voice-select").onchange = () => { stopReading(); if (typeof updateApiBadge === "function") updateApiBadge(); };
  $("#speed-select").onchange = () => stopReading();
  // 目录抽屉（滑动）
  $("#btn-toc").onclick = () => { $("#toc-drawer").classList.toggle("open"); $("#cfg-drawer").classList.remove("open"); refreshToc(); };
  $("#btn-toc-close").onclick = () => $("#toc-drawer").classList.remove("open");
  // 点击抽屉外的空白处自动关闭
  document.addEventListener("click", e => {
    const toc = $("#toc-drawer"), cfg = $("#cfg-drawer");
    if (toc && toc.classList.contains("open") && !toc.contains(e.target) && !$("#btn-toc").contains(e.target))
      toc.classList.remove("open");
    if (cfg && cfg.classList.contains("open") && !cfg.contains(e.target) && !$("#btn-reader-cfg").contains(e.target))
      cfg.classList.remove("open");
  });
  // 个性化抽屉（滑动）
  $("#btn-reader-cfg").onclick = () => { $("#cfg-drawer").classList.toggle("open"); $("#toc-drawer").classList.remove("open"); initRCPanel(); };
  $("#btn-cfg-close").onclick = () => $("#cfg-drawer").classList.remove("open");
  // 个性化控件
  const rc = loadRC();
  $("#rc-font").value = rc.font; $("#rc-size").value = rc.size; $("#rc-size-val").textContent = rc.size;
  $("#rc-line").value = rc.line; $("#rc-line-val").textContent = rc.line;
  $("#rc-pause").value = rc.pause; $("#rc-pause-val").textContent = rc.pause;
  $("#rc-font").onchange = e => { const c = loadRC(); c.font = e.target.value; saveRC(c); applyRC(c); repaginate(); };
  $("#rc-size").oninput = e => { $("#rc-size-val").textContent = e.target.value; const c = loadRC(); c.size = +e.target.value; saveRC(c); applyRC(c); repaginate(); };
  $("#rc-line").oninput = e => { $("#rc-line-val").textContent = e.target.value; const c = loadRC(); c.line = +e.target.value; saveRC(c); applyRC(c); repaginate(); };
  $("#rc-pause").oninput = e => { $("#rc-pause-val").textContent = e.target.value; const c = loadRC(); c.pause = +e.target.value; saveRC(c); applyRC(c); };
  $("#rc-text-custom").onchange = e => { const c = loadRC(); c.text = e.target.value; saveRC(c); applyRC(c); renderRCSwatches(); };

  document.addEventListener("keydown", e => {
    if ($("#page-reader").classList.contains("hidden")) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowRight") nextSpread();
    else if (e.key === "ArrowLeft") prevSpread();
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  });
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (!$("#page-reader").classList.contains("hidden")) repaginate(); }, 250); });
});

function initRCPanel() { renderRCSwatches(); }
function renderRCSwatches() {
  const rc = loadRC();
  const paperBox = $("#rc-paper"); paperBox.innerHTML = "";
  PAPERS.forEach(col => {
    const s = document.createElement("div"); s.className = "swatch" + ((rc.paper || "") === col ? " active" : "");
    s.style.background = col || "var(--paper)"; s.title = col || "默认";
    s.onclick = () => { const c = loadRC(); c.paper = col; saveRC(c); applyRC(c); renderRCSwatches(); };
    paperBox.appendChild(s);
  });
  const textBox = $("#rc-text"); textBox.innerHTML = "";
  TEXTS.forEach(col => {
    const s = document.createElement("div"); s.className = "swatch" + ((rc.text || "") === col ? " active" : "");
    s.style.background = col || "var(--text)"; s.title = col || "默认";
    s.onclick = () => { const c = loadRC(); c.text = col; saveRC(c); applyRC(c); renderRCSwatches(); };
    textBox.appendChild(s);
  });
}
