// ReQuora data layer (Supabase PostgreSQL in production, a JSON file for development).
// This keeps the project free of any external database engine, which is fine
// for a capstone-scale deployment. Swap this module for a real database
// (MySQL / Postgres / MongoDB) later without touching the routes or services,
// as long as the same function names are kept.
//
// Safety notes:
//  - Writes are atomic (temp file + rename) so a crash mid-write cannot
//    leave a half-written db.json behind.
//  - Data written by earlier ReQuora versions (old status names) is upgraded
//    automatically the first time it is read.
//  - Node runs one request at a time through these synchronous functions, so
//    read-modify-write sequences cannot interleave inside a single server.

const crypto = require('crypto');
const { LEGACY_ITEM_STATUS, LEGACY_CLAIM_STATUS } = require('./constants');
const { createJsonStore, DB_PATH } = require('./dbJson');
const { getConfig } = require('./supabase');

const SCHEMA_VERSION = 2;

// Which storage is used:
//   - Supabase (PostgreSQL) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
//     (this is what production should use: data survives restarts/redeploys)
//   - otherwise a local JSON file (zero-install, fine for development)
// DB_DRIVER=json forces the file even if Supabase variables exist.
let store;
function chooseStore() {
  const wanted = String(process.env.DB_DRIVER || '').toLowerCase();
  if (wanted !== 'json' && (wanted === 'supabase' || getConfig().configured)) {
    const { createSupabaseStore } = require('./dbSupabase');
    return createSupabaseStore();
  }
  return createJsonStore();
}
store = chooseStore();

// Call once before serving requests. Loads the Supabase data into memory
// (does nothing for the JSON file). Returns row counts for Supabase.
async function init() {
  if (store.init) return store.init();
  ensureDB();
  return null;
}

// Waits until every change has been written to the database (Supabase only).
async function flush() {
  if (store.flush) await store.flush();
}

const driver = () => store.name;
const COLLECTIONS = ['users', 'items', 'claims', 'notifications'];

function emptyDB() {
  return { schemaVersion: SCHEMA_VERSION, users: [], items: [], claims: [], notifications: [] };
}

function ensureDB() {
  store.ensure(emptyDB());
}

// Wipes the database back to empty (or to the data you pass in). Used by tests and seed.
function resetDB(data = emptyDB()) {
  ensureDB();
  writeDB({ ...emptyDB(), ...data });
}

/* ---------- upgrade of data written by older versions ---------- */
function migrate(data) {
  let changed = false;

  for (const user of data.users) {
    if (typeof user.email === 'string' && user.email !== user.email.toLowerCase()) {
      user.email = user.email.toLowerCase();
      changed = true;
    }
  }

  for (const item of data.items) {
    if (Object.prototype.hasOwnProperty.call(LEGACY_ITEM_STATUS, item.status)) {
      const mapped = LEGACY_ITEM_STATUS[item.status];
      item.status = mapped === null ? item.type : mapped; // "matched" -> lost/found
      changed = true;
    }
  }

  for (const claim of data.claims) {
    if (Object.prototype.hasOwnProperty.call(LEGACY_CLAIM_STATUS, claim.status)) {
      claim.status = LEGACY_CLAIM_STATUS[claim.status];
      changed = true;
    }
  }

  if (data.schemaVersion !== SCHEMA_VERSION) {
    data.schemaVersion = SCHEMA_VERSION;
    changed = true;
  }
  return changed;
}

function readDB() {
  ensureDB();
  const data = store.load();
  // Collections added after the first release may be missing from older data.
  for (const name of COLLECTIONS) if (!Array.isArray(data[name])) data[name] = [];
  if (migrate(data)) writeDB(data);
  return data;
}

function writeDB(data) {
  store.save(data);
}

function newId() {
  return crypto.randomUUID();
}

const nowIso = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v : '');

// ---------- Users ----------
function findUserByEmail(email) {
  const wanted = String(email || '').toLowerCase();
  return readDB().users.find((u) => String(u.email).toLowerCase() === wanted);
}

function findUserById(id) {
  return readDB().users.find((u) => u.id === id);
}

function listUsers() {
  return readDB().users.slice();
}

function createUser(user) {
  const db = readDB();
  const newUser = {
    id: newId(),
    createdAt: nowIso(),
    ...user,
    email: String(user.email).toLowerCase(),
  };
  db.users.push(newUser);
  writeDB(db);
  return newUser;
}

function updateUser(id, updates) {
  const db = readDB();
  const idx = db.users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  db.users[idx] = { ...db.users[idx], ...updates, updatedAt: nowIso() };
  writeDB(db);
  return db.users[idx];
}

// ---------- Items ----------
/**
 * Returns every item matching the filters, newest first.
 * filters: type, category, status, q, location, dateFrom, dateTo, reportedBy,
 *          statusNotIn (array of statuses to hide)
 */
