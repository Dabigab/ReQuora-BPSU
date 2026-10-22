/* ============================================================
   ReQuora — statistics and office (admin) actions
   ============================================================ */

const db = require('../utils/db');
const { Errors } = require('../utils/http');
const { ITEM_STATUSES, CATEGORIES, OFFICE_TIMEZONE_OFFSET_MINUTES } = require('../utils/constants');
const { serializeItem, serializeClaim } = require('../utils/serialize');
const { clean, asString } = require('../utils/validate');
const itemService = require('./itemService');
const notifications = require('./notificationService');
const claimWindow = require('./claimWindowService');

const ACTIVE_STATUSES = ['pending_verification', 'lost', 'found', 'claimed', 'awaiting_review', 'under_verification', 'no_valid_claim'];
const CLAIMS_TO_REVIEW = ['pending', 'under_review', 'info_required'];

// Numbers shown on the public home page. Counts only — nothing personal.
function publicStats() {
  const { items } = db.readDB();
  return {
    lost: items.filter((i) => i.type === 'lost').length,
    found: items.filter((i) => i.type === 'found').length,
    returned: items.filter((i) => i.status === 'returned').length,
    active: items.filter((i) => ACTIVE_STATUSES.includes(i.status)).length,
    total: items.length,
  };
}

// YYYY-MM-DD in office time for an ISO timestamp.
function officeDay(iso) {
  return new Date(new Date(iso).getTime() + OFFICE_TIMEZONE_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}

function lastDays(count) {
  const days = [];
  const base = Date.now() + OFFICE_TIMEZONE_OFFSET_MINUTES * 60000;
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

function adminStats() {
  claimWindow.sweepDeadlines();
  const { users, items, claims } = db.readDB();

  const byStatus = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0]));
  items.forEach((i) => {
    if (byStatus[i.status] !== undefined) byStatus[i.status] += 1;
  });

  const categoryCounts = {};
  items.forEach((i) => {
    const key = CATEGORIES.includes(i.category) ? i.category : 'Other';
    categoryCounts[key] = (categoryCounts[key] || 0) + 1;
  });
  const byCategory = Object.entries(categoryCounts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const days = lastDays(14);
  const perDay = Object.fromEntries(days.map((d) => [d, { date: d, lost: 0, found: 0 }]));
  items.forEach((i) => {
    const d = officeDay(i.createdAt);
    if (perDay[d]) perDay[d][i.type === 'found' ? 'found' : 'lost'] += 1;
  });

  const nonAdminUsers = users.filter((u) => u.role !== 'admin');

  return {
    totalReports: items.length,
    lost: items.filter((i) => i.type === 'lost').length,
    found: items.filter((i) => i.type === 'found').length,
    pendingVerification: byStatus.pending_verification,
    pendingClaims: claims.filter((c) => c.status === 'pending').length,
    claimsToReview: claims.filter((c) => CLAIMS_TO_REVIEW.includes(c.status)).length,
    awaitingReview: byStatus.awaiting_review + byStatus.under_verification,
    approvedClaims: claims.filter((c) => c.status === 'approved').length,
    returned: byStatus.returned,
    users: nonAdminUsers.length,
    byStatus,
    byCategory,
    reportsPerDay: days.map((d) => perDay[d]),
  };
}

// Admin list: every report, any status, with reporter + claim info for the office.
function listItemsForAdmin(query) {
  claimWindow.sweepDeadlines();
  const filters = itemService.parseFilters({ ...query, status: query.status || 'all' });
  const sorted = itemService.sortItems(db.getItems(filters), query.sort);
  const { slice, pagination } = itemService.paginate(sorted, query, 15);

  const usersById = new Map(db.listUsers().map((u) => [u.id, u]));
  const items = slice.map((i) => {
    const claims = db.getClaims({ itemId: i.id }).filter((c) => c.status !== 'cancelled');
    const reporter = usersById.get(i.reportedBy);
    return {
      ...serializeItem(i, { role: 'admin' }),
      reporterEmail: reporter ? reporter.email : null,
      claimsCount: claims.length,
      pendingClaims: claims.filter((c) => CLAIMS_TO_REVIEW.includes(c.status)).length,
    };
  });
  return { items, pagination };
}

// "Verify" = the office has checked the report; it becomes active (lost/found).
function verifyItem(id) {
  const item = itemService.findItemOr404(id);
  if (item.status !== 'pending_verification') {
    throw Errors.conflict('Only reports that are pending verification can be verified.');
  }
  const updated = db.updateItem(item.id, { status: item.type, verifiedAt: new Date().toISOString() });
  notifications.notify(item.reportedBy, {
    type: 'report_verified',
    title: 'Your report was verified',
    message: `"${item.title}" is now live in the Lost & Found feed.`,
    link: `item.html?id=${item.id}`,
  });
  return serializeItem(updated, { role: 'admin' });
}

function setItemStatus(id, rawStatus) {
  const item = itemService.findItemOr404(id);
  const status = itemService.checkAdminStatus(item, clean(asString(rawStatus)));
  if (status === item.status) return serializeItem(item, { role: 'admin' });

  const updated = db.updateItem(item.id, { status });
  itemService.syncClaimsWithItemStatus(updated);
  notifications.notify(item.reportedBy, {
    type: 'report_status',
    title: 'Your report was updated',
    message: `"${item.title}" is now marked as ${status.replace(/_/g, ' ')}.`,
    link: `item.html?id=${item.id}`,
  });
  return serializeItem(updated, { role: 'admin' });
}

// Administrative exception to the 24-hour rule: reopen a report for more claims.
function reopenClaiming(admin, id, hours) {
  const updated = claimWindow.reopenClaiming(admin, id, hours);
  return serializeItem(updated, { role: 'admin' });
}

function listUsers() {
  const { users, items, claims } = db.readDB();
  return users
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      studentId: u.studentId || null,
      role: u.role,
      createdAt: u.createdAt,
      reports: items.filter((i) => i.reportedBy === u.id).length,
      claims: claims.filter((c) => c.claimantId === u.id).length,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Recent claims for the overview, with item details attached.
function recentClaims(limit = 5) {
  return db
    .getClaims()
    .slice(0, limit)
    .map((c) => serializeClaim(c, db.getItemById(c.itemId), 'admin'));
}

module.exports = {
  publicStats,
  adminStats,
  listItemsForAdmin,
  verifyItem,
  setItemStatus,
  reopenClaiming,
  listUsers,
  recentClaims,
};
