/* In-app notifications.
   Created by the other services when something happens that a person should
   know about (claim filed, claim decided, report verified…). They are stored
   per user and only ever shown to that user. */

const db = require('../utils/db');
const { Errors } = require('../utils/http');
const { isUuid, queryInt } = require('../utils/validate');

function serialize(n) {
  return { id: n.id, type: n.type, title: n.title, message: n.message, link: n.link, read: !!n.read, createdAt: n.createdAt };
}

// Never lets a notification problem break the action that triggered it.
function safely(fn) {
  try {
    return fn();
  } catch (err) {
    console.warn('[notifications] could not save a notification:', err.message);
    return null;
  }
}

function notify(userId, payload) {
  if (!userId) return null;
  return safely(() => db.addNotification({ userId, ...payload }));
}

function notifyAdmins(payload) {
  return safely(() => db.listUsers().filter((u) => u.role === 'admin').map((a) => db.addNotification({ userId: a.id, ...payload })));
}

function list(user, query = {}) {
  const limit = queryInt(query.limit, 20, { min: 1, max: 50 });
  const all = db.getNotifications(user.id);
  return { notifications: all.slice(0, limit).map(serialize), unread: all.filter((n) => !n.read).length };
}

function markRead(user, id) {
  if (!isUuid(id)) throw Errors.notFound('That notification could not be found.');
  const note = db.markNotificationRead(user.id, id);
  if (!note) throw Errors.notFound('That notification could not be found.');
  return serialize(note);
}

function markAllRead(user) {
  return { updated: db.markAllNotificationsRead(user.id) };
}

module.exports = { notify, notifyAdmins, list, markRead, markAllRead };
