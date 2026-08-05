let profile;

async function signOut() {
  await Auth.logout();
  window.location.href = 'index.html';
}

async function changePassword() {
  const oldPassword = window.prompt('Enter your current password:');
  if (!oldPassword) return;
  const newPassword = window.prompt('Enter a new password (6+ characters):');
  if (!newPassword) return;
  const res = await Auth.changePassword(oldPassword, newPassword);
  if (!res.ok) { alert(res.error); return; }
  alert('Password updated.');
}

async function resetTeacherPassword(username) {
  const newPassword = window.prompt(`New password for "${username}" (6+ characters):`);
  if (!newPassword) return;
  const res = await Auth.callAdminAction('resetPassword', { username, newPassword });
  if (!res.ok) { alert(res.error); return; }
  alert(`Password reset for ${username}. Share the new password with them directly.`);
}

function showTab(name) {
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelector(`.tabs button[data-tab="${name}"]`).classList.add('active');
  if (name === 'teachers') loadTeachers();
}

// ── OVERVIEW ────────────────────────────────────────────────────────────

async function loadDashboard() {
  const date = document.getElementById('dashDate').value;
  const grid = document.getElementById('dashboardGrid');
  grid.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const { data, error } = await sb.rpc('get_dashboard', { p_date: date });
    if (error) throw error;

    const byGrade = { 6: [], 7: [], 8: [] };
    data.forEach(c => byGrade[c.grade].push(c));

    grid.innerHTML = Object.keys(byGrade).map(grade => `
      <div class="grade-block">
        <h3>Grade ${grade}</h3>
        <div class="class-grid">
          ${byGrade[grade].map(c => `
            <div class="class-tile ${c.marked ? 'marked' : 'unmarked'}">
              <div class="dot"></div>
              <div class="sec">${grade}-${c.section}</div>
              <div class="count">${c.marked ? `${c.present_count}P / ${c.absent_count}A` : 'Not marked'}</div>
            </div>`).join('')}
        </div>
      </div>`).join('');
  } catch (err) {
    grid.innerHTML = `<div class="status-banner warn">${err.message}</div>`;
  }
}

// ── ABSENTEES / WHATSAPP ────────────────────────────────────────────────

let currentAbsentees = [];

function fillTemplate(tpl, name, date) {
  return tpl.replace(/{name}/g, name).replace(/{date}/g, date);
}

async function loadAbsentees() {
  const date = document.getElementById('absDate').value;
  const grade = document.getElementById('absGrade').value || null;
  const section = document.getElementById('absSection').value || null;
  const listEl = document.getElementById('absenteeList');
  listEl.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const { data, error } = await sb.rpc('get_absentees', { p_date: date, p_grade: grade, p_section: section });
    if (error) throw error;
    currentAbsentees = data.map(a => ({
      studentId: a.student_id, name: a.name, grade: a.grade, section: a.section,
      parentName: a.parent_name, parentPhone: a.parent_phone
    }));
    renderAbsentees(date);
  } catch (err) {
    listEl.innerHTML = `<div class="status-banner warn">${err.message}</div>`;
  }
}

function renderAbsentees(date) {
  const listEl = document.getElementById('absenteeList');
  if (!currentAbsentees.length) {
    listEl.innerHTML = '<div class="empty-state">No absentees found for this selection — nice.</div>';
    return;
  }
  const tpl = document.getElementById('msgTemplate').value;
  listEl.innerHTML = `
    <div style="margin-bottom:10px;">
      <button class="btn small" onclick="sendAllWhatsApp('${date}')">Open WhatsApp for all (one tab each)</button>
    </div>
  ` + currentAbsentees.map((a, i) => {
    const hasPhone = !!a.parentPhone;
    const msg = encodeURIComponent(fillTemplate(tpl, a.name, date));
    const link = hasPhone ? `https://wa.me/${a.parentPhone}?text=${msg}` : null;
    return `
      <div class="absentee-row" id="abs-row-${i}">
        <div class="who">
          <div class="name">${a.name} <span class="hint">· Grade ${a.grade}-${a.section}</span></div>
          <div class="meta">${a.parentName || 'Parent'} ${hasPhone ? '· ' + a.parentPhone : ''}</div>
        </div>
        ${hasPhone
          ? `<button class="btn small" onclick="sendOne(${i}, '${link}')">Send WhatsApp</button>`
          : `<span class="no-phone">No phone on file</span>`}
      </div>`;
  }).join('');
}

function sendOne(i, link) {
  window.open(link, '_blank');
  document.getElementById(`abs-row-${i}`).classList.add('sent');
}

