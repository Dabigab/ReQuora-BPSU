// Run by supabase.test.js in a child process with SUPABASE_* pointing at the fake server.
const assert = require('assert');
const db = require('../utils/db');
const { photoStorage } = require('../utils/photoStorage');
const itemService = require('../services/itemService');

(async () => {
  assert.equal(db.driver(), 'supabase');
  assert.equal(photoStorage().mode, 'supabase');
  await db.init();
  const user = db.createUser({ name: 'Flow User', email: 'flow@bpsu.edu.ph', passwordHash: 'x', role: 'student' });
  const saved = await photoStorage().save(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), 'png');
  const item = itemService.createReport(
    { id: user.id, name: user.name, role: 'student' },
    { type: 'lost', title: 'Flow wallet', category: 'Bags', description: 'Brown leather wallet with cards', location: 'Library', date: new Date().toISOString().slice(0, 10) },
    { url: saved.url, filename: saved.key }
  );
  await db.flush();

  // simulate a restart: new process state would call init() again
  const { createSupabaseStore } = require('../utils/dbSupabase');
  const second = createSupabaseStore();
  await second.init();
  const data = second.load();
  assert.ok(data.items.find((i) => i.id === item.id && i.imageUrl === saved.url), 'report + photo URL persisted');
  assert.ok(data.users.find((u) => u.email === 'flow@bpsu.edu.ph'));
  console.log('FLOW OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
