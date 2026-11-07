-- =====================================================================
-- RGMS · Supabase (PostgreSQL) — schema + ล็อกอิน/สิทธิ์ (RLS)
-- รันทั้งไฟล์ใน Supabase Dashboard → SQL Editor (ครั้งเดียว ก่อนรัน 02-seed.sql)
-- ส่วนที่ 1 = ตารางหลักของโครงการ (เดิมจากชุด PostgreSQL ของคุณ)
-- ส่วนที่ 2 = บัญชีผู้ใช้/บทบาท + สถานะ workflow + สิทธิ์เขียนรายบทบาท
-- =====================================================================

-- ---------- ส่วนที่ 1: ตารางหลัก ----------
-- RGMS · ระบบบริหารจัดการทุนวิจัย มฟล. — PostgreSQL 14+
-- วันที่เก็บเป็น DATE/TIMESTAMPTZ จริง (ต้นแบบใช้ พ.ศ. เป็นสตริง → แปลงเป็น ค.ศ. ตอน seed)
CREATE TABLE personnel (            -- เจ้าหน้าที่ / อนุกรรมการ / เจ้าหน้าที่การเงิน
  id           serial PRIMARY KEY,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('staff','reviewer','finance')),
  school       text,
  fn           text,              -- หน้าที่ (staff)
  fn_label     text,
  expertise    text[] NOT NULL DEFAULT '{}',
  UNIQUE (name, kind)
);


CREATE TABLE funding_calls (        -- รอบทุน
  id            text PRIMARY KEY,
  fiscal_year   int  NOT NULL,
  title         text NOT NULL,
  open_date     date NOT NULL,
  close_date    date NOT NULL,
  cap           numeric(12,2) NOT NULL CHECK (cap BETWEEN 100000 AND 300000),
  status        text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','open','closed','closed_recent')),
  is_custom     boolean NOT NULL DEFAULT false,
  CHECK (close_date > open_date)
);
-- เปิดรับได้ทีละรอบเดียว
ALTER TABLE funding_calls ADD CONSTRAINT one_open_call
  EXCLUDE USING btree ((status) WITH =) WHERE (status = 'open') DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE projects (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  pi_name       text NOT NULL,
  school        text NOT NULL,
  call_id       text REFERENCES funding_calls(id),
  tier          text,
  budget_req    numeric(12,2) NOT NULL CHECK (budget_req >= 0),
  status        text NOT NULL,
  submitted_at  date,
  updated_at    date,
  abstract      text,
  duration      text,
  owner_role    text,
  start_date    date,
  closed_date   date,
  progress_pct  int CHECK (progress_pct BETWEEN 0 AND 100),
  score         numeric(5,2),
  meeting_no    text,
  finance       jsonb,            -- ผลตรวจแทร็กการเงิน
  extra         jsonb NOT NULL DEFAULT '{}'  -- ledger, vouchers, output, publication ฯลฯ
);
CREATE INDEX projects_status_idx ON projects(status);
CREATE INDEX projects_school_idx ON projects(school);
CREATE INDEX projects_call_idx   ON projects(call_id);

CREATE TABLE project_budget_items (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq        int  NOT NULL,
  item       text NOT NULL,
  amount     numeric(12,2) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (project_id, seq)
);

CREATE TABLE project_checklist (    -- ผลตรวจความครบถ้วนเอกสาร
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        text NOT NULL,
  label      text NOT NULL,
  ok         boolean NOT NULL,
  note       text,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE project_criteria (     -- เกณฑ์ให้คะแนน
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  criterion  text NOT NULL,
  label      text NOT NULL,
  max_score  int  NOT NULL,
  PRIMARY KEY (project_id, criterion)
);

CREATE TABLE project_reviews (      -- อนุกรรมการประเมิน (แทร็กเนื้อหา)
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reviewer_name text NOT NULL,
  submitted     boolean NOT NULL DEFAULT false,
  total         numeric(5,2),
  recommend     text CHECK (recommend IN ('approve','approve_revise','reject')),
  scores        jsonb NOT NULL DEFAULT '{}',
  comment       text,
  PRIMARY KEY (project_id, reviewer_name)
);

CREATE TABLE project_installments ( -- งวดเงิน
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  no         int  NOT NULL,
  label      text NOT NULL,
  amount     numeric(12,2) NOT NULL,
  status     text NOT NULL CHECK (status IN ('paid','due','pending')),
  paid_date  date,
  PRIMARY KEY (project_id, no)
);

CREATE TABLE project_history (
  id         bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at         timestamptz,       -- ข้อมูลเดิมบางรายการไม่มีเวลา
  by         text NOT NULL,
  action     text NOT NULL
);
CREATE INDEX project_history_idx ON project_history(project_id, at);

CREATE TABLE meetings (
  no          text PRIMARY KEY,
  fiscal_year int  NOT NULL,
  date        date,
  committee   text,
  status      text NOT NULL CHECK (status IN ('draft','minuted','open'))
);
CREATE TABLE meeting_items (
  meeting_no text NOT NULL REFERENCES meetings(no) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id),
  resolution text NOT NULL CHECK (resolution IN ('approve','approve_revise','reject')),
  PRIMARY KEY (meeting_no, project_id)
);

