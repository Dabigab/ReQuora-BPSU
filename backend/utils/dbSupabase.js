/* ============================================================
   ReQuora — Supabase (PostgreSQL) storage driver
   How it works (kept deliberately simple and safe):
     - On start-up the whole database is loaded from Supabase into memory
       (init()). Reads are then instant and the existing, tested service
       logic runs unchanged.
     - Every write updates memory and is then written through to Supabase in
       the background. The writer compares memory with what Supabase is known
       to hold, so a failed request is simply retried — nothing is lost while
       the server is running, and shutdown waits for the queue to drain.
     - Rows are real table columns (see supabase/schema.sql). Any extra
       field a record carries is kept in a jsonb "extra" column.
   Limit: this is designed for ONE running server (Render free = one). For
   several servers you would read straight from Postgres instead.
   ============================================================ */

const { createClient } = require('./supabase');

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// camelCase field -> column (snake_case). Anything not listed goes to "extra".
const SPEC = {
  users: ['id', 'name', 'email', 'studentId', 'passwordHash', 'role', 'createdAt', 'updatedAt'],
  items: ['id', 'type', 'title', 'category', 'description', 'location', 'date', 'status', 'reportedBy', 'imageUrl', 'createdAt', 'updatedAt'],
  claims: ['id', 'itemId', 'claimantId', 'status', 'history', 'createdAt', 'updatedAt'],
  notifications: ['id', 'userId', 'type', 'title', 'message', 'link', 'read', 'createdAt'],
};
// Parents before children so foreign keys are satisfied on insert.
const ORDER = ['users', 'items', 'claims', 'notifications'];

function toRow(collection, doc) {
  const known = SPEC[collection];
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(doc)) {
    if (known.includes(k)) row[snake(k)] = v === undefined ? null : v;
    else if (v !== undefined) extra[k] = v;
  }
  row.extra = extra;
  return row;
}

function fromRow(collection, row) {
  const doc = {};
  for (const k of SPEC[collection]) {
    const v = row[snake(k)];
    if (v !== null && v !== undefined) doc[k] = v;
    else if (k === 'studentId' || k === 'imageUrl' || k === 'link') doc[k] = null;
  }
  return { ...(row.extra || {}), ...doc };
}

function createSupabaseStore({ client, log = console, retryMs = 5000 } = {}) {
  const api = client || createClient();
  let cache = null; // { users: [...], items: [...], ... }
  const persisted = {}; // collection -> Map(id -> json of the ROW that Supabase holds)
  let flushing = null;
  let dirty = false;
  let retryTimer = null;
  let lastError = null;

  const rowJson = (collection, doc) => JSON.stringify(toRow(collection, doc));

  async function init() {
    const data = {};
    for (const c of ORDER) {
      const rows = await api.selectAll(c);
      data[c] = rows.map((r) => fromRow(c, r));
      persisted[c] = new Map(data[c].map((d) => [d.id, rowJson(c, d)]));
    }
    cache = data;
    return counts();
  }

  const counts = () => Object.fromEntries(ORDER.map((c) => [c, cache[c].length]));

  async function flushOnce() {
    const upserts = {};
    const deletes = {};
    for (const c of ORDER) {
      const seen = new Set();
      upserts[c] = [];
      for (const doc of cache[c]) {
        seen.add(doc.id);
        const json = rowJson(c, doc);
        if (persisted[c].get(doc.id) !== json) upserts[c].push({ doc, json });
      }
      deletes[c] = [...persisted[c].keys()].filter((id) => !seen.has(id));
    }
    for (const c of ORDER) {
      if (upserts[c].length) {
        await api.upsert(c, upserts[c].map((u) => JSON.parse(u.json)));
        for (const u of upserts[c]) persisted[c].set(u.doc.id, u.json);
      }
    }
    for (const c of [...ORDER].reverse()) {
      if (deletes[c].length) {
        await api.removeIds(c, deletes[c]);
        for (const id of deletes[c]) persisted[c].delete(id);
      }
    }
  }

  function schedule() {
    dirty = true;
    if (flushing) return;
    flushing = (async () => {
      try {
        while (dirty) {
          dirty = false;
          await flushOnce();
        }
        lastError = null;
      } catch (err) {
        lastError = err;
        log.error(`[ReQuora] Could not save to Supabase (will retry): ${err.message}`);
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            schedule();
          }, retryMs);
          if (retryTimer.unref) retryTimer.unref();
        }
      } finally {
        flushing = null;
        if (dirty && !retryTimer) schedule();
      }
    })();
  }

  return {
    name: 'supabase',
    path: 'Supabase (PostgreSQL)',
    init,
    exists: () => true,
    ensure() {
      if (!cache) throw new Error('The Supabase database has not been loaded yet. Call db.init() before starting the server.');
    },
    load() {
      this.ensure();
      return JSON.parse(JSON.stringify(cache));
    },
    save(data) {
      this.ensure();
      for (const c of ORDER) cache[c] = JSON.parse(JSON.stringify(data[c] || []));
      schedule();
    },
    // Resolves when everything has been written (or rejects with the last error).
    async flush() {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      schedule();
      while (flushing) await flushing;
      if (lastError) throw lastError;
    },
    status: () => ({ pendingError: lastError ? lastError.message : null }),
  };
}

module.exports = { createSupabaseStore, toRow, fromRow, SPEC, ORDER };
