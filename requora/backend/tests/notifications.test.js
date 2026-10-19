/* Notifications, claim timelines and CSV export (service layer, no web server). */

process.env.DB_PATH = require('path').join(__dirname, 'tmp-notifications-db.json');
process.env.NODE_ENV = 'test';

const { test, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const db = require('../utils/db');
const itemService = require('../services/itemService');
const claimService = require('../services/claimService');
const adminService = require('../services/adminService');
const notificationService = require('../services/notificationService');
const exportService = require('../services/exportService');
const { weekdayFromNow, validReport, uuid } = require('./helpers');

let maria; // reporter
let juan; // claimant
let admin;

function makeUser(name, email, role = 'student') {
  const u = db.createUser({ name, email, studentId: null, passwordHash: 'x', role });
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

const claimBody = (itemId) => ({
  itemId,
  appointmentDate: weekdayFromNow(2),
  appointmentTime: '10:00',
  proofDescription: 'It has a scratch on the back and my initials inside the flap.',
});

// A verified "found" report that Juan can claim.
function verifiedFoundItem() {
  const item = itemService.createReport(maria, validReport({ type: 'found', title: 'Black wallet' }), null);
  adminService.verifyItem(item.id);
  return item;
}

beforeEach(() => {
  db.resetDB();
  maria = makeUser('Maria Santos', 'maria@bpsu.edu.ph');
  juan = makeUser('Juan Dela Cruz', 'juan@bpsu.edu.ph');
  admin = makeUser('Office Admin', 'admin@bpsu.edu.ph', 'admin');
});

after(() => {
  if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
});

describe('notifications', () => {
  test('verifying a report tells the reporter', () => {
    const item = itemService.createReport(maria, validReport(), null);
    adminService.verifyItem(item.id);
    const { notifications, unread } = notificationService.list(maria);
    assert.equal(unread, 1);
    assert.equal(notifications[0].type, 'report_verified');
    assert.match(notifications[0].link, /^item\.html\?id=/);
  });

  test('filing a claim tells the reporter and every admin, not the claimant', () => {
    const item = verifiedFoundItem();
    notificationService.markAllRead(maria);
    claimService.createClaim(juan, claimBody(item.id));
    assert.equal(notificationService.list(maria).unread, 1);
    assert.equal(notificationService.list(admin).notifications.some((n) => n.type === 'claim_filed'), true);
    assert.equal(notificationService.list(juan).notifications.length, 0);
  });

  test('the reporter notification does not leak the proof or contact details', () => {
    const item = verifiedFoundItem();
    claimService.createClaim(juan, { ...claimBody(item.id), contactInfo: '0917-SECRET' });
    const text = JSON.stringify(notificationService.list(maria));
    assert.doesNotMatch(text, /SECRET|scratch on the back|juan@/i);
  });

  test('approving, rejecting and completing a claim each notify the claimant', () => {
    const item = verifiedFoundItem();
    const claim = claimService.createClaim(juan, claimBody(item.id));
    claimService.decideClaim(admin, claim.id, { status: 'approved' });
    claimService.decideClaim(admin, claim.id, { status: 'completed' });
    const types = notificationService.list(juan).notifications.map((n) => n.type);
    assert.deepEqual(types.sort(), ['claim_approved', 'claim_completed']);

    const other = verifiedFoundItem();
    const claim2 = claimService.createClaim(juan, claimBody(other.id));
    claimService.decideClaim(admin, claim2.id, { status: 'rejected', officeNotes: 'ID did not match.' });
    const rejected = notificationService.list(juan).notifications.find((n) => n.type === 'claim_rejected');
    assert.match(rejected.message, /ID did not match/);
  });

  test('completing one claim notifies the other claimants that were turned down', () => {
    const item = verifiedFoundItem();
    const third = makeUser('Ana Reyes', 'ana@bpsu.edu.ph');
    const a = claimService.createClaim(juan, claimBody(item.id));
    claimService.createClaim(third, claimBody(item.id));
    claimService.decideClaim(admin, a.id, { status: 'approved' });
    claimService.decideClaim(admin, a.id, { status: 'completed' });
    assert.equal(notificationService.list(third).notifications.some((n) => n.type === 'claim_rejected'), true);
  });

  test('people only see and change their own notifications', () => {
    const item = itemService.createReport(maria, validReport(), null);
    adminService.verifyItem(item.id);
    const mine = notificationService.list(maria).notifications[0];
    assert.throws(() => notificationService.markRead(juan, mine.id), (e) => e.status === 404);
    assert.equal(notificationService.list(maria).unread, 1);
    notificationService.markRead(maria, mine.id);
    assert.equal(notificationService.list(maria).unread, 0);
  });

  test('mark-all-read and bad ids', () => {
    verifiedFoundItem();
    assert.equal(notificationService.markAllRead(maria).updated, 1);
    assert.equal(notificationService.markAllRead(maria).updated, 0);
    assert.throws(() => notificationService.markRead(maria, 'nope'), (e) => e.status === 404);
    assert.throws(() => notificationService.markRead(maria, uuid()), (e) => e.status === 404);
  });

  test('only the newest 100 notifications per user are kept', () => {
    for (let i = 0; i < 105; i += 1) notificationService.notify(maria.id, { type: 'info', title: `n${i}` });
    const all = db.getNotifications(maria.id);
    assert.equal(all.length, 100);
    assert.equal(all[0].title, 'n104');
  });
});

describe('claim timeline', () => {
  test('records every status in order', () => {
    const item = verifiedFoundItem();
    const claim = claimService.createClaim(juan, claimBody(item.id));
    assert.deepEqual(claim.timeline.map((s) => s.status), ['pending']);
    claimService.decideClaim(admin, claim.id, { status: 'approved', officeNotes: 'Bring the ID.' });
    const done = claimService.decideClaim(admin, claim.id, { status: 'completed' });
    assert.deepEqual(done.timeline.map((s) => s.status), ['pending', 'approved', 'completed']);
    assert.equal(done.timeline[1].note, 'Bring the ID.');
  });

  test('a cancelled claim shows pending then cancelled', () => {
    const item = verifiedFoundItem();
    const claim = claimService.createClaim(juan, claimBody(item.id));
    const cancelled = claimService.cancelClaim(juan, claim.id);
    assert.deepEqual(cancelled.timeline.map((s) => s.status), ['pending', 'cancelled']);
  });

  test('claims saved before timelines existed still get one', () => {
    const item = verifiedFoundItem();
    const claim = claimService.createClaim(juan, claimBody(item.id));
    const data = db.readDB();
    delete data.claims[0].history;
    data.claims[0].status = 'approved';
    db.writeDB(data);
    const mine = claimService.listMine(juan)[0];
    assert.deepEqual(mine.timeline.map((s) => s.status), ['pending', 'approved']);
    assert.equal(claim.id, mine.id);
  });

  test('the reporter view has no timeline (it would reveal the review details)', () => {
    const item = verifiedFoundItem();
    claimService.createClaim(juan, claimBody(item.id));
    const view = claimService.listForItem(maria, item.id)[0];
    assert.equal(view.timeline, undefined);
  });
});

describe('CSV export', () => {
  test('quotes cells, escapes quotes and starts with a BOM', () => {
    const csv = exportService.toCsv([{ label: 'A', value: (r) => r.a }], [{ a: 'say "hi", ok' }]);
    assert.ok(csv.startsWith('﻿"A"\r\n'));
    assert.ok(csv.includes('"say ""hi"", ok"'));
  });

  test('neutralises spreadsheet formulas', () => {
    const csv = exportService.toCsv([{ label: 'A', value: (r) => r.a }], [{ a: '=HYPERLINK("http://evil")' }, { a: '+1' }, { a: '@SUM(A1)' }, { a: '-5' }]);
    for (const bad of ['"=HYPERLINK', '"+1', '"@SUM', '"-5']) assert.ok(!csv.includes(bad), `${bad} must be prefixed`);
    assert.ok(csv.includes('"\'=HYPERLINK'));
  });

  test('reports export lists every report with its reporter', () => {
    itemService.createReport(maria, validReport({ title: '=cmd|calc' }), null);
    verifiedFoundItem();
    const csv = exportService.itemsCsv();
    assert.equal(csv.trim().split('\r\n').length, 3); // header + 2 rows
    assert.ok(csv.includes('maria@bpsu.edu.ph'));
    assert.ok(csv.includes("\"'=cmd|calc\""));
  });

  test('claims export has the claim, claimant and status but not the proof text', () => {
    const item = verifiedFoundItem();
    claimService.createClaim(juan, claimBody(item.id));
    const csv = exportService.claimsCsv();
    assert.ok(csv.includes('juan@bpsu.edu.ph'));
    assert.ok(csv.includes('"pending"'));
    assert.doesNotMatch(csv, /scratch on the back/);
  });
});
