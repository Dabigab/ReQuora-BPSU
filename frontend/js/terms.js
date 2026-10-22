/* ============================================================
   ReQuora — Terms and Conditions and Rules and Regulations
   One copy of the text, used by the sign-up page, the terms page and
   the "please accept the updated terms" dialog.
   These are proposed platform rules written for the ReQuora capstone
   project. They are NOT an official BPSU policy and have not been
   legally approved; the university must review them before use.
   When the text changes in a way that matters, change TERMS_VERSION here
   AND TERMS_VERSION in backend/utils/constants.js (same value). Members
   are then asked to accept the new version the next time they log in.
   ============================================================ */

const TERMS_VERSION = '2026-10-v1';
const TERMS_UPDATED = 'October 2026';

const TERMS_SECTIONS = [
  {
    id: 'purpose',
    title: 'A. Purpose of ReQuora-BPSU',
    body: [
      'ReQuora-BPSU is a web system that helps the Bataan Peninsula State University (BPSU) community report found items and reconnect lost belongings with their rightful owners.',
      'It is a tool to organise reports and claims. The Lost and Found Office stays in charge of keeping items safe and handing them over.',
    ],
  },
  {
    id: 'reporting',
    title: 'B. Accurate Reporting',
    body: [
      'When you report an item, give accurate and honest information: what it is, where and when it was found or lost, and how to reach you if needed.',
      'False, misleading, duplicate or intentionally deceptive reports are not allowed.',
      'A person who reports a found item is the finder, not the owner. Reporting an item does not give you any right to keep it or to claim it.',
    ],
  },
  {
    id: 'claiming',
    title: 'C. Claiming Rules',
    body: [
      'You may submit a claim only if you reasonably believe the item belongs to you.',
      'You must give truthful information and cooperate with reasonable ownership checks, such as answering the office’s follow-up questions.',
      'Submitting a claim does not mean it is approved. Only an administrator can approve a claim.',
    ],
  },
  {
    id: 'multiple',
    title: 'D. Multiple Claimants',
    body: [
      'Several users may submit claims for the same report.',
      'For a found item, the system accepts claims for 24 hours, starting when the report is published. The period is counted by the server clock, not by your device. After it ends, ordinary new claims are no longer accepted unless an administrator reopens the report.',
      'Submitting a claim early does not give you priority. After the claiming period, the administrator compares the evidence of all claimants and decides which claimant, if any, has shown enough proof of ownership. Only one claimant can be approved for an item.',
    ],
  },
  {
    id: 'evidence',
    title: 'E. Evidence and Verification',
    body: [
      'Do not fabricate receipts, serial numbers, photographs, identifying details or any other proof of ownership.',
      'You do not need a receipt for every item. Detailed and accurate descriptions (marks, contents, accessories, personal details) can also show ownership.',
      'The administrator may ask you for more information. If you do not answer, your claim may be rejected.',
      'The finder may keep a private verification detail about the item. Claimants are expected to describe such details on their own; they are never shown on the public pages.',
    ],
  },
  {
    id: 'conduct',
    title: 'F. Prohibited Conduct',
    body: [
      'Fraudulent claims, impersonating another person, harassing other users or staff, unauthorised access to accounts or data, manipulating reports, falsifying evidence, and trying to get around the system’s restrictions (for example by sending hand-made requests) are prohibited.',
    ],
  },
  {
    id: 'privacy',
    title: 'G. Privacy and Personal Information',
    body: [
      'Give only the information needed to report an item or to prove ownership.',
      'Claim evidence, contact details and administrator notes are not shown publicly. Other claimants cannot see your evidence, and you cannot see theirs.',
      'Your account details, reports and claims are used to run the system, to verify ownership and to let administrators manage the Lost and Found service. Your password is stored in a protected (hashed) form.',
    ],
  },
  {
    id: 'admin',
    title: 'H. Admin Authority',
    body: [
      'Authorised administrators review reports, compare ownership evidence, resolve conflicting claims, reject unsupported claims and protect the integrity of the platform.',
      'Each decision is recorded with the administrator’s name, the date and time, and the reason.',
    ],
  },
  {
    id: 'account',
    title: 'I. Account Responsibility',
    body: [
      'You are responsible for keeping your password safe and for everything done through your account. Tell the office if you think someone else is using it.',
    ],
  },
  {
    id: 'violations',
    title: 'J. Violations and Consequences',
    body: [
      'Breaking these rules may lead to a rejected claim, removal of a report, restrictions on your account, or referral to the appropriate university office when the university’s own rules justify it.',
    ],
  },
  {
    id: 'updates',
    title: 'K. Agreement and Updates',
    body: [
      'When you create an account, ReQuora records that you accepted these terms, the date and time, and the version you accepted.',
      'If the terms change in an important way, a new version number is published and you will be asked to read and accept it again the next time you log in.',
    ],
  },
];

// The full text as HTML (all values are fixed strings above, so no user input is involved).
function termsContentHtml() {
  const sections = TERMS_SECTIONS.map(
    (s) =>
      `<section class="terms-section" aria-labelledby="terms-${s.id}"><h3 id="terms-${s.id}">${s.title}</h3>${s.body.map((p) => `<p>${p}</p>`).join('')}</section>`
  ).join('');
  return `
    <div class="terms-notice" role="note">
      <strong>Proposed platform rules.</strong> These Terms and Conditions and Rules and Regulations were prepared for the ReQuora-BPSU project.
      They are not an official BPSU policy and have not been legally approved. They need review by the university before official use.
    </div>
    <p class="terms-meta">Version ${TERMS_VERSION} · Updated ${TERMS_UPDATED}</p>
    ${sections}`;
}
