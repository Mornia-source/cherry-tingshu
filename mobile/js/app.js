"use strict";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ---------------- IndexedDB ---------------- */
const DB = {
  _db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("cherry-tingshu", 1);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "key" });
      };
      r.onsuccess = e => { this._db = e.target.result; res(); };
      r.onerror = e => rej(e.target.error);
    });
  },
  _tx(store, mode) { return this._db.transaction(store, mode).objectStore(store); },
  put(store, val) { return new Promise((res, rej) => { const r = this._tx(store, "readwrite").put(val); r.onsuccess = res; r.onerror = () => rej(r.error); }); },
  get(store, key) { return new Promise((res, rej) => { const r = this._tx(store, "readonly").get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  all(store) { return new Promise((res, rej) => { const r = this._tx(store, "readonly").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  del(store, key) { return new Promise((res, rej) => { const r = this._tx(store, "readwrite").delete(key); r.onsuccess = res; r.onerror = () => rej(r.error); }); },
  async delAudioOf(bookId, count) { for (let i = 0; i < count; i++) await this.del("audio", bookId + ":" + i); },
};

/* ---------------- 导入听书包 ---------------- */
async function importPack(file) {
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch (e) { alert("无法读取该文件，请确认是有效的听书包(.zip)"); return; }
  const mf = zip.file("manifest.json");
  if (!mf) { alert("听书包缺少 manifest.json"); return; }
  let m;
  try { m = JSON.parse(await mf.async("string")); } catch (e) { alert("听书包信息损坏"); return; }
  if (m.format !== "cherry-tingshu-pack-v1") { alert("听书包格式不匹配"); return; }

  const id = "bk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  let coverBlob = null;
  if (m.has_cover && zip.file("cover.png")) {
    try { coverBlob = await zip.file("cover.png").async("blob"); } catch (e) {}
  }
  const audio = m.audio || [];
  let stored = 0;
  for (let i = 0; i < audio.length; i++) {
    if (!audio[i]) continue;
    const af = zip.file(audio[i]);
    if (!af) continue;
    const blob = await af.async("blob");
    await DB.put("audio", { key: id + ":" + i, blob });
    stored++;
  }
  await DB.put("books", {
    id, book: m.book || "未命名", chapter: m.chapter || "", voice: m.voice || "",
    speed: m.speed || 1, sentences: m.sentences || [], para_starts: m.para_starts || [],
    audioCount: audio.length,
    bookId: m.book_id || ("title:" + (m.book || "未命名")),  // 按电子书归类的稳定标识
    chapterIndex: (m.chapter_index != null ? m.chapter_index : 0),
    source: m.source || "", totalChapters: m.total_chapters || 0,
    cover: coverBlob,
    importedAt: Date.now(),
  });
  alert(`导入成功：${m.book} · ${m.chapter}（${stored} 句音频）`);
  renderLibrary();
}

/* ---------------- 书架（按电子书归类，下钻到章节） ---------------- */
const Lib = { mode: "books", bookId: null };
async function renderLibrary() {
  const box = $("#book-list");
  const all = await DB.all("books");
  if (!all.length) {
    Lib.mode = "books"; box.className = "book-list";
    box.innerHTML = `<div class="empty"><svg class="app-logo"><use href="#cherry-logo"></use></svg>
      <p>书架还是空的<br>导入一个听书包开始收听吧</p></div>`;
    return;
  }
  if (Lib.mode === "chapters") return renderChapters(box, all);

  // 一级：按 bookId 归类成“书”，双列网格带封面
  box.className = "book-list";
  const groups = {};
  for (const r of all) (groups[r.bookId] = groups[r.bookId] || []).push(r);
  const books = Object.values(groups).sort((a, b) =>
    Math.max(...b.map(x => x.importedAt)) - Math.max(...a.map(x => x.importedAt)));
  box.innerHTML = "";
  for (const chs of books) {
    const b = chs[0];
    const coverRec = chs.find(x => x.cover);
    const card = document.createElement("div"); card.className = "book-card";
    const coverHtml = coverRec
      ? `<div class="book-cover"><img alt=""></div>`
      : `<div class="book-cover"><span class="ph">${b.book}</span></div>`;
    card.innerHTML = `${coverHtml}<h4>${b.book}</h4>
      <div class="meta">已导入 ${chs.length} 章${b.totalChapters ? " / " + b.totalChapters : ""}</div>`;
    if (coverRec) { const img = card.querySelector("img"); img.src = URL.createObjectURL(coverRec.cover); }
    card.onclick = () => { Lib.mode = "chapters"; Lib.bookId = b.bookId; renderLibrary(); };
    box.appendChild(card);
  }
}
function renderChapters(box, all) {
  const chs = all.filter(r => r.bookId === Lib.bookId)
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
  if (!chs.length) { Lib.mode = "books"; return renderLibrary(); }
  box.className = "book-list chapters";
  const title = chs[0].book;
  box.innerHTML = `<div class="sub-head">
      <button class="icon-btn" id="lib-back"><i class="fas fa-chevron-left"></i></button>
      <span>${title}</span></div>`;
  $("#lib-back").onclick = () => { Lib.mode = "books"; renderLibrary(); };
  for (const c of chs) {
    const card = document.createElement("div"); card.className = "book-card";
    card.innerHTML = `<h4>${c.chapter}</h4>
      <div class="meta">${c.voice} · ${c.speed}× · ${c.sentences.length} 句</div>`;
    card.onclick = () => openBook(c.id);
    box.appendChild(card);
  }
}

/* ---------------- 阅读器（左右翻页 + 排版） ---------------- */
const Reader = { book: null, idx: 0, playing: false, page: 0, pages: 1, colW: 0 };
async function openBook(id) {
  const b = await DB.get("books", id);
  if (!b) return;
  const prog = loadProgress(id);
  Reader.book = b; Reader.idx = prog.idx || 0; Reader.playing = false; Reader.page = prog.page || 0;
  $("#reader-title").textContent = `${b.book} · ${b.chapter}`;
  renderPages(b);
  showView("reader");
  // 等显示与字体就绪后再分页，并跳到上次阅读位置
  requestAnimationFrame(() => requestAnimationFrame(() => {
    layoutPages();
    const p = (prog.page != null && prog.page < Reader.pages) ? prog.page : pageOfSentence(Reader.idx);
    goPage(p);
    setPlayIcon();
  }));
}
// 按段落渲染：para_starts 为每段首句下标
function renderPages(b) {
  const pagesEl = $("#pages"); pagesEl.innerHTML = "";
  const starts = new Set((b.para_starts && b.para_starts.length) ? b.para_starts : [0]);
  let para = null;
  b.sentences.forEach((s, i) => {
    if (starts.has(i) || !para) {
      para = document.createElement("p"); para.className = "para";
      pagesEl.appendChild(para);
    }
    const el = document.createElement("span");
    el.className = "sentence"; el.id = "s" + i; el.textContent = s;
    el.onclick = () => { Reader.idx = i; playCurrent(); };
    para.appendChild(el);
    para.appendChild(document.createTextNode(" "));
  });
}
function layoutPages() {
  const vp = $("#page-viewport"), pagesEl = $("#pages");
  if (!vp.clientWidth) return;
  const cs = getComputedStyle(vp);
  const colW = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  Reader.colW = colW;
  pagesEl.style.transform = "none";
  pagesEl.style.columnWidth = colW + "px";
  Reader.pages = Math.max(1, Math.round(pagesEl.scrollWidth / colW));
  if (Reader.page >= Reader.pages) Reader.page = Reader.pages - 1;
  const sr = $("#scrub-range"); if (sr) sr.max = Reader.pages - 1;
  goPage(Reader.page);
}
function goPage(p) {
  p = Math.max(0, Math.min(p, Reader.pages - 1));
  Reader.page = p;
  $("#pages").style.transform = `translateX(${-p * Reader.colW}px)`;
  $("#page-num").textContent = `${p + 1} / ${Reader.pages}`;
  const sr = $("#scrub-range"); if (sr) sr.value = p;
  const sl = $("#scrub-label"); if (sl) sl.textContent = `${p + 1}/${Reader.pages}`;
}
// 手动翻页：同步“当前句”为该页首句，并保存进度
function turnTo(p) {
  goPage(p);
  Reader.idx = firstSentenceOnPage(Reader.page);
  saveProgress();
}
function nextPage() { turnTo(Reader.page + 1); }
function prevPage() { turnTo(Reader.page - 1); }
function pageOfSentence(i) {
  const el = $("#s" + i);
  if (!el || !Reader.colW) return Reader.page;
  return Math.floor((el.offsetLeft + 2) / Reader.colW);
}
function firstSentenceOnPage(p) {
  const n = Reader.book ? Reader.book.sentences.length : 0;
  for (let i = 0; i < n; i++) if (pageOfSentence(i) === p) return i;
  return Reader.idx;
}
// 保存阅读进度到 localStorage（同步、抗异常退出）
function saveProgress() {
  if (!Reader.book) return;
  try { localStorage.setItem("prog_" + Reader.book.id, JSON.stringify({ idx: Reader.idx, page: Reader.page })); } catch (e) {}
}
function loadProgress(id) {
  try { return JSON.parse(localStorage.getItem("prog_" + id) || "{}"); } catch (e) { return {}; }
}
async function getAudioURL(i) {
  const rec = await DB.get("audio", Reader.book.id + ":" + i);
  if (!rec) return null;
  return URL.createObjectURL(rec.blob);
}
function highlight() {
  $$(".sentence.active").forEach(e => e.classList.remove("active"));
  const el = $("#s" + Reader.idx);
  if (el) {
    el.classList.add("active");
    const pg = pageOfSentence(Reader.idx);
    if (pg !== Reader.page) goPage(pg);   // 当前朗读句不在本页则自动翻过去
  }
  $("#progress").textContent = `${Reader.idx + 1}/${Reader.book.sentences.length}`;
  saveProgress();
}
async function playCurrent() {
  const url = await getAudioURL(Reader.idx);
  highlight();
  const audio = $("#audio");
  if (!url) { // 此句无音频，自动跳到下一句有音频的
    return nextSentence(true);
  }
  audio.src = url;
  audio.playbackRate = Reader.book.speed || 1;
  try { await audio.play(); } catch (e) {}
}
// 按钮图标始终反映 <audio> 真实状态（唯一状态源），避免切页后错乱
function setPlayIcon() {
  const playing = Reader.playing;
  $("#btn-play").innerHTML = `<i class="fas fa-${playing ? "pause" : "play"}"></i>`;
}
function togglePlay() {
  const audio = $("#audio");
  if (!audio.paused) audio.pause();
  else if (audio.src) audio.play();
  else playCurrent();
}
async function nextSentence(auto) {
  let i = Reader.idx + 1;
  const n = Reader.book.sentences.length;
  while (auto && i < n && !(await DB.get("audio", Reader.book.id + ":" + i))) i++;
  if (i >= n) { const a = $("#audio"); a.pause(); a.removeAttribute("src"); return; }
  Reader.idx = i; playCurrent();
}
async function prevSentence() {
  let i = Reader.idx - 1;
  while (i >= 0 && !(await DB.get("audio", Reader.book.id + ":" + i))) i--;
  if (i < 0) i = 0;
  Reader.idx = i; playCurrent();
}
async function deleteCurrentBook() {
  if (!Reader.book || !confirm(`删除《${Reader.book.book}》${Reader.book.chapter}？`)) return;
  await DB.delAudioOf(Reader.book.id, Reader.book.audioCount);
  await DB.del("books", Reader.book.id);
  Reader.book = null; showView("library"); renderLibrary();
}

/* ---------------- 设置 / 主题 ---------------- */
const THEMES = [
  { name: "紫", c1: "#8770e2", c3: "#353460", d: "#6a55c4" },
  { name: "樱", c1: "#e26d8a", c3: "#5a2740", d: "#c4536f" },
  { name: "青", c1: "#3aa6a0", c3: "#1f4f4c", d: "#2f8b86" },
  { name: "橙", c1: "#e0883a", c3: "#5a3a1f", d: "#c4702f" },
  { name: "蓝", c1: "#5b8def", c3: "#26365a", d: "#456fd0" },
];
function applyTheme(t) {
  const r = document.documentElement.style;
  r.setProperty("--primary", t.c1); r.setProperty("--primary-d", t.d);
  r.setProperty("--logo-c1", t.c1); r.setProperty("--logo-c3", t.c3);
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  r.setProperty("--logo-c5", dark
    ? `color-mix(in srgb, ${t.c1} 30%, #17151f)` : `color-mix(in srgb, ${t.c1} 16%, #ffffff)`);
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = t.c1;
  localStorage.setItem("m-theme", t.name);
  $$("#theme-presets .swatch").forEach((s, i) => s.classList.toggle("sel", THEMES[i].name === t.name));
}
function renderThemePresets() {
  const box = $("#theme-presets"); box.innerHTML = "";
  THEMES.forEach(t => {
    const s = document.createElement("div"); s.className = "swatch"; s.style.background = t.c1; s.title = t.name;
    s.onclick = () => applyTheme(t);
    box.appendChild(s);
  });
}
function relayoutIfReading() {
  if (Reader.book && !$("#view-reader").classList.contains("hidden")) {
    layoutPages();
    if (Reader.colW) goPage(pageOfSentence(Reader.idx));
  }
}
function setFont(px) {
  document.documentElement.style.setProperty("--reader-font", px + "px");
  $("#font-val").textContent = px + " px";
  localStorage.setItem("m-font", px);
  relayoutIfReading();
}
function setLineHeight(v) {
  document.documentElement.style.setProperty("--reader-lh", (v / 100).toFixed(2));
  $("#lh-val").textContent = (v / 100).toFixed(1) + " 倍";
  localStorage.setItem("m-lh", v);
  relayoutIfReading();
}
const FONT_FAMILIES = {
  serif: '"Noto Serif SC", "Songti SC", STSong, serif',
  sans: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
};
function setFontFamily(ff) {
  document.documentElement.style.setProperty("--reader-ff", FONT_FAMILIES[ff] || FONT_FAMILIES.serif);
  localStorage.setItem("m-ff", ff);
  $$("#font-family-seg .seg-btn").forEach(b => b.classList.toggle("sel", b.dataset.ff === ff));
  relayoutIfReading();
}
function toggleDark() {
  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") === "dark";
  root.setAttribute("data-theme", dark ? "light" : "dark");
  $("#btn-theme").innerHTML = `<i class="fas fa-${dark ? "moon" : "sun"}"></i>`;
  localStorage.setItem("m-dark", dark ? "0" : "1");
  const cur = THEMES.find(t => t.name === localStorage.getItem("m-theme")) || THEMES[1];
  applyTheme(cur);
}

/* ---------------- 进度拖拽条（展开/收起） ---------------- */
let _scrubTimer = null;
function resetScrubTimer() { clearTimeout(_scrubTimer); _scrubTimer = setTimeout(() => $("#scrubber").classList.remove("open"), 3000); }
function toggleScrub() {
  const s = $("#scrubber");
  if (s.classList.contains("open")) s.classList.remove("open");
  else { s.classList.add("open"); resetScrubTimer(); }
}

/* ---------------- 阅读样式面板 ---------------- */
function openStylePanel() { $("#style-panel").classList.add("open"); $("#style-mask").classList.remove("hidden"); }
function closeStylePanel() { $("#style-panel").classList.remove("open"); $("#style-mask").classList.add("hidden"); }

/* ---------------- 返回上一级 ---------------- */
function goBackLevel() {
  if ($("#style-panel").classList.contains("open")) { closeStylePanel(); return true; }
  if ($("#scrubber").classList.contains("open")) { $("#scrubber").classList.remove("open"); return true; }
  const readerVisible = !$("#view-reader").classList.contains("hidden");
  const settingsVisible = !$("#view-settings").classList.contains("hidden");
  if (readerVisible) { showView("library"); renderLibrary(); return true; }   // 阅读 -> 章节列表
  if (settingsVisible) { Lib.mode = "books"; showView("library"); renderLibrary(); return true; }
  if (Lib.mode === "chapters") { Lib.mode = "books"; renderLibrary(); return true; }  // 章节 -> 书架
  return false;  // 已在书架根层 -> 允许退出
}

/* ---------------- 视图切换 ---------------- */
function showView(v) {
  ["library", "reader", "settings"].forEach(name => $("#view-" + name).classList.toggle("hidden", name !== v));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === v));
  document.body.classList.toggle("reading", v === "reader");  // 阅读时隐藏底部导航
  // 切走阅读器时暂停（onpause 会同步状态/图标）并存进度
  if (v !== "reader") { $("#audio").pause(); saveProgress(); }
  else if (Reader.book) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      relayoutIfReading();   // 重排并定位到当前句所在页
      setPlayIcon();         // 同步播放/暂停按钮
      highlight();           // 高亮当前句并翻到其页
    }));
  }
}

