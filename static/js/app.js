/* FinGuard Intelligence — client interactions for the FastAPI/Jinja MPA.
 *
 * The Next.js SPA became server-rendered pages; this file is the small amount of
 * genuinely client-side behaviour that survived the port:
 *   - theme toggle + live-feed toggle (sessionStorage)
 *   - mobile nav drawer
 *   - dashboard alert single-open expander
 *   - transactions search + severity filter
 *   - [data-confirm] submit guards
 *   - the graph canvas (hover-isolate, zoom/fit, filter, focus, node drawer)
 *   - the CSV upload preview + history tabs
 *   - the investigator chat island (/api/chat)
 *   - the SAR print button
 *
 * Every module no-ops unless its root element is on the page, so one bundle
 * serves all routes. Loaded with `defer`, so the DOM is parsed before we run.
 */
(function () {
  "use strict";

  // ── tiny helpers ───────────────────────────────────────────────────────────
  var qs = function (sel, root) { return (root || document).querySelector(sel); };
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var on = function (el, ev, fn, opts) { if (el) el.addEventListener(ev, fn, opts); };
  function show(el) { if (!el) return; el.hidden = false; el.classList.remove("hidden"); }
  function hide(el) { if (!el) return; el.hidden = true; el.classList.add("hidden"); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function severityColor(s) { return s === "high" ? "#ef4444" : s === "medium" ? "#f59e0b" : "#22c55e"; }
  function classifyRisk(amount, note) {
    var n = String(note || "").toLowerCase();
    if (/shell|layer|structur|mule|offshore|rapid|pass-through|split/.test(n)) return "high";
    if (amount >= 1000000) return "high";
    if (amount >= 100000) return "medium";
    return "safe";
  }
  function enIN(n) { try { return Number(n).toLocaleString("en-IN"); } catch (e) { return String(n); } }

  // ═══════════════════════════════════════════════════════════════════════════
  // Theme toggle — mirrors ThemeProvider: dark by default, choice held in
  // sessionStorage so it lasts the browser session only. The <head> flash-guard
  // already applied the class before paint; here we only flip + persist.
  // ═══════════════════════════════════════════════════════════════════════════
  function initTheme() {
    qsa("[data-theme-toggle]").forEach(function (btn) {
      on(btn, "click", function () {
        var isDark = document.documentElement.classList.contains("dark");
        var next = isDark ? "light" : "dark";
        document.documentElement.classList.remove("light", "dark");
        document.documentElement.classList.add(next);
        try { sessionStorage.setItem("finguard-theme", next); } catch (e) {}
        document.dispatchEvent(new CustomEvent("finguard:theme", { detail: { theme: next } }));
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Live-feed toggle — cosmetic in the MPA, default ON, persisted in
  // sessionStorage. Also drives the dashboard's [data-live-word]/[data-live-dot].
  // ═══════════════════════════════════════════════════════════════════════════
  function initLive() {
    var btns = qsa("[data-live-toggle]");
    var stored = null;
    try { stored = sessionStorage.getItem("finguard-live"); } catch (e) {}
    var live = stored == null ? true : stored === "1";
    var ON = ["border-emerald-500/40", "bg-emerald-500/10", "text-emerald-200", "shadow-glow"];

    function render() {
      btns.forEach(function (btn) {
        btn.setAttribute("aria-pressed", live ? "true" : "false");
        ON.forEach(function (c) { btn.classList.toggle(c, live); });
        if (live) { btn.style.borderColor = ""; btn.style.background = ""; btn.style.color = ""; }
        else { btn.style.borderColor = "var(--border)"; btn.style.background = "var(--chip)"; btn.style.color = "var(--muted)"; }
      });
      qsa("[data-live-label]").forEach(function (l) { l.textContent = live ? "Live feed · ON" : "Live feed · OFF"; });
      qsa("[data-live-word]").forEach(function (l) { l.textContent = live ? "streaming" : "paused"; });
      qsa("[data-live-dot]").forEach(function (d) {
        d.classList.toggle("animate-blink", live);
        if (live) { d.style.background = ""; d.classList.add("bg-emerald-400"); }
        else { d.classList.remove("bg-emerald-400"); d.style.background = "var(--muted)"; }
      });
    }
    render();
    btns.forEach(function (btn) {
      on(btn, "click", function () {
        live = !live;
        try { sessionStorage.setItem("finguard-live", live ? "1" : "0"); } catch (e) {}
        render();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mobile navigation drawer (off-canvas below lg).
  // ═══════════════════════════════════════════════════════════════════════════
  function initNav() {
    var nav = qs("#app-nav");
    var backdrop = qs("[data-nav-backdrop]");
    if (!nav) return;
    function open() { nav.classList.remove("-translate-x-full"); if (backdrop) show(backdrop); }
    function close() { nav.classList.add("-translate-x-full"); if (backdrop) hide(backdrop); }
    qsa("[data-nav-open]").forEach(function (b) { on(b, "click", open); });
    qsa("[data-nav-close]").forEach(function (b) { on(b, "click", close); });
    on(backdrop, "click", close);
    // Escape also closes the drawer (drawer/graph handle their own below).
    on(document, "keydown", function (e) { if (e.key === "Escape") close(); });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dashboard alerts — single-open expander. Detail markup is server-rendered
  // and hidden via the Tailwind `hidden` class; we toggle that class.
  // ═══════════════════════════════════════════════════════════════════════════
  function initAlerts() {
    var toggles = qsa("[data-alert-toggle], [data-alert-toggle-btn]");
    if (!toggles.length) return;
    function closeAll() {
      qsa("[data-alert-detail]").forEach(function (d) { d.classList.add("hidden"); });
    }
    toggles.forEach(function (t) {
      on(t, "click", function (e) {
        // The "Investigate" button lives inside the clickable row; don't double-fire.
        if (t.hasAttribute("data-alert-toggle") && e.target.closest("[data-alert-toggle-btn]")) return;
        var wrap = t.closest("[data-alert-id]") || t.closest("[data-alert-toggle]");
        var detail = wrap && wrap.querySelector("[data-alert-detail]");
        if (!detail) return;
        var isOpen = !detail.classList.contains("hidden");
        closeAll();
        if (!isOpen) detail.classList.remove("hidden");
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Transactions — search + severity filter. Desktop table and mobile cards
  // both carry [data-tx-row]; every transaction appears once per layout, so the
  // match count is exactly (matches / number-of-layouts).
  // ═══════════════════════════════════════════════════════════════════════════
  function initTransactions() {
    var search = qs("input[data-tx-search]");
    var sevBtns = qsa("[data-tx-sev]");
    var rows = qsa("[data-tx-row]");
    var empties = qsa("[data-tx-empty]");
    var counts = qsa("[data-tx-count]");
    if (!rows.length && !search) return;

    var layouts = Math.max(1, empties.length);
    var sev = "all";
    var ON = ["border-emerald-500/40", "bg-emerald-500/10", "text-emerald-200"];

    function apply() {
      var q = (search && search.value ? search.value : "").trim().toLowerCase();
      var matches = 0;
      rows.forEach(function (row) {
        var rSev = row.getAttribute("data-tx-sev-val") || "safe";
        var hay = row.getAttribute("data-tx-search") || "";
        var ok = (sev === "all" || rSev === sev) && (q === "" || hay.indexOf(q) !== -1);
        row.style.display = ok ? "" : "none";
        if (ok) matches++;
      });
      var visible = Math.round(matches / layouts);
      counts.forEach(function (c) { c.textContent = String(visible); });
      empties.forEach(function (e) { if (visible === 0) show(e); else hide(e); });
    }

    on(search, "input", apply);
    sevBtns.forEach(function (btn) {
      on(btn, "click", function () {
        sev = btn.getAttribute("data-tx-sev") || "all";
        sevBtns.forEach(function (b) {
          var isOn = b === btn;
          b.setAttribute("aria-pressed", isOn ? "true" : "false");
          ON.forEach(function (c) { b.classList.toggle(c, isOn); });
          if (!isOn) { b.style.borderColor = "var(--border)"; b.style.color = "var(--text)"; }
          else { b.style.borderColor = ""; b.style.color = ""; }
        });
        apply();
      });
    });
    apply();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [data-confirm] — native confirm() before a destructive POST.
  // ═══════════════════════════════════════════════════════════════════════════
  function initConfirm() {
    on(document, "submit", function (e) {
      var form = e.target && e.target.closest ? e.target.closest("[data-confirm]") : null;
      if (!form) return;
      var msg = form.getAttribute("data-confirm") || "Are you sure?";
      if (!window.confirm(msg)) e.preventDefault();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Graph canvas — the server renders the SVG at zoom=1; this wires interaction:
  // hover-isolate dimming, zoom/fit, severity filter, focus highlight, the
  // light-mode lane-label recolour, and the node-detail drawer.
  // ═══════════════════════════════════════════════════════════════════════════
  var LANE_TEXT = {
    "#38bdf8": "#0369a1", "#a78bfa": "#6d28d9", "#f59e0b": "#b45309", "#22c55e": "#15803d",
    "#ec4899": "#be185d", "#06b6d4": "#0e7490", "#f97316": "#c2410c", "#8b5cf6": "#6d28d9",
    "#14b8a6": "#0f766e", "#e11d48": "#be123c", "#ef4444": "#dc2626"
  };

  function initGraph() {
    var root = qs("[data-graph-root]");
    if (!root) return;

    var W = parseFloat(root.getAttribute("data-graph-w")) || 1240;
    var H = parseFloat(root.getAttribute("data-graph-h")) || 640;
    var focusAttr = root.getAttribute("data-graph-focus") || "";
    var focus = focusAttr ? focusAttr.split(",").filter(Boolean) : [];

    var svg = qs("[data-graph-svg]", root);
    var scroll = qs("[data-graph-scroll]", root);
    var viewport = qs("[data-graph-viewport]", root);
    var zoomLabel = qs("[data-graph-zoom-label]", root);

    var nodes = qsa("[data-graph-node]", root).map(function (el) {
      var disc = el.querySelector("[data-node-disc]");
      return {
        el: el, id: el.getAttribute("data-node-id"), sev: el.getAttribute("data-node-sev") || "safe",
        disc: disc, meta: el.querySelector("[data-node-meta]"), label: el.querySelector("[data-node-label]"),
        baseR: disc ? parseFloat(disc.getAttribute("r")) : 0
      };
    });
    var edges = qsa("[data-graph-edge]", root).map(function (el) {
      return {
        el: el, id: el.getAttribute("data-edge-id"),
        source: el.getAttribute("data-edge-source"), target: el.getAttribute("data-edge-target"),
        path: el.querySelector("[data-edge-path]"), amount: el.querySelector("[data-edge-amount]")
      };
    });
    var clusters = qsa("[data-graph-cluster]", root);
    var nodeById = {};
    nodes.forEach(function (n) { nodeById[n.id] = n; });

    // spread(): one hop out along every incident edge (single pass, order-stable).
    function spread(roots) {
      var s = {};
      roots.forEach(function (r) { s[r] = true; });
      edges.forEach(function (e) {
        if (s[e.source]) s[e.target] = true;
        if (s[e.target]) s[e.source] = true;
      });
      return s;
    }

    var litSet = focus.length ? spread(focus) : null;
    var filter = "all";

    function nodeVisible(id) {
      var n = nodeById[id];
      if (!n) return false;
      return filter === "all" || n.sev === filter;
    }

    function render(hoverId) {
      var hoverSet = hoverId ? spread([hoverId]) : null;

      nodes.forEach(function (n) {
        var vis = filter === "all" || n.sev === filter;
        n.el.style.display = vis ? "" : "none";
        n.el.style.opacity = hoverSet && !hoverSet[n.id] ? "0.55" : "";
        var selfHover = hoverId === n.id;
        if (n.disc) n.disc.setAttribute("r", String(selfHover ? n.baseR + 3 : n.baseR));
        if (n.meta) n.meta.style.display = selfHover ? "" : "none";
        if (n.label) n.label.style.fontWeight = selfHover ? "700" : "";
      });

      edges.forEach(function (e) {
        var edgeVis = nodeVisible(e.source) && nodeVisible(e.target);
        e.el.style.display = edgeVis ? "" : "none";
        var litBoth = litSet && litSet[e.source] && litSet[e.target];
        var hovBoth = hoverSet && hoverSet[e.source] && hoverSet[e.target];
        var touched = litBoth || hovBoth;
        var faded = hoverSet && !hovBoth;
        e.el.style.opacity = faded ? "0.5" : (touched ? "1" : "");
        if (e.path) {
          e.path.style.strokeWidth = touched ? "2.4" : "";
          e.path.style.strokeOpacity = touched ? "1" : "";
        }
        if (e.amount) e.amount.style.display = touched ? "" : "none";
      });

      clusters.forEach(function (c) { c.style.opacity = hoverSet ? "0.55" : ""; });
    }

    // ── hover + click wiring ──
    nodes.forEach(function (n) {
      on(n.el, "mouseenter", function () { render(n.id); });
      on(n.el, "mouseleave", function () { render(null); });
      on(n.el, "click", function () { openNode(n.id); });
    });

    // ── filter buttons ──
    var filterBtns = qsa("[data-graph-filter]", root);
    var FON = ["border-emerald-500/40", "bg-emerald-500/10", "text-emerald-200"];
    filterBtns.forEach(function (btn) {
      on(btn, "click", function () {
        filter = btn.getAttribute("data-graph-filter") || "all";
        filterBtns.forEach(function (b) {
          var isOn = b === btn;
          FON.forEach(function (c) { b.classList.toggle(c, isOn); });
          if (isOn) { b.classList.remove("hover:bg-[var(--hover)]"); b.style.borderColor = ""; b.style.color = ""; }
          else { b.classList.add("hover:bg-[var(--hover)]"); b.style.borderColor = "var(--border)"; b.style.color = "var(--text)"; }
        });
        render(null);
      });
    });

    // ── zoom / fit ──
    var mq = window.matchMedia("(max-width: 1023px)");
    var zoom = 1;
    var touchedZoom = false;

    function applyZoom() {
      if (svg) {
        svg.setAttribute("width", String(Math.round(W * zoom)));
        svg.setAttribute("height", String(Math.round(H * zoom)));
      }
      if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + "%";
      var fittedH = Math.round(H * zoom) + 8;
      if (viewport) viewport.style.height = (mq.matches ? fittedH : Math.min(760, Math.max(520, fittedH))) + "px";
    }
    function setZoom(z) { zoom = z; touchedZoom = true; applyZoom(); }

    qsa("[data-graph-zoom]", root).forEach(function (btn) {
      on(btn, "click", function () {
        var kind = btn.getAttribute("data-graph-zoom");
        if (kind === "out") setZoom(Math.max(0.35, Math.round((zoom - 0.1) * 100) / 100));
        else if (kind === "in") setZoom(Math.min(2, Math.round((zoom + 0.1) * 100) / 100));
        else if (kind === "reset") setZoom(1);
        else if (kind === "fit" && scroll) setZoom(Math.max(0.3, Math.min(1, (scroll.clientWidth - 12) / W)));
      });
    });

    function autoFit() {
      if (touchedZoom || !mq.matches || !scroll) return;
      zoom = Math.max(0.16, Math.min(1, (scroll.clientWidth - 12) / W));
      applyZoom();
    }

    // ── light-mode lane-label recolour ──
    function applyLaneText() {
      var light = document.documentElement.classList.contains("light");
      qsa("[data-lane-hue]", root).forEach(function (el) {
        var hue = el.getAttribute("data-lane-hue");
        el.style.fill = light ? (LANE_TEXT[hue] || hue) : hue;
      });
    }
    on(document, "finguard:theme", applyLaneText);

    // ── node-detail drawer ──
    var drawer = qs("[data-drawer]");
    var overlay = qs("[data-drawer-overlay]");
    var body = qs("[data-drawer-body]");
    function openDrawer() {
      if (drawer) drawer.classList.remove("translate-x-full");
      if (overlay) { overlay.classList.remove("opacity-0", "pointer-events-none"); overlay.classList.add("opacity-100"); }
    }
    function closeDrawer() {
      if (drawer) drawer.classList.add("translate-x-full");
      if (overlay) { overlay.classList.add("opacity-0", "pointer-events-none"); overlay.classList.remove("opacity-100"); }
    }
    function openNode(id) {
      if (!body) return;
      body.innerHTML = '<div class="p-6 text-[13px]" style="color: var(--muted)">Loading account…</div>';
      openDrawer();
      fetch("/graph/node/" + encodeURIComponent(id), { credentials: "same-origin" })
        .then(function (r) { return r.text(); })
        .then(function (html) { body.innerHTML = html; })
        .catch(function () {
          body.innerHTML = '<div class="p-6 text-[13px]" style="color: var(--muted)">Could not load this account.</div>';
        });
    }
    on(overlay, "click", closeDrawer);
    on(document, "click", function (e) {
      if (e.target && e.target.closest && e.target.closest("[data-drawer-close]")) closeDrawer();
    });
    on(document, "keydown", function (e) { if (e.key === "Escape") closeDrawer(); });

    // ── init ──
    applyLaneText();
    applyZoom();
    autoFit();
    render(null);
    on(window, "resize", autoFit);
    if (mq.addEventListener) mq.addEventListener("change", autoFit);
    else if (mq.addListener) mq.addListener(autoFit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Upload — client CSV preview (server re-parses authoritatively on submit)
  // and the history tab switcher.
  // ═══════════════════════════════════════════════════════════════════════════
  var CSV_ALIASES = {
    date: ["date", "timestamp", "time", "transaction_date"],
    from: ["from", "from_account", "source", "sender", "payer"],
    to: ["to", "to_account", "target", "receiver", "payee", "beneficiary"],
    amount: ["amount", "value", "sum"],
    bank: ["bank", "institution"],
    currency: ["currency", "curr"],
    type: ["type", "transaction_type", "category"],
    note: ["note", "description", "memo", "remarks"]
  };
  var CSV_REQUIRED = ["date", "from", "to", "amount"];

  function splitCsvLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { q = false; } }
        else cur += c;
      } else {
        if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  }

  function parseCSV(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
    if (lines.length < 2) throw new Error("File is empty or has only headers.");
    var headers = lines[0].split(",").map(function (h) { return h.trim().toLowerCase().replace(/\s+/g, "_"); });
    var idx = {};
    Object.keys(CSV_ALIASES).forEach(function (key) {
      idx[key] = headers.findIndex(function (h) { return CSV_ALIASES[key].indexOf(h) !== -1; });
    });
    var missing = CSV_REQUIRED.filter(function (k) { return idx[k] === -1; });
    if (missing.length) {
      throw new Error("Missing required column(s): " + missing.join(", ") +
        ". Expected headers include: date, from, to, amount.");
    }
    var rows = [], errors = [];
    var get = function (cols, k) { return idx[k] >= 0 && cols[idx[k]] != null ? String(cols[idx[k]]).trim() : ""; };
    for (var i = 1; i < lines.length; i++) {
      var cols = splitCsvLine(lines[i]);
      var amountRaw = get(cols, "amount").replace(/[,\s₹$€£]/g, "");
      var amount = Number(amountRaw);
      if (!isFinite(amount)) {
        errors.push('Row ' + (i + 1) + ': amount "' + get(cols, "amount") + '" is not a number, skipped.');
        continue;
      }
      rows.push({
        _row: i + 1, date: get(cols, "date"), fromAccount: get(cols, "from"), toAccount: get(cols, "to"),
        amount: amount, bank: get(cols, "bank") || "Unknown", currency: get(cols, "currency") || "INR",
        type: get(cols, "type") || "transfer", note: get(cols, "note") || undefined
      });
    }
    return { rows: rows, errors: errors };
  }

  function initUpload() {
    var form = qs("[data-upload-form]");
    var drop = qs("[data-upload-drop]");
    var input = qs("[data-upload-input]");
    if (!input) { initUploadHistory(); return; }

    var filename = qs("[data-upload-filename]");
    var resetBtn = qs("[data-upload-reset]");
    var warnings = qs("[data-upload-warnings]");
    var warnlist = qs("[data-upload-warnlist]");
    var preview = qs("[data-upload-preview]");
    var countEl = qs("[data-upload-count]");
    var highwrap = qs("[data-upload-highwrap]");
    var highEl = qs("[data-upload-high]");
    var rowsEl = qs("[data-upload-rows]");
    var moreEl = qs("[data-upload-more]");
    var fallback = qs("[data-upload-fallback]");

    // JS is present → the plain no-JS submit button is redundant.
    if (fallback) hide(fallback);

    function rowHtml(r) {
      var sev = classifyRisk(r.amount, r.note);
      var color = severityColor(sev);
      return '<div class="grid grid-cols-6 text-[12.5px] px-3 py-2 border-b" style="border-color: var(--border); color: var(--text)">' +
        '<div class="truncate">' + esc(r.date) + '</div>' +
        '<div class="truncate">' + esc(r.fromAccount) + '</div>' +
        '<div class="truncate">' + esc(r.toAccount) + '</div>' +
        '<div class="truncate">' + esc(r.bank) + '</div>' +
        '<div class="text-right font-mono tabular-nums">' + esc(enIN(r.amount)) + ' ' + esc(r.currency) + '</div>' +
        '<div class="text-right"><span class="inline-block rounded px-1.5 py-0.5 text-[10.5px] font-medium capitalize" style="background:' +
        color + '22; color:' + color + '">' + esc(sev) + '</span></div>' +
        '</div>';
    }
    function showWarnings(list) {
      if (!warnings || !warnlist) return;
      warnlist.innerHTML = list.map(function (w) {
        return '<li>' + esc(w) + '</li>';
      }).join("");
      show(warnings);
    }
    function renderPreview(text) {
      var parsed;
      try { parsed = parseCSV(text); }
      catch (err) { showWarnings([err.message]); hide(preview); return; }
      var rows = parsed.rows, errs = parsed.errors;
      if (errs.length) {
        var shown = errs.slice(0, 5);
        if (errs.length > 5) shown.push("…and " + (errs.length - 5) + " more");
        showWarnings(shown);
      } else { hide(warnings); }
      if (rowsEl) rowsEl.innerHTML = rows.slice(0, 8).map(rowHtml).join("");
      if (countEl) countEl.textContent = String(rows.length);
      var high = rows.filter(function (r) { return classifyRisk(r.amount, r.note) === "high"; }).length;
      if (high > 0) { if (highEl) highEl.textContent = String(high); show(highwrap); } else { hide(highwrap); }
      if (rows.length > 8) { if (moreEl) moreEl.textContent = "…and " + (rows.length - 8) + " more rows not shown here"; show(moreEl); }
      else { hide(moreEl); }
      show(preview);
    }
    function handleFiles(files) {
      var file = files && files[0];
      if (!file) return;
      try { var dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; } catch (e) {}
      if (filename) filename.textContent = file.name;
      if (resetBtn) show(resetBtn);
      var reader = new FileReader();
      reader.onload = function () { renderPreview(String(reader.result || "")); };
      reader.onerror = function () { showWarnings(["Could not read that file."]); };
      reader.readAsText(file);
    }
    function reset() {
      input.value = "";
      try { input.files = new DataTransfer().files; } catch (e) {}
      if (filename) filename.textContent = "";
      if (rowsEl) rowsEl.innerHTML = "";
      hide(preview); hide(warnings); hide(highwrap); hide(moreEl);
      if (resetBtn) hide(resetBtn);
      if (fallback) hide(fallback);
    }

    on(drop, "click", function () { input.click(); });
    on(input, "change", function () { handleFiles(input.files); });
    on(resetBtn, "click", function (e) { e.preventDefault(); reset(); });
    if (drop) {
      ["dragenter", "dragover"].forEach(function (ev) {
        on(drop, ev, function (e) { e.preventDefault(); drop.classList.add("ring-2", "ring-emerald-500/40"); });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        on(drop, ev, function (e) { e.preventDefault(); drop.classList.remove("ring-2", "ring-emerald-500/40"); });
      });
      on(drop, "drop", function (e) { if (e.dataTransfer) handleFiles(e.dataTransfer.files); });
    }
    // Never submit an empty form (the preview is JS-only; the file is required).
    on(form, "submit", function (e) {
      if (!input.files || !input.files.length) { e.preventDefault(); showWarnings(["Choose a CSV file first."]); }
    });

    initUploadHistory();
  }

  function initUploadHistory() {
    var root = qs("[data-history-root]");
    if (!root) return;
    var def = root.getAttribute("data-history-default") || "";
    var selectors = qsa("[data-history-select]", root);
    var panels = qsa("[data-history-panel]", root);
    var ON = ["bg-emerald-500/10", "text-emerald-200", "border-emerald-500/40"];

    function showSel(sel) {
      panels.forEach(function (p) {
        if (p.getAttribute("data-history-panel") === sel) show(p); else hide(p);
      });
      selectors.forEach(function (b) {
        var isOn = b.getAttribute("data-history-select") === sel;
        b.setAttribute("aria-pressed", isOn ? "true" : "false");
        ON.forEach(function (c) { b.classList.toggle(c, isOn); });
      });
    }
    selectors.forEach(function (b) {
      on(b, "click", function () { showSel(b.getAttribute("data-history-select")); });
    });
    if (def) showSel(def);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Investigator chat — the one real client island. Talks to POST /api/chat,
  // persists the transcript per-user, cycles the "thinking" agents, and renders
  // casual / investigation replies (with a cooldown countdown on HTTP 429).
  // ═══════════════════════════════════════════════════════════════════════════
  var AGENT_ORDER = ["Graph Analyst", "Risk Analyst", "Compliance Officer", "Investigation Assistant"];
  var DEFAULT_LEVEL_TEXT = { high: "High risk", medium: "Needs a look", safe: "Clear" };

  function engineLabel(model) {
    if (model == null) return "gemini · 3.1-flash-live";
    if (model === "built-in engine") return model;
    return String(model).replace(/^models\//, "").replace(/^gemini-/, "gemini · ").replace(/-preview$/, "");
  }
  function nowLabel() {
    try { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  }
  function renderBold(text) {
    return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong style="color: var(--text-strong)">$1</strong>');
  }
  function paragraph(text) {
    var BULLET = /^\s*([•\-*]|\d+\.)\s/;
    var raw = String(text == null ? "" : text).split("\n");
    var lines = [];
    raw.forEach(function (ln) {
      if (BULLET.test(ln) || lines.length === 0) lines.push(ln);
      else if (ln.trim() !== "") lines[lines.length - 1] += " " + ln.trim();
    });
    var nonEmpty = lines.filter(function (l) { return l.trim().length; });
    var allBullets = nonEmpty.length > 1 && nonEmpty.every(function (l) { return BULLET.test(l); });
    if (allBullets) {
      var items = nonEmpty.map(function (l) {
        var m = l.match(BULLET);
        var marker = m[1];
        var bodyText = l.replace(BULLET, "");
        var isNum = /\d+\./.test(marker);
        return '<li class="flex gap-2"><span style="color: var(--muted)">' +
          (isNum ? esc(marker) : "•") + '</span><span>' + renderBold(bodyText) + "</span></li>";
      }).join("");
      return '<ul class="space-y-1">' + items + "</ul>";
    }
    return "<p>" + renderBold(String(text == null ? "" : text).replace(/\n/g, " ")) + "</p>";
  }

  function initChat() {
    var configEl = qs("[data-chat-config]");
    var messagesEl = qs("[data-chat-messages]");
    if (!configEl || !messagesEl) return;

    var config = {};
    try { config = JSON.parse(configEl.textContent || "{}"); } catch (e) { config = {}; }
    var uid = config.uid || "";
    var txCount = config.txCount || 0;
    var agentMeta = config.agentMeta || {};
    var levelText = config.levelText || DEFAULT_LEVEL_TEXT;
    var storageKey = uid ? "finguard-chat-" + uid : "finguard-chat";

    var scrollEl = qs("[data-chat-scroll]");
    var thinkingEl = qs("[data-chat-thinking]");
    var thinkingDot = qs("[data-chat-thinking-dot]");
    var thinkingLabel = qs("[data-chat-thinking-label]");
    var noticeEl = qs("[data-chat-notice]");
    var errorEl = qs("[data-chat-error]");
    var inputEl = qs("[data-chat-input]");
    var sendBtn = qs("[data-chat-send]");

    var ctxTx = qs("[data-chat-ctx-tx]");
    var ctxAnalysis = qs("[data-chat-ctx-analysis]");
    var ctxEvidence = qs("[data-chat-ctx-evidence]");
    var ctxAccounts = qs("[data-chat-ctx-accounts]");
    var ctxRings = qs("[data-chat-ctx-rings]");
    var ctxFindings = qs("[data-chat-ctx-findings]");
    var ctxHigh = qs("[data-chat-ctx-high]");
    var ctxModel = qs("[data-chat-ctx-model]");

    function freshSession() {
      return [{ id: "m0", role: "system", content: "Session opened — ask a question, or run a full investigation.", time: nowLabel() }];
    }

    var state = { messages: freshSession(), evidence: null, engine: null };
    var thinking = null, notice = "", aiError = "", cooldown = 0, cooldownTimer = null, busy = false;

    // hydrate
    try {
      var saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && Array.isArray(saved.messages) && saved.messages.length) {
        state.messages = saved.messages;
        state.evidence = saved.evidence || null;
        state.engine = saved.engine || null;
      }
    } catch (e) {}

    function persist() {
      try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (e) {}
    }

    function viewGraph(accounts) {
      if (!accounts || !accounts.length) return "";
      return '<a href="/graph?focus=' + encodeURIComponent(accounts.join(",")) +
        '" class="mt-2 inline-flex items-center gap-1 text-[12px] text-emerald-300 hover:text-emerald-200">View on graph →</a>';
    }
    function suggestions(list) {
      if (!list || !list.length) return "";
      return '<div class="mt-2 flex flex-wrap gap-2">' + list.map(function (q) {
        return '<button type="button" data-chat-suggest="' + esc(q) +
          '" class="text-left text-[12px] rounded-lg border px-2.5 py-1 hover:bg-[var(--hover)]" ' +
          'style="border-color: var(--border); background: var(--chip); color: var(--text)">' + esc(q) + "</button>";
      }).join("") + "</div>";
    }
    function agentPanel(p) {
      var meta = agentMeta[p.agent] || {};
      var conf = Math.round((p.confidence == null ? 0.85 : p.confidence) * 100);
      return '<div class="rounded-lg border p-3" style="border-color: var(--border); background: var(--chip)">' +
        '<div class="flex items-center gap-2">' +
        '<span class="grid place-items-center w-6 h-6 rounded-md text-[12px]" style="background: ' +
        (meta.bg || "var(--chip)") + "; color: " + (meta.color || "var(--text)") + '">' + esc(meta.icon || "●") + "</span>" +
        '<div class="text-[12.5px]" style="color: var(--text-strong)">' + esc(p.agent) + "</div>" +
        '<span class="ml-auto text-[11px]" style="color: var(--muted)">' + conf + "%</span></div>" +
        (p.headline ? '<div class="mt-1 text-[12px]" style="color: var(--text)">' + renderBold(p.headline) + "</div>" : "") +
        '<div class="mt-1 text-[12.5px]" style="color: var(--text)">' + paragraph(p.content) + "</div>" +
        (p.findings && p.findings.length ? '<ul class="mt-1 space-y-0.5">' + p.findings.map(function (f) {
          return '<li class="text-[12px]" style="color: var(--muted-2)">• ' + renderBold(f) + "</li>";
        }).join("") + "</ul>" : "") + "</div>";
    }

    function messageHtml(m) {
      if (m.role === "system") {
        return '<div class="flex justify-center"><span class="text-[11px] rounded-full px-3 py-1" ' +
          'style="background: var(--chip); color: var(--muted)">' + esc(m.content) + "</span></div>";
      }
      if (m.role === "user") {
        return '<div class="flex items-start gap-2 justify-end">' +
          '<div class="max-w-[80%] rounded-2xl rounded-tr-sm px-3.5 py-2 text-[13.5px] border border-sky-500/25 bg-sky-500/15" ' +
          'style="color: var(--text)">' + esc(m.content) + "</div>" +
          '<div class="grid place-items-center w-7 h-7 shrink-0 rounded-full bg-sky-500/20 text-sky-300 text-[11px] font-semibold">U</div></div>';
      }
      if (m.role === "report") {
        var level = (m.verdict && m.verdict.level) || "safe";
        var tone = severityColor(level);
        var lt = levelText[level] || level;
        var points = (m.verdict && m.verdict.points ? m.verdict.points : []).map(function (p) {
          return '<div class="mt-1 flex gap-2 text-[13px]" style="color: var(--text)"><span style="color: ' +
            tone + '">▸</span><span>' + renderBold(p) + "</span></div>";
        }).join("");
        var panels = m.panels || [];
        var breakdown = panels.length ? '<details class="mt-2"><summary class="cursor-pointer text-[12px]" ' +
          'style="color: var(--muted)">▾ Full breakdown (' + panels.length + ' agents)</summary>' +
          '<div class="mt-2 space-y-2">' + panels.map(agentPanel).join("") + "</div></details>" : "";
        return '<div class="flex items-start gap-2">' +
          '<div class="grid place-items-center w-7 h-7 shrink-0 rounded-full" style="background: ' + tone + "22; color: " + tone + '">◉</div>' +
          '<div class="min-w-0 flex-1">' +
          '<div class="flex items-center gap-2">' +
          '<span class="text-[11px] rounded px-1.5 py-0.5" style="background: ' + tone + "22; color: " + tone + '">' + esc(lt) + "</span>" +
          '<span class="text-[11px]" style="color: var(--muted)">' + esc(m.time || "") + "</span></div>" +
          '<div class="mt-1 text-[14px] font-semibold" style="color: var(--text-strong)">' + renderBold(m.content) + "</div>" +
          points + viewGraph(m.verdict && m.verdict.accounts) + breakdown + suggestions(m.suggestions) + "</div></div>";
      }
      // assistant
      return '<div class="flex items-start gap-2">' +
        '<div class="grid place-items-center w-7 h-7 shrink-0 rounded-full bg-emerald-500/15 text-emerald-300">◉</div>' +
        '<div class="min-w-0 flex-1">' +
        '<div class="flex items-center gap-2">' +
        '<span class="text-[11px] rounded px-1.5 py-0.5 bg-emerald-500/15 text-emerald-300">Assistant</span>' +
        '<span class="text-[11px]" style="color: var(--muted)">' + esc(m.time || "") + "</span></div>" +
        '<div class="mt-1 text-[13.5px] whitespace-pre-wrap" style="color: var(--text)">' + paragraph(m.content) + "</div>" +
        suggestions(m.suggestions) + "</div></div>";
    }

    function renderContext() {
      var ev = state.evidence;
      if (ctxTx) ctxTx.textContent = String(ev ? ev.txCount : txCount);
      if (ev) {
        if (ctxAnalysis) hide(ctxAnalysis);
        if (ctxEvidence) show(ctxEvidence);
        if (ctxAccounts) ctxAccounts.textContent = String(ev.accountCount || 0);
        if (ctxRings) ctxRings.textContent = String(ev.ringCount || 0);
        if (ctxFindings) ctxFindings.textContent = String(ev.findingCount || 0);
        if (ctxHigh) ctxHigh.textContent = String(ev.highCount || 0);
      } else {
        if (ctxAnalysis) show(ctxAnalysis);
        if (ctxEvidence) hide(ctxEvidence);
      }
      if (ctxModel) ctxModel.textContent = engineLabel(state.engine);
    }

    function renderThinking() {
      if (!thinkingEl) return;
      if (thinking) {
        var meta = agentMeta[thinking] || {};
        var color = meta.color || "#22c55e";
        if (thinkingDot) thinkingDot.style.background = color;
        if (thinkingLabel) { thinkingLabel.textContent = thinking; thinkingLabel.style.color = color; }
        show(thinkingEl);
      } else { hide(thinkingEl); }
    }

    function renderErrorNotice() {
      if (noticeEl) { if (notice) { noticeEl.textContent = notice; show(noticeEl); } else hide(noticeEl); }
      if (errorEl) {
        if (aiError) {
          var text = cooldown > 0
            ? aiError.replace(/\d+ seconds?/, cooldown + " second" + (cooldown === 1 ? "" : "s"))
            : aiError;
          errorEl.textContent = text;
          show(errorEl);
        } else hide(errorEl);
      }
    }

    function renderMessages() {
      messagesEl.innerHTML = state.messages.map(messageHtml).join("");
    }

    function scrollDown() {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function renderAll() {
      renderMessages();
      renderContext();
      renderThinking();
      renderErrorNotice();
      scrollDown();
    }

    function historyText(m) {
      var base = m.content;
      if (m.role !== "report" || !m.verdict) return base;
      var pts = (m.verdict.points || []).slice(0, 4).map(function (p) { return "• " + p; }).join("\n");
      var accounts = (m.verdict.accounts || []).slice(0, 10).join(", ");
      return [base, pts, accounts ? "Accounts implicated: " + accounts : ""].filter(Boolean).join("\n");
    }

    function startCooldown(sec) {
      cooldown = sec;
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = setInterval(function () {
        cooldown -= 1;
        if (cooldown <= 0) { clearInterval(cooldownTimer); cooldownTimer = null; cooldown = 0; }
        renderErrorNotice();
      }, 1000);
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function send(text, forcedMode) {
      if (!text || !text.trim() || busy) return;
      busy = true;
      if (sendBtn) sendBtn.disabled = true;
      notice = ""; aiError = ""; cooldown = 0;
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }

      // Prior turns (exclude system, exclude the message we're about to add).
      var history = state.messages.filter(function (m) { return m.role !== "system"; }).slice(-8).map(function (m) {
        return { role: m.role === "user" ? "user" : "assistant", content: historyText(m) };
      });

      state.messages.push({ id: "u" + Date.now(), role: "user", content: text, time: nowLabel() });
      if (inputEl) inputEl.value = "";
      thinking = "Assistant";
      renderAll();
      persist();

      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ message: text, mode: forcedMode, history: history })
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (errData) {
            if (res.status === 429 && typeof errData.retryAfter === "number") startCooldown(errData.retryAfter);
            throw new Error(errData.error || ("API returned " + res.status));
          });
        }
        return res.json();
      }).then(function (data) {
        if (!data) return;
        if (data.degraded) notice = "Live model unavailable — this reply uses the built-in engine.";
        if (data.evidence) state.evidence = data.evidence;
        state.engine = data.model != null ? data.model : "built-in engine";

        if (data.mode === "casual") {
          thinking = null;
          state.messages.push({
            id: "a" + Date.now(), role: "assistant",
            content: data.reply != null ? data.reply : "…",
            suggestions: data.suggestions || [], time: nowLabel()
          });
          renderAll(); persist();
          return;
        }

        // investigate — build panels in the canonical agent order.
        var agents = data.agents || [];
        var panels = [];
        AGENT_ORDER.forEach(function (name, i) {
          var a = agents.filter(function (x) {
            return String(x.agent || "").toLowerCase() === name.toLowerCase();
          })[0] || agents[i];
          if (!a || !a.content) return;
          panels.push({
            agent: a.agent || name, headline: a.headline, content: a.content,
            findings: a.findings || [], confidence: a.confidence == null ? 0.85 : a.confidence
          });
        });

        var chain = Promise.resolve();
        panels.forEach(function (p) {
          chain = chain.then(function () { thinking = p.agent; renderThinking(); return sleep(240); });
        });
        return chain.then(function () {
          thinking = null;
          state.messages.push({
            id: "r" + Date.now(), role: "report",
            content: (data.verdict && data.verdict.headline) || "Investigation complete.",
            verdict: data.verdict, panels: panels, suggestions: data.suggestions || [], time: nowLabel()
          });
          renderAll(); persist();
        });
      }).catch(function (err) {
        thinking = null;
        aiError = err && err.message ? err.message : "Something went wrong.";
        renderAll(); persist();
      }).then(function () {
        busy = false;
        if (sendBtn) sendBtn.disabled = false;
      });
    }

    // ── wiring ──
    on(sendBtn, "click", function () { if (inputEl) send(inputEl.value); });
    on(inputEl, "keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); send(inputEl.value); } });
    qsa("[data-chat-run-investigation]").forEach(function (b) {
      on(b, "click", function () { send("Run a full investigation on the uploaded transactions.", "investigate"); });
    });
    // Suggested queries — both the static rail and in-message chips (delegated).
    on(document, "click", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-chat-suggest]") : null;
      if (el) send(el.getAttribute("data-chat-suggest"));
    });
    on(qs("[data-chat-export]"), "click", function () {
      var text = state.messages.map(function (m) {
        var who = m.role === "report" ? "report" : m.role;
        return "[" + (m.time || "") + "] " + who + ": " + m.content;
      }).join("\n");
      var blob = new Blob([text], { type: "text/plain" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "transcript.txt";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    on(qs("[data-chat-reset]"), "click", function () {
      state.messages = [{ id: "m0", role: "system", content: "Session reset", time: nowLabel() }];
      state.evidence = null; state.engine = null;
      thinking = null; notice = ""; aiError = ""; cooldown = 0;
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
      renderAll(); persist();
    });

    renderAll();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SAR — the print button. app.css hides everything but #sar-print-portal.
  // ═══════════════════════════════════════════════════════════════════════════
  function initSar() {
    qsa("[data-sar-print]").forEach(function (b) {
      on(b, "click", function () { window.print(); });
    });
  }

  // ── boot ────────────────────────────────────────────────────────────────────
  function boot() {
    initTheme();
    initLive();
    initNav();
    initConfirm();
    initAlerts();
    initTransactions();
    initGraph();
    initUpload();
    initChat();
    initSar();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
