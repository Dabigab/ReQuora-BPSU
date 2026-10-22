/* ============================================================
   ReQuora — the 24-hour claiming period
   A found-item report accepts claims until `claimDeadline`
   (publication time + 24 hours, set by the server when the report is
   created). The deadline is enforced in three ways, so it never depends
   on a browser staying open:
     1. createClaim refuses a claim whose time has run out, whether or
        not the sweep has run yet (isOpen compares against the clock).
     2. sweepDeadlines() moves every expired report to "awaiting_review"
        (it has claims) or "no_valid_claim" (it has none) and notifies
        the people involved. It runs every minute from server.js and
        also before the main read/write endpoints.
     3. The deadline is stored in the database (items.claim_deadline).
   Reports without a deadline (lost-item reports, and reports created
   before this feature existed) keep the previous behaviour.
   ============================================================ */

const db = require('../utils/db');
const notifications = require('./notificationService');
const { Errors } = require('../utils/http');
const { OPEN_STATUSES, REVIEW_STATUSES, CLAIM_ACTIVE, CLAIM_WINDOW_MS, MAX_REOPEN_HOURS } = require('../utils/constants');
const { isUuid } = require('../utils/validate');

const deadlineFor = (publishedAtIso) => new Date(new Date(publishedAtIso).getTime() + CLAIM_WINDOW_MS).toISOString();

/** True while ordinary claims are still accepted for this report. */
function isOpen(item, nowMs = Date.now()) {
  if (!item || !OPEN_STATUSES.includes(item.status)) return false;
  if (!item.claimDeadline) return true; // no deadline: legacy / lost-item report
  return nowMs < new Date(item.claimDeadline).getTime();
}

/** True once the claiming period has ended (false when there never was one). */
function hasEnded(item, nowMs = Date.now()) {
  return !!item && !!item.claimDeadline && nowMs >= new Date(item.claimDeadline).getTime();
}

/**
 * Closes the claiming period of every expired report. Safe to call as often
 * as you like: a report that already moved on is never touched again.
 * Returns how many reports changed.
 */
function sweepDeadlines(nowMs = Date.now()) {
  const expired = db.getItems().filter((i) => OPEN_STATUSES.includes(i.status) && hasEnded(i, nowMs));
  for (const item of expired) {
    const claims = db.getClaims({ itemId: item.id }).filter((c) => CLAIM_ACTIVE.includes(c.status));
    if (claims.length) {
      db.updateItem(item.id, { status: 'awaiting_review', claimWindowClosedAt: new Date(nowMs).toISOString() });
      notifications.notify(item.reportedBy, {
        type: 'report_review',
        title: 'Claiming period ended',
        message: `"${item.title}" received ${claims.length} claim${claims.length === 1 ? '' : 's'}. The office will now review the evidence.`,
        link: `item.html?id=${item.id}`,
      });
      for (const c of claims) {
        notifications.notify(c.claimantId, {
          type: 'claim_review',
          title: 'Your claim is awaiting review',
          message: `The claiming period for "${item.title}" has ended. The office will compare the evidence and decide.`,
          link: 'dashboard.html#claims',
        });
      }
      notifications.notifyAdmins({
        type: 'report_review',
        title: 'Report ready for review',
        message: `"${item.title}" has ${claims.length} claim${claims.length === 1 ? '' : 's'} waiting for a decision.`,
        link: `item.html?id=${item.id}`,
      });
    } else {
      db.updateItem(item.id, { status: 'no_valid_claim', claimWindowClosedAt: new Date(nowMs).toISOString() });
      notifications.notify(item.reportedBy, {
        type: 'report_review',
        title: 'No claims received',
        message: `Nobody claimed "${item.title}" during the 24-hour period. The office will decide what happens next.`,
        link: `item.html?id=${item.id}`,
      });
      notifications.notifyAdmins({
        type: 'report_review',
        title: 'Report with no claims',
        message: `"${item.title}" ended its claiming period without a claim.`,
        link: `item.html?id=${item.id}`,
      });
    }
  }
  return expired.length;
}

/**
 * Re-evaluates a report that is in the office's hands after one of its claims
 * changed (rejected, cancelled, sent back for more information…).
 */
function refreshReviewState(itemId) {
  const item = db.getItemById(itemId);
  if (!item || ![...REVIEW_STATUSES, 'no_valid_claim'].includes(item.status)) return item;
  const claims = db.getClaims({ itemId });
  if (claims.some((c) => c.status === 'approved' || c.status === 'completed')) return item; // decided elsewhere
  const live = claims.filter((c) => CLAIM_ACTIVE.includes(c.status));
  let next;
  if (!live.length) next = 'no_valid_claim';
  else if (live.some((c) => c.status === 'under_review' || c.status === 'info_required')) next = 'under_verification';
  else next = 'awaiting_review';
  return next === item.status ? item : db.updateItem(itemId, { status: next });
}

/**
 * Administrative exception: gives a report a fresh claiming period.
 * Only for reports the office has not decided yet.
 */
function reopenClaiming(admin, itemId, hours = 24) {
  if (!admin || admin.role !== 'admin') throw Errors.forbidden('Administrator access is required.');
  if (!isUuid(itemId)) throw Errors.notFound('That report could not be found.');
  const item = db.getItemById(itemId);
  if (!item) throw Errors.notFound('That report could not be found.');
  if (item.type !== 'found') throw Errors.conflict('Only found-item reports have a claiming period.');
  if (!['awaiting_review', 'under_verification', 'no_valid_claim'].includes(item.status)) {
    throw Errors.conflict('Only reports that are waiting for review or have no valid claim can be reopened for claims.');
  }
  if (db.getClaims({ itemId }).some((c) => c.status === 'approved' || c.status === 'completed')) {
    throw Errors.conflict('A claimant has already been approved for this report.');
  }
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 1 || h > MAX_REOPEN_HOURS) {
    throw Errors.validation(`Choose between 1 and ${MAX_REOPEN_HOURS} hours.`, { hours: `Choose between 1 and ${MAX_REOPEN_HOURS} hours.` });
  }
  const updated = db.updateItem(itemId, {
    status: item.type,
    claimDeadline: new Date(Date.now() + Math.round(h) * 3600 * 1000).toISOString(),
    claimWindowReopenedAt: new Date().toISOString(),
    claimWindowReopenedBy: admin.id,
  });
  notifications.notify(item.reportedBy, {
    type: 'report_status',
    title: 'Claiming reopened',
    message: `The office reopened "${item.title}" for claims for another ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}.`,
    link: `item.html?id=${item.id}`,
  });
  return updated;
}

let timer = null;
/** Starts the once-a-minute sweep (server.js). Does nothing if already running. */
function startDeadlineJob(intervalMs = 60 * 1000) {
  if (timer) return timer;
  const run = () => {
    try {
      sweepDeadlines();
    } catch (err) {
      console.error('[ReQuora] Claim deadline sweep failed:', err.message);
    }
  };
  run(); // catches anything that expired while the server was down
  timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stopDeadlineJob() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  deadlineFor,
  isOpen,
  hasEnded,
  sweepDeadlines,
  refreshReviewState,
  reopenClaiming,
  startDeadlineJob,
  stopDeadlineJob,
};
