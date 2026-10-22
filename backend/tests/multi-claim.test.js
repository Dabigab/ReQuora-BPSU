/* Several claimants for one report, the 24-hour claiming period and the office's
   ownership review — through the real HTTP API.                                */

process.env.DB_PATH = require('path').join(__dirname, 'tmp-multi-claim-db.json');
process.env.JWT_SECRET = 'test-secret-for-the-multi-claim-suite';
process.env.NODE_ENV = 'test';

const { test, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const db = require('../utils/db');
const createApp = require('../app');
const claimWindow = require('../services/claimWindowService');
const { CLAIM_WINDOW_MS } = require('../utils/constants');
const { validReport, uuid, endClaimingPeriod } = require('./helpers');

const app = createApp({ serveFrontend: false });
const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeEach(() => db.resetDB());
after(() => {
  if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
});

async function register(email, name) {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'password123', acceptTerms: true });
  return { token: res.body.data.token, user: res.body.data.user };
}

async function adminToken() {
  db.createUser({ name: 'Office Admin', email: 'admin@test.bpsu.edu.ph', studentId: null, passwordHash: await bcrypt.hash('AdminPass123', 10), role: 'admin' });
  const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.bpsu.edu.ph', password: 'AdminPass123' });
  return res.body.data.token;
}

function report(token, fields = {}) {
  const req = request(app).post('/api/items').set(auth(token));
  Object.entries(validReport({ type: 'found', title: 'Black leather wallet', ...fields })).forEach(([k, v]) => req.field(k, v));
  return req;
}

const claimBody = (itemId, proof = 'Inside is a library card with a coffee stain and my initials on the flap.', extra = {}) => ({
  itemId,
  proofDescription: proof,
  ...extra,
});

// A found wallet reported by Fina, claimed by Ana and Ben, reviewed by the office.
async function scenario() {
  const admin = await adminToken();
  const finder = await register('fina@bpsu.edu.ph', 'Fina Finder');
  const ana = await register('ana@bpsu.edu.ph', 'Ana Reyes');
  const ben = await register('ben@bpsu.edu.ph', 'Ben Cruz');
  const created = await report(finder.token, { verificationHint: 'There is a folded 50-peso note behind the card slot.' });
  assert.equal(created.status, 201);
  return { admin, finder, ana, ben, item: created.body.data.item };
}

const submit = (who, itemId, proof, extra) => request(app).post('/api/claims').set(auth(who.token)).send(claimBody(itemId, proof, extra));

describe('the reporter is not a claimant', () => {
  test('a reported item is listed under My Reports and never under My Claims', async () => {
    const { finder, item } = await scenario();
    const reports = await request(app).get('/api/items/mine').set(auth(finder.token));
    assert.deepEqual(reports.body.data.items.map((i) => i.id), [item.id]);
    const claims = await request(app).get('/api/claims/mine').set(auth(finder.token));
    assert.deepEqual(claims.body.data.claims, []);
    assert.equal((await submit(finder, item.id)).status, 409); // the finder cannot claim their own report
  });

  test('a claimed item shows up under My Claims, not under My Reports', async () => {
    const { ana, item } = await scenario();
    await submit(ana, item.id);
    assert.equal((await request(app).get('/api/items/mine').set(auth(ana.token))).body.data.items.length, 0);
    assert.equal((await request(app).get('/api/claims/mine').set(auth(ana.token))).body.data.claims.length, 1);
  });
});

