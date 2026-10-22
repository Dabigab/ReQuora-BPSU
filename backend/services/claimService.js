/* ============================================================
   ReQuora — claim business rules
   Many people can claim the same report. Filing a claim never closes
   the report and never approves anyone: the office compares ALL the
   claims after the 24-hour claiming period and approves exactly one.

   Claim status flow (only the office moves a claim forward):
     pending -> under_review -> approved -> completed
     pending / under_review -> info_required -> under_review (claimant answers)
     pending / under_review / info_required -> rejected   (a reason is required)
     approved -> rejected, rejected -> pending (the office reopens a claim)
     pending / info_required -> cancelled   (by the person who submitted it)

   "Only one approved claimant per report" holds because every check and
   write below runs synchronously inside one Node process (no await
   between the check and the write), and the database backs it up with a
   unique index (supabase/migrations). Two admins pressing Approve at the
   same moment are therefore handled one after the other: the second one
   receives a conflict error.
   ============================================================ */

const db = require('../utils/db');
const notifications = require('./notificationService');
const claimWindow = require('./claimWindowService');
const { Errors } = require('../utils/http');
const {
  CLAIM_STATUSES,
  CLAIM_TRANSITIONS,
  CLAIM_ACTIVE,
  OPEN_STATUSES,
  OFFICE_TIMEZONE_OFFSET_MINUTES,
  OFFICE_OPEN_MINUTES,
  OFFICE_LAST_SLOT_MINUTES,
  LIMITS,
  verificationTier,
} = require('../utils/constants');
const { textField, throwIfInvalid, isUuid, isIsoDate, isClockTime, clean, asString, queryString } = require('../utils/validate');
const { serializeClaim } = require('../utils/serialize');
const campus = require('../utils/campusLocations');

const MAX_DAYS_AHEAD = 60;

