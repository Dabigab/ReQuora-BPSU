/* ============================================================
   ReQuora — item details page
   Shows one report and, depending on who is looking:
     guest      -> a prompt to log in to claim
     other user -> the claim flow (or the status of their claim)
     reporter   -> controls for their own report
     admin      -> the office controls
   Every permission is enforced by the server too; this page only
   decides what to SHOW.
   ============================================================ */

const TIERS = {
  high: {
    label: 'High-value item: enhanced verification',
    note: 'Items in this category are the most often claimed by mistake, so the office applies the strictest checks.',
    requirements: [
      'Valid BPSU ID and one additional government-issued ID',
      'Proof of purchase, warranty card, serial number, or the original box',
      'Photos of you with the item, or the device unlock code / account login',
      'Describe hidden details (contents, scratches, stickers, lock screen) before the item is shown to you',
      'Release is logged and, for very high-value items, may need a parent, guardian, or College Dean to co-sign',
    ],
  },
  medium: {
    label: 'Moderate-value item: standard-plus verification',
    note: 'A short interview plus one supporting proof is normally enough.',
    requirements: [
      'Valid BPSU ID',
      'Describe the contents and any distinguishing marks before the item is shown to you',
      'One supporting proof: a photo of you with the item, a receipt, or a witness',
      'Sign the release logbook at the office',
    ],
  },
  standard: {
    label: 'Low-value item: standard verification',
    note: 'A basic identity check and an accurate description are normally enough.',
    requirements: ['Valid BPSU ID', 'Accurately describe the item before it is shown to you', 'Sign the release logbook at the office'],
  },
};

const OPEN_STATUSES = ['pending_verification', 'lost', 'found'];

let current = null; // { item, myClaim, canClaim }

const root = () => document.getElementById('item-root');
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ------------------------------------------------------------
   Progress: Reported -> Open for claims -> Admin review -> Claim approved -> Resolved
   ------------------------------------------------------------ */
function progressHtml(item) {
  if (item.status === 'closed') {
    return `<div class="note note-muted">${icon('xCircle', 18)}<span>This report has been closed and is no longer active.</span></div>`;
  }
  const rank =
    { pending_verification: 1, lost: 2, found: 2, awaiting_review: 3, under_verification: 3, no_valid_claim: 3, claimed: 4, returned: 5 }[item.status] || 1;
  const steps = ['Reported', 'Open for claims', item.status === 'no_valid_claim' ? 'No valid claim' : 'Admin review', 'Claim approved', 'Resolved'];
  return `
    <ol class="progress" aria-label="Report progress">
      ${steps
        .map((label, i) => {
          const n = i + 1;
          const cls = n < rank ? 'done' : n === rank ? 'current' : '';
          return `<li class="${cls}" ${n === rank ? 'aria-current="step"' : ''}><span class="progress-dot">${n < rank || (n === rank && rank === 5) ? icon('check', 14) : n}</span><span class="progress-label">${label}</span></li>`;
        })
        .join('')}
    </ol>`;
}

/* ------------------------------------------------------------
   Left/right: photo and details
   ------------------------------------------------------------ */
function mediaHtml(item) {
  if (item.imageUrl) {
    return `<div class="detail-media"><img src="${escapeHtml(photoUrl(item.imageUrl))}" alt="Photo of ${escapeHtml(item.title)}"></div>`;
  }
  return `<div class="detail-media placeholder" role="img" aria-label="No photo provided">${icon(CATEGORY_ICONS[item.category] || 'box', 64)}<span>No photo provided</span></div>`;
}

function factHtml(iconName, label, value) {
  return `<div class="fact">${icon(iconName, 18)}<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div></div>`;
}

// "23h 12m left · until <date and time>" while claims are accepted, otherwise when it ended.
function claimPeriodHtml(item) {
  const until = `until ${escapeHtml(formatDateTime(item.claimDeadline))}`;
  return isOpenForClaims(item) ? `${countdownHtml(item)} <small class="muted">${until}</small>` : `${countdownHtml(item)} <small class="muted">ended ${escapeHtml(formatDateTime(item.claimDeadline))}</small>`;
}

function infoHtml(item) {
  const isLost = item.type === 'lost';
  const when = `${escapeHtml(formatDate(item.date))}${item.time ? ` · ${escapeHtml(formatTime12(item.time))}` : ''}`;
  return `
    <div class="badge-row">${itemBadges(item)}</div>
    <h1 class="detail-title">${escapeHtml(item.title)}</h1>
    <p class="detail-ref">Reference <strong>${escapeHtml(item.reference)}</strong> · published ${escapeHtml(timeAgo(item.createdAt))}</p>

    <dl class="facts">
      ${factHtml('tag', 'Category', escapeHtml(item.category))}
      ${factHtml('pin', isLost ? 'Last seen at' : 'Found at', escapeHtml(item.location))}
      ${factHtml('calendar', isLost ? 'Date lost' : 'Date found', when)}
      ${factHtml('clock', 'Published', escapeHtml(formatDateTime(item.createdAt)))}
      ${factHtml('user', isLost ? 'Reported by (owner)' : 'Turned in by (finder)', escapeHtml(item.reportedByName))}
      ${factHtml('shield', 'Current status', escapeHtml(isOpenForClaims(item) ? 'Open for Claims' : statusLabel(item.status)))}
      ${item.claimDeadline ? factHtml('clock', 'Claiming period', claimPeriodHtml(item)) : ''}
    </dl>

    <div class="detail-block">
      <h2>Description</h2>
      <p>${multiline(item.description)}</p>
    </div>
    ${item.additionalDetails ? `<div class="detail-block"><h2>Additional details</h2><p>${multiline(item.additionalDetails)}</p></div>` : ''}
    ${
      item.contactInfo
        ? `<div class="detail-block"><h2>Contact details</h2><p>${icon('mail', 16)} ${escapeHtml(item.contactInfo)}</p></div>`
        : '<p class="detail-locked">' + icon('lock', 15) + ' Contact details are private. They are shared only with the office and people whose claim has been approved.</p>'
    }
    ${progressHtml(item)}
  `;
}