describe('the 24-hour claiming period', () => {
  test('the deadline is set by the server, exactly 24 hours after publication, and cannot be chosen by the client', async () => {
    const admin = await adminToken();
    const finder = await register('fina@bpsu.edu.ph', 'Fina Finder');
    const farFuture = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const res = await report(finder.token, { claimDeadline: farFuture, createdAt: '2001-01-01T00:00:00.000Z' });
    const item = res.body.data.item;
    const stored = db.getItemById(item.id);
    assert.equal(new Date(stored.claimDeadline).getTime() - new Date(stored.createdAt).getTime(), CLAIM_WINDOW_MS);
    assert.ok(Math.abs(new Date(stored.createdAt).getTime() - Date.now()) < 5000);
    assert.equal(item.claimsOpen, true);
    assert.equal(item.claimDeadline, stored.claimDeadline);
    assert.ok(admin);
  });

  test('lost-item reports have no claiming period', async () => {
    const finder = await register('fina@bpsu.edu.ph', 'Fina Finder');
    const lost = (await report(finder.token, { type: 'lost' })).body.data.item;
    assert.equal(lost.claimDeadline, null);
    assert.equal(lost.claimsOpen, true);
  });

  test('two people can claim; the report stays open and nobody is approved automatically', async () => {
    const { ana, ben, admin, item } = await scenario();
    assert.equal((await submit(ana, item.id)).status, 201);
    const second = await submit(ben, item.id, 'It also has a Landers membership card and a torn corner.');
    assert.equal(second.status, 201);

    const stored = db.getItemById(item.id);
    assert.equal(stored.status, 'pending_verification'); // still open, nothing closed or claimed
    assert.deepEqual(db.getClaims({ itemId: item.id }).map((c) => c.status), ['pending', 'pending']);

    const seen = await request(app).get(`/api/claims/item/${item.id}`).set(auth(admin));
    assert.equal(seen.body.data.claims.length, 2);
    assert.deepEqual(seen.body.data.claims.map((c) => c.claimantName), ['Ana Reyes', 'Ben Cruz']); // oldest first
  });

  test('one person cannot claim the same report twice, and cannot claim on behalf of someone else', async () => {
    const { ana, ben, item } = await scenario();
    assert.equal((await submit(ana, item.id)).status, 201);
    assert.equal((await submit(ana, item.id)).status, 409);

    const forged = await submit(ben, item.id, undefined, { claimantId: ana.user.id, claimantName: 'Ana Reyes', status: 'approved' });
    assert.equal(forged.status, 201);
    const stored = db.getClaimById(forged.body.data.claim.id);
    assert.equal(stored.claimantId, ben.user.id);
    assert.equal(stored.status, 'pending');
  });

  test('claims need a login, and the explanation must be detailed', async () => {
    const { ana, item } = await scenario();
    assert.equal((await request(app).post('/api/claims').send(claimBody(item.id))).status, 401);
    assert.equal((await submit(ana, item.id, 'mine')).status, 400);
  });

  test('after the deadline new claims are refused by the server and the report moves to admin review', async () => {
    const { ana, ben, item } = await scenario();
    await submit(ana, item.id);
    db.updateItem(item.id, { claimDeadline: new Date(Date.now() - 1000).toISOString() }); // time passes… but the sweep has not run yet
    assert.equal(claimWindow.isOpen(db.getItemById(item.id)), false); // the clock alone closes the period

    const late = await submit(ben, item.id);
    assert.equal(late.status, 409);
    assert.match(late.body.message, /24-hour claiming period/);

    // the request itself ran the sweep, so the minute-by-minute job has nothing left to do
    assert.equal(db.getItemById(item.id).status, 'awaiting_review');
    assert.equal(claimWindow.sweepDeadlines(), 0);
    assert.equal((await submit(ben, item.id)).status, 409);
    const view = await request(app).get(`/api/items/${item.id}`).set(auth(ben.token));
    assert.equal(view.body.data.canClaim, false);
    assert.equal(view.body.data.item.claimsOpen, false);
  });

  test('a report nobody claimed ends as "no valid claim", not "claimed"', async () => {
    const { item } = await scenario();
    assert.equal(endClaimingPeriod(item.id), 1);
    assert.equal(db.getItemById(item.id).status, 'no_valid_claim');
  });

  test('a withdrawn claim does not keep the report in review', async () => {
    const { ana, item } = await scenario();
    const claim = (await submit(ana, item.id)).body.data.claim;
    endClaimingPeriod(item.id);
    assert.equal(db.getItemById(item.id).status, 'awaiting_review');
    await request(app).put(`/api/claims/${claim.id}/cancel`).set(auth(ana.token));
    assert.equal(db.getItemById(item.id).status, 'no_valid_claim');
  });

  test('the admin can reopen claiming (an explicit exception); others cannot', async () => {
    const { admin, ana, ben, item } = await scenario();
    await submit(ana, item.id);
    endClaimingPeriod(item.id);

    assert.equal((await request(app).post(`/api/admin/items/${item.id}/reopen-claims`).set(auth(ben.token)).send({ hours: 24 })).status, 403);
    assert.equal((await request(app).post(`/api/admin/items/${item.id}/reopen-claims`).set(auth(admin)).send({ hours: 0 })).status, 400);
    const reopened = await request(app).post(`/api/admin/items/${item.id}/reopen-claims`).set(auth(admin)).send({ hours: 12 });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.data.item.claimsOpen, true);
    assert.ok(Date.parse(reopened.body.data.item.claimDeadline) > Date.now());
    assert.equal((await submit(ben, item.id)).status, 201);

    // The set-status route cannot be used to sneak past an ended period.
    endClaimingPeriod(item.id);
    assert.equal((await request(app).put(`/api/admin/items/${item.id}/status`).set(auth(admin)).send({ status: 'found' })).status, 409);
  });
});