/* ---------------- 初始化 ---------------- */
async function init() {
  await DB.open();
  renderThemePresets();
  // 恢复设置
  if (localStorage.getItem("m-dark") === "1") { document.documentElement.setAttribute("data-theme", "dark"); $("#btn-theme").innerHTML = '<i class="fas fa-sun"></i>'; }
  applyTheme(THEMES.find(t => t.name === localStorage.getItem("m-theme")) || THEMES[1]);  // 默认粉色(樱)
  const font = +(localStorage.getItem("m-font") || 19); $("#font-range").value = font; setFont(font);
  const lh = +(localStorage.getItem("m-lh") || 200); $("#lh-range").value = lh; setLineHeight(lh);
  setFontFamily(localStorage.getItem("m-ff") || "serif");
  await renderLibrary();

  // 事件
  $("#import-input").onchange = e => { if (e.target.files[0]) importPack(e.target.files[0]); e.target.value = ""; };
  $("#btn-theme").onclick = toggleDark;
  $("#btn-back").onclick = () => { showView("library"); };
  $("#btn-del-book").onclick = deleteCurrentBook;
  $("#btn-play").onclick = togglePlay;
  $("#btn-next").onclick = () => nextSentence(false);
  $("#btn-prev").onclick = prevSentence;
  const audio = $("#audio");
  audio.onended = () => nextSentence(true);
  audio.onplay = () => { Reader.playing = true; setPlayIcon(); };
  audio.onpause = () => { Reader.playing = false; setPlayIcon(); };
  $("#font-range").oninput = e => setFont(+e.target.value);
  $("#lh-range").oninput = e => setLineHeight(+e.target.value);
  $$("#font-family-seg .seg-btn").forEach(b => b.onclick = () => setFontFamily(b.dataset.ff));
  $$(".tab").forEach(t => t.onclick = () => showView(t.dataset.view));

  // 左右滑动翻页
  const vp = $("#page-viewport");
  let sx = 0, sy = 0, st = 0;
  vp.addEventListener("touchstart", e => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
  vp.addEventListener("touchend", e => {
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 600) {
      if (dx < 0) nextPage(); else prevPage();
    }
  }, { passive: true });
  // 阅读样式面板
  $("#btn-style").onclick = openStylePanel;
  $("#btn-style-close").onclick = closeStylePanel;
  $("#style-mask").onclick = closeStylePanel;

  // 进度拖拽条：点页码展开/收起，拖动预览，松手跳转
  $("#page-num").onclick = toggleScrub;
  const sr = $("#scrub-range");
  sr.oninput = e => { goPage(+e.target.value); resetScrubTimer(); };
  sr.onchange = e => { turnTo(+e.target.value); resetScrubTimer(); };

  // 退出/切后台时保存进度
  window.addEventListener("pagehide", saveProgress);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveProgress(); });

  // 屏幕旋转 / 尺寸变化时重新分页
  window.addEventListener("resize", () => relayoutIfReading());

  // Android 硬件返回键：返回上一级，根层才退出
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp) {
    CapApp.addListener("backButton", () => { if (!goBackLevel()) CapApp.exitApp(); });
  }

  // 不再使用 Service Worker（APK 内是本地资源，无需缓存；旧 SW 会喂旧版页面）。
  // 注销任何遗留的 SW，避免更新不生效。
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  }
}
init();
