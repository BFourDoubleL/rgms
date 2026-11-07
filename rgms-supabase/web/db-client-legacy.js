/* db-client.js — ซิงก์ localStorage (คีย์ rgms_*) ให้ทุกคนเห็นข้อมูลชุดเดียวกัน
   ใส่ <script src="db-client.js"></script> ก่อน shared.js ในทุกหน้า มี 2 โหมด ตรวจเองอัตโนมัติ
   1) โหมดเซิร์ฟเวอร์: มี /api/state (server.js + PostgreSQL)
   2) โหมด Artifact: เผยแพร่บน claude.ai ใช้ฐานข้อมูลของ Artifact (collection "state")
   ถ้าไม่มีทั้งสอง (เปิดไฟล์ตรง ๆ) จะไม่ทำอะไร ต้นแบบทำงานแบบเดิม */
(function () {
  var LOCAL = /^rgms_(role|staff_nav_groups)$|_(seen|last)_/;   // ค่าเฉพาะเครื่อง/เฉพาะผู้ดู ไม่ซิงก์
  var syncKey = function (k) { return /^rgms_/.test(k) && !LOCAL.test(k); };
  var set = Storage.prototype.setItem, del = Storage.prototype.removeItem;
  function hook(onSet, onDel) {
    Storage.prototype.setItem = function (k, v) { set.apply(this, arguments); if (this === localStorage && syncKey(k)) onSet(k, v); };
    Storage.prototype.removeItem = function (k) { del.apply(this, arguments); if (this === localStorage && syncKey(k)) onDel(k); };
  }

  /* ---- โหมด 1: เซิร์ฟเวอร์ ---- */
  function serverMode() {
    if (!/^https?:$/.test(location.protocol)) return false;
    var API = "/api/state";
    try {
      var x = new XMLHttpRequest();
      x.open("GET", API, false); x.send();                     // sync ครั้งเดียว ให้ shared.js อ่านค่าล่าสุดได้ทันที
      if (x.status !== 200 || !/json/.test(x.getResponseHeader("Content-Type") || "")) return false;
      var s = JSON.parse(x.responseText);
      Object.keys(s).forEach(function (k) { if (syncKey(k)) set.call(localStorage, k, JSON.stringify(s[k])); });
    } catch (e) { return false; }
    function push(m, k, b) { try { fetch(API + "/" + encodeURIComponent(k), { method: m, headers: { "Content-Type": "application/json" }, body: b, keepalive: true }).catch(function () {}); } catch (e) {} }
    hook(function (k, v) { var val; try { val = JSON.parse(v); } catch (e) { val = v; } push("PUT", k, JSON.stringify({ value: val })); },
         function (k) { push("DELETE", k); });
    return true;
  }

  /* ---- โหมด 2: ฐานข้อมูลของ Artifact ---- */
  function artifactMode() {
    if (!window.claude || !window.claude.use) return;
    var ready = false, queue = {}, col = null;
    function write(k, v) { if (!col) return; var r = v === null ? col.doc(k).delete() : col.doc(k).set({ v: v }); r && r.catch && r.catch(function () {}); }
    hook(function (k, v) { if (ready) write(k, v); else queue[k] = v; },
         function (k) { if (ready) write(k, null); else queue[k] = null; });
    var t = setTimeout(function () { ready = true; queue = {}; }, 10000);      // ไม่มีฐานข้อมูล/ไม่ได้รับสิทธิ์ ก็ทำงานแบบเดิม
    window.claude.use("db").then(function (db) {
      if (!db) return;
      col = db.collection("state");
      return col.get().then(function (snap) {
        clearTimeout(t);
        var remote = {}, changed = false;
        snap.docs.forEach(function (d) { var v = (d.data() || {}).v; if (syncKey(d.id) && typeof v === "string") remote[d.id] = v; });
        Object.keys(remote).forEach(function (k) { if (!(k in queue) && localStorage.getItem(k) !== remote[k]) { set.call(localStorage, k, remote[k]); changed = true; } });
        ready = true;
        var q = queue; queue = {};
        Object.keys(q).forEach(function (k) { if (q[k] === null ? k in remote : remote[k] !== q[k]) write(k, q[k]); });
        if (changed) location.reload();                           // รีโหลดครั้งเดียว เพื่อให้หน้าแสดงข้อมูลล่าสุดจากฐานข้อมูล
      });
    }).catch(function () { ready = true; queue = {}; });
  }

  if (!serverMode()) artifactMode();
})();
