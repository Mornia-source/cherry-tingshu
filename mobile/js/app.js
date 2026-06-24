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
    speed: m.speed || 1, sentences: m.sentences || [], audioCount: audio.length,
    importedAt: Date.now(),
  });
  alert(`导入成功：${m.book} · ${m.chapter}（${stored} 句音频）`);
  renderLibrary();
}

/* ---------------- 书架 ---------------- */
async function renderLibrary() {
  const box = $("#book-list");
  const books = (await DB.all("books")).sort((a, b) => b.importedAt - a.importedAt);
  if (!books.length) {
    box.innerHTML = `<div class="empty"><svg class="app-logo"><use href="#cherry-logo"></use></svg>
      <p>书架还是空的<br>导入一个听书包开始收听吧</p></div>`;
    return;
  }
  box.innerHTML = "";
  for (const b of books) {
    const card = document.createElement("div"); card.className = "book-card";
    card.innerHTML = `<h4>${b.book}</h4>
      <div class="meta">${b.chapter} · ${b.voice} · ${b.speed}× · ${b.sentences.length} 句</div>`;
    card.onclick = () => openBook(b.id);
    box.appendChild(card);
  }
}

/* ---------------- 阅读器 ---------------- */
const Reader = { book: null, idx: 0, playing: false };
async function openBook(id) {
  const b = await DB.get("books", id);
  if (!b) return;
  Reader.book = b; Reader.idx = 0; Reader.playing = false;
  $("#reader-title").textContent = `${b.book} · ${b.chapter}`;
  const box = $("#sentences"); box.innerHTML = "";
  b.sentences.forEach((s, i) => {
    const el = document.createElement("span");
    el.className = "sentence" + (b.audioCount && !audioMissing(b, i) ? "" : " noaudio");
    el.id = "s" + i; el.textContent = s + " ";
    el.onclick = () => { Reader.idx = i; playCurrent(); };
    box.appendChild(el);
  });
  showView("reader");
  highlight();
}
function audioMissing() { return false; } // 占位：缺音频的句子在播放时跳过
async function getAudioURL(i) {
  const rec = await DB.get("audio", Reader.book.id + ":" + i);
  if (!rec) return null;
  return URL.createObjectURL(rec.blob);
}
function highlight() {
  $$(".sentence.active").forEach(e => e.classList.remove("active"));
  const el = $("#s" + Reader.idx);
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  $("#progress").textContent = `${Reader.idx + 1}/${Reader.book.sentences.length}`;
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
  try { await audio.play(); Reader.playing = true; setPlayIcon(); } catch (e) {}
}
function setPlayIcon() { $("#btn-play").innerHTML = `<i class="fas fa-${Reader.playing ? "pause" : "play"}"></i>`; }
function togglePlay() {
  const audio = $("#audio");
  if (Reader.playing) { audio.pause(); Reader.playing = false; setPlayIcon(); }
  else if (audio.src) { audio.play(); Reader.playing = true; setPlayIcon(); }
  else playCurrent();
}
async function nextSentence(auto) {
  let i = Reader.idx + 1;
  const n = Reader.book.sentences.length;
  while (auto && i < n && !(await DB.get("audio", Reader.book.id + ":" + i))) i++;
  if (i >= n) { Reader.playing = false; setPlayIcon(); $("#audio").removeAttribute("src"); return; }
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
function setFont(px) {
  document.documentElement.style.setProperty("--reader-font", px + "px");
  $("#font-val").textContent = px + " px";
  localStorage.setItem("m-font", px);
}
function toggleDark() {
  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") === "dark";
  root.setAttribute("data-theme", dark ? "light" : "dark");
  $("#btn-theme").innerHTML = `<i class="fas fa-${dark ? "moon" : "sun"}"></i>`;
  localStorage.setItem("m-dark", dark ? "0" : "1");
  const cur = THEMES.find(t => t.name === localStorage.getItem("m-theme")) || THEMES[0];
  applyTheme(cur);
}

/* ---------------- 视图切换 ---------------- */
function showView(v) {
  ["library", "reader", "settings"].forEach(name => $("#view-" + name).classList.toggle("hidden", name !== v));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === v));
  // 阅读器有自己的底部播放条，切走时停止播放
  if (v !== "reader") { const a = $("#audio"); a.pause(); Reader.playing = false; }
}

/* ---------------- 初始化 ---------------- */
async function init() {
  await DB.open();
  renderThemePresets();
  // 恢复设置
  if (localStorage.getItem("m-dark") === "1") { document.documentElement.setAttribute("data-theme", "dark"); $("#btn-theme").innerHTML = '<i class="fas fa-sun"></i>'; }
  applyTheme(THEMES.find(t => t.name === localStorage.getItem("m-theme")) || THEMES[0]);
  const font = +(localStorage.getItem("m-font") || 19); $("#font-range").value = font; setFont(font);
  await renderLibrary();

  // 事件
  $("#import-input").onchange = e => { if (e.target.files[0]) importPack(e.target.files[0]); e.target.value = ""; };
  $("#btn-theme").onclick = toggleDark;
  $("#btn-back").onclick = () => { showView("library"); };
  $("#btn-del-book").onclick = deleteCurrentBook;
  $("#btn-play").onclick = togglePlay;
  $("#btn-next").onclick = () => nextSentence(false);
  $("#btn-prev").onclick = prevSentence;
  $("#audio").onended = () => nextSentence(true);
  $("#font-range").oninput = e => setFont(+e.target.value);
  $$(".tab").forEach(t => t.onclick = () => showView(t.dataset.view));

  // 注册 service worker（离线）
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