/* ------------------------------------------------------------
   Claim panel (people who may claim the item)
   ------------------------------------------------------------ */
function claimPanelHtml(item) {
  const isFound = item.type === 'found';
  const tier = TIERS[item.verificationTier] || TIERS.standard;
  const question = isFound ? 'Is this item yours?' : 'Did you find this item?';
  const timed = !!item.claimDeadline;
  const lead = isFound
    ? `Answering Yes lets you submit a claim.${timed ? ' Other people can claim this item too until the claiming period ends. Being first does not matter:' : ''} The office compares the evidence and approves the claimant with the strongest proof of ownership. Nothing is released until you pass the verification in person.`
    : 'If you found the item this person lost, let the office know and hand it in. They will contact the owner.';

  const steps = isFound
    ? `
        <li><strong>Go to the BPSU Lost and Found Office</strong>, handled by the Security Services Office at the Main Gate Security Post, City of Balanga, Bataan. Open Monday to Friday, 8:00 AM to 5:00 PM.</li>
        <li><strong>Bring your reference number</strong> (${escapeHtml(item.reference)}) and the confirmation you will see on this page.</li>
        <li><strong>Bring the required proof</strong> for this item's level:
          <ul class="req-list">${tier.requirements.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        </li>
        <li><strong>Pass the verification.</strong> The handler asks you to describe the item before showing it, checks your proof, and compares it with this report.</li>
        <li><strong>Sign the release logbook</strong> once verification passes.</li>`
    : `
        <li><strong>Hand the item to the BPSU Lost and Found Office</strong> at the Main Gate Security Post (Mon to Fri, 8:00 AM to 5:00 PM).</li>
        <li><strong>Bring your reference number</strong> (${escapeHtml(item.reference)}) so the office can link it to this report.</li>
        <li><strong>The office contacts the owner</strong> and arranges the verified hand-over.</li>`;

  return `
    <section class="panel claim-panel" aria-labelledby="claim-question">
      <h2 id="claim-question">${escapeHtml(question)}</h2>
      <p class="muted">${escapeHtml(lead)}</p>

      <div class="claim-choice" id="claim-choice">
        <button type="button" class="btn btn-primary" id="claim-yes">Yes</button>
        <button type="button" class="btn btn-outline" id="claim-no">No</button>
      </div>

      <div class="note note-muted" id="claim-no-msg" hidden>
        ${icon('info', 18)}
        <div><p>No problem, nothing has been submitted. You can keep browsing, or report something of your own.</p>
        <div class="inline-actions"><a class="btn btn-outline btn-sm" href="browse.html">Back to browse</a>
        <button type="button" class="btn btn-ghost btn-sm" id="claim-reopen">Actually, it is mine</button></div></div>
      </div>

      <div id="claim-flow" hidden>
        ${isFound ? `<div class="tier tier-${escapeHtml(item.verificationTier)}"><strong>${escapeHtml(tier.label)}</strong><p>${escapeHtml(tier.note)}</p></div>
        <p class="disclaimer"><strong>Disclaimer:</strong> the more valuable the item is, the more verification a possible owner must undergo.</p>` : ''}

        <h3>What to do next</h3>
        <ol class="claim-steps">${steps}</ol>

        <h3>${isFound ? 'Submit a Claim' : 'Tell the office what you know'}</h3>
        <p class="muted">${isFound ? 'Your answers are private: only you and the office can see them. You do not need a receipt; a detailed description can also prove ownership.' : 'Only you and the office can see this.'}</p>

        <div class="form-msg" id="claim-msg"></div>
        <form id="claim-form" novalidate>
          <div class="form-field">
            <label for="proof-description">${isFound ? 'Why do you believe this item is yours?' : 'How and where did you find it?'}</label>
            <textarea id="proof-description" name="proofDescription" required rows="4" maxlength="1000"
              placeholder="${isFound ? 'Describe it in your own words: what it looks like, what is inside, when and where you lost it.' : 'Tell us where and when you found it and where it is now.'}"></textarea>
            <small class="field-hint">At least 20 characters. The office compares this with the report.</small>
          </div>
          ${
            isFound
              ? `<div class="form-field">
            <label for="ownership-evidence">Ownership evidence or identifying details <span class="optional">(optional)</span></label>
            <textarea id="ownership-evidence" name="ownershipEvidence" rows="3" maxlength="1000"
              placeholder="Anything that connects you to it and is not visible in the photo: serial number, scratches, stickers, accessories, lock screen, proof of purchase if you have one."></textarea>
            <small class="field-hint">Do not guess. A detail that does not match can weaken your claim.</small>
          </div>`
              : ''
          }
          <div class="form-field">
            <label for="claim-contact">Your contact number or email <span class="optional">(optional)</span></label>
            <input type="text" id="claim-contact" name="contactInfo" maxlength="120" placeholder="So the office can reach you">
          </div>
          <div class="inline-actions">
            <button type="submit" class="btn btn-primary" id="claim-submit">${isFound ? 'Submit Claim' : 'Notify the office'}</button>
            <button type="button" class="btn btn-ghost" id="claim-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </section>`;
}

