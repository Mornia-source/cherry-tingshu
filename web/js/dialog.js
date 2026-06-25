// 自定义弹窗（替代浏览器 alert/confirm/prompt），支持表单与条件字段。
const Dlg = (() => {
  let root, resolver = null;
  function ensure() {
    if (root) return root;
    root = document.createElement("div");
    root.className = "dlg-overlay hidden";
    root.innerHTML = `<div class="dlg-card">
      <div class="dlg-title"></div>
      <div class="dlg-body"></div>
      <div class="dlg-foot"></div>
    </div>`;
    document.body.appendChild(root);
    root.addEventListener("click", e => { if (e.target === root) close(null); });
    return root;
  }
  function open(title, bodyNode, buttons) {
    ensure();
    root.querySelector(".dlg-title").textContent = title || "";
    const body = root.querySelector(".dlg-body"); body.innerHTML = ""; if (bodyNode) body.appendChild(bodyNode);
    const foot = root.querySelector(".dlg-foot"); foot.innerHTML = "";
    buttons.forEach(b => {
      const btn = document.createElement("button");
      btn.className = "btn " + (b.cls || "");
      btn.innerHTML = b.label;
      btn.onclick = b.onClick;
      foot.appendChild(btn);
    });
    root.classList.remove("hidden");
    return new Promise(res => { resolver = res; });
  }
  function close(val) { if (root) root.classList.add("hidden"); const r = resolver; resolver = null; if (r) r(val); }

  function alert(msg, o = {}) {
    const p = document.createElement("div"); p.className = "dlg-msg"; p.textContent = msg;
    return open(o.title || "提示", p, [{ label: o.okText || "知道了", cls: "primary", onClick: () => close() }]);
  }
  function confirm(msg, o = {}) {
    const p = document.createElement("div"); p.className = "dlg-msg"; p.textContent = msg;
    return open(o.title || "确认", p, [
      { label: o.cancelText || "取消", onClick: () => close(false) },
      { label: o.okText || "确定", cls: o.danger ? "danger" : "primary", onClick: () => close(true) },
    ]);
  }
  function prompt(msg, o = {}) {
    const wrap = document.createElement("div");
    const lbl = document.createElement("div"); lbl.className = "dlg-msg"; lbl.textContent = msg; wrap.appendChild(lbl);
    const inp = document.createElement("input"); inp.className = "input"; inp.value = o.value || ""; inp.placeholder = o.placeholder || ""; wrap.appendChild(inp);
    setTimeout(() => inp.focus(), 50);
    return open(o.title || "输入", wrap, [
      { label: "取消", onClick: () => close(null) },
      { label: o.okText || "确定", cls: "primary", onClick: () => close(inp.value) },
    ]);
  }
  // o.fields: [{key,label,type:'text'|'textarea'|'select',value,options,placeholder,hint,show(values)}]
  function form(o) {
    const wrap = document.createElement("div"); wrap.className = "dlg-form";
    const ctrls = {};
    o.fields.forEach(f => {
      const row = document.createElement("div"); row.className = "dlg-field"; row.dataset.key = f.key;
      const lab = document.createElement("label"); lab.textContent = f.label; row.appendChild(lab);
      let c;
      if (f.type === "select") {
        c = document.createElement("select"); c.className = "select";
        (f.options || []).forEach(op => { const o2 = document.createElement("option"); o2.value = op.value; o2.textContent = op.label; c.appendChild(o2); });
        c.value = f.value || "";
      } else if (f.type === "textarea") {
        c = document.createElement("textarea"); c.className = "input"; c.rows = 2; c.value = f.value || ""; c.placeholder = f.placeholder || "";
      } else {
        c = document.createElement("input"); c.className = "input"; c.value = f.value || ""; c.placeholder = f.placeholder || "";
      }
      row.appendChild(c);
      if (f.hint) { const h = document.createElement("div"); h.className = "hint"; h.textContent = f.hint; row.appendChild(h); }
      wrap.appendChild(row); ctrls[f.key] = c;
    });
    const vals = () => { const v = {}; o.fields.forEach(f => v[f.key] = ctrls[f.key].value.trim()); return v; };
    const refresh = () => o.fields.forEach(f => {
      if (f.show) wrap.querySelector(`[data-key="${f.key}"]`).style.display = f.show(vals()) ? "" : "none";
    });
    wrap.addEventListener("input", refresh); wrap.addEventListener("change", refresh); refresh();
    return open(o.title || "编辑", wrap, [
      { label: "取消", onClick: () => close(null) },
      { label: o.okText || "保存", cls: "primary", onClick: () => close(vals()) },
    ]);
  }
  return { alert, confirm, prompt, form };
})();
