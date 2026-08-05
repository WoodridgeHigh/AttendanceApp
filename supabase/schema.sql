-- ============================================================
-- Attendance Register — Supabase schema
-- Run this entire file once in the Supabase SQL Editor.
-- ============================================================

-- ── TABLES ───────────────────────────────────────────────────

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  name text not null,
  role text not null check (role in ('teacher', 'admin')),
  grade text,
  section text
);

create table students (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  grade text not null,
  section text not null,
  parent_name text,
  parent_phone text,
  active boolean not null default true
);

create table attendance (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  grade text not null,
  section text not null,
  student_id uuid not null references students(id) on delete cascade,
  status text not null check (status in ('present', 'absent')),
  marked_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (date, grade, section, student_id)
);

create table attendance_log (
  date date not null,
  grade text not null,
  section text not null,
  marked_by uuid references profiles(id),
  marked_at timestamptz not null default now(),
  present_count int not null default 0,
  absent_count int not null default 0,
  primary key (date, grade, section)
);

create index idx_students_class on students (grade, section);
create index idx_attendance_class_date on attendance (date, grade, section);

-- ── HELPER FUNCTIONS ─────────────────────────────────────────
-- security definer so they can read `profiles` without getting stuck
-- in the profiles table's own RLS policy (which would otherwise recurse).

create or replace function is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function my_grade_section()
returns table(grade text, section text)
language sql stable security definer
set search_path = public
as $$
  select grade, section from profiles where id = auth.uid();
$$;

-- ── ROW LEVEL SECURITY ───────────────────────────────────────

alter table profiles enable row level security;
alter table students enable row level security;
alter table attendance enable row level security;
alter table attendance_log enable row level security;

-- profiles: everyone can see their own row; admins can see everyone.
-- No insert/update/delete policies on purpose — accounts are only ever
-- created/edited through the admin-actions Edge Function (which uses the
-- service role key and bypasses RLS entirely).
create policy "read own or admin" on profiles
  for select using (auth.uid() = id or is_admin());

-- students: teachers see only their own class; admins see and manage all.
create policy "students read own class or admin" on students
  for select using (
    is_admin() or (grade, section) in (select grade, section from my_grade_section())
  );
create policy "students admin write" on students
  for insert with check (is_admin());
create policy "students admin update" on students
  for update using (is_admin());

-- attendance: read scoped the same way. All writes go through the
-- submit_attendance() function below (security definer), so no direct
-- insert/update/delete policies are needed for regular users.
create policy "attendance read own class or admin" on attendance
  for select using (
    is_admin() or (grade, section) in (select grade, section from my_grade_section())
  );

create policy "attendance_log read own class or admin" on attendance_log
  for select using (
    is_admin() or (grade, section) in (select grade, section from my_grade_section())
  );

-- ── RPC: submit attendance (atomic, access-checked) ─────────
-- p_records is a JSON object like {"<student_uuid>": "present", ...}

create or replace function submit_attendance(p_date date, p_grade text, p_section text, p_records jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_grade text;
  caller_section text;
  rec record;
  present_count int := 0;
  absent_count int := 0;
begin
  select role, grade, section into caller_role, caller_grade, caller_section
  from profiles where id = auth.uid();

  if caller_role is null then
    raise exception 'Not authorized';
  end if;
  if caller_role <> 'admin' and (caller_grade <> p_grade or caller_section <> p_section) then
    raise exception 'You can only mark attendance for your own class';
  end if;

  delete from attendance where date = p_date and grade = p_grade and section = p_section;

  for rec in select * from jsonb_each_text(p_records) loop
    insert into attendance (date, grade, section, student_id, status, marked_by)
    values (p_date, p_grade, p_section, rec.key::uuid, rec.value, auth.uid());
    if rec.value = 'present' then present_count := present_count + 1;
    else absent_count := absent_count + 1;
    end if;
  end loop;

  insert into attendance_log (date, grade, section, marked_by, marked_at, present_count, absent_count)
  values (p_date, p_grade, p_section, auth.uid(), now(), present_count, absent_count)
  on conflict (date, grade, section) do update
    set marked_by = excluded.marked_by,
        marked_at = excluded.marked_at,
        present_count = excluded.present_count,
        absent_count = excluded.absent_count;

  return jsonb_build_object('present', present_count, 'absent', absent_count);
end;
$$;

-- ── RPC: combined roster + today's marks (one round trip for teachers) ──

create or replace function get_roster(p_date date)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_grade text;
  caller_section text;
  result jsonb;
begin
  select role, grade, section into caller_role, caller_grade, caller_section
  from profiles where id = auth.uid();

  if caller_role is null then
    raise exception 'Not authorized';
  end if;
  if caller_role = 'admin' then
    raise exception 'Admins should use get_dashboard / get_absentees';
  end if;

  select jsonb_build_object(
    'students', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name), '[]'::jsonb)
      from students s
      where s.grade = caller_grade and s.section = caller_section and s.active
    ),
    'records', (
      select coalesce(jsonb_object_agg(a.student_id, a.status), '{}'::jsonb)
      from attendance a
      where a.date = p_date and a.grade = caller_grade and a.section = caller_section
    )
  ) into result;

  return result;
end;
$$;

-- ── RPC: admin dashboard grid ─────────────────────────────────

create or replace function get_dashboard(p_date date)
returns table(grade text, section text, marked boolean, marked_by text, marked_at timestamptz, present_count int, absent_count int)
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admin access required'; end if;

  return query
  select gr.grade, sec.section,
    (al.date is not null) as marked,
    p.name as marked_by,
    al.marked_at,
    coalesce(al.present_count, 0),
    coalesce(al.absent_count, 0)
  from unnest(array['6', '7', '8']) as gr(grade)
  cross join unnest(array['A', 'B', 'C', 'D', 'E', 'F', 'G']) as sec(section)
  left join attendance_log al on al.date = p_date and al.grade = gr.grade and al.section = sec.section
  left join profiles p on p.id = al.marked_by
  order by gr.grade, sec.section;
end;
$$;

-- ── RPC: absentee list for WhatsApp messaging ─────────────────

create or replace function get_absentees(p_date date, p_grade text default null, p_section text default null)
returns table(student_id uuid, name text, grade text, section text, parent_name text, parent_phone text)
language plpgsql security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Admin access required'; end if;

  return query
  select s.id, s.name, a.grade, a.section, s.parent_name, s.parent_phone
  from attendance a
  join students s on s.id = a.student_id
  where a.date = p_date and a.status = 'absent'
    and (p_grade is null or p_grade = '' or a.grade = p_grade)
    and (p_section is null or p_section = '' or a.section = p_section)
  order by a.grade, a.section, s.name;
end;
$$;
