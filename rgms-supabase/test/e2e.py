import json, time, urllib.request
from playwright.sync_api import sync_playwright
B = "http://localhost:3200"; PW = "demo-password-12345"
ok = fail = 0
STAMP = int(time.time())
def check(name, cond, extra=""):
    global ok, fail
    if cond: ok += 1; print("PASS", name)
    else: fail += 1; print("FAIL", name, extra)
def stats(): return json.load(urllib.request.urlopen(B + "/__test/stats"))

def login(ctx, role, next_page=None):
    pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e))); pg.errs = errs
    pg.goto(B + "/" + (next_page or "login.html"))
    if "login.html" not in pg.url: pg.wait_for_url("**/login.html*")
    pg.fill("#email", role + "@rgms-demo.test"); pg.fill("#pw", PW); pg.click("#go")
    pg.wait_for_url(lambda u: "login.html" not in u); pg.wait_for_load_state("load")
    return pg

with sync_playwright() as p:
    br = p.chromium.launch()
    # 1) ยังไม่ล็อกอิน → เด้งไป login พร้อม next
    anon = br.new_context(); pg = anon.new_page(); pg.goto(B + "/reviewer-list.html"); pg.wait_for_url("**/login.html*")
    check("ยังไม่ล็อกอิน → เด้งไปหน้า login", "next=reviewer-list.html" in pg.url, pg.url)
    # 2) รหัสผ่านผิด
    pg.fill("#email", "reviewer@rgms-demo.test"); pg.fill("#pw", "wrong-password-1"); pg.click("#go"); pg.wait_for_selector("#err.is-on")
    check("รหัสผ่านผิด → แจ้งข้อความภาษาไทย", "ไม่ถูกต้อง" in pg.inner_text("#err"), pg.inner_text("#err"))
    # 3) ล็อกอินคณะอนุกรรมการ → กลับมาหน้าที่ขอ (next)
    pg.fill("#pw", PW); pg.click("#go"); pg.wait_for_url("**/reviewer-list.html"); pg.wait_for_selector("#cards .card")
    check("ล็อกอินแล้วไปหน้าที่ขอไว้ (next)", pg.url.endswith("/reviewer-list.html"))
    check("rgms_role มาจากบัญชี (reviewer)", pg.evaluate("localStorage.getItem('rgms_role')") == "reviewer")
    pg.evaluate("localStorage.setItem('rgms_role','staff')")
    check("สลับบทบาทเองไม่ได้", pg.evaluate("localStorage.getItem('rgms_role')") == "reviewer")
    # 4) ส่งความเห็น → บันทึกลงฐานข้อมูล
    pg.click("#reset-fab"); pg.wait_for_timeout(700)
    href = pg.locator("a.btn-primary", has_text="เริ่มพิจารณา").first.get_attribute("href")
    pg.goto(B + "/" + href); pg.click('[data-rec="approve"]'); pg.fill("#comment", "เห็นควรสนับสนุน (e2e)"); pg.click("#submit"); pg.wait_for_selector(".notice--ok"); pg.wait_for_timeout(700)
    pid = href.split("id=")[1]
    ch = [c for c in stats()["changes"] if c["key"] == "rgms_track_content"]
    check("ส่งความเห็นแล้วฐานข้อมูลมีสถานะโครงการ " + pid, ch and ch[-1]["value"].get(pid) == "cleared", str(ch[-1:] ))
    check("เขียนโดยบทบาท reviewer", ch[-1]["role"] == "reviewer")
    # 5) เจ้าหน้าที่ล็อกอินอีกเครื่อง → เห็นข้อมูลเดียวกัน + index เด้งไปหน้าบทบาท
    staff_ctx = br.new_context(); sp = login(staff_ctx, "staff", "index.html")
    check("index → เด้งไปหน้าตามบทบาท (staff-queue)", sp.url.endswith("/staff-queue.html"), sp.url)
    seen = json.loads(sp.evaluate("localStorage.getItem('rgms_track_content')") or "{}")
    check("เจ้าหน้าที่เห็นสถานะที่อนุกรรมการบันทึก", seen.get(pid) == "cleared", str(seen))
    # 6) sync สด: เจ้าหน้าที่แก้รอบทุน → อนุกรรมการ(ผู้ใช้อื่น) ไม่ได้ key นี้ แต่เจ้าหน้าที่เขียน exec_meta ได้ ให้ผู้ใช้ exec รับ
    exec_ctx = br.new_context(); ep = login(exec_ctx, "exec", "exec-overview.html")
    ep.evaluate("window.__ev=[];window.addEventListener('storage',e=>window.__ev.push(e.key))")
    sp.evaluate("localStorage.setItem('rgms_call_status', JSON.stringify({'2569-1':'closed','stamp':%d}))" % STAMP); sp.wait_for_timeout(600)
    ep.wait_for_timeout(5200)
    check("ผู้ใช้อื่นได้ storage event ภายในรอบ poll", "rgms_call_status" in ep.evaluate("window.__ev"), str(ep.evaluate("window.__ev")))
    # 7) สิทธิ์: อนุกรรมการเขียน key ของเจ้าหน้าที่ไม่ได้ → ถูกปฏิเสธและค่าในเครื่องถูกคืน
    before = stats()["rev"]
    pg.evaluate("localStorage.setItem('rgms_call_status', JSON.stringify({'2569-1':'open','hack':1}))"); pg.wait_for_timeout(1200)
    check("เขียน key ที่ไม่มีสิทธิ์ → ไม่เปลี่ยนฐานข้อมูล", stats()["rev"] == before)
    check("ป้ายแจ้งไม่มีสิทธิ์", "ไม่มีสิทธิ์" in pg.inner_text("#rgms-db-badge"), pg.inner_text("#rgms-db-badge"))
    cur = json.loads(pg.evaluate("localStorage.getItem('rgms_call_status')") or "{}")
    check("ค่าในเครื่องถูกคืนเป็นค่าจริงจากฐานข้อมูล", cur == {"2569-1": "closed", "stamp": STAMP}, str(cur))
    # 8) รวม map ไม่ทับกัน: อนุกรรมการกับนักวิจัยเขียนคนละโครงการใน key เดียวกันพร้อมกัน
    res_ctx = br.new_context(); rp = login(res_ctx, "researcher", "researcher-home.html")
    pg.evaluate("localStorage.setItem('rgms_track_content', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('rgms_track_content')||'{}'), {'P-X1':'cleared'})))")
    rp.evaluate("localStorage.setItem('rgms_track_content', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('rgms_track_content')||'{}'), {'P-X2':'pending'})))")
    pg.wait_for_timeout(1200)
    final = [c for c in stats()["changes"] if c["key"] == "rgms_track_content"][-1]["value"]
    check("แก้คนละโครงการพร้อมกัน → ทั้งสองค่าอยู่ครบ", final.get("P-X1") == "cleared" and final.get("P-X2") == "pending" and pid in final, str(final))
    # 9) token หมดอายุ: เขียนต่อได้ (refresh แบบ async) และรีโหลดหน้าได้ (refresh แบบ sync)
    r0 = stats()["refreshCalls"]; urllib.request.urlopen(B + "/__test/expire")
    pg.evaluate("localStorage.setItem('rgms_content_comment', JSON.stringify({'P-X1':'หลัง token หมดอายุ'}))"); pg.wait_for_timeout(1500)
    c2 = [c for c in stats()["changes"] if c["key"] == "rgms_content_comment"]
    check("token หมดอายุ → refresh อัตโนมัติแล้วเขียนสำเร็จ", c2 and c2[-1]["value"].get("P-X1") == "หลัง token หมดอายุ" and stats()["refreshCalls"] > r0)
    urllib.request.urlopen(B + "/__test/expire"); r1 = stats()["refreshCalls"]
    pg.goto(B + "/reviewer-list.html"); pg.wait_for_selector("#cards .card")
    check("token หมดอายุ → โหลดหน้าใหม่ได้ (refresh แบบ sync)", "login.html" not in pg.url and stats()["refreshCalls"] > r1, pg.url)
    # 10) หน้าหลักของแต่ละบทบาทไม่มี JS error
    pages = {"staff": ["staff-queue", "staff-finance", "staff-roles", "staff-calls", "staff-audit", "staff-export", "staff-team", "staff-agenda"], "exec": ["exec-overview"], "finance": ["finance-review-queue"], "chair": ["chair-review"], "researcher": ["researcher-home", "researcher-profile"], "secretary": ["secretary-home"], "reviewer": ["reviewer-list"]}
    bad = []
    for role, lst in pages.items():
        c = br.new_context(); lp = login(c, role, lst[0] + ".html")
        for name in lst:
            lp.goto(B + "/" + name + ".html"); lp.wait_for_timeout(350)
            if "login.html" in lp.url: bad.append(name + " (เด้งไป login)")
        bad += [role + ": " + e for e in lp.errs]
    check("ทุกหน้าหลักเปิดได้โดยไม่มี JS error", not bad, str(bad))
    # 11) ออกจากระบบ
    pg.click("#rgms-db-badge button"); pg.wait_for_url("**/login.html*")
    check("ออกจากระบบ → ล้างข้อมูลในเครื่อง", pg.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('rgms_')||k==='sb_session').length") == 0)
    pg.goto(B + "/reviewer-list.html"); pg.wait_for_url("**/login.html*")
    check("ออกจากระบบแล้วเข้าหน้าภายในไม่ได้", True)
    br.close()
print(f"\n{ok} passed, {fail} failed")
