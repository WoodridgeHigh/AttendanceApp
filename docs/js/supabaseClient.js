// Requires the Supabase UMD script + config.js to be loaded first.
// Exposes: `sb` (the Supabase client) and `Auth` (login/session helpers).

const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const Auth = {
  // Supabase Auth needs an email; teachers only ever see/type a username.
  usernameToEmail(username) {
    return `${username.toLowerCase().trim()}@attendance.local`;
  },

  async login(username, password) {
    const email = this.usernameToEmail(username);
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: 'Invalid username or password' };

    const profile = await this.loadProfile(data.user.id);
    if (!profile) {
      await sb.auth.signOut();
      return { ok: false, error: 'Your account exists but has no profile set up. Contact the admin.' };
    }
    localStorage.setItem('attendance_profile', JSON.stringify(profile));
    return { ok: true, profile };
  },

  async loadProfile(userId) {
    const { data, error } = await sb.from('profiles').select('*').eq('id', userId).single();
    if (error || !data) return null;
    return data;
  },

  getCachedProfile() {
    const raw = localStorage.getItem('attendance_profile');
    return raw ? JSON.parse(raw) : null;
  },

  // Call at the top of teacher.html / admin.html. Redirects to login if
  // there's no active session, otherwise returns { session, profile }.
  async requireOrRedirect(loginPage = 'index.html') {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { window.location.href = loginPage; return null; }

    let profile = this.getCachedProfile();
    if (!profile || profile.id !== session.user.id) {
      profile = await this.loadProfile(session.user.id);
      if (!profile) { window.location.href = loginPage; return null; }
      localStorage.setItem('attendance_profile', JSON.stringify(profile));
    }
    return { session, profile };
  },

  async logout() {
    await sb.auth.signOut();
    localStorage.removeItem('attendance_profile');
  },

  // Re-authenticates with the old password first, so this never lets
  // someone change a password without proving they knew the current one.
  async changePassword(oldPassword, newPassword) {
    const profile = this.getCachedProfile();
    if (!profile) return { ok: false, error: 'Not signed in' };
    if (newPassword.length < 6) return { ok: false, error: 'New password must be at least 6 characters' };

    const email = this.usernameToEmail(profile.username);
    const { error: reauthErr } = await sb.auth.signInWithPassword({ email, password: oldPassword });
    if (reauthErr) return { ok: false, error: 'Current password is incorrect' };

    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  },

  // Calls the admin-actions Edge Function (creating accounts, resetting
  // passwords) — the function itself re-checks admin status server-side.
  async callAdminAction(action, payload = {}) {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/admin-actions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': CONFIG.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action, ...payload })
    });
    return res.json();
  }
};

function todayISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