CREATE TABLE change_requests (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  type       text NOT NULL,
  detail     text,
  status     text NOT NULL,
  at         date
);

CREATE TABLE audit_log (            -- Audit Log ของเจ้าหน้าที่
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  by     text NOT NULL,
  action text NOT NULL,
  detail text,
  type   text NOT NULL DEFAULT 'other'
);
CREATE INDEX audit_log_at_idx ON audit_log(at DESC);

-- ---------- ส่วนที่ 2: ผู้ใช้ สถานะ และสิทธิ์ ----------

-- บทบาทของผู้ใช้ ผูกกับบัญชีล็อกอินของ Supabase (auth.users)
-- ไม่มี policy ให้เขียน → ผู้ใช้เปลี่ยนบทบาทตัวเองไม่ได้ (ผู้ดูแลเพิ่ม/แก้ผ่าน SQL Editor หรือสคริปต์)
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  role       text not null check (role in ('researcher','chair','secretary','staff','reviewer','finance','exec')),
  school     text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- สถานะที่หน้าเว็บเก็บเป็น rgms_* (1 แถว = 1 key; value = JSON ของ key นั้น)
create sequence public.app_state_rev_seq;
create table public.app_state (
  key        text primary key check (key ~ '^rgms_[a-z0-9_]{1,80}$'),
  value      jsonb,
  rev        bigint not null default 0,          -- เลขลำดับการเปลี่ยนแปลงทั้งระบบ ใช้ sync ระหว่างผู้ใช้
  deleted    boolean not null default false,     -- ลบแบบ soft เพื่อให้เครื่องอื่นรู้ว่า key ถูกลบ
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index app_state_rev_idx on public.app_state(rev);

-- ประวัติการเปลี่ยนแปลงถาวร (เขียนโดย trigger เท่านั้น)
create table public.change_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  rev        bigint,
  key        text not null,
  subkey     text,                                -- เช่น รหัสโครงการ เมื่อ value เป็น map
  op         text not null,                       -- set | del | replace
  old_value  jsonb,
  new_value  jsonb,
  actor      uuid,
  actor_role text,
  actor_name text
);
create index change_log_key_idx on public.change_log(key, subkey);

-- ใครเขียน key ไหนได้ (regex) — ปรับตรงนี้เมื่อเพิ่มฟีเจอร์ใหม่
create table public.kv_rules (
  pattern text primary key,
  roles   text[] not null
);
insert into public.kv_rules (pattern, roles) values
  ('^rgms_(track_content|content_comment|content_recommend)$',                '{reviewer,researcher}'),
  ('^rgms_(track_finance|finance_comment|finance_owner)$',                    '{finance,researcher}'),
  ('^rgms_(decision|announced|exec_announcements|exec_log|exec_meta)$',       '{exec,staff}'),
  ('^rgms_exec_resubmitted$',                                                 '{exec,staff,researcher}'),
  ('^rgms_endorse$',                                                          '{chair}'),
  ('^rgms_(call_status|calls_custom|calls_edits)$',                           '{staff}'),
  ('^rgms_staff_',                                                            '{staff}'),
  ('^rgms_profile$',                                                          '{researcher,secretary}'),
  ('^rgms_(proposals_v1|chair_state_v1|events_v1|[a-z]+_notif_v1)$',          '{researcher,chair,secretary,staff}');

-- ---------- ฟังก์ชันช่วย ----------
-- บทบาทของผู้ที่ล็อกอินอยู่ (null = ไม่มีบัญชีใช้งาน) · security definer เพื่อไม่ติด RLS ของ profiles
create or replace function public.rgms_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.can_write_key(k text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kv_rules r
    where k ~ r.pattern and public.rgms_role() = any (r.roles)
  )
$$;

-- ---------- trigger: ใส่ rev/ผู้แก้ + บันทึก change_log ----------
create or replace function public.app_state_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.rev        := nextval('public.app_state_rev_seq');
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger app_state_before before insert or update on public.app_state
  for each row execute function public.app_state_before();

create or replace function public.app_state_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k  text;
  ov jsonb := null;
  nv jsonb := null;
  r  text  := public.rgms_role();
  nm text;
