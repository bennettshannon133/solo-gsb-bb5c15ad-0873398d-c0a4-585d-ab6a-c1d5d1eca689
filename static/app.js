/* 法规条款变更审阅 —— 原生 JS 单页前端 */
"use strict";

const TYPE_LABEL = {
  unchanged: "未变更", rewrite: "改写", added: "新增", deleted: "删除",
  split: "拆分", merged: "合并", multi_rewrite: "多段改写",
};
const DECISION_LABEL = {
  pending: "待审阅", confirmed: "确认", disputed: "有异议", ignored: "忽略",
};
const CITE_STATUS_LABEL = { ok: "正常", missing: "缺失", ambiguous: "歧义" };
const MIG_STATUS_LABEL = { migrated: "已迁移", suspected: "疑似错指", review: "待核验" };
const OBL_VERDICT_LABEL = {
  added: "新增", removed: "移除", strengthened: "加强", weakened: "弱化",
  forbid_relaxed: "禁止放宽", changed: "内容变化", unchanged: "未变化", review: "待核验",
};
const MODAL_LABEL_JS = { shall: "应当", must: "必须", forbid: "不得", may: "可以" };

const state = {
  view: "list",           // list | upload | workspace
  tab: "align",           // align | citations | migrations | obligations
  doc: null,              // 当前文档详情
  cit: null,              // 引用检查数据 {check, items, new_paragraphs, ref_type_labels}
  citStatus: "",          // 引用检查状态筛选 ok|missing|ambiguous
  citType: "",            // 引用类型筛选
  citKw: "",              // 引用关键字
  mig: null,              // 引用迁移核验数据
  migStatus: "",          // 迁移三态筛选 migrated|suspected|review
  migType: "",            // 迁移引用类型筛选
  migKw: "",              // 迁移关键字
  obl: null,              // 责任矩阵数据
  oblVerdict: "",         // 责任判定筛选
  oblModal: "",           // 情态筛选
  oblKw: "",              // 责任矩阵关键字
  filterType: "",         // 变更类型筛选
  filterDecision: "",     // 决定筛选
  search: "",
};

const $app = document.getElementById("app");

// ---------------- 工具 ----------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg, isErr = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `请求失败 (${res.status})`);
  return data;
}

function fmtTime(s) {
  return s ? s.replace("T", " ").slice(0, 16) : "";
}

// ---------------- 视图：文档列表 ----------------

async function renderList() {
  state.view = "list";
  document.getElementById("nav-list").classList.add("active");
  document.getElementById("nav-upload").classList.remove("active");
  $app.innerHTML = "";

  let docs = [];
  try { docs = await api("/api/documents"); } catch (e) { toast(e.message, true); }

  $app.append(
    h("div", { class: "panel" },
      h("h2", {}, "审阅文档"),
      docs.length === 0
        ? h("div", { class: "empty" },
            h("p", {}, "还没有审阅任务"),
            h("button", { class: "btn primary", onclick: renderUpload }, "＋ 上传旧版 / 新版文本，开始审阅"))
        : docs.map(d => h("div", {
            class: "doc-item",
            onclick: () => openDoc(d.id),
          },
            h("div", {},
              h("h3", {}, d.title),
              h("div", { class: "doc-meta" },
                h("span", {}, `旧版 ${d.n_old} 段`),
                h("span", {}, `新版 ${d.n_new} 段`),
                h("span", {}, `对齐 ${d.n_align} 条`),
                h("span", {}, `已审阅 ${d.n_reviewed}/${d.n_align}`),
                d.n_cit_issues > 0
                  ? h("span", { class: "cit-warn" }, `⚠ 引用问题 ${d.n_cit_issues}/${d.n_cit_total}`)
                  : (d.n_cit_total > 0 ? h("span", { class: "cit-ok" }, `引用检查 ${d.n_cit_total} 项无误`) : null),
                h("span", {}, `创建于 ${fmtTime(d.created_at)}`))),
            h("button", {
              class: "btn danger sm",
              onclick: async (e) => {
                e.stopPropagation();
                if (!confirm(`确定删除「${d.title}」及其全部审阅记录？`)) return;
                try { await api(`/api/documents/${d.id}`, { method: "DELETE" }); toast("已删除"); renderList(); }
                catch (err) { toast(err.message, true); }
              },
            }, "删除")))),
  );
}

// ---------------- 视图：上传 ----------------

function renderUpload() {
  state.view = "upload";
  document.getElementById("nav-list").classList.remove("active");
  document.getElementById("nav-upload").classList.add("active");
  $app.innerHTML = "";

  const titleEl = h("input", { type: "text", placeholder: "例如：员工手册 2024 → 2025" });
  const oldEl = h("textarea", { placeholder: "粘贴旧版法规/制度全文（纯文本，段落之间建议空行分隔）……" });
  const newEl = h("textarea", { placeholder: "粘贴新版法规/制度全文（纯文本，段落之间建议空行分隔）……" });

  $app.append(
    h("div", { class: "panel" },
      h("h2", {}, "新建审阅任务"),
      h("label", { class: "field" }, "文档名称"),
      titleEl,
      h("div", { class: "grid-2", style: "margin-top:16px" },
        h("div", {},
          h("label", { class: "field" }, "旧版文本"),
          oldEl,
          h("div", { class: "hint" }, "按空行分块；“第一条 / 1. / （一）”等编号会自动识别为段落边界")),
        h("div", {},
          h("label", { class: "field" }, "新版文本"),
          newEl,
          h("div", { class: "hint" }, "系统按段落顺序 + 字符串相似度生成对齐候选，并给出变更类型与置信度"))),
      h("div", { class: "actions" },
        h("button", {
          class: "btn primary",
          onclick: async () => {
            const title = titleEl.value.trim();
            if (!title) return toast("请填写文档名称", true);
            if (!oldEl.value.trim() && !newEl.value.trim()) return toast("旧版与新版不能同时为空", true);
            try {
              const r = await api("/api/documents", {
                method: "POST",
                body: JSON.stringify({ title, old_text: oldEl.value, new_text: newEl.value }),
              });
              toast(`已生成 ${r.aligned} 条对齐候选`);
              openDoc(r.id);
            } catch (e) { toast(e.message, true); }
          },
        }, "生成对齐候选"),
        h("button", {
          class: "btn",
          onclick: () => {
            titleEl.value = "示例：考勤制度 v1 → v2";
            oldEl.value = DEMO_OLD;
            newEl.value = DEMO_NEW;
          },
        }, "填入示例文本"))))
}

// ---------------- 视图：审阅工作区 ----------------

async function openDoc(id) {
  try {
    state.doc = await api(`/api/documents/${id}`);
  } catch (e) { return toast(e.message, true); }
  state.tab = "align";
  state.cit = null;
  state.citStatus = "";
  state.citType = "";
  state.citKw = "";
  state.mig = null;
  state.migStatus = "";
  state.migType = "";
  state.migKw = "";
  state.obl = null;
  state.oblVerdict = "";
  state.oblModal = "";
  state.oblKw = "";
  state.filterType = "";
  state.filterDecision = "";
  state.search = "";
  state.view = "workspace";
  document.getElementById("nav-list").classList.remove("active");
  document.getElementById("nav-upload").classList.remove("active");
  renderWorkspace();
}

function typeCounts() {
  const c = {};
  for (const a of state.doc.alignments) c[a.change_type] = (c[a.change_type] || 0) + 1;
  return c;
}

async function loadCitations() {
  try {
    state.cit = await api(`/api/documents/${state.doc.id}/citations`);
  } catch (e) { toast(e.message, true); state.cit = null; }
}