function sendAllWhatsApp(date) {
  const tpl = document.getElementById('msgTemplate').value;
  currentAbsentees.forEach((a, i) => {
    if (!a.parentPhone) return;
    const msg = encodeURIComponent(fillTemplate(tpl, a.name, date));
    setTimeout(() => {
      window.open(`https://wa.me/${a.parentPhone}?text=${msg}`, '_blank');
      const row = document.getElementById(`abs-row-${i}`);
      if (row) row.classList.add('sent');
    }, i * 400); // stagger so the browser doesn't block a burst of popups
  });
}

// ── STUDENTS ────────────────────────────────────────────────────────────

async function addStudent() {
  const student = {
    name: document.getElementById('stuName').value.trim(),
    grade: document.getElementById('stuGrade').value,
    section: document.getElementById('stuSection').value,
    parent_name: document.getElementById('stuParentName').value.trim(),
    parent_phone: document.getElementById('stuParentPhone').value.trim()
  };
  if (!student.name) { alert('Enter a student name'); return; }
  const { error } = await sb.from('students').insert(student);
  if (error) { alert(error.message); return; }
  document.getElementById('stuName').value = '';
  document.getElementById('stuParentName').value = '';
  document.getElementById('stuParentPhone').value = '';
  alert('Student added.');
}

function parseCsvLine(line) {
  return line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
}

async function importCsv() {
  const fileInput = document.getElementById('csvFile');
  const status = document.getElementById('importStatus');
  if (!fileInput.files.length) { status.textContent = 'Choose a CSV file first.'; return; }

  const text = await fileInput.files[0].text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const students = lines
    .map(parseCsvLine)
    .filter(cols => cols[0] && cols[0].toLowerCase() !== 'name') // skip header if present
    .map(cols => ({
      name: cols[0],
      grade: cols[1],
      section: cols[2],
      parent_name: cols[3] || '',
      parent_phone: cols[4] || ''
    }));

  if (!students.length) { status.textContent = 'No valid rows found.'; return; }

  status.textContent = `Importing ${students.length} students…`;
  const { error } = await sb.from('students').insert(students);
  if (error) { status.textContent = error.message; return; }
  status.textContent = `Imported ${students.length} students.`;
  fileInput.value = '';
}

// ── TEACHERS ────────────────────────────────────────────────────────────

async function addTeacher() {
  const teacher = {
    name: document.getElementById('teachName').value.trim(),
    username: document.getElementById('teachUsername').value.trim(),
    password: document.getElementById('teachPassword').value,
    role: document.getElementById('teachRole').value,
    grade: document.getElementById('teachGrade').value,
    section: document.getElementById('teachSection').value
  };
  if (!teacher.name || !teacher.username || !teacher.password) {
    alert('Enter name, username, and initial password');
    return;
  }
  const res = await Auth.callAdminAction('createTeacher', teacher);
  if (!res.ok) { alert(res.error); return; }
  document.getElementById('teachName').value = '';
  document.getElementById('teachUsername').value = '';
  document.getElementById('teachPassword').value = '';
  loadTeachers();
}

async function loadTeachers() {
  const el = document.getElementById('teacherList');
  el.innerHTML = '<p class="hint">Loading…</p>';
  const { data, error } = await sb.from('profiles').select('*').order('name');
  if (error) { el.innerHTML = `<div class="status-banner warn">${error.message}</div>`; return; }

  el.innerHTML = `
    <table class="roll">
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Class</th><th></th></tr></thead>
      <tbody>
        ${data.map(t => `
          <tr>
            <td>${t.name}</td>
            <td class="mono">${t.username}</td>
            <td>${t.role}</td>
            <td>${t.role === 'admin' ? '—' : `${t.grade}-${t.section}`}</td>
            <td><button class="btn small secondary" onclick="resetTeacherPassword('${t.username}')">Reset password</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── INIT ────────────────────────────────────────────────────────────────

window.onload = async () => {
  const auth = await Auth.requireOrRedirect();
  if (!auth) return;
  profile = auth.profile;
  if (profile.role !== 'admin') { window.location.href = 'teacher.html'; return; }

  document.getElementById('whoLabel').textContent = profile.name;

  const sectionOptions = ['A','B','C','D','E','F','G'].map(s => `<option>${s}</option>`).join('');
  document.getElementById('absSection').innerHTML += sectionOptions;

  document.getElementById('dashDate').value = todayISO();
  document.getElementById('absDate').value = todayISO();

  loadDashboard();
};
