// ========== 全局状态与工具 ==========
const App = { token: localStorage.getItem("token") || null, user: null, books: [], voices: [], apiAlive: false };
function $(s) { return document.querySelector(s); }
function $all(s) { return document.querySelectorAll(s); }

async function api(path, { method = "GET", form = null, raw = false } = {}) {
  const opt = { method, headers: {} };
  if (App.token) opt.headers["Authorization"] = App.token;
  if (form) opt.body = form;
  const res = await fetch(path, opt);
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).detail || m; } catch (e) {} throw new Error(m); }
  return raw ? res : res.json();
}
function toForm(obj) { const f = new FormData(); for (const k in obj) f.append(k, obj[k]); return f; }

// ========== 通知 ==========
function notify(title, body) {
  try {
    if (window.Notification && Notification.permission === "granted") new Notification(title, { body });
    else console.log("[通知]", title, body);
  } catch (e) {}
}

// ========== 主题（明暗 + 主色） ==========
const ACCENTS = [
  { name: "樱桃红", primary: "#c0392b", d: "#a5281c", soft: "#f7e4e1", softD: "#3a2420" },
  { name: "靛蓝", primary: "#2d6cdf", d: "#2055bd", soft: "#e2ebfb", softD: "#1d2740" },
  { name: "墨绿", primary: "#2e8b6f", d: "#236f59", soft: "#def0ea", softD: "#1c3329" },
  { name: "紫罗兰", primary: "#7c5cd6", d: "#6446c0", soft: "#ece4fa", softD: "#2a2340" },
  { name: "暖橙", primary: "#e07b39", d: "#c5642a", soft: "#fbe9da", softD: "#3a2a1c" },
  { name: "玫瑰粉", primary: "#dc5a8e", d: "#c44676", soft: "#fbe3ed", softD: "#3a2230" },
  { name: "石墨", primary: "#5a5550", d: "#433f3b", soft: "#ece8e4", softD: "#33302c" },
];
function applyAccent(a) {
  const r = document.documentElement.style, p = a.primary;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  r.setProperty("--primary", p);
  r.setProperty("--primary-d", a.d);
  if (dark) {
    r.setProperty("--bg", `color-mix(in srgb, ${p} 10%, #15120f)`);
    r.setProperty("--surface", `color-mix(in srgb, ${p} 8%, #1e1a17)`);
    r.setProperty("--surface-2", `color-mix(in srgb, ${p} 15%, #241f1d)`);
    r.setProperty("--primary-soft", `color-mix(in srgb, ${p} 26%, #1b1816)`);
    r.setProperty("--border", `color-mix(in srgb, ${p} 16%, #38312b)`);
  } else {
    r.setProperty("--bg", `color-mix(in srgb, ${p} 6%, #ffffff)`);
    r.setProperty("--surface", "#ffffff");
    r.setProperty("--surface-2", `color-mix(in srgb, ${p} 9%, #ffffff)`);
    r.setProperty("--primary-soft", `color-mix(in srgb, ${p} 13%, #ffffff)`);
    r.setProperty("--border", `color-mix(in srgb, ${p} 13%, #e6ddd5)`);
  }
  // LOGO 三个主体色跟随主题：c1=主色，c3=深色描边，c5=浅色衬底
  r.setProperty("--logo-c1", p);
  r.setProperty("--logo-c3", a.d);
  r.setProperty("--logo-c5", dark
    ? `color-mix(in srgb, ${p} 30%, #1b1816)`
    : `color-mix(in srgb, ${p} 16%, #ffffff)`);
  localStorage.setItem("accent", a.name);
}
function currentAccent() { return ACCENTS.find(a => a.name === localStorage.getItem("accent")) || ACCENTS[0]; }
function renderAccentSwatches() {
  const box = $("#accent-swatches"); if (!box) return;
  box.innerHTML = "";
  const cur = currentAccent().name;
  ACCENTS.forEach(a => {
    const s = document.createElement("div");
    s.className = "swatch" + (a.name === cur ? " active" : "");
    s.style.background = a.primary; s.title = a.name;
    s.onclick = () => { applyAccent(a); renderAccentSwatches(); };
    box.appendChild(s);
  });
}
function initTheme() {
  const saved = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeIcon(saved);
  applyAccent(currentAccent());
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeIcon(next);
  applyAccent(currentAccent());
  if (typeof repaginate === "function" && !$("#page-reader").classList.contains("hidden")) repaginate();
}
function updateThemeIcon(t) { $("#btn-theme").innerHTML = t === "dark" ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>'; }

// ========== 账号 ==========
async function doAuth(kind) {
  const username = $("#username").value.trim(), password = $("#password").value;
  const msg = $("#auth-msg"); msg.className = "msg";
  try {
    const data = await api(`/api/${kind}`, { method: "POST", form: toForm({ username, password }) });
    App.token = data.token; localStorage.setItem("token", data.token);
    await enterApp();
  } catch (e) { msg.className = "msg error"; msg.textContent = e.message; }
}
async function enterApp() {
  App.user = await api("/api/me");
  $("#me-name").innerHTML = App.user.username + (App.user.is_admin ? ' <i class="fas fa-crown" style="color:var(--primary)" title="管理员"></i>' : "");
  applyMeAvatar();
  $("#nav-admin").classList.toggle("hidden", !App.user.is_admin);
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  if (window.Notification && Notification.permission === "default") Notification.requestPermission();
  await loadVoices();
  await loadShelf();
}
function applyMeAvatar() {
  const img = $("#me-avatar"), ph = $("#me-avatar-ph");
  if (App.user.avatar) { img.src = App.user.avatar + "?t=" + Date.now(); img.hidden = false; ph.style.display = "none"; }
  else { img.hidden = true; ph.style.display = ""; }
}
async function uploadAvatar(file) {
  const f = new FormData(); f.append("file", file);
  try {
    const r = await api("/api/avatar", { method: "POST", form: f });
    App.user.avatar = r.avatar; applyMeAvatar(); loadProfile();
  } catch (e) { alert("上传失败：" + e.message); }
}
function loadProfile() {
  if (!App.user) return;
  $("#profile-name").innerHTML = App.user.username + (App.user.is_admin ? ' <i class="fas fa-crown" style="color:var(--primary)"></i>' : "");
  $("#profile-uid").textContent = App.user.uid || "";
  const g = $("#profile-group"); if (g) g.textContent = "权限：" + (App.user.is_admin ? "管理员" : "普通用户");
  const img = $("#profile-avatar"), ph = $("#profile-avatar-ph");
  if (App.user.avatar) { img.src = App.user.avatar + "?t=" + Date.now(); img.hidden = false; ph.style.display = "none"; }
  else { img.hidden = true; ph.style.display = ""; ph.textContent = (App.user.username || "?")[0].toUpperCase(); }
}

async function logout() {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  App.token = null; localStorage.removeItem("token");
  $("#app-view").classList.add("hidden"); $("#auth-view").classList.remove("hidden");
}

// ========== 导航 ==========
function showOnly(id) {
  const pages = ["page-shelf", "page-reader", "page-train", "page-settings", "page-admin", "page-profile"];
  const cur = pages.find(p => !$("#" + p).classList.contains("hidden"));
  if (cur === id) return;
  const nw = $("#" + id);
  const reveal = () => { nw.classList.remove("hidden"); nw.classList.add("entering"); setTimeout(() => nw.classList.remove("entering"), 320); };
  if (cur) {
    const old = $("#" + cur); old.classList.add("leaving");
    setTimeout(() => { old.classList.add("hidden"); old.classList.remove("leaving"); reveal(); }, 175);
  } else reveal();
}
function switchPage(page) {
  if (typeof stopReading === "function") stopReading();
  $all(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  if (page === "shelf") showOnly("page-shelf");
  else if (page === "train") { showOnly("page-train"); loadTrain(); }
  else if (page === "settings") { showOnly("page-settings"); loadSettings(); }
  else if (page === "admin") { showOnly("page-admin"); loadUsers(); loadPregenAdmin(); }
  else if (page === "profile") { showOnly("page-profile"); loadProfile(); }
}

// ========== 书架 ==========
const TRAIN_BADGE = {
  running: { t: "训练中", c: "#e07b39", i: "fa-spinner fa-spin" },
  done: { t: "已训练", c: "#2e8b6f", i: "fa-circle-check" },
  partial: { t: "部分训练", c: "#2d6cdf", i: "fa-adjust" },
  none: { t: "未训练", c: "#9a938c", i: "fa-circle" },
};
async function loadShelf() {
  const data = await api("/api/books"); App.books = data.books;
  const status = await api("/api/books/status").catch(() => ({}));
  const grid = $("#shelf-grid"); grid.innerHTML = "";
  if (!App.books.length) { grid.innerHTML = '<p class="hint">书架空空如也，点右上角「导入书籍」，或把文件放进 ebook 文件夹后刷新。</p>'; return; }
  for (const b of App.books) {
    const card = document.createElement("div"); card.className = "book-card";
    const cover = b.cover ? `<img src="${b.cover}" alt="">` : `<div class="ph"><i class="fas fa-book"></i></div>`;
    const st = status[b.id] || {};
    const state = (typeof st === "string") ? st : (st.state || "none");
    const pct = (typeof st === "object" && st.percent != null) ? st.percent : null;
    const bd = TRAIN_BADGE[state] || TRAIN_BADGE.none;
    const label = state === "partial" && pct != null ? `${bd.t} ${pct}%` : bd.t;
    const badge = `<div class="train-badge" style="background:${bd.c}" title="预生成状态：${label}"><i class="fas ${bd.i}"></i> ${label}</div>`;
    const del = `<button class="book-del" title="删除此书"><i class="fas fa-trash"></i></button>`;
    card.innerHTML = `<div class="book-cover">${cover}${badge}${del}</div><div class="book-info"><div class="t" title="${b.title}">${b.title}</div><div class="f"><span class="fmt-tag">${b.format}</span></div></div>`;
    card.querySelector(".book-cover img, .book-cover .ph").onclick = () => openBook(b);
    card.querySelector(".book-info").onclick = () => openBook(b);
    card.querySelector(".book-del").onclick = (e) => { e.stopPropagation(); deleteBook(b); };
    grid.appendChild(card);
  }
}
async function deleteBook(b) {
  if (!confirm(`确认删除《${b.title}》？\n将一并删除其封面与已预生成的语音。`)) return;
  try { await api("/api/books/delete", { method: "POST", form: toForm({ bid: b.id }) }); await loadShelf(); }
  catch (e) { alert("删除失败：" + e.message); }
}
async function loadVoices() {
  try {
    const data = await api("/api/voices");
    App.voices = data.voices; App.apiAlive = data.api_alive;
    App.engines = data.engines || {};
    App.currentVoice = data.current;
    const opts = App.voices.map(v => `<option value="${v.name}">${v.name}</option>`).join("");
    ["#voice-select", "#pg-voice"].forEach(sel => { if ($(sel)) $(sel).innerHTML = opts; });
    // 朗读声线默认跟随“当前选用模型”
    if (data.current && $("#voice-select")) $("#voice-select").value = data.current;
    updateApiBadge();
  } catch (e) {}
}
const ENGINE_NAME = { "gpt-sovits": "GPT-SoVITS", "indextts": "IndexTTS" };
// 某声线对应的引擎是否在线（IndexTTS 声线只看 IndexTTS）
function engineOfVoice(name) {
  const v = (App.voices || []).find(x => x.name === name);
  return v ? (v.engine || "gpt-sovits") : "gpt-sovits";
}
function voiceEngineAlive(name) {
  const eng = engineOfVoice(name);
  return !!(App.engines && App.engines[eng] && App.engines[eng].alive);
}
// 全局 banner 跟随当前阅读所选声线的引擎状态
function updateApiBadge() {
  const badge = $("#api-badge"); if (!badge) return;
  const sel = $("#voice-select");
  const name = (sel && sel.value) || App.currentVoice || (App.voices[0] && App.voices[0].name);
  const eng = engineOfVoice(name);
  const alive = voiceEngineAlive(name);
  const label = ENGINE_NAME[eng] || eng;
  badge.className = "badge " + (alive ? "on" : "off");
  badge.innerHTML = `<i class="fas fa-circle"></i> ${label}`;
  badge.title = alive ? `${label} 在线` : `${label} 离线（请在设置页启动该引擎）`;
}
async function uploadFiles(files) {
  for (const file of files) { const f = new FormData(); f.append("file", file); try { await api("/api/upload", { method: "POST", form: f }); } catch (e) { alert("导入失败：" + e.message); } }
  await loadShelf();
}

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  $("#btn-login").onclick = () => doAuth("login");
  $("#btn-register").onclick = () => doAuth("register");
  $("#password").addEventListener("keydown", e => { if (e.key === "Enter") doAuth("login"); });
  $("#btn-theme").onclick = toggleTheme;
  $("#btn-logout").onclick = logout;
  $("#btn-refresh").onclick = loadShelf;
  $("#upload-input").onchange = e => uploadFiles(e.target.files);
  $("#avatar-input").onchange = e => { if (e.target.files[0]) uploadAvatar(e.target.files[0]); };
  $("#me-area").onclick = () => switchPage("profile");
  $all(".nav-btn").forEach(b => b.onclick = () => switchPage(b.dataset.page));
  $("#btn-back-shelf").onclick = () => switchPage("shelf");
  if (App.token) { try { await enterApp(); } catch (e) { App.token = null; localStorage.removeItem("token"); } }
});
