/* =========================================================================
   db-client.js (Supabase) — ล็อกอินจริง + เก็บสถานะ rgms_* ไว้ในฐานข้อมูล
   โหลดก่อน shared.js ในทุกหน้า (หน้าเดิมมี <script src="db-client.js"> อยู่แล้ว)
   • ต้องมีไฟล์ supabase-config.json (url + anonKey) — ถ้าไม่มี จะใช้ db-client-legacy.js (โหมดเดิม)
   • ยังไม่ล็อกอิน → ไปหน้า login.html · บทบาทมาจากบัญชีที่ล็อกอิน (rgms_role เปลี่ยนเองไม่ได้)
   • โหลดสถานะทั้งหมดแบบ synchronous ก่อนสคริปต์อื่นทำงาน (โค้ดหน้าเดิมไม่ต้องแก้)
   • เขียนผ่าน RPC kv_patch/kv_put/kv_delete — ฐานข้อมูลเช็กสิทธิ์รายบทบาทอีกชั้น (RLS)
   • ดึงการเปลี่ยนแปลงของผู้ใช้อื่นทุก 4 วินาที แล้วยิง event "storage" ให้หน้าวาดใหม่
   ใช้เฉพาะ anon key (public) — ห้ามใส่ service_role key ในไฟล์ฝั่งหน้าเว็บเด็ดขาด
   ========================================================================= */
