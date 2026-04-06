import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

/**
 * Tarayıcıdan Edge Function çağrısı için izin verilen Origin’ler (CORS).
 * Supabase’te `ALLOWED_ORIGINS` secret’ı tanımlıysa bu liste yerine o kullanılır
 * (virgülle ayırın; production + localhost’u birlikte yazın).
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://localhost:19000',
  'https://nima-map.vercel.app',
];

const MAX_BODY_BYTES = 48_000;

function parseAllowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS')?.trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Yalnızca listelenen Origin değerlerine CORS yanıtı — `*` yok; rastgele siteler
 * tarayıcı üzerinden bu endpoint’i kötüye kullanamaz (CSRF benzeri senaryolar).
 */
function corsHeaders(req: Request, allowed: string[]): Record<string, string> | null {
  const origin = req.headers.get('Origin');
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, prefer, x-supabase-api-version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (!origin || !allowed.includes(origin)) {
    return null;
  }
  return { ...base, 'Access-Control-Allow-Origin': origin };
}

function json(body: unknown, status: number, cors: Record<string, string> | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cors) Object.assign(headers, cors);
  return new Response(JSON.stringify(body), { status, headers });
}

serve(async (req) => {
  const allowedOrigins = parseAllowedOrigins();
  const cors = corsHeaders(req, allowedOrigins);

  if (req.method === 'OPTIONS') {
    if (!cors) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Yalnızca POST' }, 405, cors);
  }

  if (!cors) {
    return new Response(JSON.stringify({ error: 'İzin verilmeyen köken (Origin). ALLOWED_ORIGINS ile ekleyin.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const len = req.headers.get('Content-Length');
  if (len && Number(len) > MAX_BODY_BYTES) {
    return json({ error: 'İstek gövdesi çok büyük' }, 413, cors);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Sunucu yapılandırması eksik' }, 500, cors);
  }

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json({ error: 'Geçersiz gövde' }, 400, cors);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'İstek gövdesi çok büyük' }, 413, cors);
  }

  let body: {
    mode?: string;
    email?: string;
    password?: string;
    full_name?: string;
    role?: string;
    bootstrap_secret?: string;
    user_id?: string;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: 'Geçersiz JSON' }, 400, cors);
  }

  const mode = typeof body.mode === 'string' ? body.mode.trim() : '';

  if (mode === 'bootstrap') {
    const expected = Deno.env.get('BOOTSTRAP_SECRET');
    if (!expected || body.bootstrap_secret !== expected) {
      return json({ error: 'Geçersiz kurulum anahtarı' }, 403, cors);
    }

    const { count, error: countErr } = await adminClient
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'admin');

    if (countErr) {
      return json({ error: countErr.message }, 500, cors);
    }
    if ((count ?? 0) > 0) {
      return json({ error: 'Zaten yönetici var; kurulum devre dışı.' }, 403, cors);
    }

    if (!body.email?.trim() || !body.password) {
      return json({ error: 'E-posta ve şifre gerekli' }, 400, cors);
    }

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email: body.email.trim(),
      password: body.password,
      email_confirm: true,
      user_metadata: { full_name: body.full_name ?? '' },
    });

    if (createErr || !created.user) {
      return json({ error: createErr?.message ?? 'Kullanıcı oluşturulamadı' }, 400, cors);
    }

    const { error: upErr } = await adminClient
      .from('profiles')
      .update({
        role: 'admin',
        full_name: body.full_name?.trim() || null,
        email: body.email.trim(),
      })
      .eq('id', created.user.id);

    if (upErr) {
      return json({ error: upErr.message }, 500, cors);
    }

    return json({ ok: true, user_id: created.user.id }, 200, cors);
  }

  if (mode === 'create') {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Oturum gerekli' }, 401, cors);
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
    if (authErr || !authData.user) {
      return json({ error: 'Oturum geçersiz' }, 401, cors);
    }

    const { data: prof, error: pErr } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (pErr || prof?.role !== 'admin') {
      return json({ error: 'Yönetici yetkisi yok' }, 403, cors);
    }

    if (!body.email?.trim() || !body.password) {
      return json({ error: 'E-posta ve şifre gerekli' }, 400, cors);
    }

    const role = body.role === 'admin' ? 'admin' : 'field';

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email: body.email.trim(),
      password: body.password,
      email_confirm: true,
      user_metadata: { full_name: body.full_name ?? '' },
    });

    if (createErr || !created.user) {
      return json({ error: createErr?.message ?? 'Oluşturulamadı' }, 400, cors);
    }

    const { error: upErr } = await adminClient
      .from('profiles')
      .update({
        role,
        full_name: body.full_name?.trim() || null,
        email: body.email.trim(),
      })
      .eq('id', created.user.id);

    if (upErr) {
      return json({ error: upErr.message }, 500, cors);
    }

    return json({ ok: true, user_id: created.user.id }, 200, cors);
  }

  async function requireAdminFromRequest(): Promise<
    | { ok: true; adminUserId: string }
    | { ok: false; response: Response }
  > {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return { ok: false, response: json({ error: 'Oturum gerekli' }, 401, cors) };
    }
    const token = authHeader.replace('Bearer ', '');
    const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
    if (authErr || !authData.user) {
      return { ok: false, response: json({ error: 'Oturum geçersiz' }, 401, cors) };
    }
    const { data: prof, error: pErr } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', authData.user.id)
      .maybeSingle();
    if (pErr || prof?.role !== 'admin') {
      return { ok: false, response: json({ error: 'Yönetici yetkisi yok' }, 403, cors) };
    }
    return { ok: true, adminUserId: authData.user.id };
  }

  if (mode === 'update') {
    const gate = await requireAdminFromRequest();
    if (!gate.ok) return gate.response;

    const userId = body.user_id?.trim();
    if (!userId) {
      return json({ error: 'user_id gerekli' }, 400, cors);
    }

    const { data: authUserRes, error: authGetErr } = await adminClient.auth.admin.getUserById(userId);
    if (authGetErr || !authUserRes?.user) {
      return json({ error: authGetErr?.message ?? 'Auth kullanıcısı bulunamadı' }, 404, cors);
    }
    const existingAuth = authUserRes.user;

    const { data: targetProf } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (!targetProf) {
      return json({ error: 'Kullanıcı bulunamadı' }, 404, cors);
    }

    const roleRaw = String(body.role ?? '')
      .trim()
      .toLowerCase();
    const newRole = roleRaw === 'admin' ? 'admin' : roleRaw === 'field' ? 'field' : undefined;
    if (newRole === 'field' && targetProf.role === 'admin') {
      const { count } = await adminClient
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('role', 'admin');
      if ((count ?? 0) <= 1) {
        return json({ error: 'Son yöneticinin rolü kaldırılamaz' }, 400, cors);
      }
    }

    /** Aynı e-postayı tekrar göndermek Auth API’de 400 verebilir; yalnızca değişen alanlar.
     * E-posta büyük/küçük harf farkı (form vs Auth) yanlışlıkla “değişiklik” sayılmasın diye normalize edilir. */
    const authUpdate: {
      email?: string;
      password?: string;
      user_metadata?: Record<string, unknown>;
    } = {};
    const nextEmailRaw = typeof body.email === 'string' ? body.email.trim() : '';
    const nextEmailNorm = nextEmailRaw.toLowerCase();
    const existingEmailNorm = (existingAuth.email ?? '').trim().toLowerCase();
    if (nextEmailRaw && nextEmailNorm !== existingEmailNorm) {
      authUpdate.email = nextEmailNorm;
    }
    if (typeof body.password === 'string' && body.password.length > 0) {
      authUpdate.password = body.password;
    }
    if (typeof body.full_name === 'string') {
      const nextFull = body.full_name.trim();
      const prevFull =
        typeof existingAuth.user_metadata?.full_name === 'string'
          ? existingAuth.user_metadata.full_name
          : '';
      if (nextFull !== prevFull) {
        const prevMeta =
          existingAuth.user_metadata && typeof existingAuth.user_metadata === 'object'
            ? (existingAuth.user_metadata as Record<string, unknown>)
            : {};
        authUpdate.user_metadata = { ...prevMeta, full_name: nextFull || null };
      }
    }

    if (Object.keys(authUpdate).length > 0) {
      const { error: updErr } = await adminClient.auth.admin.updateUserById(userId, authUpdate);
      if (updErr) {
        return json({ error: updErr.message }, 400, cors);
      }
    }

    const profileUpdate: Record<string, unknown> = {};
    if (nextEmailRaw) profileUpdate.email = nextEmailNorm;
    if (typeof body.full_name === 'string') profileUpdate.full_name = body.full_name.trim() || null;
    if (newRole) profileUpdate.role = newRole;

    if (Object.keys(profileUpdate).length > 0) {
      const { error: pErr } = await adminClient.from('profiles').update(profileUpdate).eq('id', userId);
      if (pErr) {
        return json({ error: pErr.message }, 500, cors);
      }
    }

    return json({ ok: true }, 200, cors);
  }

  if (mode === 'delete') {
    const gate = await requireAdminFromRequest();
    if (!gate.ok) return gate.response;

    const userId = body.user_id?.trim();
    if (!userId) {
      return json({ error: 'user_id gerekli' }, 400, cors);
    }
    if (userId === gate.adminUserId) {
      return json({ error: 'Kendi hesabınızı silemezsiniz' }, 400, cors);
    }

    const { data: targetProf } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (!targetProf) {
      return json({ error: 'Kullanıcı bulunamadı' }, 404, cors);
    }
    if (targetProf.role === 'admin') {
      const { count } = await adminClient
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('role', 'admin');
      if ((count ?? 0) <= 1) {
        return json({ error: 'Son yönetici silinemez' }, 400, cors);
      }
    }

    const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
    if (delErr) {
      return json({ error: delErr.message }, 400, cors);
    }
    return json({ ok: true }, 200, cors);
  }

  return json({ error: `Geçersiz istek (mode: ${mode || '(boş)'})` }, 400, cors);
});
