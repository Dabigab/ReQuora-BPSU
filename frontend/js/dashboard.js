/* ReQuora — user dashboard: my reports, my claims, activity, profile */

const TABS = ['reports', 'claims', 'activity', 'profile'];
const OPEN = ['pending_verification', 'lost', 'found'];

let user = null;
let reportsPage = 1;
let myClaims = [];

const el = (id) => document.getElementById(id);

/* ---------- Stat cards ---------- */
function statCard(iconName, label, value, tone) {
  return `
    <div class="stat-card ${tone || ''}">
      <span class="stat-card-icon">${icon(iconName, 22)}</span>
      <div><div class="stat-card-value">${value}</div><div class="stat-card-label">${escapeHtml(label)}</div></div>
    </div>`;
}

async function loadStats() {
  const box = el('dash-stats');
  box.innerHTML = [1, 2, 3, 4].map(() => '<div class="stat-card skeleton-block" aria-hidden="true"></div>').join('');
  try {
    // limit=1: we only need pagination.total, not the rows.
    const count = async (query) => (await apiRequest('/items/mine', { auth: true, query: { limit: 1, ...query } })).pagination.total;
    const [lost, found, returned, claims] = await Promise.all([
      count({ type: 'lost' }),
      count({ type: 'found' }),
      count({ status: 'returned' }),
      apiRequest('/claims/mine', { auth: true }),
    ]);
    myClaims = claims.claims;
    const claimsReturned = myClaims.filter((c) => c.status === 'completed').length;
    box.innerHTML =
      statCard('search', 'My Lost Reports', lost, 'tone-lost') +
      statCard('check', 'My Found Reports', found, 'tone-found') +
      statCard('shield', 'My Claims', myClaims.length, 'tone-claim') +
      statCard('award', 'Resolved Items', returned + claimsReturned, 'tone-returned');
    return true;
  } catch (err) {
    box.innerHTML = `<div class="grid-span">${errorState(err, { retryId: 'retry-stats' })}</div>`;
    const retry = el('retry-stats');
    if (retry) retry.addEventListener('click', refreshAll);
    return false;
  }
}

/* ---------- My Reports (items I reported — as the finder, or as the owner of a lost item) ---------- */

// Where the report stands, in plain words.
function reportStateText(item) {
  if (item.type === 'lost') {
    if (item.status === 'returned') return 'Resolved: your item was returned to you.';
    if (item.status === 'closed') return 'This report is closed.';
    return item.claimsCount
      ? `Someone says they found your item. The office is checking (${item.claimsCount} message${item.claimsCount === 1 ? '' : 's'}).`
      : 'Your lost-item report is live. We will tell you if someone finds it.';
  }
  if (isOpenForClaims(item)) return 'Open for claims: people who think the item is theirs can submit a claim until the countdown ends.';
  return (
    {
      pending_verification: 'Waiting for the office to look at your report.',
      found: 'Your report is live.',
      awaiting_review: 'The claiming period ended. The office is reviewing the claims it received.',
      under_verification: 'The office is checking the claimants’ evidence.',
      claimed: 'The office approved a claimant. Please make sure the item is at the Lost and Found Office so it can be handed over.',
      returned: 'Resolved: the item was handed over to its owner. Thank you!',
      no_valid_claim: 'No valid claim was received. The office will decide what happens next.',
      closed: 'This report is closed.',
    }[item.status] || ''
  );
}

