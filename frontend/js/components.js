/* ============================================================
   ReQuora — page layout (header, footer) and access guards
   Header and footer are built here, so every page shares one
   copy and nothing depends on extra files being fetched.
   ============================================================ */

/* Some static-file servers (e.g. `npx serve`) 301-redirect
   "item.html?id=x" to "/item" and drop the query string. Stashing the
   id right before navigating lets item.js find it anyway. */
function rememberItemId(id) {
  try {
    sessionStorage.setItem('requora_last_item_id', id);
  } catch (e) {
    /* storage unavailable: the query string still works on most servers */
  }
}

document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('[data-item-id]');
  if (link) rememberItemId(link.dataset.itemId);
});

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function headerHtml(user) {
  const nav = [
    ['home', 'index.html', 'Home'],
    ['browse', 'browse.html', 'Browse'],
  ];
  if (user) {
    nav.push(['my-reports', 'dashboard.html#reports', 'My Reports']);
    nav.push(['my-claims', 'dashboard.html#claims', 'My Claims']);
  }
  if (user && user.role === 'admin') nav.push(['admin', 'admin.html', 'Admin']);

  const links = nav.map(([key, href, label]) => `<a href="${href}" data-nav="${key}">${label}</a>`).join('');

  const account = user
    ? `<div class="notif-wrap">
         <button type="button" class="notif-btn" id="notif-btn" aria-haspopup="true" aria-expanded="false" aria-controls="notif-panel" aria-label="Notifications">
           ${icon('bell', 20)}<span class="notif-badge" id="notif-badge" hidden>0</span>
         </button>
         <div class="notif-panel" id="notif-panel" role="region" aria-label="Notifications" hidden></div>
       </div>
       <a class="user-chip" href="dashboard.html" title="Open my dashboard">
         <span class="avatar" aria-hidden="true">${escapeHtml(initials(user.name))}</span>
         <span class="user-chip-name">${escapeHtml(String(user.name).split(' ')[0])}</span>
       </a>
       <button type="button" class="btn btn-ghost btn-sm" id="site-logout-btn">${icon('logout', 16)} Log out</button>`
    : `<a href="login.html" class="btn btn-ghost btn-sm" data-nav="login">Log in</a>
       <a href="register.html" class="btn btn-outline btn-sm" data-nav="register">Sign up</a>`;

  return `
    <a class="skip-link" href="#main">Skip to main content</a>
    <header class="site-header">
      <div class="container header-inner">
        <a href="index.html" class="brand" aria-label="ReQuora home">
          <img class="brand-seal" src="assets/bpsu-logo.png" alt="" width="44" height="44">
          <span class="brand-text">
            <span class="brand-name">ReQuora</span>
            <span class="brand-tag">BPSU Digital Lost &amp; Found</span>
          </span>
        </a>
        <button type="button" class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="Open menu">${icon('menu', 22)}</button>
        <nav class="site-nav" id="site-nav" aria-label="Main">
          <div class="nav-links">${links}</div>
          <div class="nav-actions">
            <a href="report.html" class="btn btn-gold btn-sm" data-nav="report">${icon('plus', 16)} Report an item</a>
            ${account}
          </div>
        </nav>
      </div>
    </header>`;
}

function footerHtml() {
  return `
    <footer class="site-footer">
      <div class="container footer-grid">
        <div class="footer-brand">
          <div class="footer-logo">
            <img src="assets/bpsu-logo.png" alt="" width="40" height="40">
            <span>ReQuora</span>
          </div>
          <p>The digital lost &amp; found of Bataan Peninsula State University. Report, search and recover belongings across campus.</p>
        </div>
        <div>
          <h4>ReQuora</h4>
          <ul>
            <li><a href="browse.html">Browse Lost &amp; Found</a></li>
            <li><a href="report.html?type=lost">Report a lost item</a></li>
            <li><a href="report.html?type=found">Report a found item</a></li>
            <li><a href="dashboard.html#reports">My Reports</a></li>
            <li><a href="dashboard.html#claims">My Claims</a></li>
            <li><a href="terms.html">Terms and Conditions</a></li>
          </ul>
        </div>
        <div>
          <h4>Lost &amp; Found Office</h4>
          <ul>
            <li>Security Services Office</li>
            <li>Main Gate Security Post</li>
            <li>Mon–Fri, 8:00 AM – 5:00 PM</li>
          </ul>
        </div>
        <div>
          <h4>The University</h4>
          <ul>
            <li><a href="https://bpsu.edu.ph" target="_blank" rel="noopener noreferrer">bpsu.edu.ph</a></li>
            <li><a href="#" data-modal="vision-mission">Mission &amp; Vision</a></li>
            <li>City of Balanga, Bataan</li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom"><div class="container">&copy; ${new Date().getFullYear()} ReQuora — Bataan Peninsula State University. Built for the university community.</div></div>
    </footer>`;
}

