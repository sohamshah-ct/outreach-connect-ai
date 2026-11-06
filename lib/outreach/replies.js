// Spotting replies to the emails the desk sent, the same way the desk does
// (artifact/outreach-desk.html, handleReplies): a message from the business's
// address counts as a reply unless it's an auto-responder. Used by the
// reply check that runs without the desk open (scripts/outreach-replies.js).

const { profileOf } = require('./settings');

// Where "someone wrote back" emails go: settings.notify_emails, or the
// student's school and Gmail addresses when that's empty.
const notifyTo = settings => profileOf(settings).notify_emails;

// Out of office, "Thank you for contacting RAB!" and the like. A thank-you line
// only counts when the subject was replaced: people replying keep "Re: ...".
const AUTO_STRONG = /(auto(matic|mated)?[- ]?(reply|response)|out of (the )?office|this is an automated|do not reply to this|away from (my|the) (desk|office|email) until)/i;
const AUTO_SUBJECT = /(thank(s| you) for (contacting|reaching out|your (e-?mail|message|inquiry|note))|we('ve| have) received your (e-?mail|message|inquiry))/i;
const isAutoReply = m => AUTO_STRONG.test(`${m.subject || ''} ${m.snippet || ''}`) || (!/^\s*re:/i.test(m.subject || '') && AUTO_SUBJECT.test(m.subject || ''));
const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|not interested|no thanks|no thank you|please don'?t (email|contact)|do not (email|contact)|we('| a)re all set|we'?ll pass|not at this time|not (a )?good time|(now|this) is(n'?t| not) (a )?good time|not right now)\b/i;

const { crmNotesNow } = require('./crmnotes');
const unentity = t => String(t || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const fromThem = (p, m) => !!p.email && String(m.sender || '').toLowerCase().includes(p.email.toLowerCase());
const WATCHED = ['sent', 'followed_up', 'replied'];

function shortName(n) {
  return String(n || '').replace(/,?\s*\b(l\.?\s?l\.?\s?c|inc|incorporated|corp|corporation|co|company|ltd|p\.?\s?c|p\.?\s?l\.?\s?l\.?\s?c)\b\.?\s*$/i, '').replace(/[,\s]+$/, '').trim();
}

// The email you get when someone writes back.
function notifyEmail(p, { snippet, threadId, noThanks }, settings = {}) {
  const deskUrl = String(profileOf(settings).desk_url || '').trim();
  const biz = shortName(p.name);
  const who = p.contact_name ? `${p.contact_name} at ${biz}` : biz;
  const subject = noThanks ? `${biz} said no thanks` : `${who} replied to your email`;
  const body = [
    noThanks ? `${who} (${p.email}) wrote back and isn't interested:` : `${who} (${p.email}) wrote back:`,
    `"${snippet}"`,
    threadId ? `Read the whole email: https://mail.google.com/mail/u/0/#all/${threadId}` : null,
    noThanks ? `The desk has moved them to "Not interested".` : `Open the desk to read it and get a reply drafted${deskUrl ? `: ${deskUrl}` : '.'}`,
  ].filter(Boolean).join('\n\n');
  // Same look as the reply-ready email: their words in a quote, plain buttons, no raw links.
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])).replace(/\n/g, '<br>');
  const gmailUrl = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;
  const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
