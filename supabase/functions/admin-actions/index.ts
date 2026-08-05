// Supabase Edge Function: admin-actions
// Handles the two things that require the service role key (creating a
// login account, resetting a password) — this key must never reach the
// browser, so these operations live server-side here instead.
//
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically by Supabase — no manual secret setup needed.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function usernameToEmail(username: string) {
  return `${username.toLowerCase().trim()}@attendance.local`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify the caller is a signed-in admin, using THEIR token (respects RLS).
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

    const { data: profile } = await userClient.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || profile.role !== "admin") {
      return json({ ok: false, error: "Admin access required" }, 403);
    }

    // From here on, use the service role client for the privileged action itself.
    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json();

    if (body.action === "createTeacher") {
      const { username, password, name, role, grade, section } = body;
      if (!username || !password || !name || !role) {
        return json({ ok: false, error: "Missing required fields" });
      }
      if (password.length < 6) {
        return json({ ok: false, error: "Password must be at least 6 characters" });
      }
      const email = usernameToEmail(username);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createErr) return json({ ok: false, error: createErr.message });

      const { error: profileErr } = await admin.from("profiles").insert({
        id: created.user!.id,
        username: username.toLowerCase().trim(),
        name,
        role,
        grade: role === "admin" ? null : grade,
        section: role === "admin" ? null : section,
      });
      if (profileErr) {
        // Roll back the auth user so a failed profile insert doesn't leave an orphan login.
        await admin.auth.admin.deleteUser(created.user!.id);
        return json({ ok: false, error: profileErr.message });
      }
      return json({ ok: true });
    }

    if (body.action === "resetPassword") {
      const { username, newPassword } = body;
      if (!username || !newPassword) return json({ ok: false, error: "Missing username or new password" });
      if (newPassword.length < 6) return json({ ok: false, error: "Password must be at least 6 characters" });

      const { data: prof } = await admin.from("profiles").select("id").eq("username", username.toLowerCase().trim()).single();
      if (!prof) return json({ ok: false, error: "No such username" });

      const { error } = await admin.auth.admin.updateUserById(prof.id, { password: newPassword });
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action" });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});