function wireNavToggle() {
  const toggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;
  const set = (open) => {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    toggle.innerHTML = icon(open ? 'x' : 'menu', 22);
  };
  toggle.addEventListener('click', () => set(!nav.classList.contains('open')));
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) set(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('open')) {
      set(false);
      toggle.focus();
    }
  });
}

/* ---------- Notification bell ---------- */
const NOTIF_ICONS = {
  claim_submitted: 'shield',
  claim_received: 'shield',
  claim_review: 'clock',
  claim_under_review: 'eye',
  claim_info_required: 'alert',
  claim_approved: 'checkCircle',
  claim_rejected: 'xCircle',
  claim_completed: 'award',
  claim_pending: 'clock',
  report_verified: 'check',
  report_status: 'info',
  report_review: 'clock',
};

// Only same-site pages (the server builds these links, but never trust a link blindly).
function safeLink(raw) {
  return /^[a-z0-9_-]+\.html(\?[\w=&%.-]*)?(#\w+)?$/i.test(raw || '') ? raw : null;
}

function initNotifications() {
  const btn = document.getElementById('notif-btn');
  const panel = document.getElementById('notif-panel');
  const badge = document.getElementById('notif-badge');
  if (!btn || !panel) return;
  let notes = [];
  let unread = 0;

  const paintBadge = () => {
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    btn.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  };

  const paintPanel = () => {
    const rows = notes.length
      ? notes
          .map(
            (n) => `<li><button type="button" class="notif-item ${n.read ? '' : 'unread'}" data-id="${escapeHtml(n.id)}" data-link="${escapeHtml(safeLink(n.link) || '')}">
              <span class="notif-icon">${icon(NOTIF_ICONS[n.type] || 'bell', 16)}</span>
              <span class="notif-text"><strong>${escapeHtml(n.title)}</strong><span>${escapeHtml(n.message)}</span><small>${escapeHtml(timeAgo(n.createdAt))}</small></span>
              ${n.read ? '' : '<span class="notif-dot" aria-label="Unread"></span>'}
            </button></li>`
          )
          .join('')
      : `<li class="notif-empty">${icon('bell', 24)}<p>You are all caught up.</p><small>Updates about your reports and claims appear here.</small></li>`;
    panel.innerHTML = `
      <div class="notif-head"><h2>Notifications</h2>${unread ? '<button type="button" class="link-btn" id="notif-read-all">Mark all as read</button>' : ''}</div>
      <ul class="notif-list">${rows}</ul>`;

    const all = panel.querySelector('#notif-read-all');
    if (all) {
      all.addEventListener('click', async () => {
        try {
          await apiRequest('/notifications/read-all', { method: 'PUT', auth: true });
          notes.forEach((n) => (n.read = true));
          unread = 0;
          paintBadge();
          paintPanel();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
    panel.querySelectorAll('.notif-item').forEach((row) =>
      row.addEventListener('click', async () => {
        const link = row.dataset.link;
        if (row.classList.contains('unread')) {
          try {
            await apiRequest(`/notifications/${row.dataset.id}/read`, { method: 'PUT', auth: true });
          } catch (e) {
            /* opening the page matters more than the read flag */
          }
        }
        if (link) window.location.href = link;
        else {
          const note = notes.find((n) => n.id === row.dataset.id);
          if (note && !note.read) {
            note.read = true;
            unread = Math.max(0, unread - 1);
          }
          paintBadge();
          paintPanel();
        }
      })
    );
  };

  async function refresh() {
    try {
      const data = await apiRequest('/notifications', { auth: true, query: { limit: 15 } });
      notes = data.notifications;
      unread = data.unread;
      paintBadge();
      if (!panel.hidden) paintPanel();
    } catch (err) {
      /* the bell is a convenience: stay quiet if the server is unreachable */
    }
  }

  const setOpen = (open) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      paintPanel();
      refresh();
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      btn.focus();
    }
  });

  refresh();
  // Check again once a minute while the page is open and visible.
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 60000);
}

/**
 * Builds the header/footer, wires dialogs and shows any pending message.
 * @param {string} [activeNav] data-nav value of the current page
 * @returns the logged-in user (from localStorage) or null
 */
function initLayout(activeNav) {
  const user = getCurrentUser();

  const headerMount = document.getElementById('site-header');
  const footerMount = document.getElementById('site-footer');
  if (headerMount) headerMount.innerHTML = headerHtml(user);
  if (footerMount) footerMount.innerHTML = footerHtml();

  hydrateIcons();

  const main = document.querySelector('main');
  if (main && !main.id) main.id = 'main';
  if (main) main.setAttribute('tabindex', '-1');

  if (activeNav) {
    const link = document.querySelector(`[data-nav="${activeNav}"]`);
    if (link) link.setAttribute('aria-current', 'page');
  }

  wireNavToggle();
  wireVisionMissionLinks();
  if (user) initNotifications();
  const logoutBtn = document.getElementById('site-logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', showLogoutModal);

  const pending = showPendingFlash();
  if (pending) toast(pending.message, pending.type);
  if (user && user.needsTermsAcceptance) promptTermsAcceptance();
  return user;
}

/* ---------- Terms: existing members accept the current version ---------- */
let termsPromptOpen = false;

function loadTermsScript() {
  return new Promise((resolve, reject) => {
    if (typeof termsContentHtml === 'function') return resolve();
    const script = document.createElement('script');
    script.src = 'js/terms.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Shown to accounts that pre-date the Terms, and to everyone when the Terms version changes.
async function promptTermsAcceptance() {
  if (termsPromptOpen || /(^|\/)(terms|login|register)\.html$/.test(window.location.pathname)) return;
  termsPromptOpen = true;
  try {
    await loadTermsScript();
    const result = await openDialog({
      title: 'Please review our Terms and Conditions',
      size: 'lg',
      bodyHtml: `
        <p class="muted">We updated the rules for using ReQuora-BPSU. Please read them and confirm to keep using your account.</p>
        <div class="terms-box" tabindex="0" role="region" aria-label="Terms and Conditions">${termsContentHtml()}</div>
        <div class="form-field check-field"><label class="check-label" for="renew-terms">
          <input type="checkbox" id="renew-terms"><span>I have read and agree to the Terms and Conditions and Rules and Regulations of ReQuora-BPSU.</span>
        </label></div>`,
      actions: [
        { label: 'Not now', value: 'later', variant: 'ghost' },
        {
          label: 'I agree',
          value: 'accept',
          variant: 'primary',
          validate: (panel) => {
            const box = panel.querySelector('#renew-terms');
            if (box.checked) return true;
            toast('Please tick the box to agree.', 'error');
            box.focus();
            return false;
          },
        },
      ],
    });
    if (result.action !== 'accept') return;
    const data = await apiRequest('/auth/accept-terms', { method: 'POST', auth: true, body: { acceptTerms: true } });
    updateStoredUser(data.user);
    toast('Thank you. Your agreement was recorded.');
  } catch (err) {
    toast(err.message || 'Could not record your agreement. Please try again.', 'error');
  } finally {
    termsPromptOpen = false;
  }
}

/* ---------- Access guards ---------- */

// Confirms with the server that the stored login is still valid and refreshes
// the stored user (so a changed role or name shows up). Returns the user or null.
async function refreshSession() {
  if (!getToken()) return null;
  try {
    const data = await apiRequest('/auth/me', { auth: true });
    updateStoredUser(data.user);
    if (data.user.needsTermsAcceptance) promptTermsAcceptance();
    return data.user;
  } catch (err) {
    return null; // 401 is handled by apiRequest (redirects to login)
  }
}

// Sends visitors who are not logged in to the login page, then back afterwards.
function requireLogin() {
  if (getToken() && getCurrentUser()) return true;
  const here = window.location.pathname.split('/').pop() + window.location.search;
  flash('Please log in to continue.', 'info');
  window.location.href = `login.html?next=${encodeURIComponent(here)}`;
  return false;
}

// Admin pages: the browser check is only a convenience. The server enforces
// admin access on every request regardless of what is stored here.
async function requireAdminPage(mainEl) {
  if (!requireLogin()) return null;
  const user = await refreshSession();
  if (!user || user.role !== 'admin') {
    if (mainEl) {
      mainEl.innerHTML = `<div class="container section">${stateBlock({
        iconName: 'lock',
        tone: 'error',
        title: 'Administrators only',
        text: 'This area is for the Lost and Found Office. Your account does not have admin access.',
        actionHtml: '<a class="btn btn-primary btn-sm" href="index.html">Back to home</a>',
      })}</div>`;
    }
    return null;
  }
  return user;
}

// Only follow same-site "next" targets (prevents redirecting to another website).
function safeNext(raw, fallback = 'dashboard.html') {
  if (!raw) return fallback;
  return /^[a-z0-9_-]+\.html(\?[\w=&%.-]*)?$/i.test(raw) ? raw : fallback;
}