function wireClaimPanel(item) {
  const yes = document.getElementById('claim-yes');
  if (!yes) return;
  const choice = document.getElementById('claim-choice');
  const flow = document.getElementById('claim-flow');
  const noMsg = document.getElementById('claim-no-msg');
  const form = document.getElementById('claim-form');
  const msg = document.getElementById('claim-msg');

  const show = (which) => {
    choice.hidden = which !== 'choice';
    noMsg.hidden = which !== 'no';
    flow.hidden = which !== 'flow';
    if (which === 'flow') flow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  yes.addEventListener('click', () => show('flow'));
  document.getElementById('claim-no').addEventListener('click', () => show('no'));
  document.getElementById('claim-reopen').addEventListener('click', () => show('flow'));
  document.getElementById('claim-cancel').addEventListener('click', () => show('choice'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    setFormMessage(msg, '');

    // Quick checks before bothering the server (the server checks everything again).
    if (document.getElementById('proof-description').value.trim().length < 20) {
      showFieldErrors(form, { proofDescription: 'Please write at least 20 characters.' });
      return;
    }

    const btn = document.getElementById('claim-submit');
    setLoading(btn, true, 'Submitting…');
    try {
      const evidence = document.getElementById('ownership-evidence');
      const data = await apiRequest('/claims', {
        method: 'POST',
        auth: true,
        body: {
          itemId: item.id,
          proofDescription: document.getElementById('proof-description').value.trim(),
          ownershipEvidence: evidence ? evidence.value.trim() : '',
          contactInfo: document.getElementById('claim-contact').value.trim(),
        },
      });
      toast('Claim Submitted. The office will review it.');
      current.myClaim = data.claim;
      current.canClaim = false;
      renderActionZone();
    } catch (err) {
      setLoading(btn, false);
      const orphan = showFieldErrors(form, err.fields);
      setFormMessage(msg, orphan[0] || err.message, 'error');
      // The period may have just ended while the form was open: show the real state.
      if (err.status === 409) {
        toast(err.message, 'error');
        reload().catch(() => {});
      }
    }
  });
}

/* ------------------------------------------------------------
   "Your claim" card
   ------------------------------------------------------------ */
function claimStatusHelp(claim) {
  const map = {
    pending: 'Your claim was received. Other people may claim this item too; the office compares all claims after the 24-hour claiming period ends and approves the strongest proof of ownership.',
    under_review: 'The office is comparing the evidence submitted for this item.',
    info_required: 'The office needs more information from you before it can decide. Please answer below.',
    approved: 'Your claim is approved. Bring your reference number and a valid ID to the Lost and Found Office to collect the item.',
    rejected: 'The office could not approve this claim. See the reason below or visit the office for details.',
    completed: 'The item has been handed over. Thank you for using ReQuora!',
    cancelled: 'You cancelled this claim.',
  };
  return map[claim.status] || '';
}

function myClaimHtml(claim) {
  const tier = TIERS[claim.verificationTier] || TIERS.standard;
  return `
    <section class="panel" aria-labelledby="my-claim-title">
      <div class="panel-head">
        <h2 id="my-claim-title">Your claim</h2>
        ${claimBadge(claim.status)}
      </div>
      <p class="muted">${escapeHtml(claimStatusHelp(claim))}</p>
      ${claimTimelineHtml(claim)}
      <dl class="detail-list">
        <dt>Claim reference</dt><dd>${escapeHtml(claim.reference)}</dd>
        <dt>Item reference</dt><dd>${escapeHtml(claim.itemReference)}</dd>
        <dt>Claim Submitted</dt><dd>${escapeHtml(formatDateTime(claim.createdAt))}</dd>
        <dt>Your explanation</dt><dd>${multiline(claim.proofDescription)}</dd>
        ${claim.ownershipEvidence ? `<dt>Your identifying details</dt><dd>${multiline(claim.ownershipEvidence)}</dd>` : ''}
        ${claim.appointmentDate ? `<dt>Appointment</dt><dd>${appointmentText(claim)}</dd>` : ''}
        ${claim.appointmentRequest ? `<dt>Your change request</dt><dd>${appointmentRequestText(claim.appointmentRequest)} <span class="muted">(waiting for the office)</span></dd>` : ''}
        <dt>Where</dt><dd>BPSU Lost and Found Office, Security Services Office, Main Gate Security Post</dd>
        ${claim.claimType === 'ownership' ? `<dt>Verification level</dt><dd>${escapeHtml(tier.label)}</dd>` : ''}
        ${claim.infoRequest ? `<dt>Office question</dt><dd>${multiline(claim.infoRequest)}</dd>` : ''}
        ${claim.infoResponse ? `<dt>Your answer</dt><dd>${multiline(claim.infoResponse)}</dd>` : ''}
        ${claim.officeNotes ? `<dt>Office notes</dt><dd>${escapeHtml(claim.officeNotes)}</dd>` : ''}
      </dl>
      ${
        claim.status === 'info_required'
          ? `<form id="respond-form" novalidate>
               <div class="form-field"><label for="respond-text">Your answer to the office</label>
               <textarea id="respond-text" name="response" rows="3" maxlength="1000" required></textarea></div>
               <button type="submit" class="btn btn-primary btn-sm" id="respond-submit">Send answer</button>
             </form>`
          : ''
      }
      <div class="inline-actions">
        ${['pending', 'under_review', 'info_required', 'approved'].includes(claim.status) ? `<button type="button" class="btn btn-outline btn-sm" id="request-appointment">${icon('calendar', 15)} Request a different time or place</button>` : ''}
        ${['pending', 'info_required'].includes(claim.status) ? `<button type="button" class="btn btn-outline btn-sm" id="cancel-claim">${icon('x', 15)} Cancel my claim</button>` : ''}
      </div>
    </section>`;
}

function wireMyClaim(claim) {
  const respond = document.getElementById('respond-form');
  if (respond) {
    respond.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldErrors(respond);
      const response = document.getElementById('respond-text').value.trim();
      if (response.length < 5) {
        showFieldErrors(respond, { response: 'Please write at least 5 characters.' });
        return;
      }
      const btn = document.getElementById('respond-submit');
      setLoading(btn, true, 'Sending…');
      try {
        await apiRequest(`/claims/${claim.id}/respond`, { method: 'PUT', auth: true, body: { response } });
        toast('Thank you. The office has your answer.');
        await reload();
      } catch (err) {
        setLoading(btn, false);
        const orphan = showFieldErrors(respond, err.fields);
        if (orphan.length || !Object.keys(err.fields || {}).length) toast(orphan[0] || err.message, 'error');
      }
    });
  }

  const requestBtn = document.getElementById('request-appointment');
  if (requestBtn) {
    requestBtn.addEventListener('click', async () => {
      if (await openAppointmentRequestDialog(claim)) await reload();
    });
  }

  const btn = document.getElementById('cancel-claim');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const yes = await confirmDialog({
      title: 'Cancel your claim?',
      message: 'The office will no longer consider your claim. You can submit a new one later if the claiming period is still open.',
      confirmText: 'Cancel claim',
      cancelText: 'Keep claim',
      danger: true,
    });
    if (!yes) return;
    setLoading(btn, true, 'Cancelling…');
    try {
      await apiRequest(`/claims/${claim.id}/cancel`, { method: 'PUT', auth: true });
      toast('Your claim was cancelled.', 'info');
      await reload();
    } catch (err) {
      setLoading(btn, false);
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------------
   Reporter + admin panels
   ------------------------------------------------------------ */
// The reporter's list: how many people claimed and where each claim stands — never anyone's evidence.
function claimRecordHtml(c) {
  return `
    <div class="record">
      <div class="record-top"><strong>${escapeHtml(c.claimantName)}</strong>${claimBadge(c.status)}</div>
      <p class="muted">${escapeHtml(c.reference)} · Claim Submitted ${escapeHtml(timeAgo(c.createdAt))}</p>
    </div>`;
}

async function loadClaimsInto(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  try {
    const data = await apiRequest(`/claims/item/${current.item.id}`, { auth: true });
    const counted = data.claims.filter((c) => c.status !== 'cancelled');
    box.innerHTML = counted.length
      ? `<p class="muted">${counted.length} ${counted.length === 1 ? 'person has' : 'people have'} claimed this item. The office decides who the owner is; you do not need to do anything until it asks.</p>${counted.map(claimRecordHtml).join('')}`
      : '<p class="muted">No one has claimed this item yet.</p>';
    // With claims waiting, only the office can close or delete the report (the server enforces this too).
    if (counted.length) ['close-report', 'delete-report'].forEach((id) => document.getElementById(id)?.remove());
  } catch (err) {
    box.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

// Plain-words explanation of where a report is, for the person who reported it.
function ownerStateText(item) {
  if (item.type === 'lost') return 'This is your lost-item report. If someone finds your item, the office will contact you.';
  if (isOpenForClaims(item)) return 'You reported this item as the finder. People who believe it is theirs can submit claims until the countdown ends. You are not the owner, so you cannot claim it.';
  return (
    {
      pending_verification: 'You reported this item as the finder. The office has not looked at your report yet.',
      found: 'You reported this item as the finder. You are not the owner, so you cannot claim it.',
      awaiting_review: 'The claiming period ended. The office is reviewing the claims it received.',
      under_verification: 'The office is checking the claimants’ evidence.',
      claimed: 'The office approved a claimant. Please make sure the item is at the Lost and Found Office so it can be handed over.',
      returned: 'Resolved: the item was handed over to its owner. Thank you for reporting it!',
      no_valid_claim: 'No valid claim was received. The office will decide what happens next.',
      closed: 'This report is closed.',
    }[item.status] || ''
  );
}

function ownerPanelHtml(item) {
  const open = OPEN_STATUSES.includes(item.status);
  return `
    <section class="panel" aria-labelledby="owner-title">
      <h2 id="owner-title">Your report</h2>
      <p class="muted">${escapeHtml(ownerStateText(item))}</p>
      ${item.type === 'found' && item.verificationHint ? `<div class="detail-block"><h3>Private verification detail</h3><p>${multiline(item.verificationHint)}</p><small class="muted">${icon('lock', 13)} Only you and the office can see this. Claimants are never shown it.</small></div>` : ''}
      <div class="inline-actions">
        ${open ? `<button type="button" class="btn btn-primary btn-sm" id="edit-report">${icon('edit', 15)} Edit report</button>
        <button type="button" class="btn btn-outline btn-sm" id="close-report">${icon('xCircle', 15)} Close report</button>
        <button type="button" class="btn btn-danger-outline btn-sm" id="delete-report">${icon('trash', 15)} Delete</button>` : ''}
      </div>
      ${open ? '' : '<p class="muted">The office is handling this report, so it can no longer be edited. Contact the Lost and Found Office for changes.</p>'}
      <h3>${item.type === 'found' ? 'Claimants' : 'Responses'}</h3>
      <div id="item-claims"><p class="muted">Loading…</p></div>
    </section>`;
}

/* ------------------------------------------------------------
   Admin: all claims for this report, side by side
   ------------------------------------------------------------ */
const ADMIN_CLAIM_ACTIONS = {
  pending: ['under_review', 'info_required', 'approved', 'rejected'],
  under_review: ['info_required', 'approved', 'rejected'],
  info_required: ['under_review', 'rejected'],
  approved: ['completed', 'rejected'],
  rejected: ['pending'],
  completed: [],
  cancelled: [],
};
const ADMIN_ACTION_LABEL = {
  under_review: 'Mark under review',
  info_required: 'Request more information',
  approved: 'Approve this claimant',
  rejected: 'Reject with reason',
  completed: 'Mark item handed over',
  pending: 'Reopen as pending',
};
const ADMIN_ACTION_VARIANT = { approved: 'btn-primary', completed: 'btn-primary', rejected: 'btn-danger-outline' };

function decisionHistoryHtml(c) {
  const steps = (c.timeline || [])
    .map(
      (s) =>
        `<li><strong>${escapeHtml(claimStatusLabel(s.status))}</strong> · ${escapeHtml(formatDateTime(s.at))}${s.byName ? ` · by ${escapeHtml(s.byName)}` : ''}${s.note ? `<br><span class="muted">${escapeHtml(s.note)}</span>` : ''}</li>`
    )
    .join('');
  return `<details class="evidence"><summary>Decision history (${(c.timeline || []).length})</summary><ol class="history-list">${steps}</ol></details>`;
}

function reviewCardHtml(c, item, canDecide) {
  const actions = ADMIN_CLAIM_ACTIONS[c.status] || [];
  const decisionBlocked = (a) => !canDecide && (a === 'approved' || a === 'completed');
  return `
    <article class="review-card" data-claim="${escapeHtml(c.id)}" data-status="${escapeHtml(c.status)}">
      <header class="review-head">
        <div><strong>${escapeHtml(c.claimantName)}</strong><small class="cell-sub">${escapeHtml(c.claimantEmail || '')}</small></div>
        ${claimBadge(c.status)}
      </header>
      <p class="muted">${icon('clock', 14)} Claim Submitted ${escapeHtml(formatDateTime(c.createdAt))} · ${escapeHtml(c.reference)}</p>
      <dl class="detail-list compact">
        <dt>Why they say it is theirs</dt><dd class="proof">${multiline(c.proofDescription)}</dd>
        <dt>Ownership evidence / identifying details</dt><dd class="proof">${c.ownershipEvidence ? multiline(c.ownershipEvidence) : '<span class="muted">None provided</span>'}</dd>
        <dt>Contact</dt><dd>${escapeHtml(c.contactInfo || c.claimantEmail || '—')}</dd>
        ${c.infoRequest ? `<dt>Question you asked${c.infoRequestedAt ? ` (${escapeHtml(formatDateTime(c.infoRequestedAt))})` : ''}</dt><dd class="proof">${multiline(c.infoRequest)}</dd>` : ''}
        ${c.infoRequest ? `<dt>Their answer</dt><dd class="proof">${c.infoResponse ? multiline(c.infoResponse) : '<span class="muted">Waiting for an answer…</span>'}</dd>` : ''}
        <dt>Appointment</dt><dd>${c.appointmentDate ? appointmentText(c) : '<span class="muted">Not scheduled yet</span>'}</dd>
        ${c.appointmentRequest ? `<dt>Claimant asked for</dt><dd>${appointmentRequestText(c.appointmentRequest)}${c.appointmentRequest.note ? `<br><span class="muted">${escapeHtml(c.appointmentRequest.note)}</span>` : ''}</dd>` : ''}
        ${c.reviewedAt ? `<dt>Last decision</dt><dd>${escapeHtml(formatDateTime(c.reviewedAt))}${c.reviewedByName ? ` by ${escapeHtml(c.reviewedByName)}` : ''}</dd>` : ''}
      </dl>
      ${decisionHistoryHtml(c)}
      <div class="form-field"><label for="reason-${escapeHtml(c.id)}">Reason / message for the claimant <span class="optional">(required to reject)</span></label>
        <textarea id="reason-${escapeHtml(c.id)}" data-office-notes rows="2" maxlength="500">${escapeHtml(c.officeNotes || '')}</textarea></div>
      <div class="form-field"><label for="notes-${escapeHtml(c.id)}">Private admin notes <span class="optional">(never shown to the claimant)</span></label>
        <textarea id="notes-${escapeHtml(c.id)}" data-admin-notes rows="2" maxlength="1000">${escapeHtml(c.adminNotes || '')}</textarea></div>
      <div class="inline-actions review-actions">
        ${actions
          .map(
            (a) =>
              `<button type="button" class="btn btn-sm ${ADMIN_ACTION_VARIANT[a] || 'btn-outline'}" data-decide="${a}" ${decisionBlocked(a) ? 'disabled title="Available when the claiming period ends"' : ''}>${escapeHtml(ADMIN_ACTION_LABEL[a])}</button>`
          )
          .join('')}
        ${['pending', 'under_review', 'info_required', 'approved'].includes(c.status) ? `<button type="button" class="btn btn-outline btn-sm" data-schedule>${icon('calendar', 15)} ${c.appointmentDate ? 'Reschedule' : 'Schedule appointment'}</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-save-notes>Save notes</button>
      </div>
    </article>`;
}

function adminReviewHtml(item, claims) {
  const live = claims.filter((c) => c.status !== 'cancelled');
  const windowOpen = !!item.claimDeadline && item.claimsOpen;
  const canReopen = item.type === 'found' && ['awaiting_review', 'under_verification', 'no_valid_claim'].includes(item.status);
  const intro = windowOpen
    ? `<div class="note note-gold">${icon('clock', 18)}<span>The claiming period is still open (${countdownHtml(item)}). You can read the claims as they arrive, but approving a claimant is available after it ends so everyone is compared fairly.</span></div>`
    : item.claimDeadline
      ? `<div class="note note-muted">${icon('clock', 18)}<span>The claiming period ended ${escapeHtml(formatDateTime(item.claimDeadline))}. Compare the claims below and approve at most one claimant.</span></div>`
      : '';
  const cards = live.length
    ? `<div class="review-grid">${live.map((c) => reviewCardHtml(c, item, !windowOpen)).join('')}</div>`
    : '<p class="muted">No one has claimed this item.</p>';
  return `
    ${intro}
    ${item.type === 'found' ? `<div class="detail-block"><h3>Finder’s private verification detail</h3><p>${item.verificationHint ? multiline(item.verificationHint) : '<span class="muted">The finder did not add one.</span>'}</p><small class="muted">${icon('lock', 13)} Compare it with what each claimant describes. It is never shown publicly.</small></div>` : ''}
    <h3>${live.length} claim${live.length === 1 ? '' : 's'} on this item</h3>
    ${canReopen ? `<div class="inline-actions"><button type="button" class="btn btn-outline btn-sm" id="reopen-claims">${icon('refresh', 15)} Reopen claiming</button><small class="muted">Gives claimants more time (an exception to the 24-hour rule).</small></div>` : ''}
    ${cards}`;
}

async function loadAdminReview() {
  const box = document.getElementById('item-claims');
  if (!box) return;
  try {
    const data = await apiRequest(`/claims/item/${current.item.id}`, { auth: true });
    box.innerHTML = adminReviewHtml(current.item, data.claims);
    box._claims = data.claims;
    wireAdminReview(box);
    startCountdowns(reload);
  } catch (err) {
    box.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

async function askForText({ title, label, hint, confirmText, min = 5, max = 500 }) {
  const result = await openDialog({
    title,
    bodyHtml: `<div class="form-field"><label for="ask-text">${escapeHtml(label)}</label><textarea id="ask-text" rows="4" maxlength="${max}"></textarea>${hint ? `<small class="field-hint">${escapeHtml(hint)}</small>` : ''}</div>`,
    actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      {
        label: escapeHtml(confirmText),
        value: 'ok',
        variant: 'primary',
        validate: (panel) => {
          const field = panel.querySelector('#ask-text');
          if (field.value.trim().length >= min) return true;
          clearFieldErrors(panel);
          showFieldErrors(panel, { 'ask-text': `Please write at least ${min} characters.` });
          return false;
        },
      },
    ],
    focus: '#ask-text',
    collect: (panel) => ({ text: panel.querySelector('#ask-text').value.trim() }),
  });
  return result.action === 'ok' ? result.data.text : null;
}

function wireAdminReview(box) {
  const reopen = document.getElementById('reopen-claims');
  if (reopen) {
    reopen.addEventListener('click', async () => {
      const result = await openDialog({
        title: 'Reopen claiming',
        bodyHtml: `<p class="muted">New claims will be accepted again. Existing claims stay as they are.</p>
          <div class="form-field"><label for="reopen-hours">For how long?</label>
          <select id="reopen-hours"><option value="12">12 hours</option><option value="24" selected>24 hours</option><option value="48">48 hours</option><option value="72">72 hours</option></select></div>`,
        actions: [
          { label: 'Cancel', value: 'cancel', variant: 'ghost' },
          { label: 'Reopen claiming', value: 'ok', variant: 'primary' },
        ],
        collect: (panel) => ({ hours: Number(panel.querySelector('#reopen-hours').value) }),
      });
      if (result.action !== 'ok') return;
      try {
        await apiRequest(`/admin/items/${current.item.id}/reopen-claims`, { method: 'POST', auth: true, body: { hours: result.data.hours } });
        toast('Claiming reopened.');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  box.querySelectorAll('.review-card').forEach((card) => {
    const id = card.dataset.claim;
    const officeField = card.querySelector('[data-office-notes]');
    const adminField = card.querySelector('[data-admin-notes]');

    const send = async (body, doneMessage) => {
      try {
        await apiRequest(`/claims/${id}`, { method: 'PUT', auth: true, body });
        toast(doneMessage);
        await reload();
      } catch (err) {
        const detail = err.fields && Object.values(err.fields)[0];
        toast(detail || err.message, 'error');
      }
    };

    const scheduleBtn = card.querySelector('[data-schedule]');
    if (scheduleBtn) {
      scheduleBtn.addEventListener('click', async () => {
        const claim = (box._claims || []).find((x) => x.id === id);
        const body = claim && (await openScheduleDialog(claim));
        if (body) await send(body, body.dismissAppointmentRequest ? 'Request declined.' : 'Appointment saved.');
      });
    }

    card.querySelector('[data-save-notes]').addEventListener('click', () =>
      send({ officeNotes: officeField.value.trim(), adminNotes: adminField.value.trim() }, 'Notes saved.')
    );

    card.querySelectorAll('[data-decide]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const status = btn.dataset.decide;
        const body = { status };
        if (officeField.value.trim()) body.officeNotes = officeField.value.trim();
        if (adminField.value.trim()) body.adminNotes = adminField.value.trim();

        if (status === 'rejected') {
          if (!officeField.value.trim()) {
            toast('Please write the reason for rejecting this claim.', 'error');
            officeField.focus();
            return;
          }
          const yes = await confirmDialog({ title: 'Reject this claim?', message: 'The claimant will see the rejection and your reason.', confirmText: 'Reject claim', danger: true });
          if (!yes) return;
        } else if (status === 'info_required') {
          const question = await askForText({
            title: 'Request more information',
            label: 'What should the claimant tell you?',
            hint: 'Ask about something only the real owner would know. Do not reveal the finder’s private detail.',
            confirmText: 'Send request',
          });
          if (!question) return;
          body.infoRequest = question;
        } else if (status === 'approved') {
          const others = box.querySelectorAll('.review-card:not([data-claim="' + id + '"])');
          const yes = await confirmDialog({
            title: 'Approve this claimant?',
            message: `Only one claimant can be approved. ${others.length ? 'The other claimants who are still waiting will be notified that their claims were not approved. ' : ''}The report will be marked "Claim approved" until the item is handed over.`,
            confirmText: 'Approve claimant',
          });
          if (!yes) return;
        } else if (status === 'completed') {
          const yes = await confirmDialog({ title: 'Mark as handed over?', message: 'This records that the item was released to this claimant and resolves the report.', confirmText: 'Mark handed over' });
          if (!yes) return;
        }
        setLoading(btn, true, 'Saving…');
        await send(body, 'Claim updated.');
        setLoading(btn, false);
      })
    );
  });
}

function adminPanelHtml(item) {
  const statuses = [...new Set(['pending_verification', item.type, 'awaiting_review', 'under_verification', 'no_valid_claim', 'returned', 'closed', item.status])];
  return `
    <section class="panel panel-admin" aria-labelledby="admin-title">
      <div class="panel-head"><h2 id="admin-title">Office controls</h2><span class="badge badge-pending">${icon('shield', 13)}<span>Admin</span></span></div>
      <p class="muted">Reporter: ${escapeHtml(item.reportedByName)}. Changes here are recorded for everyone.</p>
      <div class="inline-actions">
        ${item.status === 'pending_verification' ? `<button type="button" class="btn btn-gold btn-sm" id="verify-report">${icon('shield', 15)} Verify report</button>` : ''}
        <button type="button" class="btn btn-outline btn-sm" id="edit-report">${icon('edit', 15)} Edit details</button>
        <button type="button" class="btn btn-danger-outline btn-sm" id="delete-report">${icon('trash', 15)} Delete report</button>
      </div>
      <div class="form-field">
        <label for="status-select">Change status</label>
        <div class="inline-actions">
          <select id="status-select">${statuses.map((s) => `<option value="${s}" ${item.status === s ? 'selected' : ''}>${escapeHtml(statusLabel(s))}</option>`).join('')}</select>
          <button type="button" class="btn btn-primary btn-sm" id="save-status">Update status</button>
        </div>
        <small class="field-hint">“Claim approved” is set by approving a claim below.</small>
      </div>
      <h2 class="review-title">Claim review</h2>
      <div id="item-claims"><p class="muted">Loading claims…</p></div>
    </section>`;
}

/* ---------- Edit dialog (reporter or admin) ---------- */
async function openEditDialog(item) {
  const meta = await loadMeta();
  const cats = (meta.categories || FALLBACK_CATEGORIES)
    .map((c) => `<option value="${escapeHtml(c)}" ${c === item.category ? 'selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');

  const body = `
    <form id="edit-form" novalidate>
      <div class="form-msg" id="edit-msg"></div>
      <div class="form-field"><label for="e-title">Item name</label><input id="e-title" name="title" maxlength="100" value="${escapeHtml(item.title)}" required></div>
      <div class="form-field"><label for="e-category">Category</label><select id="e-category" name="category">${cats}</select></div>
      <div class="form-field"><label for="e-description">Description</label><textarea id="e-description" name="description" rows="4" maxlength="1000" required>${escapeHtml(item.description)}</textarea></div>
      <div class="form-field"><label for="e-location">Location</label><input id="e-location" name="location" maxlength="150" value="${escapeHtml(item.location)}" required></div>
      <div class="form-row">
        <div class="form-field"><label for="e-date">Date</label><input type="date" id="e-date" name="date" max="${todayLocal()}" value="${escapeHtml(item.date)}" required></div>
        <div class="form-field"><label for="e-time">Time <span class="optional">(optional)</span></label><input type="time" id="e-time" name="time" value="${escapeHtml(item.time || '')}"></div>
      </div>
      <div class="form-field"><label for="e-additionalDetails">Additional details <span class="optional">(optional)</span></label><textarea id="e-additionalDetails" name="additionalDetails" rows="2" maxlength="500">${escapeHtml(item.additionalDetails || '')}</textarea></div>
      <div class="form-field"><label for="e-contactInfo">Contact info <span class="optional">(optional)</span></label><input id="e-contactInfo" name="contactInfo" maxlength="120" value="${escapeHtml(item.contactInfo || '')}"></div>
      ${
        item.type === 'found'
          ? `<div class="form-field"><label for="e-verificationHint">Private verification detail <span class="optional">(optional)</span></label><textarea id="e-verificationHint" name="verificationHint" rows="2" maxlength="500">${escapeHtml(item.verificationHint || '')}</textarea><small class="field-hint">Something only the real owner would know. Only you and the office can see it.</small></div>`
          : ''
      }
      <div class="modal-actions inline">
        <button type="button" class="btn btn-ghost" data-edit-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary" id="edit-save">Save changes</button>
      </div>
    </form>`;

  const result = await openDialog({
    title: 'Edit report',
    size: 'lg',
    bodyHtml: body,
    focus: '#e-title',
    onOpen(panel, finish) {
      const form = panel.querySelector('#edit-form');
      panel.querySelector('[data-edit-cancel]').addEventListener('click', () => finish({ action: null, data: {} }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFieldErrors(form);
        const msg = panel.querySelector('#edit-msg');
        setFormMessage(msg, '');
        const payload = Object.fromEntries(new FormData(form).entries());
        const btn = panel.querySelector('#edit-save');
        setLoading(btn, true, 'Saving…');
        try {
          const data = await apiRequest(`/items/${item.id}`, { method: 'PUT', auth: true, body: payload });
          finish({ action: 'saved', data: { item: data.item } });
        } catch (err) {
          setLoading(btn, false);
          const orphan = showFieldErrors(form, err.fields);
          setFormMessage(msg, orphan[0] || err.message, 'error');
        }
      });
    },
  });
  return result.action === 'saved';
}

function wireManagePanels(item, isAdmin) {
  const byId = (id) => document.getElementById(id);

  const edit = byId('edit-report');
  if (edit) {
    edit.addEventListener('click', async () => {
      if (await openEditDialog(item)) {
        toast('Report updated.');
        await reload();
      }
    });
  }

  const close = byId('close-report');
  if (close) {
    close.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: 'Close this report?',
        message: 'Use this when the item is sorted out or you no longer need the report. It will leave the public feed.',
        confirmText: 'Close report',
      });
      if (!yes) return;
      try {
        await apiRequest(`/items/${item.id}`, { method: 'PUT', auth: true, body: { status: 'closed' } });
        toast('Report closed.', 'info');
        await reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  const del = byId('delete-report');
  if (del) {
    del.addEventListener('click', async () => {
      const yes = await confirmDialog({
        title: 'Delete this report?',
        message: 'This permanently removes the report, its photo and any claims on it. This cannot be undone.',
        confirmText: 'Delete report',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiRequest(`/items/${item.id}`, { method: 'DELETE', auth: true });
        flash('The report was deleted.', 'success');
        window.location.href = isAdmin ? 'admin.html#reports' : 'dashboard.html';
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  const verify = byId('verify-report');
  if (verify) {
    verify.addEventListener('click', async () => {
      setLoading(verify, true, 'Verifying…');
      try {
        await apiRequest(`/admin/items/${item.id}/verify`, { method: 'POST', auth: true });
        toast('Report verified.');
        await reload();
      } catch (err) {
        setLoading(verify, false);
        toast(err.message, 'error');
      }
    });
  }

  const save = byId('save-status');
  if (save) {
    save.addEventListener('click', async () => {
      const status = byId('status-select').value;
      if (status === item.status) {
        toast('That is already the current status.', 'info');
        return;
      }
      if (['closed', 'returned'].includes(status)) {
        const yes = await confirmDialog({
          title: `Mark as ${statusLabel(status)}?`,
          message: status === 'returned' ? 'Approved claims will be marked completed and other open claims rejected.' : 'Open claims on this report will be rejected.',
          confirmText: `Mark ${statusLabel(status)}`,
        });
        if (!yes) return;
      }
      setLoading(save, true, 'Saving…');
      try {
        await apiRequest(`/admin/items/${item.id}/status`, { method: 'PUT', auth: true, body: { status } });
        toast('Status updated.');
        await reload();
      } catch (err) {
        setLoading(save, false);
        toast(err.message, 'error');
      }
    });
  }
}

/* ------------------------------------------------------------
   Render
   ------------------------------------------------------------ */
function renderActionZone() {
  const zone = document.getElementById('action-zone');
  const { item, myClaim, canClaim } = current;
  const user = getCurrentUser();
  const isAdmin = !!user && user.role === 'admin';

  let html;
  if (isAdmin) html = adminPanelHtml(item);
  else if (item.isOwner) html = ownerPanelHtml(item);
  else if (myClaim && myClaim.status !== 'cancelled') html = myClaimHtml(myClaim);
  else if (!user) {
    const isFound = item.type === 'found';
    html = `
      <section class="panel">
        <h2>${isFound ? 'Is this item yours?' : 'Did you find this item?'}</h2>
        <p class="muted">Log in with your BPSU account to ${isFound ? 'submit a claim' : 'let the office know'}.</p>
        <div class="inline-actions"><a class="btn btn-primary" href="login.html?next=${encodeURIComponent(itemUrl(item.id))}">Log in to continue</a>
        <a class="btn btn-outline" href="register.html">Create an account</a></div>
      </section>`;
  } else if (canClaim) html = claimPanelHtml(item);
  else {
    const ended = item.claimDeadline && !item.claimsOpen;
    const why = ended
      ? 'The 24-hour claiming period for this item has ended. The office is reviewing the claims it received.'
      : `This item can no longer be claimed because it is ${statusLabel(item.status).toLowerCase()}.`;
    html = `<section class="panel"><div class="note note-muted">${icon('info', 18)}<span>${escapeHtml(why)}</span></div></section>`;
  }

  zone.innerHTML = html;
  if (isAdmin) {
    wireManagePanels(item, true);
    loadAdminReview();
  } else if (item.isOwner) {
    wireManagePanels(item, false);
    loadClaimsInto('item-claims');
  } else if (myClaim && myClaim.status !== 'cancelled') {
    wireMyClaim(myClaim);
  } else if (canClaim) {
    wireClaimPanel(item);
  }
}

function renderItem() {
  const { item } = current;
  document.title = `${item.title} — ReQuora`;
  root().setAttribute('aria-busy', 'false');
  root().innerHTML = `
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="index.html">Home</a>${icon('chevronRight', 14)}<a href="browse.html">Browse</a>${icon('chevronRight', 14)}<span aria-current="page">${escapeHtml(item.title)}</span>
    </nav>
    <div class="detail-grid">
      ${mediaHtml(item)}
      <div class="detail-info card">${infoHtml(item)}</div>
    </div>
    <div class="detail-actions" id="action-zone"></div>`;
  renderActionZone();
  startCountdowns(reload); // when the 24 hours run out, show the page as the server now sees it
}

async function reload() {
  const id = current && current.item ? current.item.id : null;
  if (!id) return;
  const data = await apiRequest(`/items/${encodeURIComponent(id)}`, { auth: !!getToken() });
  current = data;
  renderItem();
}

document.addEventListener('DOMContentLoaded', async () => {
  initLayout();

  const params = new URLSearchParams(window.location.search);
  let id = params.get('id');

  // Fallback for servers that redirect item.html?id=x to /item and drop the query.
  if (!id) {
    try {
      id = sessionStorage.getItem('requora_last_item_id');
    } catch (e) {
      id = null;
    }
    if (id) window.history.replaceState(null, '', `${window.location.pathname}?id=${encodeURIComponent(id)}`);
  }

  const container = root();
  if (!id) {
    container.setAttribute('aria-busy', 'false');
    container.innerHTML = stateBlock({
      iconName: 'search',
      title: 'No item selected',
      text: 'Open a report from the browse page to see its details.',
      actionHtml: '<a class="btn btn-primary btn-sm" href="browse.html">Browse reports</a>',
    });
    return;
  }

  try {
    current = await apiRequest(`/items/${encodeURIComponent(id)}`, { auth: !!getToken() });
    renderItem();
  } catch (err) {
    container.setAttribute('aria-busy', 'false');
    container.innerHTML = errorState(err, { retryId: 'retry-item' });
    const retry = document.getElementById('retry-item');
    if (retry) retry.addEventListener('click', () => window.location.reload());
  }
});