function getItems(filters = {}) {
  let items = readDB().items;

  if (filters.type) items = items.filter((i) => i.type === filters.type);
  if (filters.category) {
    const c = filters.category.toLowerCase();
    items = items.filter((i) => str(i.category).toLowerCase() === c);
  }
  if (filters.status) {
    items = items.filter((i) => i.status === filters.status);
  } else if (Array.isArray(filters.statusNotIn) && filters.statusNotIn.length) {
    items = items.filter((i) => !filters.statusNotIn.includes(i.status));
  }
  if (filters.reportedBy) items = items.filter((i) => i.reportedBy === filters.reportedBy);
  if (filters.location) {
    const l = filters.location.toLowerCase();
    items = items.filter((i) => str(i.location).toLowerCase().includes(l));
  }
  if (filters.dateFrom) items = items.filter((i) => str(i.date) >= filters.dateFrom);
  if (filters.dateTo) items = items.filter((i) => str(i.date) <= filters.dateTo);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter(
      (i) =>
        str(i.title).toLowerCase().includes(q) ||
        str(i.description).toLowerCase().includes(q) ||
        str(i.location).toLowerCase().includes(q) ||
        str(i.category).toLowerCase().includes(q)
    );
  }

  return items.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getItemById(id) {
  return readDB().items.find((i) => i.id === id);
}

function createItem(item) {
  const db = readDB();
  const newItem = {
    id: newId(),
    status: 'pending_verification',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...item,
  };
  db.items.push(newItem);
  writeDB(db);
  return newItem;
}

function updateItem(id, updates) {
  const db = readDB();
  const idx = db.items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  db.items[idx] = { ...db.items[idx], ...updates, updatedAt: nowIso() };
  writeDB(db);
  return db.items[idx];
}

// Removes the item AND its claims in a single write. Returns the removed item
// (so the caller can delete its photo) or null when it did not exist.
function deleteItem(id) {
  const db = readDB();
  const idx = db.items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const [removed] = db.items.splice(idx, 1);
  db.claims = db.claims.filter((c) => c.itemId !== id);
  writeDB(db);
  return removed;
}

// ---------- Claims ----------
function getClaims(filters = {}) {
  let claims = readDB().claims;

  if (filters.itemId) claims = claims.filter((c) => c.itemId === filters.itemId);
  if (filters.claimantId) claims = claims.filter((c) => c.claimantId === filters.claimantId);
  if (filters.status) claims = claims.filter((c) => c.status === filters.status);

  return claims.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getClaimById(id) {
  return readDB().claims.find((c) => c.id === id);
}

function createClaim(claim) {
  const db = readDB();
  const newClaim = {
    id: newId(),
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...claim,
  };
  // Every status the claim passes through is kept, so people can follow its progress.
  newClaim.history = [{ status: newClaim.status, at: newClaim.createdAt, note: null }];
  db.claims.push(newClaim);
  writeDB(db);
  return newClaim;
}

function updateClaim(id, rawUpdates) {
  const db = readDB();
  const idx = db.claims.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const before = db.claims[idx];
  // historyNote / decidedBy only describe the history entry; they are not stored on the claim itself.
  const { historyNote, decidedBy, ...updates } = rawUpdates;
  const next = { ...before, ...updates, updatedAt: nowIso() };
  if (updates.status && updates.status !== before.status) {
    const history = Array.isArray(before.history) ? before.history.slice() : [];
    // "by" is the administrator behind a decision (null for the claimant's own actions).
    history.push({ status: updates.status, at: next.updatedAt, note: historyNote || updates.officeNotes || null, by: decidedBy || null });
    next.history = history;
  }
  db.claims[idx] = next;
  writeDB(db);
  return db.claims[idx];
}

/* ---------- notifications (in-app) ---------- */
const MAX_NOTIFICATIONS_PER_USER = 100;

function addNotification({ userId, type, title, message, link }) {
  const db = readDB();
  const note = { id: newId(), userId, type: type || 'info', title, message: message || '', link: link || null, read: false, createdAt: nowIso() };
  db.notifications.push(note);
  // Keep the file small: only the newest MAX per user survive.
  const mine = db.notifications.filter((n) => n.userId === userId);
  if (mine.length > MAX_NOTIFICATIONS_PER_USER) {
    const drop = new Set(mine.slice(0, mine.length - MAX_NOTIFICATIONS_PER_USER).map((n) => n.id));
    db.notifications = db.notifications.filter((n) => !drop.has(n.id));
  }
  writeDB(db);
  return note;
}

function getNotifications(userId) {
  // Newest first; entries created in the same millisecond keep their insertion order (latest first).
  return readDB()
    .notifications.map((n, i) => [n, i])
    .filter(([n]) => n.userId === userId)
    .sort((a, b) => new Date(b[0].createdAt) - new Date(a[0].createdAt) || b[1] - a[1])
    .map(([n]) => n);
}

function markNotificationRead(userId, id) {
  const db = readDB();
  const note = db.notifications.find((n) => n.id === id && n.userId === userId);
  if (!note) return null;
  note.read = true;
  writeDB(db);
  return note;
}

function markAllNotificationsRead(userId) {
  const db = readDB();
  let count = 0;
  db.notifications.forEach((n) => {
    if (n.userId === userId && !n.read) {
      n.read = true;
      count += 1;
    }
  });
  if (count) writeDB(db);
  return count;
}

module.exports = {
  DB_PATH,
  init,
  flush,
  driver,
  SCHEMA_VERSION,
  ensureDB,
  resetDB,
  readDB,
  writeDB,
  findUserByEmail,
  findUserById,
  listUsers,
  createUser,
  updateUser,
  getItems,
  getItemById,
  createItem,
  updateItem,
  deleteItem,
  getClaims,
  getClaimById,
  createClaim,
  updateClaim,
  addNotification,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
