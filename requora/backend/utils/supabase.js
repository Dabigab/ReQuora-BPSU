/* ============================================================
   ReQuora — tiny Supabase REST client (no dependencies)
   Talks to Supabase over plain HTTPS using Node's built-in fetch:
     - PostgREST   : <url>/rest/v1/<table>      (database rows)
     - Storage     : <url>/storage/v1/object/…  (photos)
   It uses the SERVICE-ROLE key, so it must only ever run on the
   server. The key is never sent to the browser.
   ============================================================ */

function getConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '').trim();
  return {
    url,
    key,
    bucket: String(env.SUPABASE_BUCKET || 'item-images').trim(),
    configured: Boolean(url && key),
  };
}

class SupabaseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.body = body;
  }
}

function createClient(config = getConfig(), fetchImpl = (...a) => fetch(...a)) {
  if (!config.configured) throw new Error('Supabase is not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required).');

  const baseHeaders = { apikey: config.key, Authorization: `Bearer ${config.key}` };

  async function request(path, { method = 'GET', headers = {}, body, expect = [200, 201, 204] } = {}) {
    let res;
    try {
      res = await fetchImpl(`${config.url}${path}`, { method, headers: { ...baseHeaders, ...headers }, body });
    } catch (err) {
      throw new SupabaseError(`Could not reach Supabase (${err.message}). Check SUPABASE_URL and the internet connection.`, 0);
    }
    if (!expect.includes(res.status)) {
      let text = '';
      try {
        text = await res.text();
      } catch (e) {
        /* ignore */
      }
      const hint =
        res.status === 401 || res.status === 403
          ? ' Check that SUPABASE_SERVICE_ROLE_KEY is the service_role / secret key (not the anon key).'
          : res.status === 404
            ? ' Check that you ran supabase/schema.sql and that the table or bucket name is right.'
            : '';
      throw new SupabaseError(`Supabase returned ${res.status} for ${method} ${path.split('?')[0]}.${hint} ${text.slice(0, 300)}`.trim(), res.status, text);
    }
    return res;
  }

  /* ---------- database ---------- */
  const PAGE = 1000; // Supabase returns at most 1000 rows per request by default

  async function selectAll(table, order = 'created_at.asc') {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const res = await request(`/rest/v1/${table}?select=*&order=${order},id.asc`, {
        headers: { Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' },
        expect: [200, 206],
      });
      const page = await res.json();
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  async function upsert(table, rows) {
    for (let i = 0; i < rows.length; i += 200) {
      await request(`/rest/v1/${table}?on_conflict=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows.slice(i, i + 200)),
      });
    }
  }

  async function removeIds(table, ids) {
    for (let i = 0; i < ids.length; i += 100) {
      const list = ids.slice(i, i + 100).map((id) => encodeURIComponent(id)).join(',');
      await request(`/rest/v1/${table}?id=in.(${list})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  }

  /* ---------- storage (photos) ---------- */
  const publicUrl = (key) => `${config.url}/storage/v1/object/public/${config.bucket}/${key}`;

  async function uploadObject(key, buffer, contentType) {
    await request(`/storage/v1/object/${config.bucket}/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' },
      body: buffer,
    });
    return publicUrl(key);
  }

  async function deleteObject(key) {
    await request(`/storage/v1/object/${config.bucket}/${key}`, { method: 'DELETE', expect: [200, 204, 400, 404] });
  }

  return { config, request, selectAll, upsert, removeIds, uploadObject, deleteObject, publicUrl };
}

module.exports = { getConfig, createClient, SupabaseError };