begin
  select name into nm from public.profiles where id = auth.uid();
  if tg_op = 'UPDATE' and not old.deleted then ov := old.value; end if;
  if not new.deleted then nv := new.value; end if;

  if new.deleted then
    insert into public.change_log(rev, key, op, old_value, new_value, actor, actor_role, actor_name)
    values (new.rev, new.key, 'del', ov, null, auth.uid(), r, nm);
  elsif ov is not null and jsonb_typeof(ov) = 'object' and jsonb_typeof(nv) = 'object' then
    for k in select jk from (select jsonb_object_keys(nv) as jk union select jsonb_object_keys(ov)) s loop
      if (ov -> k) is distinct from (nv -> k) then
        insert into public.change_log(rev, key, subkey, op, old_value, new_value, actor, actor_role, actor_name)
        values (new.rev, new.key, k, case when (nv -> k) is null then 'del' else 'set' end, ov -> k, nv -> k, auth.uid(), r, nm);
      end if;
    end loop;
  elsif ov is distinct from nv then
    insert into public.change_log(rev, key, op, old_value, new_value, actor, actor_role, actor_name)
    values (new.rev, new.key, 'replace', ov, nv, auth.uid(), r, nm);
  end if;
  return null;
end $$;
create trigger app_state_audit after insert or update on public.app_state
  for each row execute function public.app_state_audit();

-- ---------- ฟังก์ชันที่หน้าเว็บเรียก (RPC) ----------
-- รวมการแก้ระดับ subkey ของ map: คนละโครงการแก้พร้อมกันไม่ทับกัน (upsert เป็น atomic ต่อแถว)
create or replace function public.kv_patch(p_key text, p_set jsonb default '{}'::jsonb, p_del text[] default '{}'::text[])
returns jsonb language plpgsql as $$
declare res jsonb;
begin
  if not public.can_write_key(p_key) then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.app_state as s (key, value)
  values (p_key, coalesce(p_set, '{}'::jsonb))
  on conflict (key) do update set
    value   = ((case when not s.deleted and jsonb_typeof(s.value) = 'object' then s.value else '{}'::jsonb end)
               || coalesce(p_set, '{}'::jsonb)) - coalesce(p_del, '{}'::text[]),
    deleted = false
  returning s.value into res;
  return res;
end $$;

create or replace function public.kv_put(p_key text, p_value jsonb) returns jsonb
language plpgsql as $$
declare res jsonb;
begin
  if not public.can_write_key(p_key) then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.app_state as s (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, deleted = false
  returning s.value into res;
  return res;
end $$;

create or replace function public.kv_delete(p_key text) returns void
language plpgsql as $$
begin
  if not public.can_write_key(p_key) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.app_state set value = null, deleted = true where key = p_key and not deleted;
end $$;

-- ปุ่มรีเซ็ตของโหมดทดสอบ: ล้างสถานะทั้งหมด (เฉพาะเจ้าหน้าที่ส่วนบริหาร)
create or replace function public.kv_clear() returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.rgms_role() is distinct from 'staff' then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.app_state set value = null, deleted = true where not deleted;
end $$;

-- ---------- สิทธิ์การเข้าถึง ----------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on function public.kv_patch(text, jsonb, text[]), public.kv_put(text, jsonb),
                           public.kv_delete(text), public.kv_clear() from public, anon;
grant  execute on function public.kv_patch(text, jsonb, text[]), public.kv_put(text, jsonb),
                           public.kv_delete(text), public.kv_clear() to authenticated;

-- ---------- Row Level Security ----------
alter table public.profiles   enable row level security;
alter table public.app_state  enable row level security;
alter table public.change_log enable row level security;
alter table public.kv_rules   enable row level security;
alter table public.audit_log  enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.rgms_role() = 'staff');

create policy app_state_read on public.app_state for select to authenticated
  using (public.rgms_role() is not null);
create policy app_state_ins on public.app_state for insert to authenticated
  with check (public.can_write_key(key));
create policy app_state_upd on public.app_state for update to authenticated
  using (public.can_write_key(key)) with check (public.can_write_key(key));
-- ไม่มี policy delete: ลบได้เฉพาะ soft delete ผ่าน kv_delete

create policy change_log_read on public.change_log for select to authenticated
  using (public.rgms_role() in ('staff','exec'));
create policy kv_rules_read on public.kv_rules for select to authenticated
  using (public.rgms_role() is not null);
create policy audit_log_read on public.audit_log for select to authenticated
  using (public.rgms_role() in ('staff','exec'));
create policy audit_log_write on public.audit_log for all to authenticated
  using (public.rgms_role() = 'staff') with check (public.rgms_role() = 'staff');

-- ตารางหลักของโครงการ: ผู้ใช้ที่ active อ่านได้ · เจ้าหน้าที่ส่วนบริหารเท่านั้นที่แก้ได้
do $$
declare t text;
begin
  foreach t in array array['personnel','funding_calls','projects','project_budget_items','project_checklist',
    'project_criteria','project_reviews','project_installments','project_history','meetings','meeting_items','change_requests']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.rgms_role() is not null)', t || '_read', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.rgms_role() = ''staff'') with check (public.rgms_role() = ''staff'')', t || '_staff_write', t);
  end loop;
end $$;