(function () {
  "use strict";
  var ls, proto = window.Storage && window.Storage.prototype;
  try { ls = window.localStorage; } catch (e) { return; }
  if (!ls || !proto) return;

  /* ---- อ่านค่าตั้งต้น ---- */
  var CFG = null;
  try {
    var cx = new XMLHttpRequest(); cx.open("GET", "supabase-config.json", false); cx.send();
    if (cx.status === 200) CFG = JSON.parse(cx.responseText);
  } catch (e) {}
  if (!CFG || !CFG.url || !CFG.anonKey || /YOUR-/.test(CFG.url + CFG.anonKey) || location.protocol === "file:") {
    document.write('<script src="db-client-legacy.js"><\/script>');
    return;
  }
  var BASE = String(CFG.url).replace(/\/+$/, ""), KEY = CFG.anonKey;
  var SESSION_KEY = "sb_session";
  var LOCAL = /^rgms_(role|staff_nav_groups)$|_(seen|last)_/;          // ค่าเฉพาะเครื่อง ไม่ซิงก์
  var POLL_MS = 4000;
  var HOME = { researcher: "researcher-home.html", chair: "chair-review.html", secretary: "secretary-home.html", staff: "staff-queue.html", reviewer: "reviewer-list.html", finance: "finance-review-queue.html", exec: "exec-overview.html" };
  var ROLE_LABEL = { researcher: "นักวิจัย", chair: "ประธานวิจัย/คณบดี", secretary: "เลขาสำนักวิชา", staff: "เจ้าหน้าที่ส่วนบริหาร", reviewer: "คณะอนุกรรมการ", finance: "เจ้าหน้าที่การเงิน", exec: "ผู้บริหาร/คกก." };
  var page = location.pathname.split("/").pop() || "index.html";

  var native = { get: proto.getItem, set: proto.setItem, del: proto.removeItem, clear: proto.clear };
  function syncKey(k) { return typeof k === "string" && /^rgms_[a-z0-9_]{1,80}$/.test(k) && !LOCAL.test(k); }
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function jparse(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }
  function stable(v) { return JSON.stringify(v, function (k, x) { if (isObj(x)) { var o = {}; Object.keys(x).sort().forEach(function (kk) { o[kk] = x[kk]; }); return o; } return x; }); }

  /* ---- session ---- */
  function loadSession() { var s = jparse(native.get.call(ls, SESSION_KEY)); return s && s.access_token ? s : null; }
  function saveSession(s) { native.set.call(ls, SESSION_KEY, JSON.stringify(s)); }
  function toSession(j) { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)), user: { id: j.user && j.user.id, email: j.user && j.user.email } }; }
  function headers(tok) { return { apikey: KEY, Authorization: "Bearer " + (tok || KEY), "Content-Type": "application/json" }; }
  function wipeLocalState() {
    var del = [];
    Object.keys(ls).forEach(function (k) { if (/^rgms_/.test(k) || k === SESSION_KEY) del.push(k); });
    del.forEach(function (k) { native.del.call(ls, k); });
  }
  function toLogin(msg) {
    wipeLocalState();
    hide();
    location.replace("login.html?next=" + encodeURIComponent(page + location.search) + (msg ? "&msg=" + msg : ""));
  }
  function hide() { try { document.documentElement.style.visibility = "hidden"; } catch (e) {} }   // ไม่ให้หน้าที่ยังไม่มีข้อมูลกะพริบระหว่างเปลี่ยนหน้า

  function xhr(method, url, tok, body) {
    var x = new XMLHttpRequest(); x.open(method, url, false);
    var h = headers(tok); for (var k in h) x.setRequestHeader(k, h[k]);
    try { x.send(body == null ? null : JSON.stringify(body)); } catch (e) { return { status: 0 }; }
    return { status: x.status, json: jparse(x.responseText) };
  }

  var session = loadSession();
  if (!session) { toLogin(); return; }
  function refreshSync() {
    var rr = xhr("POST", BASE + "/auth/v1/token?grant_type=refresh_token", null, { refresh_token: session.refresh_token });
    if (rr.status === 200 && rr.json && rr.json.access_token) { session = toSession(rr.json); saveSession(session); return true; }
    return false;
  }
  // เรียกแบบ sync พร้อมต่ออายุ token ให้ 1 ครั้งถ้าถูกปฏิเสธ (401) — กันกรณีนาฬิกาเครื่องคลาดเคลื่อนหรือ token ถูกยกเลิก
  function xhrAuth(method, path) {
    var r = xhr(method, BASE + path, session.access_token);
    if (r.status === 401 && refreshSync()) r = xhr(method, BASE + path, session.access_token);
    return r;
  }
  if (session.expires_at - 30 < Date.now() / 1000 && !refreshSync()) { toLogin("expired"); return; }

  /* ---- โปรไฟล์/บทบาท ---- */
  var pr = xhrAuth("GET", "/rest/v1/profiles?id=eq." + encodeURIComponent(session.user.id) + "&select=name,role,school,active");
  var profile = pr.status === 200 && pr.json && pr.json[0];
  if (!profile || !profile.active) { toLogin(pr.status === 0 ? "offline" : "no-profile"); return; }
  native.set.call(ls, "rgms_role", profile.role);
  if (page === "index.html" || page === "") { hide(); location.replace(HOME[profile.role] || "login.html"); return; }

  /* ---- โหลดสถานะทั้งหมดแบบ sync ---- */
  var rev = 0;
  var hr = xhrAuth("GET", "/rest/v1/app_state?select=key,value,rev,deleted&order=rev&limit=5000");
  if (hr.status !== 200 || !Array.isArray(hr.json)) { console.warn("[RGMS] โหลดสถานะจากฐานข้อมูลไม่ได้ (" + hr.status + ")"); toLogin(hr.status === 0 ? "offline" : "expired"); return; }
  var remote = {};
  hr.json.forEach(function (r) { if (r.rev > rev) rev = r.rev; if (!r.deleted && syncKey(r.key)) remote[r.key] = r.value; });
  Object.keys(ls).forEach(function (k) { if (syncKey(k) && !(k in remote)) native.del.call(ls, k); });
  Object.keys(remote).forEach(function (k) { native.set.call(ls, k, JSON.stringify(remote[k])); });

  /* ---- token สำหรับคำสั่งแบบ async ---- */
  var refreshing = null;
  function ensureToken(force) {
    var s = loadSession(); if (!s) return Promise.reject(new Error("no session"));
    if (!force && s.expires_at - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
    if (!refreshing) {
      refreshing = fetch(BASE + "/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: headers(), body: JSON.stringify({ refresh_token: s.refresh_token }) })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("refresh failed")); })
        .then(function (j) { var n = toSession(j); saveSession(n); return n.access_token; })
        .catch(function (e) { toLogin("expired"); throw e; })
        .then(function (t) { refreshing = null; return t; }, function (e) { refreshing = null; throw e; });
    }
    return refreshing;
  }
  function authed(url, opt, retried) {
    return ensureToken().then(function (tok) {
      opt.headers = headers(tok);
      if (opt.body && opt.body.length < 60000) opt.keepalive = true;
      return fetch(url, opt);
    }).then(function (r) { if (r.status === 401 && !retried) return ensureToken(true).then(function () { return authed(url, opt, true); }); return r; });
  }

  /* ---- ป้ายสถานะ ---- */
  var el, msgTimer, MSG = { ok: ["#0F7B4F", "เชื่อมต่อฐานข้อมูลแล้ว"], saving: ["#B7791F", "กำลังบันทึก…"], error: ["#B42318", "บันทึกไม่สำเร็จ"], denied: ["#B42318", "ไม่มีสิทธิ์บันทึกข้อมูลนี้"], offline: ["#B42318", "ขาดการเชื่อมต่อ"] };
  function badge(s) { if (!el) return; el.dot.style.background = MSG[s][0]; el.txt.textContent = MSG[s][1]; el.dataset.state = s; }
  function mount() {
    var d = document.createElement("div"); d.setAttribute("role", "status"); d.setAttribute("aria-live", "polite"); d.id = "rgms-db-badge";
    d.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:900;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:999px;background:#fff;border:1px solid #E2E8F0;box-shadow:0 2px 8px rgba(15,23,42,.1);font:500 12px/1.2 inherit;color:#475569";
    d.innerHTML = '<i style="width:8px;height:8px;border-radius:50%;display:inline-block"></i><span></span><span style="color:#94A3B8">·</span><span></span><button type="button" style="all:unset;cursor:pointer;color:#851419;font-weight:600;padding:2px 8px;border-radius:999px">ออกจากระบบ</button>';
    var c = d.children; d.dot = c[0]; d.txt = c[1]; c[3].textContent = ROLE_LABEL[profile.role] || profile.role; c[4].addEventListener("click", signOut);
    document.body.appendChild(d); el = d; badge("ok");
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
  function flash(s) { badge(s); clearTimeout(msgTimer); msgTimer = setTimeout(function () { badge(pending ? "saving" : "ok"); }, 5000); }

  /* ---- คิวเขียน (เรียงลำดับ) ---- */
  var chain = Promise.resolve(), pending = 0;
  function rpc(fn, args, onOk, key) {
    pending++; badge("saving");
    chain = chain.then(function () { return authed(BASE + "/rest/v1/rpc/" + fn, { method: "POST", body: JSON.stringify(args) }); })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, json: jparse(t) }; }); })
      .then(function (res) {
        pending--;
        if (res.ok) { if (onOk) onOk(res.json); if (!pending) badge("ok"); return; }
        console.warn("[RGMS] " + fn + " " + (key || "") + " → " + res.status, res.json);
        flash(res.status === 403 || (res.json && res.json.code === "42501") ? "denied" : "error");
        if (key) restoreKey(key); else setTimeout(function () { location.reload(); }, 1500);
      })
      .catch(function (e) { pending--; flash("error"); console.error(e); if (key) restoreKey(key); });
  }
  function restoreKey(k) {            // เขียนไม่สำเร็จ → ดึงค่าจริงจากฐานข้อมูลมาแทนค่าที่แก้ในเครื่อง
    authed(BASE + "/rest/v1/app_state?select=key,value,rev,deleted&key=eq." + encodeURIComponent(k), { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) { rows.forEach(function (row) { applyRow(row, true); }); }).catch(function () {});
  }

  function push(k, oldS, newS) {
    var o = oldS == null ? undefined : jparse(oldS), n = jparse(newS);
    if (n === undefined) n = newS;
    if (isObj(n) && (o === undefined || isObj(o))) {
      var set = {}, del = [], any = false, kk;
      o = o || {};
      for (kk in n) if (stable(n[kk]) !== stable(o[kk])) { set[kk] = n[kk]; any = true; }
      for (kk in o) if (!(kk in n)) { del.push(kk); any = true; }
      if (!any && oldS != null) return;
      rpc("kv_patch", { p_key: k, p_set: set, p_del: del }, function (merged) {
        if (!pending && merged && stable(merged) !== stable(jparse(native.get.call(ls, k)))) native.set.call(ls, k, JSON.stringify(merged));
      }, k);
    } else {
      rpc("kv_put", { p_key: k, p_value: n }, null, k);
    }
  }

  /* ---- override Storage ---- */
  proto.setItem = function (k, v) {
    if (this !== ls) return native.set.apply(this, arguments);
    if (k === "rgms_role") return;                                    // บทบาทมาจากบัญชีที่ล็อกอิน
    var old = native.get.call(ls, k); v = String(v); native.set.call(ls, k, v);
    if (syncKey(k) && old !== v) push(k, old, v);
  };
  proto.removeItem = function (k) {
    if (this !== ls) return native.del.apply(this, arguments);
    if (k === "rgms_role" || k === SESSION_KEY) return;
    var had = native.get.call(ls, k) != null; native.del.call(ls, k);
    if (syncKey(k) && had) rpc("kv_delete", { p_key: k }, null, k);
  };
  proto.clear = function () {
    if (this !== ls) return native.clear.call(this);
    var keep = {}; [SESSION_KEY, "rgms_role"].forEach(function (k) { var v = native.get.call(ls, k); if (v != null) keep[k] = v; });
    native.clear.call(ls); for (var k in keep) native.set.call(ls, k, keep[k]);
    rpc("kv_clear", {}, null, null);
  };

  /* ---- ดึงการเปลี่ยนแปลงของผู้ใช้อื่น ---- */
  function applyRow(row, quiet) {
    if (row.rev > rev) rev = row.rev;
    if (!syncKey(row.key)) return;
    var cur = native.get.call(ls, row.key), next = row.deleted ? null : JSON.stringify(row.value);
    if (next == null ? cur == null : (cur != null && stable(jparse(cur)) === stable(row.value))) return;
    if (next == null) native.del.call(ls, row.key); else native.set.call(ls, row.key, next);
    try { window.dispatchEvent(new StorageEvent("storage", { key: row.key, oldValue: cur, newValue: next, storageArea: ls })); } catch (e) {}
  }
  function poll() {                    // ดึงย้อนหลัง 100 rev เผื่อ transaction ที่ commit ช้ากว่าลำดับ rev (applyRow ข้ามค่าที่ไม่เปลี่ยนอยู่แล้ว)
    if (pending) return;
    authed(BASE + "/rest/v1/app_state?select=key,value,rev,deleted&order=rev&rev=gt." + Math.max(0, rev - 100), { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("poll " + r.status)); })
      .then(function (rows) { if (pending) return; rows.forEach(function (row) { applyRow(row); }); if (!pending && el && el.dataset.state === "offline") badge("ok"); })
      .catch(function () { badge("offline"); });
  }
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });

  function signOut() {
    var s = loadSession();
    var done = function () { wipeLocalState(); location.href = "login.html"; };
    if (!s) return done();
    fetch(BASE + "/auth/v1/logout", { method: "POST", headers: headers(s.access_token), keepalive: true }).then(done, done);
  }
  window.RGMS_DB = { online: true, supabase: true, role: profile.role, name: profile.name, sync: poll, signOut: signOut, rev: function () { return rev; } };
})();