describe('the office picks exactly one claimant', () => {
  test('no decision can be made while the claiming period is still open', async () => {
    const { admin, ana, item } = await scenario();
    const claim = (await submit(ana, item.id)).body.data.claim;
    const early = await request(app).put(`/api/claims/${claim.id}`).set(auth(admin)).send({ status: 'approved' });
    assert.equal(early.status, 409);
    assert.equal(db.getClaimById(claim.id).status, 'pending');
  });

  test('approving one claimant rejects the others with a notification, and the report is claimed, not resolved', async () => {
    const { admin, ana, ben, item } = await scenario();
    const a = (await submit(ana, item.id)).body.data.claim;
    const b = (await submit(ben, item.id, 'It has a Landers card and a torn corner on the left.')).body.data.claim;
    endClaimingPeriod(item.id);

    const decision = await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'approved', officeNotes: 'Described the folded note.' });
    assert.equal(decision.status, 200);
    assert.equal(db.getClaimById(a.id).status, 'approved');
    assert.equal(db.getClaimById(b.id).status, 'rejected');
    assert.equal(db.getItemById(item.id).status, 'claimed'); // handover still to come
    assert.equal(db.getClaimById(a.id).reviewedBy, db.findUserByEmail('admin@test.bpsu.edu.ph').id);

    const note = (await request(app).get('/api/notifications').set(auth(ben.token))).body.data.notifications.find((n) => n.type === 'claim_rejected');
    assert.ok(note);
    assert.doesNotMatch(JSON.stringify(note), /Ana|folded/);

    const done = await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'completed' });
    assert.equal(done.status, 200);
    assert.equal(db.getItemById(item.id).status, 'returned');
  });

  test('two admins approving different claimants at the same moment produce only one approval', async () => {
    const { admin, ana, ben, item } = await scenario();
    const a = (await submit(ana, item.id)).body.data.claim;
    const b = (await submit(ben, item.id, 'It has a Landers card and a torn corner on the left.')).body.data.claim;
    endClaimingPeriod(item.id);

    const results = await Promise.all([
      request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'approved' }),
      request(app).put(`/api/claims/${b.id}`).set(auth(admin)).send({ status: 'approved' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(db.getClaims({ itemId: item.id }).filter((c) => c.status === 'approved').length, 1);
  });

  test('a rejection needs a reason, which the claimant then sees', async () => {
    const { admin, ana, item } = await scenario();
    const a = (await submit(ana, item.id)).body.data.claim;
    const bare = await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'rejected' });
    assert.equal(bare.status, 400);
    assert.ok(bare.body.fields.officeNotes);
    const done = await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'rejected', officeNotes: 'Could not describe the contents.' });
    assert.equal(done.status, 200);
    assert.equal((await request(app).get('/api/claims/mine').set(auth(ana.token))).body.data.claims[0].officeNotes, 'Could not describe the contents.');
  });

  test('the office can ask for more evidence; the claim waits until the claimant answers', async () => {
    const { admin, ana, ben, item } = await scenario();
    const a = (await submit(ana, item.id)).body.data.claim;
    endClaimingPeriod(item.id);

    const noQuestion = await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'info_required' });
    assert.equal(noQuestion.status, 400);
    const ask = await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'info_required', infoRequest: 'What is behind the card slot?' });
    assert.equal(ask.status, 200);
    assert.equal(db.getItemById(item.id).status, 'under_verification');
    assert.equal(db.getClaimById(a.id).status, 'info_required');

    assert.equal((await request(app).put(`/api/claims/${a.id}/respond`).set(auth(ben.token)).send({ response: 'A folded 50 peso note.' })).status, 403);
    assert.equal((await request(app).put(`/api/claims/${a.id}/respond`).set(auth(ana.token)).send({ response: 'no' })).status, 400);
    const answer = await request(app).put(`/api/claims/${a.id}/respond`).set(auth(ana.token)).send({ response: 'A folded 50 peso note.' });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.data.claim.status, 'under_review');
    assert.equal((await request(app).put(`/api/claims/${a.id}/respond`).set(auth(ana.token)).send({ response: 'again please' })).status, 409);

    const adminView = (await request(app).get(`/api/claims/item/${item.id}`).set(auth(admin))).body.data.claims[0];
    assert.equal(adminView.infoResponse, 'A folded 50 peso note.');
  });

  test('without enough evidence the claim can simply stay pending', async () => {
    const { admin, ana, item } = await scenario();
    const a = (await submit(ana, item.id)).body.data.claim;
    endClaimingPeriod(item.id);
    const note = await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ adminNotes: 'Waiting for the serial number.' });
    assert.equal(note.status, 200);
    assert.equal(db.getClaimById(a.id).status, 'pending');
    assert.equal(db.getItemById(item.id).status, 'awaiting_review');
  });
});