function reportRowHtml(item) {
  const open = OPEN.includes(item.status) && !item.claimsCount; // with claims waiting, only the office can close it
  const finder = item.type === 'found';
  const claimsLine = item.claimsCount
    ? `<span class="badge badge-pending">${item.claimsCount} ${item.type === 'found' ? 'claimant' : 'claim'}${item.claimsCount === 1 ? '' : 's'}</span>`
    : '';
  return `
    <article class="row-card row-card-report" data-id="${escapeHtml(item.id)}">
      <a class="row-media" href="${escapeHtml(itemUrl(item.id))}" data-item-id="${escapeHtml(item.id)}" tabindex="-1" aria-hidden="true">
        ${
          item.imageUrl
            ? `<img src="${escapeHtml(photoUrl(item.imageUrl))}" alt="" loading="lazy">`
            : icon(CATEGORY_ICONS[item.category] || 'box', 28)
        }
      </a>
      <div class="row-main">
        <div class="badge-row">${itemBadges(item)}${claimsLine}${isOpenForClaims(item) ? countdownHtml(item) : ''}</div>
        <h3><a href="${escapeHtml(itemUrl(item.id))}" data-item-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</a></h3>
        <p class="muted">${icon('tag', 14)} ${escapeHtml(item.category)} · ${icon('pin', 14)} ${escapeHtml(item.location)} · ${icon('calendar', 14)} ${finder ? 'Found' : 'Lost'} ${escapeHtml(formatDate(item.date))}</p>
        <p class="row-desc">${escapeHtml(item.description)}</p>
        <p class="muted">Published ${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(item.reference)}</p>
        <p class="note-inline">${icon('info', 14)} <span>${escapeHtml(reportStateText(item))}</span></p>
      </div>
      <div class="row-actions">
        <a class="btn btn-outline btn-sm" href="${escapeHtml(itemUrl(item.id))}" data-item-id="${escapeHtml(item.id)}">View</a>
        ${open ? `<button type="button" class="btn btn-ghost btn-sm" data-close="${escapeHtml(item.id)}">Close</button>` : ''}
        ${open ? `<button type="button" class="btn btn-danger-outline btn-sm" data-delete="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)}">${icon('trash', 15)}</button>` : ''}
      </div>
    </article>`;
}

async function loadReports() {
  const panel = el('panel-reports');
  panel.setAttribute('aria-busy', 'true');
  panel.innerHTML = `<div class="list-stack">${skeletonCards(3)}</div>`;
  try {
    const data = await apiRequest('/items/mine', { auth: true, query: { page: reportsPage, limit: 8 } });
    reportsPage = data.pagination.page;
    if (!data.items.length) {
      panel.innerHTML = stateBlock({
        iconName: 'file',
        title: 'No reports yet',
        text: 'Lost or found something on campus? Report it and the office will help.',
        actionHtml: '<a class="btn btn-primary btn-sm" href="report.html">Report an Item</a>',
      });
      return;
    }
    panel.innerHTML = `<p class="muted tab-intro">Items you reported. If you found an item, you are the finder: you do not claim it, the owner does.</p><div class="list-stack">${data.items.map(reportRowHtml).join('')}</div><div id="reports-pagination"></div>`;
    startCountdowns(loadReports);
    renderPagination(el('reports-pagination'), data.pagination, (n) => {
      reportsPage = n;
      loadReports();
    });
    wireReportActions(panel);
  } catch (err) {
    panel.innerHTML = errorState(err, { retryId: 'retry-reports' });
    const retry = el('retry-reports');
    if (retry) retry.addEventListener('click', loadReports);
  } finally {
    panel.setAttribute('aria-busy', 'false');
  }
}

