#!/usr/bin/env node
/* ============================================================
   Copies an existing local database (backend/data/db.json) and its photos
   (backend/uploads) into Supabase. Safe to repeat: rows are upserted by id
   and nothing is ever deleted from Supabase.

   Usage (from the backend folder, with SUPABASE_* in .env):
     node scripts/migrate-to-supabase.js            # dry run: only reports
     node scripts/migrate-to-supabase.js --apply    # really copies
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { createClient, getConfig } = require('../utils/supabase');
const { toRow, ORDER } = require('../utils/dbSupabase');
const { createPhotoStorage } = require('../utils/photoStorage');
const { detectImageType } = require('../utils/imageFiles');

async function migrate({ data, client, photos, uploadDir, apply = false, log = console.log }) {
  const report = { copied: {}, skipped: [], photos: { uploaded: 0, missing: 0 } };
  const users = new Set((data.users || []).map((u) => u.id));
  const items = new Set((data.items || []).map((i) => i.id));

  const keep = {
    users: data.users || [],
    items: [],
    claims: [],
    notifications: [],
  };

  for (const item of data.items || []) {
    if (item.reportedBy && !users.has(item.reportedBy)) {
      report.skipped.push(`item ${item.id} ("${item.title}"): its reporter no longer exists`);
      items.delete(item.id);
      continue;
    }
    const copy = { ...item };
    if (copy.imageUrl && copy.imageUrl.startsWith('/uploads/')) {
      const file = path.join(uploadDir, path.basename(copy.imageUrl));
      if (!fs.existsSync(file)) {
        report.photos.missing += 1;
        log(`  photo missing on disk, report kept without it: ${copy.imageUrl}`);
        copy.imageUrl = null;
      } else {
        const buffer = fs.readFileSync(file);
        const type = detectImageType(buffer);
        if (!type) {
          copy.imageUrl = null;
        } else if (apply) {
          copy.imageUrl = (await photos.save(buffer, type)).url;
          report.photos.uploaded += 1;
        } else {
          report.photos.uploaded += 1; // would upload
        }
      }
    }
    keep.items.push(copy);
  }
  for (const claim of data.claims || []) {
    if (!items.has(claim.itemId)) report.skipped.push(`claim ${claim.id}: its report no longer exists`);
    else if (claim.claimantId && !users.has(claim.claimantId)) report.skipped.push(`claim ${claim.id}: its claimant no longer exists`);
    else keep.claims.push(claim);
  }
  for (const note of data.notifications || []) {
    if (users.has(note.userId)) keep.notifications.push(note);
    else report.skipped.push(`notification ${note.id}: its user no longer exists`);
  }

  for (const c of ORDER) {
    report.copied[c] = keep[c].length;
    if (apply && keep[c].length) await client.upsert(c, keep[c].map((d) => toRow(c, d)));
  }
  return report;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const apply = process.argv.includes('--apply');
  const config = getConfig();
  if (!config.configured) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env first.');
    process.exit(1);
  }
  const file = path.join(__dirname, '..', 'data', 'db.json');
  if (!fs.existsSync(file)) {
    console.error(`No local database found at ${file}. Nothing to copy.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const client = createClient(config);
  const photos = createPhotoStorage({ config, client });
  console.log(apply ? 'Copying to Supabase...' : 'DRY RUN (nothing is changed). Add --apply to copy for real.');
  const report = await migrate({ data, client, photos, uploadDir: path.join(__dirname, '..', 'uploads'), apply });
  console.log('Rows:', report.copied);
  console.log('Photos:', report.photos);
  if (report.skipped.length) {
    console.log('Skipped (would break database links):');
    report.skipped.forEach((s) => console.log('  - ' + s));
  }
  console.log(apply ? 'Done.' : 'Dry run finished.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { migrate };
