// 03-create-demo-users.mjs — สร้างบัญชีทดลอง 7 บทบาท (ตรงกับชื่อผู้ใช้สาธิตในต้นแบบ) + โปรไฟล์
// รันบนเครื่องของคุณเท่านั้น (ต้อง Node 18+):
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... DEMO_PASSWORD='รหัสผ่านยาว 12+ ตัว' node 03-create-demo-users.mjs
// service_role key อยู่ใน Dashboard → Project Settings → API · ห้าม commit/ห้ามใส่ในไฟล์หน้าเว็บ/ห้ามส่งให้ใคร
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PW = process.env.DEMO_PASSWORD || '';
if (!URL_ || !SRK) { console.error('ตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ก่อน'); process.exit(1); }
if (PW.length < 12) { console.error('DEMO_PASSWORD ต้องยาวอย่างน้อย 12 ตัวอักษร'); process.exit(1); }

const USERS = [
  { role: 'researcher', name: 'ผศ.ดร.นภัส วงศ์ประเสริฐ' },
  { role: 'chair',      name: 'รศ.ดร.อาคม ผลานุสนธิ์' },
  { role: 'secretary',  name: 'คุณเบญจวรรณ ทิพย์วงศ์' },
  { role: 'staff',      name: 'คุณกมลชนก อินทร์แก้ว' },
  { role: 'reviewer',   name: 'รศ.ดร.สุเมธ ธำรงชัย' },
  { role: 'finance',    name: 'คุณรัตน์ติการณ์ หลวงใจ' },
  { role: 'exec',       name: 'รศ.ดร.อรวรรณ สีหราช' },
];
const H = { apikey: SRK, Authorization: 'Bearer ' + SRK, 'Content-Type': 'application/json' };
const api = async (method, path, body, extra = {}) => {
  const r = await fetch(URL_ + path, { method, headers: { ...H, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
};

for (const u of USERS) {
  const email = `${u.role}@rgms-demo.test`;
  let id = null;
  const c = await api('POST', '/auth/v1/admin/users', { email, password: PW, email_confirm: true });
  if (c.status === 200 || c.status === 201) id = c.json.id;
  else {                                   // มีอยู่แล้ว → หา id แล้วตั้งรหัสผ่านใหม่ให้ตรงกับที่ระบุ
    const l = await api('GET', '/auth/v1/admin/users?per_page=200');
    const f = ((l.json && l.json.users) || []).find(x => x.email === email);
    if (!f) { console.error(`✗ ${email}: สร้างไม่ได้ (${c.status}) ${c.text.slice(0, 120)}`); continue; }
    id = f.id; await api('PUT', '/auth/v1/admin/users/' + id, { password: PW });
  }
  const p = await api('POST', '/rest/v1/profiles', { id, name: u.name, role: u.role, active: true }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  console.log(p.status < 300 ? `✓ ${email}  →  ${u.role}` : `✗ ${email}: โปรไฟล์ไม่สำเร็จ (${p.status}) ${p.text.slice(0, 120)}`);
}
console.log('\nเสร็จแล้ว — ล็อกอินด้วยอีเมล <บทบาท>@rgms-demo.test และ DEMO_PASSWORD ที่ตั้งไว้ (ใช้เพื่อทดลอง ลบ/เปลี่ยนก่อนใช้งานจริง)');