function wireReportActions(panel) {
  panel.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: 'Close this report?',
        message: 'Close it when the item is sorted out. It will leave the public feed.',
        confirmText: 'Close report',
      });
      if (!yes) return;
      try {
        await apiRequest(`/items/${btn.dataset.close}`, { method: 'PUT', auth: true, body: { status: 'closed' } });
        toast('Report closed.', 'info');
        refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
  panel.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: 'Delete this report?',
        message: 'This permanently removes the report, its photo and any claims on it. This cannot be undone.',
        confirmText: 'Delete report',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiRequest(`/items/${btn.dataset.delete}`, { method: 'DELETE', auth: true });
        toast('Report deleted.');
        refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

/* ---------- My claims ---------- */
// What the claim status means for the claimant.
const CLAIM_STATE_TEXT = {
  pending: 'Your claim was received. The office compares all claims once the 24-hour claiming period ends.',
  under_review: 'The office is comparing the evidence.',
  info_required: 'The office needs more information from you. Please answer below.',
  approved: 'Approved! Bring your reference number and a valid ID to the Lost and Found Office to collect the item.',
  rejected: 'The office could not approve this claim. See the reason below.',
  completed: 'The item was handed over to you. Thank you for using ReQuora!',
  cancelled: 'You cancelled this claim.',
};

function claimRowHtml(c) {
  const visit = c.appointmentDate ? ` · ${icon('calendar', 14)} Appointment ${appointmentText(c)}` : '';
  const requested = c.appointmentRequest ? `<p class="note-inline">${icon('clock', 14)} <span>Your request (${appointmentRequestText(c.appointmentRequest)}) is waiting for the office.</span></p>` : '';
  return `
    <article class="row-card row-card-claim">
      <a class="row-media" href="${escapeHtml(itemUrl(c.itemId))}" data-item-id="${escapeHtml(c.itemId)}" tabindex="-1" aria-hidden="true">
        ${c.itemImageUrl ? `<img src="${escapeHtml(photoUrl(c.itemImageUrl))}" alt="" loading="lazy">` : icon(CATEGORY_ICONS[c.itemCategory] || 'box', 28)}
      </a>
      <div class="row-main">
        <div class="badge-row">${claimBadge(c.status)}${c.itemStatus ? statusBadge(c.itemStatus) : ''}</div>
        <h3><a href="${escapeHtml(itemUrl(c.itemId))}" data-item-id="${escapeHtml(c.itemId)}">${escapeHtml(c.itemTitle)}</a></h3>
        <p class="muted">${icon('tag', 14)} ${escapeHtml(c.itemCategory || '')} · ${icon('pin', 14)} ${escapeHtml(c.itemLocation || '—')} · ${icon('calendar', 14)} ${c.itemType === 'lost' ? 'Lost' : 'Found'} ${escapeHtml(formatDate(c.itemDate))}</p>
        <p class="muted">Claim Submitted ${escapeHtml(formatDateTime(c.createdAt))} · ${escapeHtml(c.reference)}${visit}</p>
        <p class="note-inline">${icon('info', 14)} <span>${escapeHtml(CLAIM_STATE_TEXT[c.status] || '')}</span></p>
        ${requested}
        ${claimTimelineHtml(c)}
        <details class="evidence"><summary>My explanation and evidence</summary>
          <p><strong>Why it is mine:</strong> ${multiline(c.proofDescription)}</p>
          ${c.ownershipEvidence ? `<p><strong>Identifying details:</strong> ${multiline(c.ownershipEvidence)}</p>` : ''}
          ${c.infoRequest ? `<p><strong>Office question:</strong> ${multiline(c.infoRequest)}</p>` : ''}
          ${c.infoResponse ? `<p><strong>My answer:</strong> ${multiline(c.infoResponse)}</p>` : ''}
        </details>
        ${c.officeNotes ? `<p class="note-inline">${icon('info', 14)} <span>Office: ${escapeHtml(c.officeNotes)}</span></p>` : ''}
        ${
          c.status === 'info_required'
            ? `<form class="respond-form" data-respond="${escapeHtml(c.id)}" novalidate>
                 <p class="note-inline">${icon('alert', 14)} <span><strong>The office asks:</strong> ${escapeHtml(c.infoRequest || 'Please send more evidence.')}</span></p>
                 <div class="form-field"><label for="resp-${escapeHtml(c.id)}">Your answer</label>
                 <textarea id="resp-${escapeHtml(c.id)}" name="response" rows="3" maxlength="1000" required></textarea></div>
                 <button type="submit" class="btn btn-primary btn-sm">Send answer</button>
               </form>`
            : ''
        }
      </div>
      <div class="row-actions">
        <a class="btn btn-outline btn-sm" href="${escapeHtml(itemUrl(c.itemId))}" data-item-id="${escapeHtml(c.itemId)}">View item</a>
        ${['pending', 'under_review', 'info_required', 'approved'].includes(c.status) ? `<button type="button" class="btn btn-outline btn-sm" data-request-appointment="${escapeHtml(c.id)}">Request time/place change</button>` : ''}
        ${['pending', 'info_required'].includes(c.status) ? `<button type="button" class="btn btn-ghost btn-sm" data-cancel-claim="${escapeHtml(c.id)}">Cancel claim</button>` : ''}
      </div>
    </article>`;
}

function renderClaims() {
  const panel = el('panel-claims');
  if (!myClaims.length) {
    panel.innerHTML = stateBlock({
      iconName: 'shield',
      title: 'No claims yet',
      text: 'When you believe a reported item is yours, you can submit a claim and follow it here.',
      actionHtml: '<a class="btn btn-primary btn-sm" href="browse.html?type=found">Browse found items</a>',
    });
    return;
  }
  panel.innerHTML = `<p class="muted tab-intro">Items you say belong to you. Only you and the office can see the evidence you submitted.</p><div class="list-stack">${myClaims.map(claimRowHtml).join('')}</div>`;
  panel.querySelectorAll('[data-respond]').forEach((form) =>
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors(form);
      const response = form.elements.response.value.trim();
      if (response.length < 5) {
        showFieldErrors(form, { response: 'Please write at least 5 characters.' });
        return;
      }
      const btn = form.querySelector('button[type="submit"]');
      setLoading(btn, true, 'Sending…');
      try {
        await apiRequest(`/claims/${form.dataset.respond}/respond`, { method: 'PUT', auth: true, body: { response } });
        toast('Thank you. The office has your answer.');
        await refreshAll();
      } catch (err) {
        setLoading(btn, false);
        const orphan = showFieldErrors(form, err.fields);
        if (orphan.length || !err.fields || !Object.keys(err.fields).length) toast(orphan[0] || err.message, 'error');
      }
    })
  );
  panel.querySelectorAll('[data-request-appointment]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const claim = myClaims.find((c) => c.id === btn.dataset.requestAppointment);
      if (claim && (await openAppointmentRequestDialog(claim))) refreshAll();
    })
  );
  panel.querySelectorAll('[data-cancel-claim]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: 'Cancel your claim?',
        message: 'The office will no longer consider your claim. You can submit a new one while the claiming period is still open.',
        confirmText: 'Cancel claim',
        cancelText: 'Keep claim',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiRequest(`/claims/${btn.dataset.cancelClaim}/cancel`, { method: 'PUT', auth: true });
        toast('Claim cancelled.', 'info');
        refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

/* ---------- Recent activity (built from real records only) ---------- */
async function renderActivity() {
  const panel = el('panel-activity');
  panel.innerHTML = '<div class="state"><span class="spinner dark" aria-hidden="true"></span><p>Loading activity…</p></div>';
  try {
    const data = await apiRequest('/items/mine', { auth: true, query: { limit: 10 } });
    const events = [];
    data.items.forEach((i) => events.push({ at: i.createdAt, icon: i.type === 'lost' ? 'search' : 'check', text: `You reported a ${i.type} item: ${i.title}`, href: itemUrl(i.id), id: i.id }));
    myClaims.forEach((c) => {
      events.push({ at: c.createdAt, icon: 'shield', text: `You submitted a claim for ${c.itemTitle}`, href: itemUrl(c.itemId), id: c.itemId });
      if (c.updatedAt && c.status !== 'pending' && c.updatedAt !== c.createdAt) {
        events.push({ at: c.updatedAt, icon: c.status === 'rejected' ? 'xCircle' : 'checkCircle', text: `Your claim for ${c.itemTitle} is now ${claimStatusLabel(c.status).toLowerCase()}`, href: itemUrl(c.itemId), id: c.itemId });
      }
    });
    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    if (!events.length) {
      panel.innerHTML = stateBlock({ iconName: 'clock', title: 'Nothing here yet', text: 'Your reports and claims will show up here as they happen.' });
      return;
    }
    panel.innerHTML = `<ol class="timeline">${events
      .slice(0, 12)
      .map(
        (e) => `<li><span class="timeline-dot">${icon(e.icon, 14)}</span>
          <div><a href="${escapeHtml(e.href)}" data-item-id="${escapeHtml(e.id)}">${escapeHtml(e.text)}</a><small>${escapeHtml(timeAgo(e.at))}</small></div></li>`
      )
      .join('')}</ol>`;
  } catch (err) {
    panel.innerHTML = errorState(err, { retryId: 'retry-activity' });
    const retry = el('retry-activity');
    if (retry) retry.addEventListener('click', renderActivity);
  }
}

/* ---------- Profile ---------- */
function renderProfile() {
  const panel = el('panel-profile');
  panel.innerHTML = `
    <div class="profile-grid">
      <section class="panel">
        <h2>Profile</h2>
        <div class="form-msg" id="profile-msg"></div>
        <form id="profile-form" novalidate>
          <div class="form-field"><label for="p-name">Full name</label><input id="p-name" name="name" maxlength="80" value="${escapeHtml(user.name)}" required autocomplete="name"></div>
          <div class="form-field"><label for="p-email">Email</label><input id="p-email" value="${escapeHtml(user.email)}" disabled><small class="field-hint">Your email is your login and cannot be changed here.</small></div>
          <div class="form-field"><label for="p-student">Student / employee ID <span class="optional">(optional)</span></label><input id="p-student" name="studentId" maxlength="30" value="${escapeHtml(user.studentId || '')}"></div>
          <div class="form-field"><label>Account type</label><p class="static-value">${escapeHtml(user.role)}</p></div>
          <button type="submit" class="btn btn-primary" id="profile-save">Save profile</button>
        </form>
      </section>
      <section class="panel">
        <h2>Change password</h2>
        <div class="form-msg" id="pw-msg"></div>
        <form id="pw-form" novalidate>
          <div id="pw-current-slot"></div>
          <div id="pw-new-slot"></div>
          <button type="submit" class="btn btn-primary" id="pw-save">Update password</button>
        </form>
      </section>
    </div>`;

  el('pw-current-slot').innerHTML = passwordFieldHtml({ id: 'currentPassword', label: 'Current password', autocomplete: 'current-password' });
  el('pw-new-slot').innerHTML = passwordFieldHtml({
    id: 'newPassword',
    label: 'New password',
    autocomplete: 'new-password',
    hint: '8 to 72 characters with at least one letter and one number.',
  });
  wirePasswordToggles(panel);

  const profileForm = el('profile-form');
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(profileForm);
    const msg = el('profile-msg');
    setFormMessage(msg, '');
    const name = el('p-name').value.trim();
    if (name.length < 2) {
      showFieldErrors(profileForm, { name: 'Enter your full name (at least 2 characters).' });
      return;
    }
    const btn = el('profile-save');
    setLoading(btn, true, 'Saving…');
    try {
      const data = await apiRequest('/auth/me', { method: 'PUT', auth: true, body: { name, studentId: el('p-student').value.trim() } });
      user = data.user;
      updateStoredUser(user);
      setFormMessage(msg, 'Profile saved.', 'success');
      el('welcome').textContent = `Welcome, ${user.name.split(' ')[0]}`;
    } catch (err) {
      const orphan = showFieldErrors(profileForm, err.fields);
      setFormMessage(msg, orphan[0] || err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  const pwForm = el('pw-form');
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(pwForm);
    const msg = el('pw-msg');
    setFormMessage(msg, '');
    const currentPassword = el('currentPassword').value;
    const newPassword = el('newPassword').value;
    const errors = {};
    if (!currentPassword) errors.currentPassword = 'Enter your current password.';
    if (newPassword.length < 8 || newPassword.length > 72 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      errors.newPassword = 'Use 8 to 72 characters with at least one letter and one number.';
    }
    if (Object.keys(errors).length) {
      showFieldErrors(pwForm, errors);
      return;
    }
    const btn = el('pw-save');
    setLoading(btn, true, 'Updating…');
    try {
      await apiRequest('/auth/password', { method: 'PUT', auth: true, body: { currentPassword, newPassword } });
      pwForm.reset();
      setFormMessage(msg, 'Password updated.', 'success');
    } catch (err) {
      const orphan = showFieldErrors(pwForm, err.fields);
      setFormMessage(msg, orphan[0] || err.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });
}

/* ---------- Tabs ---------- */
const loaded = {};

function selectTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'reports';
  TABS.forEach((t) => {
    const tab = el(`tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    el(`panel-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  });
  window.history.replaceState(null, '', `#${name}`);
  // Highlight "My Reports" / "My Claims" in the main menu to match the open tab.
  document.querySelectorAll('[data-nav="my-reports"], [data-nav="my-claims"]').forEach((a) => a.removeAttribute('aria-current'));
  const navLink = document.querySelector(`[data-nav="my-${name}"]`);
  if (navLink) navLink.setAttribute('aria-current', 'page');
  if (name === 'claims') renderClaims();
  if (name === 'activity') renderActivity();
  if (name === 'profile' && !loaded.profile) {
    renderProfile();
    loaded.profile = true;
  }
}

function wireTabs() {
  const tabs = TABS.map((t) => el(`tab-${t}`));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1 };
      if (keys[e.key]) {
        e.preventDefault();
        selectTab(TABS[(i + keys[e.key] + TABS.length) % TABS.length], { focus: true });
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        selectTab(e.key === 'Home' ? TABS[0] : TABS[TABS.length - 1], { focus: true });
      }
    });
  });
}

async function refreshAll() {
  await Promise.all([loadStats(), loadReports()]);
  const active = TABS.find((t) => !el(`panel-${t}`).hidden);
  if (active === 'claims') renderClaims();
  if (active === 'activity') renderActivity();
}

document.addEventListener('DOMContentLoaded', async () => {
  initLayout('dashboard');
  if (!requireLogin()) return;

  user = (await refreshSession()) || getCurrentUser();
  if (!user) return;

  el('welcome').textContent = `Welcome, ${user.name.split(' ')[0]}`;
  wireTabs();
  // Menu links ("My Reports", "My Claims") only change the #hash while this page is open.
  window.addEventListener('hashchange', () => {
    const name = window.location.hash.replace('#', '');
    if (TABS.includes(name)) selectTab(name);
  });
  const initial = window.location.hash.replace('#', '');
  await refreshAll();
  selectTab(TABS.includes(initial) ? initial : 'reports');
});
