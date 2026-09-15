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

  // The CSV importer (initUpload / initUploadHistory) was removed with the
  // Upload CSV tab — the Chain Tracer (initCryptoTrace) is the only feature on
  // that route now. See initCryptoTrace below.


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

  // ═══════════════════════════════════════════════════════════════════════════
  // Toasts — transient confirmations rendered into [data-toast-container] (base.html).
  // Ported from the TRINETRA reference UI; exposed on window.FinGuard for inline use.
  // ═══════════════════════════════════════════════════════════════════════════
  function showToast(message, opts) {
    opts = opts || {};
    var host = qs("[data-toast-container]");
    if (!host) return;
    var t = document.createElement("div");
    t.className = "toast";
    var iconMap = {
      success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="#f87171" stroke-width="2.2" stroke-linecap="round"/></svg>',
      info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#38bdf8" stroke-width="1.8"/><path d="M12 11v5M12 8h.01" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round"/></svg>'
    };
    var kind = opts.type && iconMap[opts.type] ? opts.type : "success";
    t.innerHTML = iconMap[kind] + '<span>' + esc(message) + '</span>';
    host.appendChild(t);
    var ttl = typeof opts.duration === "number" ? opts.duration : 2600;
    setTimeout(function () {
      t.classList.add("toast-out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, ttl);
  }

  // Copy-to-clipboard chips: any [data-copy] element copies its data-copy value
  // (or its text content) and flashes a toast. Delegated so it covers dynamically
  // rendered rows (graph drawer, chat, etc.).
  function initCopyActions() {
    on(document, "click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-copy]") : null;
      if (!el) return;
      e.preventDefault();
      var value = el.getAttribute("data-copy");
      if (value == null || value === "") value = (el.textContent || "").trim();
      if (!value) return;
      var done = function () { showToast(el.getAttribute("data-copy-label") || "Copied to clipboard"); };
      var fallback = function () {
        try {
          var ta = document.createElement("textarea");
          ta.value = value; ta.setAttribute("readonly", "");
          ta.style.position = "absolute"; ta.style.left = "-9999px";
          document.body.appendChild(ta); ta.select();
          document.execCommand("copy"); document.body.removeChild(ta);
          done();
        } catch (err) { showToast("Copy failed", { type: "error" }); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, fallback);
      } else {
        fallback();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // On-chain wallet trace → interactive "Deep Investigation" graph. A single
  // pasted address is auto-routed to its chain and traced by the forensic engine
  // (POST /api/crypto-trace); app.js renders the returned trace_result.graph as a
  // typed, colour-coded Cytoscape network with a node-details panel and a
  // transaction timeline, modelled on the TRINETRA reference UI.
  // ═══════════════════════════════════════════════════════════════════════════
  var TRACE_NET = { EVM: "eth-mainnet", TRON: "tron-mainnet", BTC: "btc-mainnet" };
  var TRACE_NET_LABEL = { EVM: "Ethereum", TRON: "TRON", BTC: "Bitcoin" };

  var NETWORK_LABEL = {
    "eth-mainnet": "Ethereum", "bnb-mainnet": "BNB Chain", "polygon-mainnet": "Polygon",
    "arb-mainnet": "Arbitrum", "base-mainnet": "Base", "btc-mainnet": "Bitcoin", "tron-mainnet": "TRON"
  };
  // Node categories → legend colours (match the reference legend exactly).
  var NODE_CAT = {
    subject:      { color: "#ef4444", label: "Subject / Victim", icon: "🎯" },
    intermediary: { color: "#a78bfa", label: "Intermediate wallet", icon: "👛" },
    bridge:       { color: "#3b82f6", label: "DEX / Bridge", icon: "🌉" },
    vasp:         { color: "#22c55e", label: "Exchange (VASP)", icon: "🏦" },
    mixer:        { color: "#eab308", label: "Mixer / Privacy", icon: "🌀" },
    sanctioned:   { color: "#ec4899", label: "Sanctioned / Threat", icon: "⚠" }
  };
  function traceCategoryOf(n) {
    var t = (n.type || "").toUpperCase();
    if ((n.hop_distance || 0) === 0) return "subject";
    if (/SANCTION|THREAT|NATION_STATE/.test(t)) return "sanctioned";
    if (/MIXER/.test(t)) return "mixer";
    if (/BRIDGE|DEX|CROSS_CHAIN/.test(t)) return "bridge";
    if (/VASP/.test(t)) return "vasp";
    return "intermediary";
  }
  function traceShortAddr(a) { a = a || ""; return a.length > 16 ? a.slice(0, 8) + "…" + a.slice(-6) : a; }
  function traceNodeName(n) {
    if ((n.hop_distance || 0) === 0) return "Subject wallet";
    var first = (n.label || "").split("\n")[0].trim();
    var stripped = first.replace(/^(VASP|MIXER|BRIDGE|THREAT|UNMASKED EXIT|CROSS[- ]CHAIN MINT|Infra|Intermediary|BURNER|Inflow Feeder|Gas Parent|CASHOUT)\b\s*[:>\-]*\s*/i, "").trim();
    if (stripped && !/^0x/i.test(stripped) && stripped.indexOf("…") === -1 && stripped.indexOf("...") === -1) return stripped;
    return traceShortAddr(n.id);
  }
  function traceExplorerAddr(network, addr) {
    if (network === "btc-mainnet") return "https://mempool.space/address/" + addr;
    if (network === "tron-mainnet") return "https://tronscan.org/#/address/" + addr;
    var m = { "eth-mainnet": "https://etherscan.io", "bnb-mainnet": "https://bscscan.com", "polygon-mainnet": "https://polygonscan.com", "arb-mainnet": "https://arbiscan.io", "base-mainnet": "https://basescan.org" };
    return (m[network] || "https://etherscan.io") + "/address/" + addr;
  }
  function traceExplorerTx(network, hash) {
    if (!hash) return null;
    if (network === "btc-mainnet") return "https://mempool.space/tx/" + hash;
    if (network === "tron-mainnet") return "https://tronscan.org/#/transaction/" + hash;
    var m = { "eth-mainnet": "https://etherscan.io", "bnb-mainnet": "https://bscscan.com", "polygon-mainnet": "https://polygonscan.com", "arb-mainnet": "https://arbiscan.io", "base-mainnet": "https://basescan.org" };
    return (m[network] || "https://etherscan.io") + "/tx/" + hash;
  }
  function traceAmt(v, asset) {
    v = Number(v || 0);
    var s = v.toLocaleString("en-US", { maximumFractionDigits: v >= 1 ? 2 : 6 });
    return s + (asset ? " " + asset : "");
  }
  function traceUsd(v) { try { return "$" + Number(v || 0).toLocaleString("en-US", { maximumFractionDigits: 0 }); } catch (e) { return "$" + (v || 0); } }
  function traceInr(v) { try { return "₹" + Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 }); } catch (e) { return "₹" + (v || 0); } }
  function traceIST(ts) {
    ts = Number(ts || 0); if (!ts) return "—";
    try { return new Date(ts * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return "—"; }
  }
  function traceRisk(taint) {
    taint = Number(taint || 0);
    if (taint >= 0.66) return { label: "High", color: "#ef4444" };
    if (taint >= 0.33) return { label: "Medium", color: "#f59e0b" };
    return { label: "Low", color: "#22c55e" };
  }
  function traceEdgeType(byId, e) {
    var tgt = byId[e.target] || {}; var cat = traceCategoryOf(tgt);
    return cat === "bridge" ? "Swap/Bridge" : cat === "vasp" ? "Cash-out" : cat === "mixer" ? "Mixer" : "Transfer";
  }

  function classifyWalletAddress(v) {
    v = (v || "").trim();
    if (!v) return null;
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return "EVM";
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v)) return "TRON";
    var lo = v.toLowerCase();
    if (lo.indexOf("bc1") === 0) return /^bc1[ac-hj-np-z02-9]{11,71}$/.test(lo) ? "BTC" : null;
    if (/^[13][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(v)) return "BTC";
    return null;
  }

  function initCryptoTrace() {
    var root = qs("[data-trace-root]");
    if (!root) return;
    var endpoint = root.getAttribute("data-trace-endpoint") || "/api/crypto-trace";
    var addrInput = qs("[data-trace-address-input]", root);
    var detectedEl = qs("[data-trace-detected]", root);
    var runBtn = qs("[data-trace-run]", root);
    var statusEl = qs("[data-trace-status]", root);
    var region = qs("[data-inv-region]", root);

    // Investigation state, shared across the renderers + toolbar bindings below.
    var cy = null;               // current Cytoscape instance (destroyed on re-run)
    var lastGraph = null;        // { nodes, edges, byId, network }
    var traceNetwork = "eth-mainnet";
    var lastExport = null;       // payload for the "Export graph (JSON)" button

    // Show which chain the pasted address routes to. The network is derived from
    // the address shape alone — there is no coin picker.
    function updateDetected() {
      if (!detectedEl) return;
      var v = addrInput ? addrInput.value.trim() : "";
      if (!v) {
        detectedEl.textContent = "Enter an address and its chain is detected automatically.";
        detectedEl.style.color = "var(--muted-2)";
        return;
      }
      var fam = classifyWalletAddress(v);
      if (fam) {
        detectedEl.innerHTML = 'Detected chain: <span style="color: var(--accent-2)">' + esc(TRACE_NET_LABEL[fam]) +
          '</span> <span style="color: var(--muted)">(' + esc(fam) + ' · ' + esc(TRACE_NET[fam]) + ')</span>';
        detectedEl.style.color = "var(--muted-2)";
      } else {
        detectedEl.textContent = "Unrecognized address — expected 0x… (Ethereum), T… (TRON) or 1 / 3 / bc1… (Bitcoin).";
        detectedEl.style.color = "#ef4444";
      }
    }

    // Example chips just fill the address field; the chain still auto-detects.
    qsa("[data-trace-example]", root).forEach(function (btn) {
      on(btn, "click", function () {
        if (addrInput) { addrInput.value = btn.getAttribute("data-trace-address") || ""; addrInput.focus(); }
        updateDetected();
      });
    });

    function setStatus(html, tone) {
      if (!statusEl) return;
      statusEl.innerHTML = html;
      statusEl.style.borderColor = tone === "err" ? "rgba(239,68,68,0.45)" : tone === "ok" ? "rgba(34,197,94,0.45)" : "var(--border)";
      show(statusEl);
    }
    function fmt(n, cur) {
      try { return (cur === "usd" ? "$" : "₹") + Number(n || 0).toLocaleString(cur === "usd" ? "en-US" : "en-IN", { maximumFractionDigits: cur === "usd" ? 2 : 0 }); }
      catch (e) { return (cur === "usd" ? "$" : "₹") + (n || 0); }
    }

    function catColor(cat) { return (NODE_CAT[cat] || NODE_CAT.intermediary).color; }
    function catIcon(cat) { return (NODE_CAT[cat] || NODE_CAT.intermediary).icon; }
    function prettyStatus(s) { return String(s || "").replace(/_/g, " ").toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }); }
    function detailRow(k, v) {
      return '<div class="mt-2.5 flex items-center justify-between gap-2 text-[12px]">' +
        '<span style="color: var(--muted)">' + esc(k) + '</span>' +
        '<span class="font-mono text-right" style="color: var(--text)">' + esc(String(v)) + '</span></div>';
    }
    function copyText(t) { try { navigator.clipboard.writeText(t); showToast("Address copied"); } catch (e) {} }

    // Build Cytoscape elements + a preset (hierarchical) layout from hop_distance.
    function buildElements(g) {
      var byId = {};
      (g.nodes || []).forEach(function (n) { byId[n.id] = n; });
      var buckets = {};
      (g.nodes || []).forEach(function (n) { var h = n.hop_distance || 0; (buckets[h] = buckets[h] || []).push(n); });
      var colGap = 240, rowGap = 92, baseY = 300, els = [];
      Object.keys(buckets).forEach(function (h) {
        var arr = buckets[h], m = arr.length;
        arr.forEach(function (n, i) {
          var cat = traceCategoryOf(n);
          var size = cat === "subject" ? 60 : (cat === "intermediary" ? 40 : 48);
          els.push({
            data: {
              id: n.id, name: traceNodeName(n), category: cat, color: catColor(cat), size: size,
              isRoot: (n.hop_distance || 0) === 0 ? 1 : 0,
              chain: NETWORK_LABEL[traceNetwork] || traceNetwork, raw: n
            },
            position: { x: 90 + Number(h) * colGap, y: baseY + (i - (m - 1) / 2) * rowGap }
          });
        });
      });
      (g.edges || []).forEach(function (e) {
        if (!byId[e.source] || !byId[e.target]) return;
        var risk = traceRisk(e.taint_ratio);
        var type = traceEdgeType(byId, e);
        els.push({
          data: {
            id: e.id || (e.source + "->" + e.target), source: e.source, target: e.target,
            label: traceAmt(e.value, e.asset), type: type,
            color: risk.color === "#22c55e" ? "#94a3b8" : risk.color,
            width: (e.taint_ratio || 0) >= 0.66 ? 2.6 : 1.5,
            chain: NETWORK_LABEL[traceNetwork] || traceNetwork, raw: e
          }
        });
      });
      return { els: els, byId: byId };
    }

    // Cytoscape stylesheet, resolved against the live CSS theme variables so the
    // graph matches light/dark like the rest of the console.
    function cyStyle() {
      var css = getComputedStyle(document.documentElement);
      function v(name, fb) { var x = (css.getPropertyValue(name) || "").trim(); return x || fb; }
      var textCol = v("--text", "#0f172a"), panelCol = v("--panel", "#ffffff"),
          bgCol = v("--bg", "#f8fafc"), mutedCol = v("--muted", "#64748b");
      return [
        { selector: "node", style: {
          "background-color": "data(color)", "background-opacity": 0.18,
          "border-color": "data(color)", "border-width": 2.4,
          "width": "data(size)", "height": "data(size)", "shape": "round-rectangle",
          "label": "data(name)", "font-size": 10, "font-family": "JetBrains Mono, monospace",
          "color": textCol, "text-valign": "bottom", "text-margin-y": 6,
          "text-max-width": 130, "text-wrap": "wrap",
          "text-outline-color": panelCol, "text-outline-width": 2.5
        } },
        { selector: "node[isRoot = 1]", style: { "border-width": 3.6, "background-opacity": 0.3, "font-weight": "bold", "font-size": 11 } },
        { selector: "node:selected", style: { "border-width": 4.5, "background-opacity": 0.34 } },
        { selector: "node.faded", style: { "opacity": 0.12 } },
        { selector: "node.match", style: { "border-color": "#38bdf8", "border-width": 4.5 } },
        { selector: "edge", style: {
          "width": "data(width)", "line-color": "data(color)",
          "target-arrow-color": "data(color)", "target-arrow-shape": "triangle",
          "curve-style": "bezier", "arrow-scale": 1.1,
          "label": "data(label)", "font-size": 9, "font-family": "JetBrains Mono, monospace",
          "color": mutedCol, "text-background-color": bgCol, "text-background-opacity": 0.92,
          "text-background-padding": 2, "text-rotation": "autorotate"
        } },
        { selector: 'edge[type = "Swap/Bridge"]', style: { "line-style": "dashed", "line-color": "#3b82f6", "target-arrow-color": "#3b82f6" } },
        { selector: "edge.faded", style: { "opacity": 0.07, "text-opacity": 0 } }
      ];
    }

    function runLayout(name) {
      if (!cy) return;
      if (name === "hierarchical") {
        cy.nodes().forEach(function (nd) { var p = nd.scratch("_pos"); if (p) nd.position(p); });
        cy.fit(undefined, 40); return;
      }
      var opts = { name: name, animate: false, fit: true, padding: 40 };
      if (name === "breadthfirst") {
        opts.directed = true; opts.spacingFactor = 1.1;
        var roots = cy.nodes("[isRoot = 1]"); if (roots.length) opts.roots = roots;
      }
      if (name === "concentric") {
        opts.concentric = function (n) { return 10 - (n.data("raw").hop_distance || 0); };
        opts.levelWidth = function () { return 2; };
      }
      cy.layout(opts).run();
    }

    function updateOverview() {
      var el = qs("[data-inv-overview]", root); if (!el || !cy) return;
      el.textContent = cy.nodes().length + " nodes · " + cy.edges().length + " edges · " + Math.round(cy.zoom() * 100) + "%";
    }
    function clearHighlight() { if (cy) cy.elements().removeClass("faded match"); }

    function buildGraph(g) {
      var wrap = qs("[data-inv-cy]", root); if (!wrap) return;
      var emptyEl = qs("[data-inv-cy-empty]", root);
      if (typeof cytoscape === "undefined") {
        if (emptyEl) { emptyEl.style.display = "grid"; emptyEl.textContent = "Graph library failed to load — check your connection and retry."; }
        return;
      }
      var built = buildElements(g);
      lastGraph = { nodes: g.nodes || [], edges: g.edges || [], byId: built.byId, network: traceNetwork };
      if (cy) { try { cy.destroy(); } catch (e) {} cy = null; }
      cy = cytoscape({
        container: wrap, elements: built.els, style: cyStyle(),
        layout: { name: "preset" }, wheelSensitivity: 0.2, minZoom: 0.15, maxZoom: 3
      });
      // Stash preset positions so the "Hierarchical" layout option can restore them.
      cy.nodes().forEach(function (nd) { nd.scratch("_pos", { x: nd.position("x"), y: nd.position("y") }); });
      cy.fit(undefined, 40);
      if (emptyEl) emptyEl.style.display = built.els.length ? "none" : "grid";
      updateOverview();
      cy.on("tap", "node", function (evt) { showNodeDetails(evt.target); });
      cy.on("tap", function (evt) { if (evt.target === cy) { clearHighlight(); resetDetails(); } });
      cy.on("zoom pan", updateOverview);
    }

    function showNodeDetails(node) {
      var panel = qs("[data-inv-details]", root); if (!panel || !cy) return;
      var n = node.data("raw"), cat = node.data("category"), col = node.data("color"), addr = n.id;
      var inUsd = 0, outUsd = 0, inCt = 0, outCt = 0, times = [];
      (lastGraph.edges || []).forEach(function (e) {
        if (e.source === addr || e.target === addr) { if (e.timestamp) times.push(e.timestamp); }
        if (e.target === addr) { inUsd += Number(e.value_usd || 0); inCt++; }
        if (e.source === addr) { outUsd += Number(e.value_usd || 0); outCt++; }
      });
      var first = times.length ? Math.min.apply(null, times) : 0;
      var last = times.length ? Math.max.apply(null, times) : 0;
      var taintPct = Math.round((n.taint_ratio || 0) * 100);
      var taintCol = taintPct >= 66 ? "#ef4444" : taintPct >= 33 ? "#f59e0b" : "#22c55e";
      var catMeta = NODE_CAT[cat] || NODE_CAT.intermediary;

      // Focus the neighbourhood of the tapped node.
      cy.elements().addClass("faded");
      node.removeClass("faded"); node.closedNeighborhood().removeClass("faded");
      cy.$(":selected").unselect(); node.select();

      var basis = [];
      if (n.status) basis.push(prettyStatus(n.status));
      basis.push("Node type: " + (n.type || "—"));
      basis.push("Hop distance from subject: " + (n.hop_distance || 0));
      if (cat === "vasp") basis.push("Consistent with an exchange deposit endpoint");
      if (cat === "mixer") basis.push("Interacted with a mixer / privacy protocol");
      if (cat === "bridge") basis.push("Routed value through a cross-chain bridge / DEX");
      if (cat === "sanctioned") basis.push("Matches sanctioned / threat-actor intelligence");

      var explorer = traceExplorerAddr(lastGraph.network, addr);
      panel.innerHTML =
        '<div class="flex items-center gap-3">' +
          '<span class="grid h-11 w-11 place-items-center rounded-xl text-[18px]" style="background:' + col + '22; color:' + col + '">' + catIcon(cat) + '</span>' +
          '<div class="min-w-0"><div class="text-[15px] font-semibold truncate" style="color: var(--text-strong)">' + esc(node.data("name")) + '</div>' +
          '<div class="text-[11px]" style="color:' + col + '">' + esc(catMeta.label) + '</div></div>' +
        '</div>' +
        '<div class="mt-3 rounded-lg border p-2.5 flex items-center gap-2" style="border-color: var(--border); background: var(--chip)">' +
          '<span class="flex-1 min-w-0 truncate font-mono text-[12px]" style="color: var(--text)">' + esc(addr) + '</span>' +
          '<button type="button" data-inv-copy="' + esc(addr) + '" class="grid h-6 w-6 place-items-center rounded-md border" style="border-color: var(--border); color: var(--muted)" title="Copy address">⧉</button>' +
        '</div>' +
        detailRow("Chain", NETWORK_LABEL[lastGraph.network] || lastGraph.network) +
        detailRow("First seen", traceIST(first)) +
        detailRow("Last activity", traceIST(last)) +
        detailRow("Total inflow", traceUsd(inUsd) + " · " + inCt + " tx") +
        detailRow("Total outflow", traceUsd(outUsd) + " · " + outCt + " tx") +
        detailRow("Valuation", traceUsd(n.valuation_usd) + " · " + traceInr(n.valuation_inr)) +
        '<div class="mt-3"><div class="flex items-center justify-between text-[11px]"><span style="color: var(--muted)">Taint score</span>' +
          '<span class="font-mono" style="color:' + taintCol + '">' + taintPct + '%</span></div>' +
          '<div class="mt-1 h-1.5 rounded-full overflow-hidden" style="background: var(--border)"><div class="h-full" style="width:' + taintPct + '%; background:' + taintCol + '"></div></div></div>' +
        '<div class="mt-3"><div class="text-[10px] uppercase tracking-widest mb-1.5" style="color: var(--muted)">Attribution basis</div>' +
          '<div class="space-y-1">' + basis.map(function (b) { return '<div class="flex items-start gap-1.5 text-[12px]" style="color: var(--text)"><span style="color:#22c55e">✓</span><span>' + esc(b) + '</span></div>'; }).join("") + '</div></div>' +
        '<div class="mt-4"><a href="' + esc(explorer) + '" target="_blank" rel="noopener" class="block text-center text-[12px] rounded-lg border px-3 py-2 transition hover:bg-[var(--hover)]" style="border-color: var(--border); color: var(--text)">Show in block explorer ↗</a></div>';
      var cp = qs("[data-inv-copy]", panel);
      if (cp) on(cp, "click", function () { copyText(cp.getAttribute("data-inv-copy")); });
    }

    function resetDetails() {
      var panel = qs("[data-inv-details]", root); if (!panel) return;
      panel.innerHTML = '<div class="grid place-items-center py-16 text-center text-[12.5px]" style="color: var(--muted-2)">' +
        '<div class="text-[26px] mb-2 opacity-40">◉</div>Click any node in the graph to inspect the wallet, its taint and attribution basis.</div>';
    }

    function renderTimeline(edges) {
      var body = qs("[data-inv-timeline]", root), cnt = qs("[data-inv-tl-count]", root);
      if (cnt) cnt.textContent = edges.length;
      if (!body) return;
      var rows = edges.slice(0, 200).map(function (e, i) {
        var risk = traceRisk(e.taint_ratio), type = traceEdgeType(lastGraph.byId, e);
        var tx = traceExplorerTx(lastGraph.network, e.tx_hash);
        return '<tr>' +
          '<td class="font-mono" style="color: var(--muted)">' + (i + 1) + '</td>' +
          '<td>' + (tx ? '<a href="' + esc(tx) + '" target="_blank" rel="noopener" class="link-hash">' + esc(traceShortAddr(e.tx_hash)) + '</a>' : '<span class="link-hash">' + esc(traceShortAddr(e.tx_hash || "—")) + '</span>') + '</td>' +
          '<td class="font-mono text-[11.5px]">' + esc(traceShortAddr(e.source)) + '</td>' +
          '<td class="font-mono text-[11.5px]">' + esc(traceShortAddr(e.target)) + '</td>' +
          '<td class="text-right font-mono" style="color: var(--text-strong)">' + esc(traceAmt(e.value, "")) + '</td>' +
          '<td>' + esc(e.asset || "—") + '</td>' +
          '<td>' + esc(NETWORK_LABEL[lastGraph.network] || lastGraph.network) + '</td>' +
          '<td class="font-mono text-[11.5px]" style="color: var(--muted)">' + esc(traceIST(e.timestamp)) + '</td>' +
          '<td class="text-[11.5px]">' + esc(type) + '</td>' +
          '<td><span class="rounded px-1.5 py-0.5 text-[10.5px] font-medium" style="background:' + risk.color + '22; color:' + risk.color + '">' + risk.label + '</span></td>' +
        '</tr>';
      }).join("");
      body.innerHTML = rows || '<tr><td colspan="10" class="text-center py-6" style="color: var(--muted)">No transactions in this trace.</td></tr>';
    }

    function renderFlow(edges) {
      var body = qs("[data-inv-flow]", root), cnt = qs("[data-inv-flow-count]", root);
      if (cnt) cnt.textContent = edges.length;
      if (!body) return;
      body.innerHTML = edges.map(function (e, i) {
        var type = traceEdgeType(lastGraph.byId, e);
        var tx = traceExplorerTx(lastGraph.network, e.tx_hash);
        var hay = ((e.tx_hash || "") + " " + (e.source || "") + " " + (e.target || "") + " " + (e.asset || "")).toLowerCase();
        return '<tr data-flow-row data-flow-search="' + esc(hay) + '">' +
          '<td class="font-mono" style="color: var(--muted)">' + (i + 1) + '</td>' +
          '<td>' + (tx ? '<a href="' + esc(tx) + '" target="_blank" rel="noopener" class="link-hash">' + esc(traceShortAddr(e.tx_hash)) + '</a>' : '<span class="link-hash">' + esc(traceShortAddr(e.tx_hash || "—")) + '</span>') + '</td>' +
          '<td class="font-mono text-[11.5px]">' + esc(traceShortAddr(e.source)) + '</td>' +
          '<td class="font-mono text-[11.5px]">' + esc(traceShortAddr(e.target)) + '</td>' +
          '<td class="text-right font-mono" style="color: var(--text-strong)">' + esc(traceAmt(e.value, "")) + '</td>' +
          '<td class="text-right font-mono" style="color: var(--muted)">' + esc(traceUsd(e.value_usd)) + '</td>' +
          '<td>' + esc(e.asset || "—") + '</td>' +
          '<td>' + esc(NETWORK_LABEL[lastGraph.network] || lastGraph.network) + '</td>' +
          '<td class="font-mono">' + (e.hop != null ? e.hop : "—") + '</td>' +
          '<td class="font-mono text-[11.5px]" style="color: var(--muted)">' + esc(traceIST(e.timestamp)) + '</td>' +
          '<td class="text-[11.5px]">' + esc(type) + '</td>' +
          '<td class="font-mono">' + Math.round((e.taint_ratio || 0) * 100) + '%</td>' +
        '</tr>';
      }).join("") || '<tr><td colspan="12" class="text-center py-6" style="color: var(--muted)">No transactions.</td></tr>';
    }

    function renderAttribution(tr) {
      var vwrap = qs("[data-inv-attr-vasps]", root), ewrap = qs("[data-inv-attr-events]", root);
      if (vwrap) {
        var vasps = tr.attributed_vasps || [];
        vwrap.innerHTML = vasps.length ? vasps.map(function (v) {
          var name = v.vasp_name || v.name || "Unknown VASP";
          var conf = v.confidence != null ? Math.round(v.confidence * (v.confidence <= 1 ? 100 : 1)) + "%" : "";
          return '<div class="rounded-lg border p-3" style="border-color: var(--border); background: var(--chip)">' +
            '<div class="flex items-center justify-between gap-2"><span class="text-[13px] font-semibold" style="color: var(--text-strong)">' + esc(name) + '</span>' +
            (conf ? '<span class="text-[11px] font-mono" style="color:#22c55e">' + esc(conf) + '</span>' : '') + '</div>' +
            (v.entity ? '<div class="text-[11.5px] mt-0.5" style="color: var(--muted-2)">' + esc(v.entity) + '</div>' : '') +
            (v.statutory_action ? '<div class="mt-1.5 inline-block rounded px-1.5 py-0.5 text-[10.5px]" style="background:#ef444422; color:#ef4444">' + esc(v.statutory_action) + '</div>' : '') +
          '</div>';
        }).join("") : '<div class="text-[12.5px]" style="color: var(--muted-2)">No exchange endpoints attributed in this trace.</div>';
      }
      if (ewrap) {
        var items = [];
        function name_of(x, fb) { return typeof x === "string" ? x : (x && (x.name || x.type || x.typology || x.mixer || x.bridge)) || fb; }
        (tr.typologies_detected || []).forEach(function (t) { items.push(["Typology", name_of(t, "Typology"), "#a78bfa"]); });
        (tr.mixer_events || []).forEach(function (m) { items.push(["Mixer", name_of(m, "Mixer interaction"), "#eab308"]); });
        (tr.bridge_events || []).forEach(function (b) { items.push(["Bridge", name_of(b, "Cross-chain bridge"), "#3b82f6"]); });
        (tr.threat_actors_detected || []).forEach(function (t) { items.push(["Threat actor", name_of(t, "Threat actor"), "#ec4899"]); });
        ewrap.innerHTML = items.length ? items.map(function (it) {
          return '<div class="flex items-center gap-2.5 rounded-lg border px-3 py-2" style="border-color: var(--border); background: var(--chip)">' +
            '<span class="w-2 h-2 rounded-full" style="background:' + it[2] + '"></span>' +
            '<span class="text-[10.5px] uppercase tracking-widest" style="color: var(--muted)">' + esc(it[0]) + '</span>' +
            '<span class="text-[12.5px]" style="color: var(--text)">' + esc(it[1]) + '</span></div>';
        }).join("") : '<div class="text-[12.5px]" style="color: var(--muted-2)">No typologies or risk events flagged.</div>';
      }
    }

    function populateChainFilter(g) {
      var sel = qs("[data-inv-chain]", root); if (!sel) return;
      var chains = {}; chains[NETWORK_LABEL[traceNetwork] || traceNetwork] = true;
      (g.nodes || []).forEach(function (n) {
        var mm = /MINT[^(]*\(([^)]+)\)|->\s*([A-Za-z][\w ]+)/.exec(n.label || "");
        if (mm) { var c = (mm[1] || mm[2] || "").trim(); if (c && c.toUpperCase() !== "MULTI_CHAIN") chains[c] = true; }
      });
      sel.innerHTML = '<option value="__all__">All chains</option>' +
        Object.keys(chains).map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join("");
    }

    function setKpi(k, val) { var el = qs('[data-inv-kpi="' + k + '"]', root); if (el) el.textContent = String(val); }

    function switchTab(key) {
      qsa("[data-inv-tab]", root).forEach(function (b) {
        var on_ = b.getAttribute("data-inv-tab") === key;
        b.style.color = on_ ? "var(--accent-2)" : "var(--muted-2)";
        b.style.borderBottom = on_ ? "2px solid var(--accent-2)" : "2px solid transparent";
      });
      qsa("[data-inv-pane]", root).forEach(function (p) {
        if (p.getAttribute("data-inv-pane") === key) show(p); else hide(p);
      });
      if (key === "graph" && cy) setTimeout(function () { cy.resize(); cy.fit(undefined, 40); }, 30);
    }

    function renderInvestigation(data) {
      var tr = data.trace_result || {}, g = tr.graph || {};
      traceNetwork = tr.network || traceNetwork;
      var subj = qs("[data-inv-subject]", root); if (subj) subj.textContent = tr.root_address || "—";
      var meta = qs("[data-inv-meta]", root);
      if (meta) meta.textContent = (NETWORK_LABEL[traceNetwork] || traceNetwork) + " · depth " +
        (tr.max_depth_traversed != null ? tr.max_depth_traversed : "—") + " · " +
        ((g.nodes || []).length) + " nodes · " + ((g.edges || []).length) + " edges";
      var verdict = qs("[data-inv-verdict]", root); if (verdict) verdict.textContent = tr.verdict_badge || "TRACE COMPLETE";

      var chip = qs("[data-inv-neo4j]", root);
      if (chip) {
        var ne = data.neo4j || {};
        if (ne.enabled && ne.ok) { chip.textContent = "◉ Neo4j · " + (ne.nodes || 0) + " nodes"; chip.style.color = "#22c55e"; chip.title = "Persisted to Neo4j graph store"; }
        else { chip.textContent = "◇ Neo4j · off"; chip.style.color = "var(--muted)"; chip.title = ne.reason || "Graph store not configured"; }
      }

      setKpi("confidence", (tr.confidence_score != null ? tr.confidence_score + "%" : "—") + (tr.confidence_tier ? " · " + tr.confidence_tier : ""));
      setKpi("seizure_usd", traceUsd(tr.total_seizure_quantum_usd));
      setKpi("hops", tr.max_depth_traversed != null ? tr.max_depth_traversed : "—");
      setKpi("vasps", (tr.attributed_vasps || []).length);
      setKpi("evidence", (tr.evidence_ledger || []).length + " sealed");
      setKpi("exec", tr.execution_time_seconds != null ? tr.execution_time_seconds + "s" : "—");

      lastExport = { trace_result: tr, verdict: data.verdict, neo4j: data.neo4j };

      buildGraph(g);
      renderTimeline(g.edges || []);
      renderFlow(g.edges || []);
      renderAttribution(tr);
      populateChainFilter(g);
      resetDetails();
      show(region);
      switchTab("graph");
      if (region && region.scrollIntoView) region.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function runTrace() {
      var address = addrInput ? addrInput.value.trim() : "";
      if (!address) { setStatus("Enter a suspect wallet address first.", "err"); return; }
      var fam = classifyWalletAddress(address);
      if (!fam) { setStatus("That does not look like an EVM (0x…), TRON (T…) or Bitcoin (1/3/bc1…) address.", "err"); return; }
      var network = TRACE_NET[fam];
      if (runBtn) runBtn.disabled = true;
      if (region) hide(region);
      setStatus("Tracing " + esc(address.slice(0, 12)) + "… on " + esc(network) + " — sealing on-chain evidence, this can take a few seconds…", null);
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address, network: network, max_depth: 4 })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      }).then(function (r) {
        if (r.ok && r.data && r.data.success) {
          setStatus("Trace complete — investigation graph ready.", "ok");
          renderInvestigation(r.data);
        } else if (r.status === 503 || (r.data && r.data.needs_config)) {
          setStatus("The trace engine is not configured on the server yet (missing ALCHEMY_API_KEY).", "err");
        } else {
          setStatus("Trace failed: " + esc((r.data && r.data.error) || ("HTTP " + r.status)), "err");
        }
      }).catch(function (err) {
        setStatus("Trace request failed: " + esc(err && err.message ? err.message : String(err)), "err");
      }).then(function () {
        if (runBtn) runBtn.disabled = false;
      });
    }

    on(runBtn, "click", runTrace);
    on(addrInput, "keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runTrace(); } });
    on(addrInput, "input", updateDetected);

    // ── Investigation toolbar / tabs (bound once; act on the live `cy`) ──
    qsa("[data-inv-tab]", root).forEach(function (b) { on(b, "click", function () { switchTab(b.getAttribute("data-inv-tab")); }); });
    on(qs("[data-inv-fit]", root), "click", function () { if (cy) cy.fit(undefined, 40); });
    qsa("[data-inv-zoom]", root).forEach(function (b) {
      on(b, "click", function () {
        if (!cy) return;
        var f = b.getAttribute("data-inv-zoom") === "in" ? 1.25 : 0.8;
        cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
        updateOverview();
      });
    });
    on(qs("[data-inv-layout]", root), "change", function () { runLayout(this.value); });
    on(qs("[data-inv-chain]", root), "change", function () {
      if (!cy) return;
      var val = this.value;
      if (val === "__all__") { cy.elements().style("display", "element"); cy.fit(undefined, 40); return; }
      cy.nodes().forEach(function (nd) { nd.style("display", nd.data("chain") === val ? "element" : "none"); });
      cy.edges().forEach(function (ed) { ed.style("display", (ed.source().data("chain") === val && ed.target().data("chain") === val) ? "element" : "none"); });
      cy.fit(undefined, 40);
    });
    on(qs("[data-inv-search]", root), "input", function () {
      if (!cy) return;
      var q = (this.value || "").trim().toLowerCase();
      if (!q) { cy.elements().removeClass("faded match"); return; }
      cy.elements().addClass("faded");
      var matches = cy.nodes().filter(function (n) { return (n.id() + " " + (n.data("name") || "")).toLowerCase().indexOf(q) !== -1; });
      matches.removeClass("faded").addClass("match");
      matches.connectedEdges().removeClass("faded").connectedNodes().removeClass("faded");
    });
    on(qs("[data-inv-fullscreen]", root), "click", function () {
      var wrap = qs("[data-inv-canvas-wrap]", root);
      var target = (wrap && wrap.parentElement) || wrap; if (!target) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (target.requestFullscreen) target.requestFullscreen();
      setTimeout(function () { if (cy) { cy.resize(); cy.fit(undefined, 40); } }, 120);
    });
    on(qs("[data-inv-copy-subject]", root), "click", function () { var s = qs("[data-inv-subject]", root); if (s) copyText((s.textContent || "").trim()); });
    on(qs("[data-inv-export]", root), "click", function () {
      if (!lastExport) return;
      try {
        var blob = new Blob([JSON.stringify(lastExport, null, 2)], { type: "application/json" });
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
        var addr = (lastExport.trace_result && lastExport.trace_result.root_address) || "graph";
        a.download = "trace_" + addr.slice(0, 12) + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        showToast("Graph exported");
      } catch (e) {}
    });
    on(qs("[data-inv-flow-search]", root), "input", function () {
      var q = (this.value || "").trim().toLowerCase();
      qsa("[data-flow-row]", root).forEach(function (r) {
        r.style.display = (!q || (r.getAttribute("data-flow-search") || "").indexOf(q) !== -1) ? "" : "none";
      });
    });
    document.addEventListener("fullscreenchange", function () { setTimeout(function () { if (cy) { cy.resize(); cy.fit(undefined, 40); } }, 120); });

    updateDetected();
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
    initCryptoTrace();
    initChat();
    initSar();
    initCopyActions();
  }

  // Expose a tiny public surface for inline template scripts.
  window.FinGuard = window.FinGuard || {};
  window.FinGuard.showToast = showToast;


  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
