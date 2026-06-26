// host-import.js — live "Host Import" panel for the config builder.
//
// Self-contained: talks to /api/host-plan, /api/host-apply, /api/host-strip,
// /api/host-pin and leaves the tool-exclusion app (app.js) untouched. Discovers
// MCP servers in Claude Code / Claude Desktop / Codex, shows whether each is new
// (migratable) or already federated (strippable), and drives those mutations
// live (every server-side write is backup-on-write).

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? ` toast--${kind}` : "");
  el.innerHTML = `<svg class="ico"><use href="#${kind === "neg" ? "i-info" : "i-check"}"/></svg><span>${esc(message)}</span>`;
  ($("#toasts") || document.body).appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 280);
  }, 2600);
}

const HOST_LABEL = { "claude-code": "Claude Code", "claude-desktop": "Claude Desktop", codex: "Codex" };
const state = { items: [], pins: [], selected: new Set(), loaded: false, busy: false };

const rowKey = (it) => `${it.host}|${it.scope}|${it.projectKey || ""}|${it.name}`;

// new = migratable · federated = already in code-mode (strippable) · pinned ·
// skip = denylisted bridge / unconvertible (left alone)
function statusOf(it) {
  if (it.pinned) return "pinned";
  if (it.duplicate) return "federated";
  if (it.canMigrate) return "new";
  return "skip";
}

function shortProject(p) {
  if (!p) return "";
  const parts = String(p).split("/").filter(Boolean);
  return parts.slice(-1)[0] || String(p);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function counts() {
  let nw = 0, fed = 0, pin = 0;
  for (const it of state.items) {
    const s = statusOf(it);
    if (s === "new") nw++;
    else if (s === "federated") fed++;
    else if (s === "pinned") pin++;
  }
  return { total: state.items.length, nw, fed, pin };
}

function applyPlan(plan) {
  if (!plan) return load();
  state.items = plan.items || [];
  state.pins = plan.pins || [];
  const keys = new Set(state.items.map(rowKey));
  for (const k of [...state.selected]) if (!keys.has(k)) state.selected.delete(k);
  render();
}

async function load() {
  try {
    applyPlan(await api("/api/host-plan"));
    state.loaded = true;
  } catch (e) {
    const list = $("#hiList");
    if (list) list.innerHTML = `<p class="host-panel__empty">Failed to scan host configs: ${esc(String(e.message || e))}</p>`;
  }
}

function render() {
  const c = counts();
  $("#hiSummary").textContent = `${c.total} entries · ${c.nw} new · ${c.fed} federated · ${c.pin} pinned`;
  $("#hiLegend").innerHTML = [
    [`new`, "not in code-mode yet — migratable"],
    [`federated`, "already in code-mode — strippable"],
    [`pinned`, "never migrated or stripped"],
    [`skip`, "code-mode bridge — left alone"]
  ]
    .map(([k, d]) => `<span class="hi-legend__item"><span class="hi-badge hi-badge--${k}">${k}</span>${esc(d)}</span>`)
    .join("");

  const groups = new Map();
  for (const it of state.items) {
    if (!groups.has(it.host)) groups.set(it.host, []);
    groups.get(it.host).push(it);
  }
  const order = ["claude-code", "claude-desktop", "codex"];
  const hosts = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  const html = hosts
    .map((host) => {
      const rows = groups
        .get(host)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name) || String(a.projectKey).localeCompare(String(b.projectKey)));
      const body = rows
        .map((it) => {
          const st = statusOf(it);
          const k = rowKey(it);
          const checked = state.selected.has(k) ? "checked" : "";
          const scopeLabel = it.scope === "project" ? `project · ${esc(shortProject(it.projectKey))}` : "global";
          return `<label class="hi-row hi-row--${st}" data-key="${esc(k)}">
            <input type="checkbox" class="hi-row__check" ${checked} ${st === "skip" ? "disabled" : ""} />
            <span class="hi-row__name">${esc(it.name)}</span>
            <span class="hi-badge hi-badge--scope">${scopeLabel}</span>
            <span class="hi-badge hi-badge--risk-${esc(it.risk)}" title="${esc(it.reason || "")}">${esc(it.risk)}</span>
            <span class="hi-badge hi-badge--${st}">${st}</span>
            <button type="button" class="hi-row__pin ${it.pinned ? "is-on" : ""}" data-pin aria-label="${it.pinned ? "Unpin" : "Pin"}" title="${it.pinned ? "Unpin" : "Pin — never migrate/strip"}"><svg class="ico"><use href="#i-pin" /></svg></button>
          </label>`;
        })
        .join("");
      return `<div class="hi-group"><div class="hi-group__head">${esc(HOST_LABEL[host] || host)}<span class="hi-group__count">${rows.length}</span></div>${body}</div>`;
    })
    .join("");

  $("#hiList").innerHTML = html || `<p class="host-panel__empty">No host MCP servers found.</p>`;
}