<p>${esc(noThanks ? `${who} (${p.email}) wrote back and isn't interested:` : `${who} (${p.email}) wrote back:`)}</p>
<blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #ccc;color:#333">${esc(snippet)}</blockquote>
<p>${esc(noThanks ? 'The desk has moved them to "Not now". Nothing else to do.' : "Open the desk's Replies tab to answer them.")}</p>
<p>${gmailUrl ? `<a href="${gmailUrl}" style="display:inline-block;padding:10px 18px;border:1px solid #999;color:#333;text-decoration:none;border-radius:6px">Read it in Gmail</a> &nbsp; ` : ''}${noThanks || !deskUrl ? '' : `<a href="${esc(deskUrl)}" style="display:inline-block;padding:10px 18px;background:#1a7f37;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">Open the desk</a>`}</p>
</div>`;
  return { to: notifyTo(settings), subject, body, htmlBody };
}

// docs: prospects (with id). threads: Gmail search_threads results.
// Returns the desk updates to write and the notification emails to send.
function planReplies(docs, threads, now = new Date().toISOString(), settings = {}) {
  const updates = [];
  const notify = [];
  const touched = new Set();
  const own = new Set([...notifyTo(settings), settings.sender_email, settings.school_email].filter(Boolean).map(x => String(x).toLowerCase()));
  for (const t of threads) {
    const msgs = t.messages || [];
    // Owners often answer from a different address than the one emailed
    // (don@shop.com instead of shop@gmail.com), so a message from anyone
    // but the student in the same Gmail thread counts too.
    const tid = t.id || t.threadId || (msgs[0] || {}).threadId;
    const sameThread = x => !!tid && (x.thread_id === tid || x.reply_thread_id === tid);
    const inbound = m => !(m.labelIds || []).includes('SENT') && !own.has(String(m.sender || '').toLowerCase());
    const p = docs.find(x => WATCHED.includes(x.status) && x.email && msgs.some(m => fromThem(x, m)))
      || docs.find(x => WATCHED.includes(x.status) && sameThread(x) && msgs.some(inbound));
    if (!p || touched.has(p.id)) continue;
    const theirs = msgs.filter(m => fromThem(p, m) || (sameThread(p) && inbound(m)));
    const keys = theirs.map(m => m.id || String(m.snippet || '').slice(0, 80));
    const seen = new Set(p.reply_msg_ids || []);
    if (p.status === 'replied' && !p.reply_msg_ids) continue; // the desk records these on its first look
    const fresh = theirs.filter((m, i) => !seen.has(keys[i]));
    if (!fresh.length) continue;
    touched.add(p.id);
    const people = fresh.filter(m => !isAutoReply(m));
    const log = what => [...(p.log || []), { at: now, what }].slice(-40);
    if (!people.length) {
      const auto = fresh[fresh.length - 1];
      updates.push({ id: p.id, data: { reply_msg_ids: keys, auto_reply_at: now, auto_reply_snippet: unentity(auto.snippet || auto.subject || '').slice(0, 300), updated_at: now,
        log: log(`Got an automatic reply from ${p.email} (not a person)`) } });
      continue;
    }
    const latest = people[people.length - 1];
    const snippet = unentity(latest.snippet || latest.subject || '').slice(0, 600);
    const noThanks = OPT_OUT.test(snippet);
    const again = p.status === 'replied';
    const who = p.contact_name || p.email;
    updates.push({ id: p.id, crm_org_id: p.crm_org_id || null, data: {
      status: noThanks ? 'not_interested' : 'replied', replied_at: now, reply_snippet: snippet, reply_thread_id: t.id, reply_msg_ids: keys,
      reply_notified_at: now, updated_at: now,
      log: log(noThanks ? `${who} said no thanks` : again ? `${who} wrote back again` : `${who} replied`),
    } });
    notify.push({ id: p.id, ...notifyEmail(p, { snippet, threadId: t.id, noThanks }, settings), crm: p.crm_org_id ? {
      org: p.crm_org_id, body: `${noThanks ? 'Replied (not interested)' : 'Replied'} from ${p.email}:\n\n${snippet}`,
      update: { ...(noThanks ? { stage: 'passed', next_step: null, next_step_due: null } : { next_step: `Reply to ${p.contact_name || shortName(p.name)}`, next_step_due: now.slice(0, 10) }),
        notes: crmNotesNow({ ...p, status: noThanks ? 'not_interested' : 'replied', replied_at: now }, settings) },
    } : null });
  }
  // Replies the desk caught while it was open but hasn't emailed you about.
  for (const p of docs) {
    if (touched.has(p.id) || !p.replied_at || !['replied', 'not_interested'].includes(p.status)) continue;
    if (p.reply_notified_at && String(p.reply_notified_at) >= String(p.replied_at)) continue;
    if (p.status === 'replied' && isAutoReply({ subject: p.reply_snippet, snippet: p.reply_snippet })) {
      // An older desk took an auto-responder for a reply: put it back to emailed.
      const D = { __delete__: true };
      updates.push({ id: p.id, data: { status: p.followup_body ? 'followed_up' : 'sent', replied_at: D, reply_snippet: D, reply_thread_id: D,
        auto_reply_at: p.auto_reply_at || p.replied_at, auto_reply_snippet: p.reply_snippet, updated_at: now,
        log: [...(p.log || []), { at: now, what: `That was an automatic reply from ${p.email}, not a person. Back to emailed.` }].slice(-40) } });
      continue;
    }
    notify.push({ id: p.id, ...notifyEmail(p, { snippet: p.reply_snippet || '', threadId: p.reply_thread_id, noThanks: p.status === 'not_interested' }, settings), crm: null });
    updates.push({ id: p.id, data: { reply_notified_at: now } });
  }
  return { updates, notify };
}

module.exports = { planReplies, notifyEmail, notifyTo, isAutoReply, OPT_OUT };
