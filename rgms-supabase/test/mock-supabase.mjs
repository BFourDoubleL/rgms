// mock-supabase.mjs — เซิร์ฟเวอร์จำลอง Supabase (Auth + PostgREST บางส่วน) สำหรับทดสอบหน้าเว็บโดยไม่ต้องมีอินเทอร์เน็ต
// กติกาสิทธิ์อ่านตรงจาก supabase/01-schema.sql (ตาราง kv_rules) เพื่อให้ตรงกับของจริง
// ไม่ใช่ตัวแทน Supabase: ไม่ได้ทดสอบ SQL/RLS ในฐานข้อมูลจริง
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const dir = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(dir, '..', 'web');
const PORT = +process.env.PORT || 3200;
const ANON = 'anon-test-key', SRK = 'service-role-test-key';
const TTL = +process.env.ACCESS_TTL || 3600;
const URL_ = `http://localhost:${PORT}`;

const sql = fs.readFileSync(path.join(dir, '..', 'supabase', '01-schema.sql'), 'utf8');
const RULES = [...sql.matchAll(/^\s*\('(\^[^']+)',\s*'\{([a-z,]+)\}'\)/gm)].map(m => ({ re: new RegExp(m[1]), roles: m[2].split(',') }));
if (RULES.length < 8) throw new Error('อ่านกติกา kv_rules จาก SQL ไม่ได้: ' + RULES.length);

const users = new Map();        // email -> {id,pw}
const profiles = new Map();     // id -> {id,name,role,active}
const access = new Map();       // token -> {uid, exp}
const refresh = new Map();      // token -> uid
const kv = new Map();           // key -> {key,value,rev,deleted}
const changes = [];
let rev = 0;
const stats = { refreshCalls: 0 };

const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
const body = req => new Promise(ok => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function issue(uid) {
  const at = 'at_' + crypto.randomUUID(), rt = 'rt_' + crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + TTL;
  access.set(at, { uid, exp }); refresh.set(rt, uid);
  const email = [...users].find(([, u]) => u.id === uid)[0];
  return { access_token: at, refresh_token: rt, expires_in: TTL, expires_at: exp, token_type: 'bearer', user: { id: uid, email } };
}
function who(req) {
  if (req.headers.apikey !== ANON && req.headers.apikey !== SRK) return { err: 401 };
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (tok === SRK) return { service: true };
  if (tok === ANON || !tok) return { anon: true };
  const a = access.get(tok); if (!a || a.exp < Date.now() / 1000) return { err: 401, expired: true };
  const p = profiles.get(a.uid);
  return { uid: a.uid, role: p && p.active ? p.role : null };
}
const canWrite = role => key => !!role && RULES.some(r => r.re.test(key) && r.roles.includes(role));

function writeKv(key, fn, role, uid) {
  const cur = kv.get(key);
  const next = fn(cur && !cur.deleted ? cur.value : undefined);
  const row = { key, value: next, rev: ++rev, deleted: next === null };
  kv.set(key, row); changes.push({ rev, key, role, uid, value: next });
  return row;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, URL_), p = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }

  /* ---- Auth ---- */
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const b = await body(req), g = u.searchParams.get('grant_type');
    if (g === 'password') {
      const us = users.get(b.email);
      if (!us || us.pw !== b.password) return json(res, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return json(res, 200, issue(us.id));
    }
    if (g === 'refresh_token') {
      stats.refreshCalls++;
      const uid = refresh.get(b.refresh_token); if (!uid) return json(res, 400, { error_code: 'refresh_token_not_found' });
      refresh.delete(b.refresh_token); return json(res, 200, issue(uid));
    }
  }
  if (p === '/auth/v1/logout') { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); access.delete(t); return json(res, 204, {}); }
  if (p === '/auth/v1/admin/users') {
    if (req.headers.apikey !== SRK) return json(res, 401, {});
    if (req.method === 'POST') { const b = await body(req); if (users.has(b.email)) return json(res, 422, { msg: 'exists' }); const id = crypto.randomUUID(); users.set(b.email, { id, pw: b.password }); return json(res, 200, { id, email: b.email }); }
    if (req.method === 'GET') return json(res, 200, { users: [...users].map(([email, x]) => ({ id: x.id, email })) });
  }
  const adm = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(p);
  if (adm && req.method === 'PUT') { const b = await body(req); const e = [...users].find(([, x]) => x.id === adm[1]); if (e) e[1].pw = b.password; return json(res, 200, {}); }

  /* ---- REST ---- */
  if (p.startsWith('/rest/v1/')) {
    const w = who(req);
    if (w.err) return json(res, 401, { code: 'PGRST301', message: w.expired ? 'JWT expired' : 'bad apikey' });

    if (p === '/rest/v1/profiles') {
      if (req.method === 'POST') {          // สคริปต์สร้างผู้ใช้ (service role)
        if (!w.service) return json(res, 403, { code: '42501' });
        const b = await body(req); profiles.set(b.id, { id: b.id, name: b.name, role: b.role, active: b.active !== false }); return json(res, 201, {});
      }
      if (!w.uid) return json(res, 401, {});
      const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
      return json(res, 200, [...profiles.values()].filter(x => (!id || x.id === id) && (x.id === w.uid || w.role === 'staff')));
    }
    if (p === '/rest/v1/app_state' && req.method === 'GET') {
      if (!w.role) return json(res, 200, []);
      const gt = +(u.searchParams.get('rev') || '').replace(/^gt\./, '') || 0, k = (u.searchParams.get('key') || '').replace(/^eq\./, '');
      return json(res, 200, [...kv.values()].filter(r => r.rev > gt && (!k || r.key === k)).sort((a, b) => a.rev - b.rev));
    }
    const m = /^\/rest\/v1\/rpc\/(kv_\w+)$/.exec(p);
    if (m && req.method === 'POST') {
      if (!w.uid) return json(res, 401, { code: 'PGRST301' });
      const a = await body(req), cw = canWrite(w.role), deny = () => json(res, 403, { code: '42501', message: 'forbidden' });
      if (m[1] === 'kv_patch') {
        if (!cw(a.p_key)) return deny();
        const row = writeKv(a.p_key, cur => { const base = isObj(cur) ? { ...cur } : {}; Object.assign(base, a.p_set || {}); (a.p_del || []).forEach(k => delete base[k]); return base; }, w.role, w.uid);
        return json(res, 200, row.value);
      }
      if (m[1] === 'kv_put') { if (!cw(a.p_key)) return deny(); return json(res, 200, writeKv(a.p_key, () => a.p_value, w.role, w.uid).value); }
      if (m[1] === 'kv_delete') { if (!cw(a.p_key)) return deny(); if (kv.has(a.p_key) && !kv.get(a.p_key).deleted) writeKv(a.p_key, () => null, w.role, w.uid); return json(res, 204, null); }
      if (m[1] === 'kv_clear') { if (w.role !== 'staff') return deny(); [...kv.values()].filter(r => !r.deleted).forEach(r => writeKv(r.key, () => null, w.role, w.uid)); return json(res, 204, null); }
    }
    return json(res, 404, { message: 'not found' });
  }

  /* ---- เครื่องมือทดสอบ ---- */
  if (p === '/__test/expire') { const uid = u.searchParams.get('uid'); access.forEach((a, t) => { if (!uid || a.uid === uid) a.exp = 1; }); return json(res, 200, { ok: true }); }
  if (p === '/__test/stats') return json(res, 200, { ...stats, rev, keys: kv.size, changes });

  /* ---- static ---- */
  if (p === '/supabase-config.json') return json(res, 200, { url: URL_, anonKey: ANON });
  const file = path.normalize(path.join(WEB, p === '/' ? '/index.html' : decodeURIComponent(p)));
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(b); });
}).listen(PORT, () => console.log('mock supabase on ' + URL_ + '  rules=' + RULES.length));