async function loadMigrations() {
  try {
    state.mig = await api(`/api/documents/${state.doc.id}/citation-migrations`);
  } catch (e) { toast(e.message, true); state.mig = null; }
}

async function loadObligations() {
  try {
    state.obl = await api(`/api/documents/${state.doc.id}/obligations`);
  } catch (e) { toast(e.message, true); state.obl = null; }
}

async function switchTab(tab) {
  state.tab = tab;
  if (tab === "citations" && !state.cit) await loadCitations();
  if (tab === "migrations" && !state.mig) await loadMigrations();
  if (tab === "obligations") { state.obl = null; renderWorkspace(); await loadObligations(); }
  renderWorkspace();
}

function renderWorkspace() {
  const d = state.doc;
  $app.innerHTML = "";

  const reviewed = d.alignments.filter(a => a.decision !== "pending").length;
  const cc = d.citation_check;
  const nIssues = cc ? cc.n_missing + cc.n_ambiguous : 0;
  // 引用迁移为按需即时计算，标签上先不显示角标数字（切换时加载）
  const tabbar = h("div", { class: "tabs" },
    h("button", {
      class: `tab ${state.tab === "align" ? "active" : ""}`,
      onclick: () => switchTab("align"),
    }, "条款对齐", h("span", { class: "tab-count" }, d.alignments.length)),
    h("button", {
      class: `tab ${state.tab === "citations" ? "active" : ""}`,
      onclick: () => switchTab("citations"),
    }, "引用检查",
      cc
        ? h("span", { class: `tab-count ${nIssues ? "warn" : "ok"}` },
            nIssues ? `问题 ${nIssues}` : `${cc.total} 项无误`)
        : h("span", { class: "tab-count" }, "未扫描")),
    h("button", {
      class: `tab ${state.tab === "migrations" ? "active" : ""}`,
      onclick: () => switchTab("migrations"),
    }, "引用迁移",
      state.mig
        ? (state.mig.counts.review + state.mig.counts.suspected
            ? h("span", { class: "tab-count warn" },
                `待核验 ${state.mig.counts.review + state.mig.counts.suspected}`)
            : h("span", { class: "tab-count ok" }, `${state.mig.counts.migrated} 已迁移`))
        : null),
    h("button", {
      class: `tab ${state.tab === "obligations" ? "active" : ""}`,
      onclick: () => switchTab("obligations"),
    }, "责任矩阵",
      state.obl
        ? (state.obl.counts.review
            ? h("span", { class: "tab-count warn" }, `待核验 ${state.obl.counts.review}`)
            : h("span", { class: "tab-count ok" }, `${state.obl.total} 项`))
        : null));

  const head = h("div", { class: "panel" },
    h("div", { class: "breadcrumb", onclick: renderList }, "← 返回文档列表"),
    h("div", { class: "workspace-head" },
      h("div", {},
        h("h2", {}, d.title),
        h("div", { class: "doc-meta" },
          h("span", {}, `旧版 ${d.paragraphs.old.length} 段`),
          h("span", {}, `新版 ${d.paragraphs.new.length} 段`),
          h("span", {}, `对齐 ${d.alignments.length} 条`),
          h("span", {}, `已审阅 ${reviewed}/${d.alignments.length}`),
          d.aligned_at ? h("span", {}, `对齐时间 ${fmtTime(d.aligned_at)}`) : null)),
      h("div", { class: "actions", style: "margin:0" },
        h("button", { class: "btn sm", onclick: () => openNewMapping() }, "＋ 新建映射"),
        h("button", { class: "btn sm", onclick: () => realign(d.id) }, "↻ 重新自动对齐"),
        exportMenu(d.id))),
    tabbar);

  $app.append(head);
  if (state.tab === "align") renderAlignTab();
  else if (state.tab === "citations") renderCitationsTab();
  else if (state.tab === "migrations") renderMigrationsTab();
  else renderObligationsTab();
}

// ---------------- 对齐 Tab ----------------

function renderAlignTab() {
  const d = state.doc;
  const counts = typeCounts();

  // 统计 chips（点击按类型筛选）；圆点颜色由 CSS 类控制
  const chips = Object.entries(TYPE_LABEL).map(([key, label]) => {
    const n = counts[key] || 0;
    return h("span", {
      class: `chip clickable ${key} ${state.filterType === key ? "" : "off"}`,
      onclick: () => { state.filterType = state.filterType === key ? "" : key; renderWorkspace(); },
    }, h("span", { class: "dot" }), `${label} ${n}`);
  });

  $app.append(
    h("div", { class: "panel tab-panel" },
      h("div", { class: "stats" }, chips),
      h("div", { class: "toolbar" },
        h("input", {
          type: "text", placeholder: "搜索原文 / 备注关键字…", value: state.search,
          oninput: (e) => { state.search = e.target.value; applyListFilter(); },
        }),
        h("select", {
          onchange: (e) => { state.filterDecision = e.target.value; renderWorkspace(); },
        },
          h("option", { value: "" }, "全部审阅状态"),
          ...Object.entries(DECISION_LABEL).map(([v, l]) =>
            h("option", { value: v, selected: state.filterDecision === v }, l))),
        h("span", { class: "foot-label", id: "visible-count" }))));

  const list = h("div", { id: "alignment-list" });
  d.alignments.forEach(a => list.appendChild(renderCard(a)));
  $app.append(list);
  applyListFilter();
}

function exportMenu(docId) {
  const root = h("div", { style: "position:relative" });
  const menu = h("div", {
    style: "position:absolute;right:0;top:110%;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);z-index:30;display:none;min-width:200px",
  },
    ...["csv", "md", "json"].map(fmt => h("button", {
      class: "btn sm",
      style: "width:100%;border:none;border-radius:0;justify-content:flex-start;text-align:left",
      onclick: () => doExport(docId, fmt),
    }, { csv: "⬇ 导出 CSV（Excel）", md: "⬇ 导出 Markdown 报告", json: "⬇ 导出 JSON" }[fmt])));
  const btn = h("button", { class: "btn primary sm" }, "⬇ 导出");
  btn.onclick = (e) => { e.stopPropagation(); menu.style.display = menu.style.display === "none" ? "block" : "none"; };
  // 点击页面其他位置时关闭菜单（仅在菜单打开期间监听一次）
  document.addEventListener("click", function closeMenu(ev) {
    if (!root.contains(ev.target)) {
      menu.style.display = "none";
      document.removeEventListener("click", closeMenu);
    }
  });
  root.append(btn, menu);
  return root;
}

function doExport(docId, fmt) {
  const p = new URLSearchParams();
  if (state.filterType) p.set("change_type", state.filterType);
  if (state.filterDecision) p.set("decision", state.filterDecision);
  window.location.href = `/api/documents/${docId}/export?format=${fmt}&${p.toString()}`;
}

async function realign(id) {
  if (!confirm("将清除全部对齐结果（含人工调整与审阅决定）并重新计算，确定继续？")) return;
  try {
    await api(`/api/documents/${id}/realign`, { method: "POST" });
    toast("已重新对齐");
    state.cit = null;
    state.mig = null;
    state.obl = null;
    openDoc(id);
  } catch (e) { toast(e.message, true); }
}

// ---------------- 引用检查 Tab ----------------