function selectedItems() {
  const byKey = new Map(state.items.map((it) => [rowKey(it), it]));
  return [...state.selected].map((k) => byKey.get(k)).filter(Boolean);
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("hi-busy");
  try {
    await fn();
  } catch (e) {
    toast(String(e.message || e), "neg");
  } finally {
    state.busy = false;
    document.body.classList.remove("hi-busy");
  }
}

async function migrate() {
  const names = [...new Set(selectedItems().filter((it) => statusOf(it) === "new").map((it) => it.name))];
  if (!names.length) return toast("Select some 'new' servers to migrate", "neg");
  await withBusy(async () => {
    const r = await api("/api/host-apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names })
    });
    applyPlan(r.plan);
    toast(r.added && r.added.length ? `Migrated ${r.added.length} → code-mode` : "Nothing new to migrate", r.added && r.added.length ? "pos" : "neg");
  });
}

async function strip() {
  const entries = selectedItems()
    .filter((it) => statusOf(it) === "federated")
    .map((it) => ({ host: it.host, scope: it.scope, projectKey: it.projectKey, name: it.name }));
  if (!entries.length) return toast("Select some 'federated' servers to strip", "neg");
  const names = [...new Set(entries.map((e) => e.name))];
  const ok = window.confirm(
    `Strip ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${names.length} server${names.length === 1 ? "" : "s"}) from the live host configs?\n\n` +
      `Backed up to ~/.host-import-backups/. code-mode still provides these via federation.`
  );
  if (!ok) return;
  await withBusy(async () => {
    const r = await api("/api/host-strip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries })
    });
    applyPlan(r.plan);
    const n = (r.stripped || []).reduce((a, s) => a + (s.removed ? s.removed.length : 0), 0);
    const refused = (r.refused || []).length;
    toast(`Stripped ${n} entr${n === 1 ? "y" : "ies"}` + (refused ? ` · ${refused} refused` : ""), n ? "pos" : "neg");
  });
}

async function togglePin(it) {
  await withBusy(async () => {
    const r = await api("/api/host-pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: it.name, host: it.host, pinned: !it.pinned })
    });
    applyPlan(r.plan);
  });
}

function showPanel(show) {
  document.body.classList.toggle("view-host", show);
  $("#hostImport").hidden = !show;
  if (show && !state.loaded) load();
}

// --- wiring ---
$("#hostImportToggle")?.addEventListener("click", () => showPanel(true));
$("#hiBack")?.addEventListener("click", () => showPanel(false));
$("#hiRefresh")?.addEventListener("click", () => load());
$("#hiMigrate")?.addEventListener("click", migrate);
$("#hiStrip")?.addEventListener("click", strip);
$("#hiClear")?.addEventListener("click", () => {
  state.selected.clear();
  render();
});
$("#hiSelMigratable")?.addEventListener("click", () => {
  state.selected.clear();
  for (const it of state.items) if (statusOf(it) === "new") state.selected.add(rowKey(it));
  render();
});
$("#hiSelFederated")?.addEventListener("click", () => {
  state.selected.clear();
  for (const it of state.items) if (statusOf(it) === "federated") state.selected.add(rowKey(it));
  render();
});

$("#hiList")?.addEventListener("change", (e) => {
  const cb = e.target.closest(".hi-row__check");
  if (!cb) return;
  const k = e.target.closest(".hi-row")?.dataset.key;
  if (!k) return;
  if (cb.checked) state.selected.add(k);
  else state.selected.delete(k);
});

$("#hiList")?.addEventListener("click", (e) => {
  const pin = e.target.closest("[data-pin]");
  if (!pin) return;
  e.preventDefault();
  e.stopPropagation();
  const k = e.target.closest(".hi-row")?.dataset.key;
  const it = state.items.find((x) => rowKey(x) === k);
  if (it) togglePin(it);
});

// Esc returns to the tool view.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("view-host") && !state.busy) showPanel(false);
});