// Current date and minutes-since-midnight at the office (Philippine time).
function officeNow(nowMs = Date.now()) {
  const t = new Date(nowMs + OFFICE_TIMEZONE_OFFSET_MINUTES * 60000);
  return { date: t.toISOString().slice(0, 10), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Returns an error message, or null when the appointment is acceptable. */
function validateAppointment(dateStr, timeStr, now = officeNow()) {
  if (!dateStr || !timeStr) return 'Please choose both an appointment date and a time.';
  if (!isIsoDate(dateStr) || !isClockTime(timeStr)) return 'That appointment date or time could not be read.';

  const weekday = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (weekday === 0 || weekday === 6) return 'The Lost and Found Office is open on weekdays only (Monday to Friday).';

  const minutes = toMinutes(timeStr);
  if (minutes < OFFICE_OPEN_MINUTES || minutes > OFFICE_LAST_SLOT_MINUTES) {
    return 'Please choose a time between 8:00 AM and 4:30 PM (the office closes at 5:00 PM).';
  }

  if (dateStr < now.date || (dateStr === now.date && minutes <= now.minutes)) {
    return 'Appointments cannot be booked in the past.';
  }

  const limit = new Date(`${now.date}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + MAX_DAYS_AHEAD);
  if (dateStr > limit.toISOString().slice(0, 10)) {
    return `Appointments can be booked up to ${MAX_DAYS_AHEAD} days ahead.`;
  }
  return null;
}

/**
 * Reads a claimant's wish for a different time and/or place. It is only a request:
 * nothing about the real appointment changes until an administrator approves it.
 * Problems are recorded in `fields`; returns null when the claimant asked for nothing.
 */
function parseAppointmentRequest(body, fields) {
  const date = clean(asString(body.appointmentDate));
  const time = clean(asString(body.appointmentTime));
  const location = clean(asString(body.appointmentLocation));
  const note = textField(fields, 'appointmentNote', body.appointmentNote, { label: 'Your note', max: LIMITS.appointmentNote.max });
  if (!date && !time && !location) return null;

  if (date || time) {
    const err = validateAppointment(date, time);
    if (err) fields.appointment = err;
  }
  let place = null;
  if (location) {
    // Claimants only suggest; the administrator confirms the place when approving.
    const checked = campus.checkLocation(location, { confirmedMainCampus: true });
    if (checked.error) fields.appointmentLocation = checked.error;
    else place = checked.value;
  }
  return { date: date || null, time: time || null, location: place, note: note || null, requestedAt: new Date().toISOString() };
}

function appointmentSentence(claim) {
  return `${claim.appointmentDate} at ${claim.appointmentTime}, ${claim.appointmentLocation} (${campus.CAMPUS_NAME})`;
}

function findClaimOr404(id) {
  if (!isUuid(id)) throw Errors.notFound('That claim could not be found.');
  const claim = db.getClaimById(id);
  if (!claim) throw Errors.notFound('That claim could not be found.');
  return claim;
}

/* ------------------------------------------------------------
   Submitting a claim
   ------------------------------------------------------------ */
function createClaim(user, body) {
  claimWindow.sweepDeadlines();
  const fields = {};

  const itemId = clean(asString(body.itemId));
  if (!isUuid(itemId)) throw Errors.validation('Please choose a valid item to claim.', { itemId: 'Invalid item.' });
  const item = db.getItemById(itemId);
  if (!item) throw Errors.notFound('That item could not be found.');

  if (user.role === 'admin') throw Errors.forbidden('Administrators review claims; they cannot submit them.');
  if (item.reportedBy === user.id) {
    throw Errors.conflict('You submitted this report yourself, so you cannot claim it.');
  }
  // Enforced on the server clock: a browser cannot extend the 24-hour period.
  if (claimWindow.hasEnded(item) || ['awaiting_review', 'under_verification', 'no_valid_claim'].includes(item.status)) {
    throw Errors.conflict('The 24-hour claiming period for this report has ended. The office is reviewing the claims it received.');
  }
  if (!OPEN_STATUSES.includes(item.status)) {
    throw Errors.conflict('This item can no longer be claimed because it is already being processed or has been closed.');
  }

  const proof = textField(fields, 'proofDescription', body.proofDescription, { label: 'Your explanation', ...LIMITS.proof, required: true });
  const evidence = textField(fields, 'ownershipEvidence', body.ownershipEvidence, { label: 'Ownership evidence', max: LIMITS.ownershipEvidence.max });
  const contactInfo = textField(fields, 'contactInfo', body.contactInfo, { label: 'Contact info', max: LIMITS.contactInfo.max });
  // The office books the appointment (always inside the Main Campus). A date, time or
  // place sent here is only the claimant's preference, kept as a request for the office.
  const appointmentRequest = parseAppointmentRequest(body, fields);
  throwIfInvalid(fields, fields.appointment || fields.appointmentLocation || 'Please check the highlighted fields.');

  // One claim per person per report (a withdrawn claim does not count).
  const existing = db.getClaims({ itemId, claimantId: user.id }).find((c) => c.status !== 'cancelled');
  if (existing) {
    throw Errors.conflict('You already submitted a claim for this item.', { claim: serializeClaim(existing, item, 'claimant') });
  }

  const claim = db.createClaim({
    itemId,
    itemTitle: item.title,
    itemCategory: item.category,
    claimType: item.type === 'found' ? 'ownership' : 'finder',
    claimantId: user.id,
    claimantName: user.name,
    claimantEmail: user.email,
    contactInfo: contactInfo || null,
    proofDescription: proof,
    ownershipEvidence: evidence || null,
    appointmentDate: null,
    appointmentTime: null,
    appointmentLocation: null,
    appointmentRequest,
    verificationTier: verificationTier(item.category),
  });

  const timed = !!item.claimDeadline;
  notifications.notify(user.id, {
    type: 'claim_submitted',
    title: 'Claim Submitted',
    message: `${item.title}: ${timed ? 'the office reviews every claim once the 24-hour claiming period ends.' : 'the office will review your claim.'}`,
    link: 'dashboard.html#claims',
  });
  notifications.notify(item.reportedBy, {
    type: 'claim_received',
    title: claim.claimType === 'ownership' ? 'Someone submitted a claim on your report' : 'Someone says they found your item',
    message: `${item.title}: the office will review it and verify in person.`,
    link: `item.html?id=${item.id}`,
  });
  notifications.notifyAdmins({
    type: 'claim_received',
    title: 'New claim to review',
    message: `${user.name} submitted a claim on "${item.title}".`,
    link: `item.html?id=${item.id}`,
  });
  return serializeClaim(claim, item, 'claimant');
}

/* ------------------------------------------------------------
   Reading
   ------------------------------------------------------------ */
function listMine(user) {
  claimWindow.sweepDeadlines();
  return db.getClaims({ claimantId: user.id }).map((c) => serializeClaim(c, db.getItemById(c.itemId), 'claimant'));
}

function listForItem(user, itemId) {
  claimWindow.sweepDeadlines();
  if (!isUuid(itemId)) throw Errors.notFound('That report could not be found.');
  const item = db.getItemById(itemId);
  if (!item) throw Errors.notFound('That report could not be found.');

  const admin = user.role === 'admin';
  if (!admin && item.reportedBy !== user.id) {
    throw Errors.forbidden('Only the person who submitted this report or an administrator can see its claims.');
  }
  // Oldest claim first, so the office compares them in the order they arrived.
  return db
    .getClaims({ itemId })
    .reverse()
    .map((c) => serializeClaim(c, item, admin ? 'admin' : 'reporter'));
}

function listAll(query) {
  claimWindow.sweepDeadlines();
  const status = queryString(query.status);
  if (status && !CLAIM_STATUSES.includes(status)) {
    throw Errors.validation('Unknown claim status.', { status: 'Unknown status.' });
  }
  return db.getClaims({ status: status || undefined }).map((c) => serializeClaim(c, db.getItemById(c.itemId), 'admin'));
}

/* ------------------------------------------------------------
   Withdrawing / answering (by the claimant)
   ------------------------------------------------------------ */
function cancelClaim(user, id) {
  const claim = findClaimOr404(id);
  if (claim.claimantId !== user.id) throw Errors.forbidden('You can only cancel your own claims.');
  if (!['pending', 'info_required'].includes(claim.status)) {
    throw Errors.conflict('Only a claim that has not been decided yet can be cancelled. Please contact the office.');
  }
  const updated = db.updateClaim(claim.id, { status: 'cancelled' });
  claimWindow.refreshReviewState(claim.itemId);
  return serializeClaim(updated, db.getItemById(claim.itemId), 'claimant');
}

// The claimant answers the office's request for more evidence.
function respondToInfoRequest(user, id, body) {
  const claim = findClaimOr404(id);
  if (claim.claimantId !== user.id) throw Errors.forbidden('You can only answer requests on your own claims.');
  if (claim.status !== 'info_required') throw Errors.conflict('The office is not waiting for more information on this claim.');

  const fields = {};
  const response = textField(fields, 'response', body.response, { label: 'Your answer', ...LIMITS.infoResponse, required: true });
  throwIfInvalid(fields);

  const item = db.getItemById(claim.itemId);
  const updated = db.updateClaim(claim.id, {
    status: 'under_review',
    infoResponse: response,
    infoRespondedAt: new Date().toISOString(),
    historyNote: 'Claimant sent the additional information.',
  });
  claimWindow.refreshReviewState(claim.itemId);
  notifications.notifyAdmins({
    type: 'claim_received',
    title: 'Claimant answered your request',
    message: `${claim.claimantName} sent more information for "${(item && item.title) || claim.itemTitle}".`,
    link: `item.html?id=${claim.itemId}`,
  });
  return serializeClaim(updated, db.getItemById(claim.itemId), 'claimant');
}

// The claimant asks for another time and/or another Main Campus place. The appointment
// itself is untouched; an administrator must approve it by rescheduling.
function requestAppointmentChange(user, id, body) {
  const claim = findClaimOr404(id);
  if (claim.claimantId !== user.id) throw Errors.forbidden('You can only change requests on your own claims.');
  if (!['pending', 'under_review', 'info_required', 'approved'].includes(claim.status)) {
    throw Errors.conflict('An appointment change can only be requested for a claim that is still active.');
  }
  const fields = {};
  const request = parseAppointmentRequest(body, fields);
  if (!request && !Object.keys(fields).length) fields.appointment = 'Choose a different date and time, or a different Main Campus place.';
  throwIfInvalid(fields, fields.appointment || fields.appointmentLocation || 'Please check the highlighted fields.');

  const item = db.getItemById(claim.itemId);
  const updated = db.updateClaim(claim.id, { appointmentRequest: request });
  notifications.notifyAdmins({
    type: 'claim_received',
    title: 'Appointment change requested',
    message: `${claim.claimantName} asked to change the appointment for "${(item && item.title) || claim.itemTitle}".`,
    link: `item.html?id=${claim.itemId}`,
  });
  return serializeClaim(updated, item, 'claimant');
}

/* ------------------------------------------------------------
   The office's decision (admin only — enforced by the route AND here)
   ------------------------------------------------------------ */
// Tells the claimant what the office decided. Never mentions other claimants.
function notifyClaimant(claim, item) {
  const title = (item && item.title) || claim.itemTitle || 'your item';
  const visit = claim.appointmentLocation ? ` Your appointment: ${appointmentSentence(claim)}.` : '';
  const copy = {
    approved: ['Your claim was approved', `Bring your reference number and a valid ID to the Lost and Found Office.${visit}`],
    rejected: ['Your claim was not approved', claim.officeNotes ? `Reason: ${claim.officeNotes}` : 'Visit the office for details.'],
    completed: ['Item handed over', `${title} has been released to you. Thank you for using ReQuora!`],
    pending: ['Your claim is back in the queue', 'The office reopened your claim.'],
    under_review: ['Your claim is under review', 'The office is comparing the evidence.'],
    info_required: ['More information needed', claim.infoRequest || 'The office needs more evidence to continue.'],
  }[claim.status];
  if (!copy) return;
  notifications.notify(claim.claimantId, { type: `claim_${claim.status}`, title: copy[0], message: `${title}: ${copy[1]}`, link: 'dashboard.html#claims' });
}

function decideClaim(admin, id, body) {
  if (!admin || admin.role !== 'admin') throw Errors.forbidden('Administrator access is required.');
  claimWindow.sweepDeadlines();

  const claim = findClaimOr404(id);
  const item = db.getItemById(claim.itemId);
  const fields = {};
  const updates = {};
  let next = null;

  if (body.status !== undefined) {
    next = clean(asString(body.status));
    if (!CLAIM_STATUSES.includes(next) || next === 'cancelled') {
      throw Errors.validation('Invalid claim status.', { status: 'Choose under review, more information, approved, rejected or completed.' });
    }
    if (next === claim.status) next = null;
    else if (!CLAIM_TRANSITIONS[claim.status].includes(next)) {
      throw Errors.conflict(`A ${claim.status.replace('_', ' ')} claim cannot be changed to ${next.replace('_', ' ')}.`);
    } else updates.status = next;
  }

  if (body.officeNotes !== undefined) {
    updates.officeNotes = textField(fields, 'officeNotes', body.officeNotes, { label: 'Reason / notes for the claimant', max: LIMITS.officeNotes.max }) || null;
  }
  if (body.adminNotes !== undefined) {
    updates.adminNotes = textField(fields, 'adminNotes', body.adminNotes, { label: 'Private admin notes', max: LIMITS.adminNotes.max }) || null;
  }

  if (next === 'rejected' && !(updates.officeNotes !== undefined ? updates.officeNotes : claim.officeNotes)) {
    fields.officeNotes = 'Please give a reason for rejecting this claim.';
  }
  if (next === 'info_required') {
    const request = textField(fields, 'infoRequest', body.infoRequest, { label: 'Your question', ...LIMITS.infoRequest, required: true });
    if (request) {
      updates.infoRequest = request;
      updates.infoRequestedAt = new Date().toISOString();
      updates.infoResponse = null; // a new question invalidates the previous answer
      updates.infoRespondedAt = null;
    }
  }

  // Scheduling or rescheduling: date, time AND a Main Campus place must all be valid.
  // A claimant's request never reaches this code path; only an administrator can set these.
  let appointmentChanged = false;
  if (body.appointmentDate !== undefined || body.appointmentTime !== undefined || body.appointmentLocation !== undefined) {
    const date = clean(asString(body.appointmentDate)) || claim.appointmentDate;
    const time = clean(asString(body.appointmentTime)) || claim.appointmentTime;
    const err = validateAppointment(date, time);
    if (err) fields.appointment = err;

    // A kept place is re-checked too, so an old value cannot slip past a changed approved list.
    const typed = body.appointmentLocation !== undefined ? body.appointmentLocation : claim.appointmentLocation;
    const place = campus.checkLocation(typed, {
      confirmedMainCampus: body.appointmentLocation !== undefined ? body.mainCampusConfirmed === true : true,
    });
    if (place.error) fields.appointmentLocation = place.error;

    if (!err && !place.error) {
      updates.appointmentDate = date;
      updates.appointmentTime = time;
      updates.appointmentLocation = place.value;
      updates.appointmentRequest = null; // the administrator has settled the claimant's request
      appointmentChanged = true;
    }
  }
  if (body.dismissAppointmentRequest === true && claim.appointmentRequest) {
    updates.appointmentRequest = null;
  }
  throwIfInvalid(fields);

  if (!Object.keys(updates).length) throw Errors.validation('Nothing to update.');

  if (updates.status) {
    if (!item) throw Errors.conflict('The report for this claim no longer exists.');
    if (item.status === 'closed') throw Errors.conflict('This report is closed.');

    const decided = db.getClaims({ itemId: item.id }).find((c) => c.id !== claim.id && (c.status === 'approved' || c.status === 'completed'));

    if (['approved', 'completed'].includes(next) || (next === 'pending' && claim.status === 'rejected')) {
      if (decided) throw Errors.conflict('Another claimant is already approved for this item. Reject that claim first if you need to choose someone else.');
    }
    if (next === 'approved' || next === 'completed') {
      // The deadline cannot be bypassed: no decision while claims can still arrive.
      if (item.claimDeadline && !claimWindow.hasEnded(item)) {
        throw Errors.conflict('The claiming period for this report is still open. Decide after it ends so every claimant is compared fairly.');
      }
      if (item.status === 'returned') throw Errors.conflict('This item is already returned.');
    }
    if (next === 'pending' && item.status === 'returned') throw Errors.conflict('This item is already returned.');

    updates.reviewedAt = new Date().toISOString();
    updates.reviewedBy = admin.id;
    updates.decidedBy = admin.id;
  }

  const updated = db.updateClaim(claim.id, updates);
  if (updates.status) notifyClaimant(updated, item);
  if (appointmentChanged && next !== 'approved') {
    notifications.notify(claim.claimantId, {
      type: 'claim_appointment',
      title: 'Your appointment',
      message: `${(item && item.title) || claim.itemTitle}: ${appointmentSentence(updated)}. Bring your reference number and a valid ID.`,
      link: 'dashboard.html#claims',
    });
  } else if (!appointmentChanged && claim.appointmentRequest && updates.appointmentRequest === null) {
    notifications.notify(claim.claimantId, {
      type: 'claim_appointment',
      title: 'Appointment request reviewed',
      message: `${(item && item.title) || claim.itemTitle}: the office kept the current appointment arrangement.`,
      link: 'dashboard.html#claims',
    });
  }

  // Keep the report's own status in step with the claim.
  if (updates.status && item) {
    const now = updates.reviewedAt;
    if (next === 'approved') {
      db.updateItem(item.id, { status: 'claimed', approvedClaimId: claim.id, approvedAt: now });
      // Exactly one claimant wins: everyone else still in the running is told, without any detail about the winner.
      for (const c of db.getClaims({ itemId: item.id })) {
        if (c.id !== claim.id && (CLAIM_ACTIVE.includes(c.status))) {
          const auto = db.updateClaim(c.id, {
            status: 'rejected',
            reviewedAt: now,
            reviewedBy: admin.id,
            decidedBy: admin.id,
            officeNotes: 'The office approved another claimant who showed stronger proof of ownership.',
          });
          notifyClaimant(auto, item);
        }
      }
      notifications.notify(item.reportedBy, {
        type: 'report_status',
        title: 'A claimant was approved',
        message: `"${item.title}": please hand the item to the Lost and Found Office if you have not done so yet, so it can be released to its owner.`,
        link: `item.html?id=${item.id}`,
      });
    } else if (next === 'completed') {
      db.updateItem(item.id, { status: 'returned', resolvedAt: now });
      notifications.notify(item.reportedBy, {
        type: 'report_status',
        title: 'Report resolved',
        message: `"${item.title}" was handed over to its owner. Thank you for reporting it!`,
        link: `item.html?id=${item.id}`,
      });
    } else if (claim.status === 'approved' && next === 'rejected' && item.status === 'claimed') {
      // Approval withdrawn: back to the review queue (or to the plain report when it never had a deadline).
      db.updateItem(item.id, { status: item.claimDeadline ? 'awaiting_review' : item.type, approvedClaimId: null, approvedAt: null });
      claimWindow.refreshReviewState(item.id);
    } else {
      claimWindow.refreshReviewState(item.id);
    }
  }

  return serializeClaim(updated, db.getItemById(claim.itemId), 'admin');
}

module.exports = {
  officeNow,
  validateAppointment,
  createClaim,
  listMine,
  listForItem,
  listAll,
  cancelClaim,
  respondToInfoRequest,
  requestAppointmentChange,
  decideClaim,
};
