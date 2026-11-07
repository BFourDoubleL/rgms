# RGMS · ฐานข้อมูล Supabase + ล็อกอินจริง

ชุดนี้ **แทนที่** ชุด PostgreSQL/Render เดิม (ไม่ต้องใช้ `server.js` แล้ว) ประกอบด้วย
- `supabase/01-schema.sql` ตารางทั้งหมด + ล็อกอิน/บทบาท + สิทธิ์ (RLS) + ประวัติการเปลี่ยนแปลง
- `supabase/02-seed.sql` ข้อมูลตั้งต้น (สมมติ) จากชุดเดิม
- `supabase/03-create-demo-users.mjs` สร้างบัญชีทดลอง 7 บทบาท
- `web/` หน้าเว็บทั้งหมด (ใช้ `db-client.js` ตัวใหม่ + `login.html`) · ไม่มี `supabase-config.json` จะทำงานโหมดเดิม (`db-client-legacy.js`)
- `test/` เซิร์ฟเวอร์จำลอง + ชุดทดสอบ (ไม่ต้องใช้อินเทอร์เน็ต)

## ขั้นตอนตั้งค่า (ครั้งแรก ประมาณ 20–30 นาที)

**1. สร้างโปรเจกต์** ที่ supabase.com → New project (จดรหัสผ่านฐานข้อมูลไว้ ไม่ต้องใช้ในชุดนี้)

**2. สร้างตาราง** Dashboard → SQL Editor → New query
  - วางเนื้อหา `supabase/01-schema.sql` ทั้งไฟล์ → Run (ต้องขึ้น Success)
  - วางเนื้อหา `supabase/02-seed.sql` ทั้งไฟล์ → Run
  - ตรวจ: `select count(*) from projects;` ต้องได้ 32 · `select count(*) from kv_rules;` ต้องได้ 9

**3. สร้างบัญชีทดลอง** บนเครื่องคุณ (ต้องมี Node 18+)
    cd supabase
    SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... DEMO_PASSWORD='รหัสผ่านยาว 12 ตัวขึ้นไป' node 03-create-demo-users.mjs
  - URL และ service_role key อยู่ที่ Project Settings → API
  - **service_role key ห้ามใส่ในไฟล์หน้าเว็บ ห้าม commit ห้ามส่งให้ใคร** ใช้พิมพ์ในคำสั่งนี้ครั้งเดียว
  - ได้บัญชี `researcher@rgms-demo.test`, `chair@…`, `secretary@…`, `staff@…`, `reviewer@…`, `finance@…`, `exec@…`

**4. ตั้งค่าหน้าเว็บ** คัดลอก `web/supabase-config.example.json` เป็น `web/supabase-config.json` แล้วใส่
  - `url` = Project URL · `anonKey` = anon public key (Project Settings → API) — anon key เป็นกุญแจสาธารณะ ปลอดภัยเพราะมี RLS คุมอยู่

