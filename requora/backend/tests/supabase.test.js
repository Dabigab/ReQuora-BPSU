/* Tests for the Supabase database + photo storage layer.
   A small fake Supabase server (REST + Storage) runs inside the test, so no
   internet, account or npm package is needed. These prove ReQuora sends the
   right requests and maps data correctly; they cannot prove your real Supabase
   project is set up — see DEPLOYMENT.md for the manual online checks. */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const { createClient } = require('../utils/supabase');
const { createSupabaseStore, toRow, fromRow } = require('../utils/dbSupabase');
const { createPhotoStorage } = require('../utils/photoStorage');

const KEY = 'test-service-role-key';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function startFakeSupabase() {
  const state = { tables: { users: [], items: [], claims: [], notifications: [] }, objects: new Map(), calls: [], failNext: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      state.calls.push(`${req.method} ${url.pathname}`);
      const send = (code, data, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (req.headers.apikey !== KEY || req.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: 'Invalid API key' });
      if (state.failNext > 0 && url.pathname.startsWith('/rest/')) {
        state.failNext -= 1;
        return send(503, { message: 'temporarily unavailable' });
      }
      let m = /^\/rest\/v1\/(\w+)$/.exec(url.pathname);
      if (m) {
        const rows = state.tables[m[1]];
        if (!rows) return send(404, { message: 'relation does not exist' });
        if (req.method === 'GET') {
          const [from, to] = String(req.headers.range || '0-999').split('-').map(Number);
          return send(206, rows.slice(from, to + 1));
        }
        if (req.method === 'POST') {
          for (const row of JSON.parse(body.toString())) {
            const i = rows.findIndex((r) => r.id === row.id);
            if (i === -1) rows.push(row);
            else rows[i] = { ...rows[i], ...row };
          }
          return send(201);
        }
        if (req.method === 'DELETE') {
          const ids = /^in\.\((.*)\)$/.exec(url.searchParams.get('id'))[1].split(',').map(decodeURIComponent);
          state.tables[m[1]] = rows.filter((r) => !ids.includes(r.id));
          return send(204);
        }
      }
      m = /^\/storage\/v1\/object\/([\w-]+)\/(.+)$/.exec(url.pathname);
      if (m && req.method === 'POST') {
        state.objects.set(`${m[1]}/${m[2]}`, { body, type: req.headers['content-type'] });
        return send(200, { Key: `${m[1]}/${m[2]}` });
      }
      if (m && req.method === 'DELETE') {
        state.objects.delete(`${m[1]}/${m[2]}`);
        return send(200, []);
      }
      return send(404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

let fake;
const cfg = () => ({ url: fake.url, key: KEY, bucket: 'item-images', configured: true });
const silent = { error() {}, log() {} };

before(async () => {
  fake = await startFakeSupabase();
});
after(() => fake.server.close());

describe('row mapping', () => {
  test('known fields become snake_case columns, the rest goes to extra, and it round-trips', () => {
    const doc = { id: 'a', title: 'Wallet', reportedBy: 'u1', imageUrl: null, additionalDetails: 'brown', contactInfo: '0917', history: undefined };
    const row = toRow('items', doc);
    assert.equal(row.reported_by, 'u1');
    assert.equal(row.title, 'Wallet');
    assert.deepEqual(row.extra, { additionalDetails: 'brown', contactInfo: '0917' });
    const back = fromRow('items', row);
    assert.equal(back.additionalDetails, 'brown');
    assert.equal(back.reportedBy, 'u1');
    assert.equal(back.imageUrl, null);
  });
});

describe('Supabase store', () => {
  test('wrong key gives a helpful error', async () => {
    const store = createSupabaseStore({ client: createClient({ ...cfg(), key: 'wrong' }), log: silent });
    await assert.rejects(() => store.init(), /401.*service_role/s);
  });

  test('loads existing rows (paging past 1000) and writes changes through', async () => {
    fake.state.tables.users = Array.from({ length: 1500 }, (_, i) => ({ id: `u${String(i).padStart(4, '0')}`, name: `User ${i}`, email: `u${i}@x.ph`, role: 'student', created_at: '2026-01-01T00:00:00Z', extra: {} }));
    const store = createSupabaseStore({ client: createClient(cfg()), log: silent });
    const counts = await store.init();
    assert.equal(counts.users, 1500);

    const data = store.load();
    data.users = data.users.slice(0, 2);
    data.items.push({ id: 'i1', type: 'lost', title: 'Umbrella', reportedBy: 'u0000', status: 'lost', createdAt: '2026-02-01T00:00:00Z', extra1: 'kept' });
    data.claims.push({ id: 'c1', itemId: 'i1', claimantId: 'u0001', status: 'pending', history: [{ status: 'pending', at: 'now', note: null }], createdAt: '2026-02-02T00:00:00Z' });
    store.save(data);
    await store.flush();

    assert.equal(fake.state.tables.users.length, 2, 'removed users deleted in Supabase');
    assert.equal(fake.state.tables.items[0].title, 'Umbrella');
    assert.equal(fake.state.tables.items[0].extra.extra1, 'kept');
    assert.deepEqual(fake.state.tables.claims[0].history[0].status, 'pending');

    // a fresh store (a server restart) sees exactly what was saved
    const again = createSupabaseStore({ client: createClient(cfg()), log: silent });
    await again.init();
    const reloaded = again.load();
    assert.equal(reloaded.items[0].extra1, 'kept');
    assert.equal(reloaded.claims[0].itemId, 'i1');
  });

  test('only changed rows are sent', async () => {
    const store = createSupabaseStore({ client: createClient(cfg()), log: silent });
    await store.init();
    fake.state.calls.length = 0;
    await store.flush();
    assert.deepEqual(fake.state.calls.filter((c) => c.startsWith('POST') || c.startsWith('DELETE')), []);
    const data = store.load();
    data.items[0].title = 'Blue umbrella';
    store.save(data);
    await store.flush();
    assert.deepEqual(fake.state.calls.filter((c) => c.startsWith('POST')), ['POST /rest/v1/items']);
    assert.equal(fake.state.tables.items[0].title, 'Blue umbrella');
  });

  test('a failed save is retried and nothing is lost', async () => {
    const store = createSupabaseStore({ client: createClient(cfg()), log: silent, retryMs: 20 });
    await store.init();
    const data = store.load();
    data.notifications.push({ id: 'n1', userId: 'u0000', type: 'info', title: 'Hi', message: '', link: null, read: false, createdAt: '2026-03-01T00:00:00Z' });
    fake.state.failNext = 1;
    store.save(data);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fake.state.tables.notifications.length, 1, 'second attempt stored it');
  });

  test('flush reports an error when Supabase stays down', async () => {
    const store = createSupabaseStore({ client: createClient(cfg()), log: silent, retryMs: 10000 });
    await store.init();
    const data = store.load();
    data.notifications.push({ id: 'n2', userId: 'u0000', type: 'info', title: 'x', message: '', link: null, read: false, createdAt: '2026-03-02T00:00:00Z' });
    fake.state.failNext = 5;
    store.save(data);
    await assert.rejects(() => store.flush(), /503/);
    fake.state.failNext = 0;
    await store.flush();
    assert.ok(fake.state.tables.notifications.some((n) => n.id === 'n2'));
  });
});

describe('photo storage', () => {
  test('uploads to the bucket and returns a public URL, then deletes it', async () => {
    const photos = createPhotoStorage({ config: cfg() });
    assert.equal(photos.mode, 'supabase');
    const { url, key } = await photos.save(PNG, 'png');
    assert.match(url, new RegExp(`^${fake.url}/storage/v1/object/public/item-images/\\d+-[\\w-]+\\.png$`));
    const stored = fake.state.objects.get(`item-images/${key}`);
    assert.equal(stored.type, 'image/png');
    assert.deepEqual(stored.body, PNG);
    assert.equal(await photos.remove(url), true);
    assert.equal(fake.state.objects.size, 0);
  });

  test('refuses to delete things that are not its own photos', async () => {
    const photos = createPhotoStorage({ config: cfg() });
    assert.equal(await photos.remove('https://evil.example/storage/v1/object/public/item-images/a.png'), false);
    assert.equal(await photos.remove(`${fake.url}/storage/v1/object/public/item-images/../../x.png`), false);
    assert.equal(await photos.remove(null), false);
  });

  test('upload errors surface (so the report can say the photo failed)', async () => {
    const photos = createPhotoStorage({ config: { ...cfg(), key: 'wrong' } });
    await assert.rejects(() => photos.save(PNG, 'png'), /401/);
  });

  test('without Supabase, photos go to the local uploads folder', async () => {
    const os = require('os');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-up-'));
    const photos = createPhotoStorage({ config: { configured: false }, uploadDir: dir });
    assert.equal(photos.mode, 'local');
    const { url } = await photos.save(PNG, 'png');
    assert.match(url, /^\/uploads\//);
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.equal(await photos.remove(url), true);
    assert.equal(fs.readdirSync(dir).length, 0);
  });
});

describe('whole app against Supabase (child process)', () => {
  test('register, report with data, restart: everything is still there', () => {
    const script = path.join(__dirname, 'supabase-flow.js');
    const env = { ...process.env, SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: KEY, SUPABASE_BUCKET: 'item-images', JWT_SECRET: 'x'.repeat(40) };
    delete env.DB_DRIVER;
    // Node runs the flow in a separate process because the database is chosen when the module loads.
    // Run async (not execFileSync) so this process's fake server can keep answering.
    return new Promise((resolve, reject) => {
      require('child_process').execFile(process.execPath, [script], { env }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`${stderr}\n${stdout}`));
        try {
          assert.match(stdout, /FLOW OK/);
          assert.ok(fake.state.tables.users.some((u) => u.email === 'flow@bpsu.edu.ph'));
          assert.ok(fake.state.tables.items.some((i) => i.title === 'Flow wallet' && /item-images/.test(i.image_url)));
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});

describe('migration from the local database', () => {
  test('copies rows and photos, skips orphans, dry run changes nothing', async () => {
    const fs = require('fs');
    const os = require('os');
    const { migrate } = require('../scripts/migrate-to-supabase');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-mig-'));
    fs.writeFileSync(path.join(dir, 'old.png'), PNG);
    const U = '11111111-1111-4111-8111-111111111111';
    const I = '22222222-2222-4222-8222-222222222222';
    const data = {
      users: [{ id: U, name: 'Old User', email: 'old@bpsu.edu.ph', passwordHash: 'h', role: 'student', createdAt: '2025-01-01T00:00:00Z' }],
      items: [
        { id: I, type: 'found', title: 'Old key', category: 'Keys', reportedBy: U, imageUrl: '/uploads/old.png', createdAt: '2025-01-02T00:00:00Z' },
        { id: 'orphan', type: 'found', title: 'Orphan', category: 'Keys', reportedBy: 'ghost', createdAt: '2025-01-03T00:00:00Z' },
      ],
      claims: [{ id: 'c-ok', itemId: I, claimantId: U, status: 'pending', createdAt: '2025-01-04T00:00:00Z' }, { id: 'c-bad', itemId: 'orphan', status: 'pending' }],
      notifications: [],
    };
    const client = createClient(cfg());
    const photos = createPhotoStorage({ config: cfg(), client });
    const before = fake.state.tables.items.length;

    const dry = await migrate({ data, client, photos, uploadDir: dir, apply: false, log() {} });
    assert.equal(fake.state.tables.items.length, before, 'dry run wrote nothing');
    assert.equal(dry.copied.items, 1);
    assert.equal(dry.skipped.length, 2);

    const done = await migrate({ data, client, photos, uploadDir: dir, apply: true, log() {} });
    assert.equal(done.photos.uploaded, 1);
    const row = fake.state.tables.items.find((i) => i.id === I);
    assert.match(row.image_url, /storage\/v1\/object\/public\/item-images\//);
    assert.ok(fake.state.tables.claims.some((c) => c.id === 'c-ok'));
    assert.ok(!fake.state.tables.items.some((i) => i.id === 'orphan'));
  });
});