async function rescanCitations() {
  const id = state.doc.id;
  try {
    const stats = await api(`/api/documents/${id}/citations/scan`, { method: "POST" });
    state.doc.citation_check = {
      total: stats.total, n_ok: stats.n_ok,
      n_missing: stats.n_missing, n_ambiguous: stats.n_ambiguous,
    };
    state.cit = null;
    state.mig = null;  // 引用重扫后迁移核验下次查看时即时重算
    state.obl = null;
    await loadCitations();
    if (state.tab === "migrations") await loadMigrations();
    renderWorkspace();
    toast(`扫描完成：共 ${stats.total} 项，缺失 ${stats.n_missing}，歧义 ${stats.n_ambiguous}`);
  } catch (e) { toast(e.message, true); }
}

function filteredCitationItems() {
  const items = state.cit ? state.cit.items : [];
  const kw = state.citKw.trim().toLowerCase();
  return items.filter(it => {
    if (state.citStatus && it.status !== state.citStatus) return false;
    if (state.citType && it.ref_type !== state.citType) return false;
    if (kw && !(it.mention_text + it.reason + it.target_label + it.source_location)
        .toLowerCase().includes(kw)) return false;
    return true;
  });
}

function renderCitationsTab() {
  if (!state.cit) {
    $app.append(h("div", { class: "panel" },
      h("div", { class: "empty" }, "引用检查数据加载中……")));
    return;
  }
  const cit = state.cit;
  const cc = cit.check;
  const nIssues = cc ? cc.n_missing + cc.n_ambiguous : 0;

  // 状态筛选 chips
  const chips = [
    { key: "", label: `全部 ${cc ? cc.total : 0}` },
    { key: "missing", label: `缺失 ${cc ? cc.n_missing : 0}` },
    { key: "ambiguous", label: `歧义 ${cc ? cc.n_ambiguous : 0}` },
    { key: "ok", label: `正常 ${cc ? cc.n_ok : 0}` },
  ].map(c => h("span", {
    class: `chip clickable cit-chip ${c.key || "all"} ${state.citStatus === c.key ? "" : "off"}`,
    onclick: () => { state.citStatus = c.key; renderWorkspace(); },
  }, h("span", { class: "dot" }), c.label));

  // 引用类型去重（出现过的类型）
  const typeSet = [...new Set(cit.items.map(x => x.ref_type))];

  const panel = h("div", { class: "panel tab-panel" },
    h("div", { class: "cit-headline" },
      cc
        ? h("div", {},
            h("b", {}, `扫描到 ${cc.total} 处引用`),
            h("span", { class: nIssues ? "cit-warn" : "cit-ok" },
              nIssues ? `　⚠ ${nIssues} 处需处理（缺失 ${cc.n_missing} · 歧义 ${cc.n_ambiguous}），不会静默选取目标`
                      : "　✔ 全部引用均可唯一定位"))
        : h("div", { class: "hint" }, "尚未生成引用检查结果"),
      h("div", { class: "actions", style: "margin:0" },
        h("button", { class: "btn sm", onclick: rescanCitations }, "↻ 重新扫描"),
        h("button", { class: "btn primary sm", onclick: exportCitations }, "⬇ 导出问题 CSV"))),
    h("div", { class: "stats" }, chips),
    h("div", { class: "toolbar" },
      h("input", {
        type: "text", placeholder: "搜索引用原文 / 目标 / 原因…", value: state.citKw,
        oninput: (e) => { state.citKw = e.target.value; applyCitationFilter(); },
      }),
      h("select", {
        onchange: (e) => { state.citType = e.target.value; renderWorkspace(); },
      },
        h("option", { value: "" }, "全部引用类型"),
        ...typeSet.map(t => h("option", {
          value: t, selected: state.citType === t,
        }, (cit.ref_type_labels && cit.ref_type_labels[t]) || t))),
      h("span", { class: "foot-label", id: "cit-visible-count" })));

  const list = h("div", { id: "citation-list" });
  filteredCitationItems().forEach(it => list.appendChild(renderCitationCard(it)));
  if (!list.children.length) {
    list.append(h("div", { class: "empty" }, "当前筛选条件下没有引用记录"));
  }
  $app.append(panel, list);
  applyCitationFilter();
}

function exportCitations() {
  const p = new URLSearchParams();
  if (state.citStatus) p.set("status", state.citStatus);
  if (state.citType) p.set("ref_type", state.citType);
  if (state.citKw.trim()) p.set("keyword", state.citKw.trim());
  // 默认（无状态筛选）时后端只导出问题项；导出全部需显式选“正常/缺失/歧义”
  const qs = p.toString();
  window.location.href = `/api/documents/${state.doc.id}/citations-export${qs ? "?" + qs : ""}`;
}

function applyCitationFilter() {
  const n = filteredCitationItems().length;
  const total = state.cit ? state.cit.items.length : 0;
  const el = document.getElementById("cit-visible-count");
  if (el) el.textContent = `显示 ${n} / ${total} 项` +
    (state.citStatus || state.citType || state.citKw.trim() ? "（已筛选）" : "");
}

function renderCitationCard(it) {
  const labels = state.cit.ref_type_labels || {};
  const srcPara = state.cit.new_paragraphs[it.source_para_idx] || "";

  const body = h("div", { class: "card-body" });

  // 来源：高亮引用片段
  body.append(
    h("div", { class: "cite-source" },
      h("b", {}, "来源　"),
      h("span", { class: "cite-loc" }, it.source_location),
      h("div", { class: "cite-quote" }, highlightMention(srcPara, it.source_start, it.source_end))));

  if (it.status === "ok") {
    body.append(h("div", { class: "cite-target ok" },
      h("b", {}, "目标　"),
      h("span", { class: "cite-target-label" }, it.target_label),
      h("div", { class: "cite-quote" }, ...it.targets.map(t =>
        h("div", { class: "target-unit" },
          h("div", { class: "target-tag" }, t.label, ` · 新版第 ${t.para_idx + 1} 段`),
          h("div", { class: "target-text" }, t.excerpt))))));
  } else if (it.status === "missing") {
    body.append(h("div", { class: "cite-target missing" },
      h("b", {}, "目标　"),
      h("span", { class: "cite-why" }, "缺失：" + it.reason)));
  } else {
    body.append(h("div", { class: "cite-target ambiguous" },
      h("b", {}, "候选　"),
      h("span", { class: "cite-why" },
        `歧义：发现 ${it.candidates.length} 个候选，不自动选取。${it.reason}`),
      h("div", { class: "cite-cands" }, ...it.candidates.map(c =>
        h("div", { class: "target-unit cand" },
          h("div", { class: "target-tag" }, c.label),
          h("div", { class: "target-text" }, c.excerpt))))));
  }

  return h("div", { class: `align-card cit-card ${it.status}` },
    h("div", { class: "card-head" },
      h("span", { class: `cite-badge ${it.status}` }, CITE_STATUS_LABEL[it.status]),
      h("span", { class: "cite-mention" }, it.mention_text),
      h("span", { class: "cite-type" }, labels[it.ref_type] || it.ref_type),
      h("span", { class: "spacer" }),
      h("button", { class: "btn sm", onclick: () => openCitationModal(it.id) }, "查看来源 / 目标原文")),
    body);
}

// 高亮来源段落中的引用片段（按字符偏移切片）
function highlightMention(text, start, end) {
  if (start == null || start < 0 || end > text.length) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  frag.append(
    document.createTextNode(text.slice(0, start)),
    h("mark", { class: "cite-mark" }, text.slice(start, end)),
    document.createTextNode(text.slice(end)));
  return frag;
}

// ---------------- 引用详情模态框（来源 ↔ 目标/候选原文对照） ----------------

