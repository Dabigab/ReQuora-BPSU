// JSON-file storage driver (the default; zero install).
// Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
// half-written file behind.

const fs = require('fs');
const path = require('path');

// DB_PATH can be overridden (e.g. by the test suite) so tests never touch
// the real data/db.json used by the running app.
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', 'data', 'db.json');

function createJsonStore() {
  return {
    name: 'json',
    path: DB_PATH,
    exists: () => fs.existsSync(DB_PATH),
    ensure(emptyData) {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(DB_PATH)) this.save(emptyData);
    },
    load() {
      try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      } catch (err) {
        throw new Error(
          `The database file (${DB_PATH}) could not be read: ${err.message}. ` +
            'Fix or delete the file (a new empty one is created automatically).'
        );
      }
    },
    save(data) {
      const json = JSON.stringify(data, null, 2);
      const tmp = `${DB_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, json);
      try {
        fs.renameSync(tmp, DB_PATH);
      } catch (err) {
        // Windows can refuse to replace a file that antivirus/indexing is touching.
        // Fall back to a direct write rather than losing the update.
        fs.writeFileSync(DB_PATH, json);
        try {
          fs.unlinkSync(tmp);
        } catch (e) {
          /* temp file already gone */
        }
      }
    },
  };
}

module.exports = { createJsonStore, DB_PATH };
