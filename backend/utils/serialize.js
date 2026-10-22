/* ============================================================
   ReQuora — what the API is allowed to show to whom
   Records are stored with everything. These functions decide which
   fields leave the server for a given viewer (guest, owner, claimant,
   admin). Doing it in one place means a new endpoint cannot
   accidentally leak private data.
   ============================================================ */

const { verificationTier } = require('./constants');
const claimWindow = require('../services/claimWindowService');
const db = require('./db');
const { CAMPUS_NAME } = require('./campusLocations');

const userName = (id) => {
  const user = db.findUserById(id);
  return user ? user.name : null;
};

// Short code people can quote at the office, e.g. RQ-3F9A12BC
function referenceCode(id) {
  return `RQ-${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// "Maria Santos" -> "Maria S."  (strangers never see full names)
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'BPSU member';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

const isAdmin = (viewer) => !!viewer && viewer.role === 'admin';

/**
 * @param item    stored item
 * @param viewer  req.user or undefined for guests
 * @param opts    { canSeeContact } extra permission (e.g. approved claimant)
 */
function serializeItem(item, viewer, opts = {}) {
  const owner = !!viewer && item.reportedBy === viewer.id;
  const admin = isAdmin(viewer);

  const out = {
    id: item.id,
    reference: referenceCode(item.id),
    type: item.type,
    title: item.title,
    description: item.description,
    category: item.category,
    location: item.location,
    date: item.date,
    time: item.time || null,
    additionalDetails: item.additionalDetails || null,
    imageUrl: item.imageUrl || null,
    status: item.status,
    verificationTier: verificationTier(item.category),
    reportedByName: owner || admin ? item.reportedByName || 'Unknown' : shortName(item.reportedByName),
    isOwner: owner,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt,
  };

  // The 24-hour claiming period. The deadline is decided by the server; the page only displays it.
  out.claimDeadline = item.claimDeadline || null;
  out.claimsOpen = claimWindow.isOpen(item);
  out.serverTime = new Date().toISOString(); // lets the countdown ignore a wrong clock on the viewer's device
  if (item.approvedAt && (owner || admin)) out.approvedAt = item.approvedAt;

  if (owner || admin || opts.canSeeContact) out.contactInfo = item.contactInfo || null;
  // The finder's private check-question: shown to the finder and the office only.
  if (owner || admin) out.verificationHint = item.verificationHint || null;
  if (admin) out.reportedBy = item.reportedBy;
  return out;
}

// The claim's journey, oldest first. Claims saved before history existed get a
// best-effort timeline from their created/updated dates.
function claimTimeline(claim, { withAdmin = false } = {}) {
  if (Array.isArray(claim.history) && claim.history.length) {
    return claim.history.map((h) => {
      const step = { status: h.status, at: h.at, note: h.note || null };
      if (withAdmin) step.byName = h.by ? userName(h.by) : null;
      return step;
    });
  }
  const steps = [{ status: 'pending', at: claim.createdAt, note: null }];
  if (claim.status !== 'pending') steps.push({ status: claim.status, at: claim.updatedAt || claim.createdAt, note: claim.officeNotes || null });
  return steps;
}

/**
 * @param claim   stored claim
 * @param item    the item it belongs to (may be undefined if deleted)
 * @param view    'claimant' | 'admin' | 'reporter'
 */
function serializeClaim(claim, item, view) {
  const base = {
    id: claim.id,
    reference: referenceCode(claim.id),
    itemId: claim.itemId,
    itemReference: referenceCode(claim.itemId),
    itemTitle: (item && item.title) || claim.itemTitle || 'Item',
    itemType: (item && item.type) || null,
    itemStatus: (item && item.status) || null,
    itemImageUrl: (item && item.imageUrl) || null,
    // Public facts about the report the claim belongs to (the same details anyone can see on the report page).
    itemCategory: (item && item.category) || claim.itemCategory || null,
    itemLocation: (item && item.location) || null,
    itemDate: (item && item.date) || null,
    itemCreatedAt: (item && item.createdAt) || null,
    itemClaimDeadline: (item && item.claimDeadline) || null,
    status: claim.status,
    claimType: claim.claimType || 'ownership',
    appointmentDate: claim.appointmentDate,
    appointmentTime: claim.appointmentTime,
    appointmentLocation: claim.appointmentLocation || null,
    appointmentCampus: CAMPUS_NAME,
    verificationTier: claim.verificationTier || verificationTier(claim.itemCategory),
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };

  if (view === 'reporter') {
    // The reporter learns that someone is claiming and when they are coming,
    // but the office alone sees the proof and contact details.
    base.claimantName = shortName(claim.claimantName);
    return base;
  }

  base.timeline = claimTimeline(claim, { withAdmin: view === 'admin' });
  base.proofDescription = claim.proofDescription;
  base.ownershipEvidence = claim.ownershipEvidence || null;
  base.contactInfo = claim.contactInfo || null;
  base.appointmentRequest = claim.appointmentRequest || null;
  base.officeNotes = claim.officeNotes || null;
  base.infoRequest = claim.infoRequest || null;
  base.infoRequestedAt = claim.infoRequestedAt || null;
  base.infoResponse = claim.infoResponse || null;
  base.infoRespondedAt = claim.infoRespondedAt || null;

  if (view === 'admin') {
    base.claimantId = claim.claimantId;
    base.claimantName = claim.claimantName;
    base.claimantEmail = claim.claimantEmail;
    base.reviewedAt = claim.reviewedAt || null;
    base.reviewedByName = claim.reviewedBy ? userName(claim.reviewedBy) : null;
    base.adminNotes = claim.adminNotes || null; // private: never sent to the claimant
  }
  return base;
}

module.exports = { referenceCode, shortName, serializeItem, serializeClaim, claimTimeline };