async function openCitationModal(issueId) {
  let it;
  try {
    it = await api(`/api/documents/${state.doc.id}/citations/${issueId}`);
  } catch (e) { return toast(e.message, true); }
  const labels = state.cit.ref_type_labels || {};
  const root = document.getElementById("modal-root");
  const close = () => { root.innerHTML = ""; };

  const srcText = it.source_para ? it.source_para.content : "";
  const srcBox = h("div", { class: "text-box new" },
    h("h4", {}, `来源 · ${it.source_location}`),
    h("div", { class: "cite-quote" }, highlightMention(srcText, it.source_start, it.source_end)));

  let targetBox;
  if (it.status === "ok") {
    targetBox = h("div", { class: "text-box tgt-ok" },
      h("h4", {}, `唯一定位目标 · ${it.target_label}`),
      ...it.targets.map(t => h("div", { class: "target-unit" },
        h("div", { class: "target-tag" }, `${t.label} · 新版第 ${t.para_idx + 1} 段`),
        h("div", { class: "target-text" }, t.excerpt))));
  } else if (it.status === "missing") {
    targetBox = h("div", { class: "text-box tgt-missing" },
      h("h4", {}, "缺失（未找到目标，未静默选取）"),
      h("div", { class: "cite-why" }, it.reason));
  } else {
    targetBox = h("div", { class: "text-box tgt-amb" },
      h("h4", {}, `歧义（${it.candidates.length} 个候选，需人工确认）`),
      ...it.candidates.map(c => h("div", { class: "target-unit cand" },
        h("div", { class: "target-tag" }, c.label),
        h("div", { class: "target-text" }, c.excerpt))));
  }

  const modal = h("div", { class: "modal-mask", onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h("div", { class: "modal" },
      h("div", { class: "modal-head" },
        h("h3", {}, "引用详情 · ",
          h("span", { class: `cite-badge ${it.status}` }, CITE_STATUS_LABEL[it.status]),
          "　", h("span", { class: "cite-mention" }, it.mention_text)),
        h("button", { class: "close-x", onclick: close }, "✕")),
      h("div", { class: "modal-body" },
        h("p", { class: "hint", style: "margin-top:0" },
          "引用类型：" + (labels[it.ref_type] || it.ref_type) + "　|　判定说明：" + it.reason),
        h("div", { class: "side-by-side" }, srcBox, targetBox)),
      h("div", { class: "modal-foot" },
        h("button", { class: "btn primary", onclick: close }, "关闭"))));
  root.append(modal);
}

// ---------------- 引用迁移 Tab ----------------

function filteredMigItems() {
  const items = state.mig ? state.mig.items : [];
  const kw = state.migKw.trim().toLowerCase();
  return items.filter(it => {
    if (state.migStatus && it.status !== state.migStatus) return false;
    if (state.migType && it.ref_type !== state.migType) return false;
    if (kw) {
      let blob = it.mapping_basis + it.reason + it.ref_type + " ";
      for (const side of [it.old, it.new]) {
        if (side) blob += side.mention_text + side.target_label + side.reason + " ";
      }
      for (const e of it.expected_targets) blob += e.label + e.excerpt + " ";
      if (!blob.toLowerCase().includes(kw)) return false;
    }
    return true;
  });
}

function applyMigFilter() {
  const n = filteredMigItems().length;
  const total = state.mig ? state.mig.total : 0;
  const el = document.getElementById("mig-visible-count");
  if (el) el.textContent = `显示 ${n} / ${total} 项` +
    (state.migStatus || state.migType || state.migKw.trim() ? "（已筛选）" : "");
}

function exportMigrations() {
  const p = new URLSearchParams();
  if (state.migStatus) p.set("status", state.migStatus);
  if (state.migType) p.set("ref_type", state.migType);
  if (state.migKw.trim()) p.set("keyword", state.migKw.trim());
  const qs = p.toString();
  window.location.href = `/api/documents/${state.doc.id}/citation-migrations-export${qs ? "?" + qs : ""}`;
}

async function recomputeMigrations() {
  state.mig = null;
  await loadMigrations();
  renderWorkspace();
  toast("已按当前映射与两版引用解析重新计算");
}

function renderMigrationsTab() {
  if (!state.mig) {
    $app.append(h("div", { class: "panel" },
      h("div", { class: "empty" }, "引用迁移数据计算中……")));
    return;
  }
  const mig = state.mig;
  const c = mig.counts;
  const nAttention = c.suspected + c.review;

  const chips = [
    { key: "", cls: "all", label: `全部 ${mig.total}` },
    { key: "migrated", cls: "migrated", label: `已迁移 ${c.migrated}` },
    { key: "suspected", cls: "suspected", label: `疑似错指 ${c.suspected}` },
    { key: "review", cls: "review", label: `待核验 ${c.review}` },
  ].map(x => h("span", {
    class: `chip clickable mig-chip ${x.cls} ${state.migStatus === x.key ? "" : "off"}`,
    onclick: () => { state.migStatus = x.key; renderWorkspace(); },
  }, h("span", { class: "dot" }), x.label));

  const typeSet = [...new Set(mig.items.map(x => x.ref_type))];

  const panel = h("div", { class: "panel tab-panel" },
    h("div", { class: "cit-headline" },
      h("div", {},
        h("b", {}, `引用迁移核验（${mig.groups_reviewed} 个含新旧映射的来源组）`),
        h("div", { class: "hint" },
          "对旧版与新版分别执行引用解析，仅审查有新旧段落映射的来源；组内按引用类型与出现序号配对，禁止猜测。")),
      h("div", { class: "actions", style: "margin:0" },
        h("button", { class: "btn sm", onclick: recomputeMigrations }, "↻ 重新计算"),
        h("button", { class: "btn primary sm", onclick: exportMigrations }, "⬇ 导出 CSV"))),
    h("div", { class: "stats" },
      h("span", { class: nAttention ? "cit-warn" : "cit-ok" },
        nAttention
          ? `　⚠ ${nAttention} 项需人工核验（疑似错指 ${c.suspected} · 待核验 ${c.review}），已迁移 ${c.migrated} 项`
          : `　✔ ${c.migrated} 项引用均已随段落映射迁移`),
      chips),
    h("div", { class: "toolbar" },
      h("input", {
        type: "text", placeholder: "搜索旧引用 / 预期目标 / 实际目标 / 依据…", value: state.migKw,
        oninput: (e) => { state.migKw = e.target.value; applyMigFilter(); },
      }),
      h("select", {
        onchange: (e) => { state.migType = e.target.value; renderWorkspace(); },
      },
        h("option", { value: "" }, "全部引用类型"),
        ...typeSet.map(t => h("option", {
          value: t, selected: state.migType === t,
        }, (mig.ref_type_labels && mig.ref_type_labels[t]) || t))),
      h("span", { class: "foot-label", id: "mig-visible-count" })));

  const list = h("div", { id: "migration-list" });
  filteredMigItems().forEach(it => list.appendChild(renderMigCard(it)));
  if (!list.children.length) {
    list.append(h("div", { class: "empty" },
      "当前筛选条件下没有迁移核验记录（无新旧映射来源组或没有引用）"));
  }
  $app.append(panel, list);
  applyMigFilter();
}

function renderSideCitation(side, paras) {
  if (!side) {
    return h("div", { class: "text-box empty-box mig-side" },
      h("h4", {}, "（无配对引用）"),
      "同类型引用数量不等，该侧无配对项，禁止猜测");
  }
  const srcText = paras[side.source_para_idx] || "";
  const cls = side.status === "ok" ? "tgt-ok"
    : side.status === "ambiguous" ? "tgt-amb" : "tgt-missing";
  return h("div", { class: `text-box mig-side ${cls}` },
    h("h4", {}, `${side.mention_text}　`,
      h("span", { class: `cite-badge ${side.status}` }, CITE_STATUS_LABEL[side.status])),
    h("div", { class: "cite-loc" }, side.source_location),
    h("div", { class: "cite-quote" }, highlightMention(srcText, side.source_start, side.source_end)),
    side.status === "ok"
      ? h("div", { class: "mig-targets" }, ...side.targets.map(t =>
          h("div", { class: "target-unit" },
            h("div", { class: "target-tag" }, `${t.label} · 第 ${t.para_idx + 1} 段`),
            h("div", { class: "target-text" }, t.excerpt))))
      : h("div", { class: "cite-why" },
          side.status === "missing"
            ? "缺失：" + side.reason
            : `歧义：${side.candidates.length} 个候选，不自动选取。${side.reason}`));
}

function renderMigCard(it) {
  const labels = (state.mig.ref_type_labels) || {};
  const expectedBox = it.expected_targets.length
    ? h("div", { class: "text-box mig-expected" },
        h("h4", {}, `预期目标（经映射 #${it.alignment_id} 推导，共 ${it.expected_targets.length} 个新版段落）`),
        ...it.expected_targets.map(e => h("div", { class: "target-unit" },
          h("div", { class: "target-tag" }, e.label),
          h("div", { class: "target-text" }, e.excerpt))))
    : h("div", { class: "text-box empty-box mig-side" },
        h("h4", {}, "预期目标 · 无"),
        "旧目标缺失/歧义或无段落映射，无法建立预期集合");

  return h("div", { class: `align-card mig-card ${it.status}` },
    h("div", { class: "card-head" },
      h("span", { class: `cite-badge mig-badge ${it.status}` }, MIG_STATUS_LABEL[it.status]),
      h("span", { class: "cite-mention" },
        it.old ? it.old.mention_text : (it.new ? it.new.mention_text : "")),
      h("span", { class: "cite-type" }, labels[it.ref_type] || it.ref_type),
      h("span", { class: "cite-type" },
        `映射 #${it.alignment_id} · 组内第 ${it.pair_ordinal || "—"} 处`
        + `（旧 ${it.pair_old_count} / 新 ${it.pair_new_count}）`),
      h("span", { class: "spacer" })),
    h("div", { class: "card-body" },
      h("div", { class: "explain" }, h("b", {}, "判定："), it.reason),
      h("div", { class: "mig-grid" },
        h("div", {}, h("h4", { class: "mig-col-title old-t" }, "旧引用"),
          renderSideCitation(it.old, state.mig.old_paragraphs)),
        h("div", {}, h("h4", { class: "mig-col-title" }, "预期目标（新版）"), expectedBox),
        h("div", {}, h("h4", { class: "mig-col-title new-t" }, "新版实际引用"),
          renderSideCitation(it.new, state.mig.new_paragraphs))),
      h("div", { class: "explain mig-basis" }, h("b", {}, "映射依据："), it.mapping_basis)));
}

// ---------------- 责任矩阵 Tab ----------------

function filteredOblItems() {
  const items = state.obl ? state.obl.items : [];
  const kw = state.oblKw.trim().toLowerCase();
  return items.filter(it => {
    if (state.oblVerdict && it.verdict !== state.oblVerdict) return false;
    if (state.oblModal
        && (!it.old || it.old.modal !== state.oblModal)
        && (!it.new || it.new.modal !== state.oblModal)) return false;
    if (kw) {
      let blob = it.reason + " ";
      for (const c of [...(it.old_candidates || []), ...(it.new_candidates || [])]) {
        const ob = c.obligation;
        blob += c.why + " " + (ob.subject || "") + " " + ob.action + " " + ob.clause_text + " ";
      }
      for (const s of [it.old, it.new]) {
        if (s) blob += (s.subject || "") + " " + s.action + " " + (s.time_limit || "") + " " + s.clause_text + " ";
      }
      if (!blob.toLowerCase().includes(kw)) return false;
    }
    return true;
  });
}

function applyOblFilter() {
  const n = filteredOblItems().length;
  const total = state.obl ? state.obl.total : 0;
  const el = document.getElementById("obl-visible-count");
  if (el) el.textContent = `显示 ${n} / ${total} 项` +
    (state.oblVerdict || state.oblModal || state.oblKw.trim() ? "（已筛选）" : "");
}

function exportObligations() {
  const p = new URLSearchParams();
  if (state.oblVerdict) p.set("verdict", state.oblVerdict);
  if (state.oblModal) p.set("modal", state.oblModal);
  if (state.oblKw.trim()) p.set("keyword", state.oblKw.trim());
  const qs = p.toString();
  window.location.href = `/api/documents/${state.doc.id}/obligations-export${qs ? "?" + qs : ""}`;
}

async function recomputeObligations() {
  state.obl = null;
  renderWorkspace();
  await loadObligations();
  renderWorkspace();
  toast("已按当前映射与两版条款重新提取、配对并判定");
}

function renderObligationsTab() {
  if (!state.obl) {
    $app.append(h("div", { class: "panel" },
      h("div", { class: "empty" }, "责任矩阵数据计算中……")));
    return;
  }
  const obl = state.obl;
  const c = obl.counts;
  const nReview = c.review;

  // 判定筛选 chips（顺序固定）
  const order = ["added", "removed", "strengthened", "weakened",
                 "forbid_relaxed", "changed", "unchanged", "review"];
  const chips = [
    h("span", {
      class: `chip clickable obl-chip all ${state.oblVerdict === "" ? "" : "off"}`,
      onclick: () => { state.oblVerdict = ""; renderWorkspace(); },
    }, h("span", { class: "dot" }), `全部 ${obl.total}`),
    ...order.map(k => h("span", {
      class: `chip clickable obl-chip obl-${k} ${state.oblVerdict === k ? "" : "off"}`,
      onclick: () => { state.oblVerdict = state.oblVerdict === k ? "" : k; renderWorkspace(); },
    }, h("span", { class: "dot" }), `${OBL_VERDICT_LABEL[k]} ${c[k] || 0}`)),
  ];

  const panel = h("div", { class: "panel tab-panel" },
    h("div", { class: "cit-headline" },
      h("div", {},
        h("b", {}, `责任矩阵（从两版条款提取 ${obl.total} 项义务配对结果）`),
        h("div", { class: "hint" },
          "按公开规则提取「主体＋应当/必须/不得/可以＋行为＋时限」；仅在现有段落映射组内按主体与行为相似度配对。",
          h("br"),
          "拆分/合并映射、任一侧主体缺失或候选并列时不强行匹配，列为待核验并展示候选及原因。")),
      h("div", { class: "actions", style: "margin:0" },
        h("button", { class: "btn sm", onclick: recomputeObligations }, "↻ 重新计算"),
        h("button", { class: "btn primary sm", onclick: exportObligations }, "⬇ 导出当前结果 CSV"))),
    h("div", { class: "stats" },
      h("span", { class: nReview ? "cit-warn" : "cit-ok" },
        nReview
          ? `　⚠ ${nReview} 项待人工核验（主体缺失 / 候选并列 / 拆分合并组），系统未强行匹配`
          : `　✔ 全部义务均已按规则配对，无待核验项`),
      chips),
    h("div", { class: "toolbar" },
      h("input", {
        type: "text", placeholder: "搜索主体 / 行为 / 时限 / 依据 / 原因…", value: state.oblKw,
        oninput: (e) => { state.oblKw = e.target.value; applyOblFilter(); },
      }),
      h("select", {
        onchange: (e) => { state.oblModal = e.target.value; renderWorkspace(); },
      },
        h("option", { value: "" }, "全部情态词"),
        ...Object.entries(MODAL_LABEL_JS).map(([v, l]) =>
          h("option", { value: v, selected: state.oblModal === v }, l))),
      h("span", { class: "foot-label", id: "obl-visible-count" })),
    h("div", { class: "hint" },
      `配对规则：综合相似度 = ${obl.rules.weights.subject}×主体相似度 + ${obl.rules.weights.action}×行为相似度；`
      + `配对门槛 综合 ≥ ${Math.round(obl.rules.pair_gate * 100)}%、行为 ≥ ${Math.round(obl.rules.action_gate * 100)}%、`
      + `主体兼容 ≥ ${Math.round(obl.rules.subject_compat * 100)}%；最佳/次佳分差 ≤ ${Math.round(obl.rules.tie_band * 100)}% 视为候选并列。`));

  const list = h("div", { id: "obligation-list" });
  filteredOblItems().forEach(it => list.appendChild(renderOblCard(it)));
  if (!list.children.length) {
    list.append(h("div", { class: "empty" }, "当前筛选条件下没有义务记录（该文档两版条款未出现应当/必须/不得/可以等义务表述）"));
  }
  $app.append(panel, list);
  applyOblFilter();
}

function oblTag(ob, side) {
  if (!ob) return h("span", { class: "obl-none" }, "（无）");
  return h("span", { class: `obl-modal modal-${ob.modal}` },
    ob.modal_text,
    ob.subject_inherited ? h("span", { class: "obl-inh", title: "同句承前继承主体" }, " 承前") : null);
}

function renderOblSide(ob, side, it) {
  if (!ob) {
    return h("div", { class: `text-box empty-box obl-side ${side}` },
      h("h4", {}, side === "old" ? "旧版义务 · 无" : "新版义务 · 无"));
  }
  return h("div", { class: `text-box obl-side ${side === "old" ? "obl-old-box" : "obl-new-box"}` },
    h("h4", {}, ob.location),
    h("div", { class: "obl-line" },
      h("span", { class: "obl-k" }, "主体"),
      ob.subject
        ? h("span", { class: "obl-subj" }, ob.subject)
        : h("span", { class: "obl-missing" }, "主体缺失（禁止猜测）")),
    h("div", { class: "obl-line" },
      h("span", { class: "obl-k" }, "情态"), oblTag(ob, side)),
    h("div", { class: "obl-line" },
      h("span", { class: "obl-k" }, "行为"),
      h("span", { class: "obl-act" }, ob.action || "（空）")),
    h("div", { class: "obl-line" },
      h("span", { class: "obl-k" }, "时限"),
      ob.time_limit
        ? h("span", { class: "obl-time" }, ob.time_limit)
        : h("span", { class: "foot-label" }, "未注明")),
    h("button", {
      class: "btn sm", style: "margin-top:8px",
      onclick: () => openOblEvidence(ob, side, it),
    }, "查看两版依据原文"));
}

function renderCandidates(cands) {
  if (!cands || !cands.length) return null;
  return h("div", { class: "obl-cands" },
    h("div", { class: "obl-cands-title" },
      `候选（${cands.length} 项，不自动选取；达门槛 ${cands.filter(x => x.eligible).length} 项）：`),
    ...cands.map(cand => {
      const ob = cand.obligation;
      return h("div", { class: `target-unit cand ${cand.eligible ? "" : "ineligible"}` },
        h("div", { class: "target-tag" },
          `${ob.location}｜${ob.subject || "（主体缺失）"} ${ob.modal_text}${ob.action}`,
          h("span", { class: "obl-score" },
            `　主体 ${(cand.subject_sim * 100).toFixed(0)}% · `
            + `行为 ${(cand.action_sim * 100).toFixed(0)}% · 综合 ${(cand.score * 100).toFixed(0)}%`,
            cand.eligible ? " ✓达门槛" : " ✗未达门槛")),
        h("div", { class: "target-text cand-why" }, "原因：" + cand.why));
    }));
}

function renderOblCard(it) {
  const groupLabel = (state.obl.group_labels[it.group_change_type] || it.group_change_type);
  const bothSides = it.old && it.new;
  const simLine = bothSides
    ? h("span", { class: "cite-type" },
        `映射 #${it.alignment_id}（${groupLabel}）｜主体相似度 ${(it.subject_sim * 100).toFixed(0)}% · `
        + `行为相似度 ${(it.action_sim * 100).toFixed(0)}% · 综合 ${(it.score * 100).toFixed(0)}%`)
    : h("span", { class: "cite-type" }, `映射 #${it.alignment_id}（${groupLabel}）`);
  return h("div", { class: `align-card obl-card obl-v-${it.verdict}` },
    h("div", { class: "card-head" },
      h("span", { class: `cite-badge obl-badge obl-v-${it.verdict}` }, OBL_VERDICT_LABEL[it.verdict]),
      h("span", { class: "cite-mention" },
        it.new ? (it.new.subject || "主体缺失") + "·" + it.new.action.slice(0, 22)
               : (it.old.subject || "主体缺失") + "·" + it.old.action.slice(0, 22)),
      simLine,
      h("span", { class: "spacer" })),
    h("div", { class: "card-body" },
      h("div", { class: "explain" }, h("b", {}, "判定："), it.reason),
      h("div", { class: "mig-grid obl-grid" },
        h("div", {}, h("h4", { class: "mig-col-title old-t" }, "旧版义务"),
          renderOblSide(it.old, "old", it)),
        h("div", {}, h("h4", { class: "mig-col-title new-t" }, "新版义务"),
          renderOblSide(it.new, "new", it))),
      renderCandidates(it.old_candidates),
      renderCandidates(it.new_candidates)));
}

// 依据原文对照模态框（左旧右新，高亮配对两义务所在小句；未配对时展示本侧+对侧同组段落）
function openOblEvidence(ob, side, it) {
  const root = document.getElementById("modal-root");
  const close = () => { root.innerHTML = ""; };

  const oldOb = it.old, newOb = it.new;
  const oldParaIdx = oldOb ? oldOb.para_idx : (newOb ? null : null);
  const newParaIdx = newOb ? newOb.para_idx : null;
  const oldText = oldParaIdx != null ? (state.obl.old_paragraphs[oldParaIdx] || "") : "";
  const newText = newParaIdx != null ? (state.obl.new_paragraphs[newParaIdx] || "") : "";

  const oldBox = oldOb
    ? h("div", { class: "text-box old" },
        h("h4", {}, `旧版依据 · ${oldOb.location}`),
        h("div", { class: "cite-quote" }, highlightMention(oldText, oldOb.sent_start, oldOb.sent_end)),
        h("div", { class: "hint", style: "margin-top:6px" },
          `提取：${oldOb.subject || "（主体缺失）"} ${oldOb.modal_text} ${oldOb.action}`
          + (oldOb.time_limit ? `　时限：${oldOb.time_limit}` : "")))
    : h("div", { class: "text-box empty-box" },
        h("h4", {}, "旧版 · 无配对义务"),
        it.old_candidates && it.old_candidates.length
          ? it.old_candidates.map(c => h("div", {}, c.obligation.location + "（候选，未选取）"))
          : "该结果无旧版义务（新增）或未强行配对（待核验）");
  const newBox = newOb
    ? h("div", { class: "text-box new" },
        h("h4", {}, `新版依据 · ${newOb.location}`),
        h("div", { class: "cite-quote" }, highlightMention(newText, newOb.sent_start, newOb.sent_end)),
        h("div", { class: "hint", style: "margin-top:6px" },
          `提取：${newOb.subject || "（主体缺失）"} ${newOb.modal_text} ${newOb.action}`
          + (newOb.time_limit ? `　时限：${newOb.time_limit}` : "")))
    : h("div", { class: "text-box empty-box" },
        h("h4", {}, "新版 · 无配对义务"),
        it.new_candidates && it.new_candidates.length
          ? it.new_candidates.map(c => h("div", {}, c.obligation.location + "（候选，未选取）"))
          : "该结果无新版义务（移除）或未强行配对（待核验）");

  const modal = h("div", { class: "modal-mask", onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h("div", { class: "modal modal-wide" },
      h("div", { class: "modal-head" },
        h("h3", {}, "两版义务依据原文 · ",
          h("span", { class: `cite-badge obl-badge obl-v-${it.verdict}` }, OBL_VERDICT_LABEL[it.verdict])),
        h("button", { class: "close-x", onclick: close }, "✕")),
      h("div", { class: "modal-body" },
        h("p", { class: "hint", style: "margin-top:0" },
          "黄色高亮为该义务所在小句；义务项依据触发词「应当 / 必须 / 不得 / 可以」按公开规则从段落原文切出。"),
        h("div", { class: "side-by-side" }, oldBox, newBox),
        h("div", { class: "explain", style: "margin-top:12px;margin-bottom:0" },
          h("b", {}, "判定说明："), it.reason)),
      h("div", { class: "modal-foot" },
        h("button", { class: "btn primary", onclick: close }, "关闭"))));
  root.append(modal);
}

function applyListFilter() {
  const kw = state.search.trim().toLowerCase();
  let n = 0;
  for (const card of document.querySelectorAll(".align-card")) {
    const aid = Number(card.dataset.aid);
    const a = state.doc.alignments.find(x => x.id === aid);
    let show = true;
    if (state.filterType && a.change_type !== state.filterType) show = false;
    if (state.filterDecision && a.decision !== state.filterDecision) show = false;
    if (kw && !(a.old_group_text + a.new_group_text + a.explanation + a.decision_note)
        .toLowerCase().includes(kw)) show = false;
    card.style.display = show ? "" : "none";
    if (show) n++;
  }
  const el = document.getElementById("visible-count");
  if (el) el.textContent = `显示 ${n} / ${state.doc.alignments.length} 条` +
    (state.filterType || state.filterDecision || kw ? "（已筛选）" : "");
}

// ---------------- 对齐记录卡片 ----------------

function renderCard(a) {
  const d = state.doc;
  const oldLabel = a.old_indices.map(i => `第 ${i + 1} 段`).join("、");
  const newLabel = a.new_indices.map(i => `第 ${i + 1} 段`).join("、");

  const oldBox = a.old_indices.length
    ? h("div", { class: "text-box old" },
        h("h4", {}, `旧版 · ${oldLabel}`),
        h("div", {}, ...boxDiff(a, "old")))
    : h("div", { class: "text-box empty-box" }, h("h4", {}, "旧版 · 无对应段落"), "（新增内容）");

  const newBox = a.new_indices.length
    ? h("div", { class: "text-box new" },
        h("h4", {}, `新版 · ${newLabel}`),
        boxDiff(a, "new"))
    : h("div", { class: "text-box empty-box" }, h("h4", {}, "新版 · 无对应段落"), "（删除内容）");

  const card = h("div", {
    class: `align-card ${a.change_type} ${a.decision !== "pending" ? "reviewed" : ""}`,
    "data-aid": a.id,
  },
    h("div", { class: "card-head" },
      h("span", { class: `badge ${a.change_type}` }, TYPE_LABEL[a.change_type]),
      h("span", { class: "conf" },
        `置信度 ${(a.confidence * 100).toFixed(0)}%`,
        h("span", { class: "conf-bar" },
          h("span", { class: "conf-fill", style: `width:${a.confidence * 100}%;background:${confColor(a.confidence)}` })),
        a.similarity != null ? ` · 相似度 ${(a.similarity * 100).toFixed(0)}%` : ""),
      a.is_manual ? h("span", { class: "manual-tag" }, "人工调整") : null,
      h("span", { class: "spacer" }),
      h("span", { class: `decision-pill ${a.decision}` }, DECISION_LABEL[a.decision])),
    h("div", { class: "card-body" },
      h("div", { class: "explain" }, h("b", {}, "判定依据："), a.explanation),
      h("div", { class: "side-by-side" }, oldBox, newBox)),
    h("div", { class: "card-foot" },
      h("span", { class: "foot-label" }, "审阅决定"),
      decisionSelect(a),
      h("input", {
        type: "text", placeholder: "审阅备注（判定理由 / 疑问 …）", value: a.decision_note,
        "data-role": "note",
        onchange: (e) => saveDecision(a.id, { decision_note: e.target.value }, false),
      }),
      h("button", { class: "btn sm", onclick: () => openRemap(a.id) }, "✎ 调整映射"),
      h("button", { class: "btn sm danger", onclick: () => removeAlignment(a.id) }, "删除映射")));

  return card;
}

// 对同一组 diff ops，只渲染属于该侧的片段
function boxDiff(a, side) {
  const out = [];
  for (const [tag, i1, i2, j1, j2] of a.diff_ops) {
    if (side === "old" && (tag === "equal" || tag === "delete" || tag === "replace"))
      out.push(h("span", { class: tag === "equal" ? "" : "del" }, a.old_group_text.slice(i1, i2)));
    if (side === "new" && (tag === "equal" || tag === "insert" || tag === "replace"))
      out.push(h("span", { class: tag === "equal" ? "" : "ins" }, a.new_group_text.slice(j1, j2)));
  }
  if (!a.diff_ops.length) out.push(document.createTextNode(side === "old" ? a.old_group_text : a.new_group_text));
  return out;
}

function confColor(c) {
  if (c >= 0.85) return "#15803d";
  if (c >= 0.65) return "#b45309";
  return "#b91c1c";
}

function decisionSelect(a) {
  const sel = h("select", {
    onchange: (e) => saveDecision(a.id, { decision: e.target.value }, true),
  }, ...Object.entries(DECISION_LABEL).map(([v, l]) =>
    h("option", { value: v, selected: a.decision === v }, l)));
  return sel;
}

async function saveDecision(id, patch, reload) {
  try {
    const updated = await api(`/api/documents/${state.doc.id}/alignments/${id}`, {
      method: "PATCH", body: JSON.stringify(patch),
    });
    const a = state.doc.alignments.find(x => x.id === id);
    Object.assign(a, updated);
    if (reload) renderWorkspace(); else {
      // 不重绘以保留输入焦点，仅更新状态徽标/卡片描边
      const card = document.querySelector(`.align-card[data-aid="${id}"]`);
      if (card) card.classList.toggle("reviewed", a.decision !== "pending");
      const pill = card && card.querySelector(".decision-pill");
      if (pill) { pill.className = `decision-pill ${a.decision}`; pill.textContent = DECISION_LABEL[a.decision]; }
    }
  } catch (e) { toast(e.message, true); }
}

async function removeAlignment(id) {
  if (!confirm("删除该条映射？段落会变为未映射状态，可通过「新建映射」重新关联。")) return;
  try {
    await api(`/api/documents/${state.doc.id}/alignments/${id}`, { method: "DELETE" });
    state.doc.alignments = state.doc.alignments.filter(a => a.id !== id);
    state.obl = null;  // 映射变化后责任矩阵下次查看即时重算
    renderWorkspace();
    toast("已删除");
  } catch (e) { toast(e.message, true); }
}

// ---------------- 调整映射模态框 ----------------

function openRemap(alignId) {
  const a = state.doc.alignments.find(x => x.id === alignId);
  openMappingModal({
    mode: "remap",
    oldSel: new Set(a.old_indices),
    newSel: new Set(a.new_indices),
    alignId,
  });
}

function openNewMapping() {
  openMappingModal({ mode: "create", oldSel: new Set(), newSel: new Set() });
}

function openMappingModal(opts) {
  const d = state.doc;
  // 已被其他映射占用的段落（重映射时排除自身占用）
  const usedOld = new Set(), usedNew = new Set();
  for (const x of d.alignments) {
    if (opts.mode === "remap" && x.id === opts.alignId) continue;
    x.old_indices.forEach(i => usedOld.add(i));
    x.new_indices.forEach(i => usedNew.add(i));
  }

  const oldSel = new Set(opts.oldSel);
  const newSel = new Set(opts.newSel);

  const typeSel = h("select", {},
    h("option", { value: "" }, "按内容自动推断"),
    ...Object.entries(TYPE_LABEL).map(([v, l]) => h("option", { value: v }, l)));

  const refreshCounts = () => {
    const oc = modal.querySelector('[data-role="old-count"]');
    const nc = modal.querySelector('[data-role="new-count"]');
    if (oc) oc.textContent = `旧版段落（已选 ${oldSel.size} 项）`;
    if (nc) nc.textContent = `新版段落（已选 ${newSel.size} 项）`;
  };

  const oldList = h("div", { class: "pick-list" },
    ...d.paragraphs.old.map(p => h("div", {
      class: `pick-item ${oldSel.has(p.idx) ? "picked" : ""} ${usedOld.has(p.idx) ? "disabled" : ""}`,
      onclick: function () {
        if (usedOld.has(p.idx)) return;
        oldSel.has(p.idx) ? oldSel.delete(p.idx) : oldSel.add(p.idx);
        this.classList.toggle("picked");
        refreshCounts();
      },
    }, h("span", { class: "pidx" }, `${p.idx + 1}`), h("span", {}, p.content.slice(0, 120) + (p.content.length > 120 ? "…" : "")))));

  const newList = h("div", { class: "pick-list" },
    ...d.paragraphs.new.map(p => h("div", {
      class: `pick-item ${newSel.has(p.idx) ? "picked" : ""} ${usedNew.has(p.idx) ? "disabled" : ""}`,
      onclick: function () {
        if (usedNew.has(p.idx)) return;
        newSel.has(p.idx) ? newSel.delete(p.idx) : newSel.add(p.idx);
        this.classList.toggle("picked");
        refreshCounts();
      },
    }, h("span", { class: "pidx" }, `${p.idx + 1}`), h("span", {}, p.content.slice(0, 120) + (p.content.length > 120 ? "…" : "")))));

  const root = document.getElementById("modal-root");
  const close = () => { root.innerHTML = ""; };

  const modal = h("div", { class: "modal-mask", onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h("div", { class: "modal" },
      h("div", { class: "modal-head" },
        h("h3", {}, opts.mode === "remap" ? "手动调整段落映射" : "新建映射"),
        h("button", { class: "close-x", onclick: close }, "✕")),
      h("div", { class: "modal-body" },
        h("p", { class: "hint", style: "margin-top:0" },
          "点击勾选段落建立对应（可多选，多旧→一新为合并，一旧→多新为拆分）。灰色条目已被其他映射占用。"),
        h("label", { class: "field" }, "变更类型（可选）"),
        typeSel,
        h("div", { class: "grid-2", style: "margin-top:14px" },
          h("div", {}, h("label", { class: "field", "data-role": "old-count" }, "旧版段落"), oldList),
          h("div", {}, h("label", { class: "field", "data-role": "new-count" }, "新版段落"), newList))),
      h("div", { class: "modal-foot" },
        h("button", { class: "btn", onclick: close }, "取消"),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            const oi = [...oldSel].sort((x, y) => x - y);
            const ni = [...newSel].sort((x, y) => x - y);
            if (!oi.length && !ni.length) return toast("至少选择一侧的段落", true);
            const body = {
              old_indices: oi, new_indices: ni,
              change_type: typeSel.value || null,
            };
            try {
              if (opts.mode === "remap") {
                await api(`/api/documents/${d.id}/alignments/${opts.alignId}`, {
                  method: "PUT", body: JSON.stringify(body),
                });
                toast("映射已更新");
              } else {
                await api(`/api/documents/${d.id}/alignments`, {
                  method: "POST", body: JSON.stringify({ ...body, decision: "confirmed" }),
                });
                toast("映射已建立");
              }
              close();
              openDoc(d.id);
            } catch (e) { toast(e.message, true); }
          },
        }, "保存映射"))));
  root.append(modal);
  refreshCounts();
}

