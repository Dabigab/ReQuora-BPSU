/* ============================================================
   ReQuora — where uploaded photos are kept
     - Supabase Storage (public bucket) when Supabase is configured.
       Photos survive restarts, redeploys and sleeping servers.
     - otherwise the local backend/uploads folder (development only:
       hosts like Render wipe local files, which is why photos vanish).
   Both return a URL that the website can show directly.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig, createClient } = require('./supabase');
const { UPLOAD_DIR, removeUpload } = require('./imageFiles');

const CONTENT_TYPE = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

function createPhotoStorage({ config = getConfig(), client, uploadDir = UPLOAD_DIR, forceLocal = false } = {}) {
  const useSupabase = !forceLocal && String(process.env.DB_DRIVER || '').toLowerCase() !== 'json' && config.configured;
  const api = useSupabase ? client || createClient(config) : null;
  const prefix = useSupabase ? `${config.url}/storage/v1/object/public/${config.bucket}/` : null;

  // type = 'jpg' | 'png' | 'gif' | 'webp' (detected from the file's real bytes)
  async function save(buffer, type) {
    const name = `${Date.now()}-${crypto.randomUUID()}.${type}`;
    if (api) {
      const url = await api.uploadObject(name, buffer, CONTENT_TYPE[type]);
      return { url, key: name };
    }
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, name), buffer);
    return { url: `/uploads/${name}`, key: name };
  }

  // Deletes a photo given the URL that was stored on the item. Never throws.
  async function remove(url) {
    try {
      if (typeof url !== 'string' || !url) return false;
      if (prefix && url.startsWith(prefix)) {
        const key = url.slice(prefix.length);
        if (!key || key.includes('/') || key.includes('..')) return false;
        await api.deleteObject(key);
        return true;
      }
      return removeUpload(url, uploadDir);
    } catch (err) {
      console.error(`[ReQuora] Could not delete photo: ${err.message}`);
      return false;
    }
  }

  return { mode: useSupabase ? 'supabase' : 'local', save, remove };
}

let shared = null;
const photoStorage = () => (shared = shared || createPhotoStorage());

module.exports = { createPhotoStorage, photoStorage };
