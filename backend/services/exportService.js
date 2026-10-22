/* CSV exports for the office (admin only; the routes enforce that).
   Opens cleanly in Excel: UTF-8 BOM, CRLF line endings, quoted cells.
   Cells that start with = + - @ get a leading apostrophe so a spreadsheet
   never runs user-typed text as a formula ("CSV injection"). */

const db = require('../utils/db');
const { referenceCode } = require('../utils/serialize');

function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}

const iso = (v) => (v ? new Date(v).toISOString() : '');

function itemsCsv() {
  const users = new Map(db.listUsers().map((u) => [u.id, u]));
  const claims = db.getClaims();
  const columns = [
    { label: 'Reference', value: (i) => referenceCode(i.id) },
    { label: 'Type', value: (i) => i.type },
    { label: 'Status', value: (i) => i.status },
    { label: 'Title', value: (i) => i.title },
    { label: 'Category', value: (i) => i.category },
    { label: 'Location', value: (i) => i.location },
    { label: 'Date', value: (i) => i.date },
    { label: 'Time', value: (i) => i.time || '' },
    { label: 'Reported by', value: (i) => (users.get(i.reportedBy) || {}).name || '' },
    { label: 'Reporter email', value: (i) => (users.get(i.reportedBy) || {}).email || '' },
    { label: 'Reported at', value: (i) => iso(i.createdAt) },
    { label: 'Verified at', value: (i) => iso(i.verifiedAt) },
    { label: 'Claims', value: (i) => claims.filter((c) => c.itemId === i.id).length },
  ];
  return toCsv(columns, db.getItems());
}

function claimsCsv() {
  const columns = [
    { label: 'Claim reference', value: (c) => referenceCode(c.id) },
    { label: 'Item reference', value: (c) => referenceCode(c.itemId) },
    { label: 'Item', value: (c) => c.itemTitle },
    { label: 'Claim type', value: (c) => c.claimType },
    { label: 'Status', value: (c) => c.status },
    { label: 'Claimant', value: (c) => c.claimantName },
    { label: 'Claimant email', value: (c) => c.claimantEmail },
    { label: 'Appointment date', value: (c) => c.appointmentDate },
    { label: 'Appointment time', value: (c) => c.appointmentTime },
    { label: 'Appointment location (BPSU Main Campus)', value: (c) => c.appointmentLocation },
    { label: 'Filed at', value: (c) => iso(c.createdAt) },
    { label: 'Reviewed at', value: (c) => iso(c.reviewedAt) },
    { label: 'Office notes', value: (c) => c.officeNotes || '' },
  ];
  return toCsv(columns, db.getClaims());
}

module.exports = { toCsv, itemsCsv, claimsCsv };
