// Follow-ups that go out on their own: one short "just bumping this" in the
// same Gmail thread for anyone who hasn't written back within
// followup_after_days business days (default 4). Used by the weekday
// morning send, so you don't have to remember them. Your school address
// (settings.school_email) is cc'd when it's set.
//
//   node scripts/outreach-followups.js --docs <dir of prospect JSON files> --out <dir> [--days 4] [--max 20] [--settings <settings JSON file>]
//     → writes <out>/plan.json: [{ id, to, cc, subject, body, htmlBody, thread_id, reply_to_message_id, after_file, crm }]
//       and <out>/after/<id>.json, the desk update to write once the email is sent.

const fs = require('fs');
const path = require('path');
const { composeFollowup } = require('../lib/outreach/compose');
const { mergeSettings, loadSettings, profileOf } = require('../lib/outreach/settings');
const { businessDaysSince } = require('../lib/outreach/util');
const { mailBodies } = require('./mail-bodies');
const { crmNotesNow } = require('../lib/outreach/crmnotes');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// Who's due: emailed once, no reply from a person, an address to write to and
// a thread to reply in, and at least `days` business days since the first email.
function dueFollowups(docs, { days = 4, now = new Date() } = {}) {
  return docs.filter(p => p.status === 'sent' && p.email && p.thread_id && p.sent_at && !p.followup_at
    && businessDaysSince(p.sent_at, now) >= days)
    .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
}

function planFollowups(docs, { days = 4, max = 20, now = new Date(), settings = mergeSettings({}) } = {}) {
  const at = now.toISOString();
  // cc_email decides who's cc'd on outgoing mail ('' = nobody); unset falls back to the school address.
  const prof = profileOf(settings);
  const ccAddr = String(prof.cc_email ?? prof.school_email ?? '').trim();
  const cc = ccAddr ? [ccAddr] : [];
  return dueFollowups(docs, { days, now }).slice(0, max).map(p => {
    const { subject, body } = composeFollowup(p, settings, p.subject);
    const after = {
      status: 'followed_up', followup_at: at, followup_body: body, updated_at: at,
      log: [...(p.log || []), { at, what: `Followed up with ${p.email} (no reply after ${days} business days)` }].slice(-40),
    };
    return {
      // Send it as a reply to the first email (Gmail send_message replyToMessageId),
      // not just into the thread: that adds the In-Reply-To/References headers, so
      // Outlook and other mail apps group it with the original, and Gmail quotes
      // the original underneath. The first message's Gmail id is its thread id.
      id: p.id, to: [p.email], cc, subject, ...mailBodies(body, settings), thread_id: p.thread_id,
      reply_to_message_id: p.message_id || p.thread_id, after,
      crm: p.crm_org_id ? { org: p.crm_org_id, body: `Follow-up email sent to ${p.email}.\n\n${body}`,
        update: { next_step: 'No reply to the follow-up yet: try calling or stopping by', next_step_due: addDays(now, 7), notes: crmNotesNow({ ...p, ...after }, settings) } } : null,
    };
  });
}

function main() {
  const dir = arg('docs');
  const out = arg('out', 'out/followups');
  const docs = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: f.replace(/\.json$/, ''), ...(j.data || j) }; });
  const plan = planFollowups(docs, { days: Number(arg('days', 4)), max: Number(arg('max', 20)), settings: loadSettings(arg('settings')) });
  fs.mkdirSync(path.join(out, 'after'), { recursive: true });
  const list = plan.map(({ after, ...rest }) => {
    const file = path.resolve(out, 'after', `${rest.id}.json`);
    fs.writeFileSync(file, JSON.stringify(after));
    return { ...rest, after_file: file };
  });
  fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(list, null, 2));
  console.log(`${list.length} follow-up(s) due. Wrote ${path.join(out, 'plan.json')}`);
}

if (require.main === module) main();
module.exports = { dueFollowups, planFollowups };