// ---------------- 示例文本 ----------------
const DEMO_OLD = `第一条 为了规范公司管理，制定本制度。本制度适用于全体员工。

第二条 员工应当遵守考勤规定，按时上下班。

第三条 请假应当提前申请，经主管批准后方可休假。
未经批准不到岗的，视为旷工。

第四条 工资于每月十日发放。

第五条 员工离职应当提前三十日书面通知部门负责人，经批准后方可办理离职手续。

第六条 对于违反本制度的行为，公司应当给予批评教育。

第七条 因公出差的员工必须事先填写出差申请单，经总经理批准。

第八条 员工之间不得在办公区域进行非业务聚会。

第九条 各部门应当在每季度结束后十五日内提交季度报表，由分管领导审核后执行。

第十条 设备使用人员应当妥善保管办公设备，不得擅自转借，损坏应当照价赔偿。

第十一条 审批人应当自收到申请之日起十日内作出审批决定。

第十二条 对逾期未整改的，应当暂停其系统权限。

第十三条 本制度自发布之日起施行。`;

const DEMO_NEW = `第一条 为规范公司经营管理，保障员工合法权益，根据有关法律，制定本制度。本制度适用于全体员工。

第二条 员工应当遵守考勤管理规定，按时上下班，不得迟到早退。

第三条 员工请假应当至少提前一个工作日通过系统提交申请。

第四条 请假经直接主管批准后方可休假；未经批准不到岗的，按前款规定处理。

第五条 工资于每月十五日发放，遇节假日顺延；发放标准见第十六条第二款第（一）项。

第六条 公司为员工缴纳社会保险和住房公积金。

第七条 前条规定的缴费基数按国家规定执行；本条未尽事宜按照第二十一条办理。

第八条 员工离职应当至少提前七日通过系统提交离职申请，经直接主管批准后方可办理离职手续。

第九条 对于违反本制度的行为，公司必须及时给予批评教育。

第十条 因公出差的员工应当事先填写出差申请单，经部门负责人批准。

第十一条 员工可以在办公区域开展正常的团队交流活动。

第十二条 各部门应当在每月结束后十个工作日内提交月度报表，由分管领导审核后执行。

第十三条 设备使用人员应当妥善保管办公设备。

第十四条 不得擅自转借办公设备；损坏的，可以按折旧价格赔偿。

第十五条 员工应当爱护办公环境，下班前应当关闭工位电源。

第十六条 薪酬构成。
（一）基本工资；
（二）绩效奖金。

第二款 绩效奖金按月考核发放。

第十七条 对违反第二十一条的行为，公司有权追究责任。

第十八条 审批人应当自收到申请之日起五个工作日内作出审批决定。

第十九条 逾期未整改的员工，人力资源部应当暂停其系统权限。

第二十条 申请人对审批决定有异议的，可以向人力资源部提出申诉。

第二十一条 本制度自发布之日起施行。`;

// ---------------- 启动 ----------------
document.getElementById("nav-list").addEventListener("click", renderList);
document.getElementById("nav-upload").addEventListener("click", renderUpload);
renderList();