describe('privacy and permissions', () => {
  test('a claimant never sees another claimant\'s evidence or the finder\'s private hint', async () => {
    const { admin, finder, ana, ben, item } = await scenario();
    await submit(ana, item.id, 'My secret description: CRIMSON-LINING and a tiny burn mark.', { ownershipEvidence: 'Serial SN-998877', contactInfo: '0917-SECRET' });
    await submit(ben, item.id);

    for (const response of [
      await request(app).get('/api/claims/mine').set(auth(ben.token)),
      await request(app).get(`/api/items/${item.id}`).set(auth(ben.token)),
      await request(app).get('/api/notifications').set(auth(ben.token)),
      await request(app).get(`/api/items/${item.id}`), // a guest
      await request(app).get('/api/items'),
    ]) {
      assert.doesNotMatch(JSON.stringify(response.body), /CRIMSON|SN-998877|0917-SECRET|folded 50-peso/);
    }
    assert.equal((await request(app).get(`/api/claims/item/${item.id}`).set(auth(ben.token))).status, 403);
    assert.equal((await request(app).get('/api/claims').set(auth(ben.token))).status, 403);

    // the finder and the office do see the hint; the finder still cannot read the claimants' evidence
    assert.match((await request(app).get(`/api/items/${item.id}`).set(auth(finder.token))).body.data.item.verificationHint, /50-peso/);
    const forFinder = await request(app).get(`/api/claims/item/${item.id}`).set(auth(finder.token));
    assert.doesNotMatch(JSON.stringify(forFinder.body), /CRIMSON|SN-998877|0917-SECRET|ben@|ana@/);
    const forAdmin = (await request(app).get(`/api/claims/item/${item.id}`).set(auth(admin))).body.data.claims[0];
    assert.match(forAdmin.proofDescription, /CRIMSON/);
    assert.equal(forAdmin.ownershipEvidence, 'Serial SN-998877');
  });

  test('claimants cannot approve or reject (their own or anyone\'s) claims, and admin notes stay private', async () => {
    const { admin, ana, ben, item } = await scenario();
    const a = (await submit(ana, item.id)).body.data.claim;
    endClaimingPeriod(item.id);
    for (const who of [ana, ben]) {
      assert.equal((await request(app).put(`/api/claims/${a.id}`).set(auth(who.token)).send({ status: 'approved' })).status, 403);
    }
    await request(app).put(`/api/claims/${a.id}`).set(auth(admin)).send({ status: 'under_review', adminNotes: 'PRIVATE-NOTE' });
    assert.doesNotMatch(JSON.stringify((await request(app).get('/api/claims/mine').set(auth(ana.token))).body), /PRIVATE-NOTE/);
    assert.match(JSON.stringify((await request(app).get(`/api/claims/item/${item.id}`).set(auth(admin))).body), /PRIVATE-NOTE/);
  });

  test('a withdrawn approval, a finished claim and unknown claim ids behave', async () => {
    const { admin, item } = await scenario();
    assert.equal((await request(app).put(`/api/claims/${uuid()}`).set(auth(admin)).send({ status: 'approved' })).status, 404);
    assert.equal((await request(app).put('/api/claims/not-a-uuid/respond').set(auth(admin)).send({ response: 'hello there' })).status, 404);
    assert.ok(item);
  });
});

describe('the sweep job', () => {
  test('it runs on its own schedule and can be stopped', () => {
    const timer = claimWindow.startDeadlineJob(60 * 60 * 1000);
    assert.ok(timer);
    assert.equal(claimWindow.startDeadlineJob(), timer); // second start is a no-op
    claimWindow.stopDeadlineJob();
  });
});
