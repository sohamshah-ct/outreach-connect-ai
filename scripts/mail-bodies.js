// The plain and HTML versions of an email, exactly as the desk sends them
// (clean "LinkedIn" link, clickable school address, both from the settings
// and both optional). Used by the morning send job so emails look the same
// whichever way they go out.
//
//   node scripts/mail-bodies.js <prospect JSON file> [settings JSON file]   → prints {body, htmlBody}

const fs = require('fs');
const { profileOf, loadSettings } = require('../lib/outreach/settings');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mailBodies(body, settings = {}) {
  const prof = profileOf(settings);
  // A draft written before offer_visit existed may still offer to stop by in person.
  if (!prof.offer_visit) body = String(body).replace('Happy to call, do Zoom, or come by.', 'Happy to call or do Zoom.').replace('Phone, Zoom, or I can stop by, whatever works.', 'Phone or Zoom, whatever works.');
  // "linkedin.com/in/maya-lin", with or without https:// and www.
  const path = prof.linkedin_short.replace(/^linkedin\.com/i, '');
  const linkedin = /^\/in\/[^/]+/i.test(path) ? new RegExp(`(?:https?:\\/\\/)?(?:www\\.)?linkedin\\.com${reEsc(path)}\\/?`, 'gi') : null;
  const email = prof.school_email ? esc(prof.school_email) : '';
  let html = esc(body);
  if (linkedin) html = html.replace(linkedin, `<a href="https://www.linkedin.com${esc(path)}">LinkedIn</a>`);
  if (email) html = html.replace(new RegExp(reEsc(email), 'gi'), m => `<a href="mailto:${m}">${m}</a>`);
  html = html.replace(/\n/g, '<br>');
  // The plain-text copy keeps the short "linkedin.com/in/..." form: a full
  // https:// address there gets shown as a long redirect link, which looks like spam.
  return { body: linkedin ? body.replace(linkedin, `linkedin.com${path}`) : body, htmlBody: `<div>${html}</div>` };
}

if (require.main === module) {
  const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const doc = raw.data || raw;
  process.stdout.write(JSON.stringify(mailBodies(doc.body || '', loadSettings(process.argv[3]))));
}
module.exports = { mailBodies };
