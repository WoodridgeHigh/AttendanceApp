let profile, students = [], statusMap = {};

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

function banner(msg, type) {
  document.getElementById('banner').innerHTML = `<div class="status-banner ${type}">${msg}</div>`;
}

function updateCounts() {
  const values = Object.values(statusMap);
  document.getElementById('presentCount').textContent = `Present: ${values.filter(v => v === 'present').length}`;
  document.getElementById('absentCount').textContent = `Absent: ${values.filter(v => v === 'absent').length}`;
}

function setStatus(studentId, status) {
  statusMap[studentId] = status;
  const row = document.querySelector(`tr[data-id="${studentId}"]`);
  row.querySelector('.present').classList.toggle('active', status === 'present');
  row.querySelector('.absent').classList.toggle('active', status === 'absent');
  updateCounts();
}

function renderRoster() {
  const body = document.getElementById('rollBody');
  body.innerHTML = '';
  document.getElementById('emptyState').style.display = students.length ? 'none' : 'block';

  students.forEach((s, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    tr.innerHTML = `
      <td class="roll-no mono">${idx + 1}</td>
      <td>${s.name}</td>
      <td>
        <div class="stamp-toggle">
          <button class="present" onclick="setStatus('${s.id}','present')">Present</button>
          <button class="absent" onclick="setStatus('${s.id}','absent')">Absent</button>
        </div>
      </td>`;
    body.appendChild(tr);
  });
}

async function loadForDate(date) {
  banner('Loading roster…', 'ok');
  try {
    // One round trip — get_roster() returns the class list and today's marks together.
    const { data, error } = await sb.rpc('get_roster', { p_date: date });
    if (error) throw error;

    students = data.students;
    renderRoster();

    statusMap = {};
    const wasMarked = Object.keys(data.records).length > 0;
    students.forEach(s => {
      // Default every student to Present; teacher only has to tap the exceptions.
      const existing = data.records[s.id];
      statusMap[s.id] = existing || 'present';
      setStatus(s.id, statusMap[s.id]);
    });

    if (wasMarked) {
      banner('Attendance already saved for this date — editing will overwrite it.', 'warn');
    } else {
      document.getElementById('banner').innerHTML = '';
    }
  } catch (err) {
    banner(err.message, 'warn');
  }
}

async function submitAttendance() {
  const date = document.getElementById('datePicker').value;
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { data, error } = await sb.rpc('submit_attendance', {
      p_date: date,
      p_grade: profile.grade,
      p_section: profile.section,
      p_records: statusMap
    });
    if (error) throw error;
    banner(`Saved — ${data.present} present, ${data.absent} absent.`, 'ok');
  } catch (err) {
    banner(err.message, 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save attendance';
  }
}

window.onload = async () => {
  const auth = await Auth.requireOrRedirect();
  if (!auth) return;
  profile = auth.profile;
  if (profile.role === 'admin') { window.location.href = 'admin.html'; return; }

  document.getElementById('whoLabel').textContent = `${profile.name} (${profile.username}) · Grade ${profile.grade}-${profile.section}`;
  document.getElementById('classTitle').textContent = `Grade ${profile.grade}-${profile.section} — Roll Call`;

  const dateInput = document.getElementById('datePicker');
  dateInput.value = todayISO();
  dateInput.max = todayISO();
  dateInput.addEventListener('change', () => loadForDate(dateInput.value));

  loadForDate(dateInput.value);
};