**5. ทดสอบบนเครื่อง** ในโฟลเดอร์ `web`: `python3 -m http.server 8000` แล้วเปิด http://localhost:8000
  (เปิดไฟล์ตรง ๆ แบบ file:// ไม่ได้ ต้องผ่านเซิร์ฟเวอร์)

**6. นำขึ้นเว็บ** (ไซต์นี้เป็นไฟล์ static) ใช้ Netlify / Cloudflare Pages / Render Static Site ชี้ไปที่โฟลเดอร์ `web` (ตรวจเงื่อนไขแผนฟรีกับหน้าเว็บของผู้ให้บริการ)

## ใส่ใน GitHub repo
วางโฟลเดอร์ `rgms-supabase/` ที่ราก repo ข้าง `prototype/` และ `docs/` (Add file → Upload files → ลากทั้งโฟลเดอร์ แล้วเลือก Create a new branch → เปิด Pull Request)
ถ้าจะ commit `supabase-config.json` ได้ (มีแต่ anon key) แต่ **ห้าม** commit service_role key

## เช็กลิสต์ว่าใช้งานได้จริง
1. เปิดเว็บ → ถูกพาไป `login.html` · ล็อกอินด้วย `reviewer@rgms-demo.test` → เข้า `reviewer-list.html`
2. ส่งความเห็น 1 โครงการ → ใน SQL Editor: `select * from app_state;` ต้องมีแถว `rgms_track_content` และ `select * from change_log order by id desc limit 5;` ต้องเห็นผู้บันทึก = reviewer
3. ล็อกอิน `staff@…` อีกเบราว์เซอร์ → เห็นสถานะเดียวกัน (อัปเดตสดภายใน ~4 วินาที)
4. ในคอนโซลเบราว์เซอร์ของ reviewer: `localStorage.setItem('rgms_call_status','{}')` → ป้ายมุมซ้ายล่างต้องขึ้น "ไม่มีสิทธิ์บันทึกข้อมูลนี้" (ฐานข้อมูลปฏิเสธ)
5. กดปุ่ม "ออกจากระบบ" มุมซ้ายล่าง → กลับ `login.html`

## ข้อจำกัดที่ต้องรู้ (สำคัญ)
- **สิทธิ์ตอนนี้คุมระดับ "บทบาทต่อ key" ยังไม่ใช่ "รายโครงการ"** เช่น คณะอนุกรรมการเขียนได้เฉพาะ key ของแทร็กเนื้อหา แต่ยังเขียนทับความเห็นของโครงการที่ไม่ได้รับมอบหมายผ่านการเรียก API ตรง ๆ ได้ และผู้ใช้ที่ล็อกอินอ่านสถานะทุก key ได้ (รวมความเห็นของกรรมการท่านอื่น) หน้าเว็บซ่อนไว้ แต่ฐานข้อมูลยังไม่ซ่อน — การซ่อนจริงต้องย้ายสถานะไปเป็นตารางรายโครงการ (`project_reviews` ฯลฯ) แล้วเขียน RLS รายแถว (ขั้นถัดไป)
- **ตัวตนในหน้าเว็บยังเป็นชื่อสาธิตตามบทบาท** (`shared.js` ผูกชื่อกับบทบาท เช่น คณะอนุกรรมการ = รศ.ดร.สุเมธ) ดังนั้นการมอบหมายโครงการยังอิงชื่อนั้น ถ้าจะมีผู้ใช้จริงหลายคนต่อบทบาท ต้องให้ชื่อมาจาก `profiles.name`
- ข้อมูลโครงการหลักยังอ่านจาก `shared.js` (ตาราง `projects` ฯลฯ ถูกสร้างและ seed ไว้แล้วแต่หน้าเว็บยังไม่อ่าน)
- ผู้ใช้เปลี่ยนบทบาทเองไม่ได้ แต่คนที่เปิดหน้าของบทบาทอื่นยังเห็นหน้าได้ (ข้อมูลที่เขียนไม่ได้จะถูกปฏิเสธ)
- ปุ่มรีเซ็ตสีแดง (โหมดทดสอบ) ใช้ได้เฉพาะ `staff` และล้างสถานะของทุกคน — ควรถอดก่อนใช้จริง
- อย่าใส่ข้อมูลจริงของ มฟล. จนกว่าจะทบทวนความปลอดภัยและ PDPA ร่วมกับฝ่าย IT

## สถานะการทดสอบ
- ทดสอบ `db-client.js`/`login.html` กับ **เซิร์ฟเวอร์จำลอง** ด้วยเบราว์เซอร์จริงหลายผู้ใช้ ผ่าน 19/19 (ล็อกอิน, เด้งไป login, บทบาทเปลี่ยนเองไม่ได้, บันทึก/sync สด, รวมการแก้พร้อมกัน, ถูกปฏิเสธเมื่อไม่มีสิทธิ์, token หมดอายุ, ออกจากระบบ, ทุกหน้าไม่มี JS error)
- **SQL (`01-schema.sql`) ยังไม่เคยรันบน PostgreSQL/Supabase จริง** เพราะที่เขียนไม่มีฐานข้อมูล ถ้า SQL Editor แจ้ง error ให้ส่งข้อความเต็มมา แล้วแก้ตรงจุด
- รันชุดทดสอบเอง: `node test/mock-supabase.mjs` (พอร์ต 3200) แล้ว `python3 test/e2e.py` (ต้องมี Playwright) · สร้างผู้ใช้ทดสอบด้วย `SUPABASE_URL=http://localhost:3200 SUPABASE_SERVICE_ROLE_KEY=service-role-test-key DEMO_PASSWORD=demo-password-12345 node supabase/03-create-demo-users.mjs`
