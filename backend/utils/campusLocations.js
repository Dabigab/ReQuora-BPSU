/* ============================================================
   ReQuora — appointment locations (BPSU Main Campus only)
   Every verification / handover appointment must happen inside the
   BPSU Main Campus. The server enforces this; the browser is only a
   convenience.

   The approved meeting places are configuration, not code, so nothing
   here invents a building name. Set APPOINTMENT_LOCATIONS in backend/.env
   to the places the project administrator has verified, separated by
   semicolons (or as a JSON array):

     APPOINTMENT_LOCATIONS=Place one;Place two;Place three

   - List configured: only those places are accepted (a dropdown).
   - List empty: the administrator types a place and must confirm it is
     inside the Main Campus. Text naming another campus or an off-campus
     place is refused (best effort; a configured list is the strict option).
   ============================================================ */

const { clean, asString } = require('./validate');

const CAMPUS_NAME = 'BPSU Main Campus';
const LOCATION_MAX = 150;
const LOCATION_MIN = 3;

// Other BPSU campuses and obviously off-campus places. Used only in free-text mode.
const OUTSIDE_CAMPUS = /\b(abucay|bagac|dinalupihan|hermosa|orani|orion)\b|off[\s-]?campus|outside (the )?campus|residence|private (house|home)|\bmall\b/i;

function parseList(raw) {
  if (!raw || !String(raw).trim()) return [];
  let items;
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    try {
      items = JSON.parse(text);
    } catch {
      items = [];
    }
  } else {
    items = text.split(/[;\n]/);
  }
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const name = clean(asString(item));
    if (name.length >= LOCATION_MIN && name.length <= LOCATION_MAX && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

// Read on every call so a changed setting needs only a restart, and tests can set it.
function approvedLocations() {
  return parseList(process.env.APPOINTMENT_LOCATIONS);
}

/**
 * Checks a proposed meeting place.
 * `confirmedMainCampus` is the administrator's explicit confirmation (free-text mode only).
 * Returns { value } on success or { error } with a message for the user.
 */
function checkLocation(raw, { confirmedMainCampus = false } = {}) {
  const typed = clean(asString(raw));
  if (!typed) return { error: `Please choose where on the ${CAMPUS_NAME} the appointment will be.` };

  const approved = approvedLocations();
  if (approved.length) {
    const match = approved.find((name) => name.toLowerCase() === typed.toLowerCase());
    return match ? { value: match } : { error: `Appointments can only be held at an approved ${CAMPUS_NAME} location.` };
  }

  if (typed.length < LOCATION_MIN || typed.length > LOCATION_MAX) {
    return { error: `The meeting place must be ${LOCATION_MIN} to ${LOCATION_MAX} characters.` };
  }
  if (OUTSIDE_CAMPUS.test(typed)) return { error: `Appointments can only be held inside the ${CAMPUS_NAME}.` };
  if (confirmedMainCampus !== true) {
    return { error: `Please confirm that this place is inside the ${CAMPUS_NAME}.` };
  }
  return { value: typed };
}

module.exports = { CAMPUS_NAME, LOCATION_MAX, approvedLocations, checkLocation, parseList };
