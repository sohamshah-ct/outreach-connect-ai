// The email you get when a business owner writes back and a reply is ready:
// their message, the reply (with open times from your calendar), and two buttons:
// "Send it" (opens your desk on this reply, where one tap sends the draft from
// your Gmail) and "Change it first" (opens the Gmail draft). Without a desk link
// or the business's id, "Approve and send" instead opens a filled-in email to
// yourself that the reply watch picks up and sends.
// Your addresses come from the settings: sender_email (the approve link) and
// notify_emails (who it's sent to).
//
//   node scripts/reply-notice.js <prospect JSON> <their message text file> <draft id> <draft url> [code] [settings JSON]
//     → { to, subject, body, htmlBody, code }
//   (pass "" for code to let it pick one and still give a settings file)

const fs = require('fs');
const crypto = require('crypto');
const { shortName } = require('../lib/outreach/crmnotes');
const { profileOf, loadSettings } = require('../lib/outreach/settings');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "Approve reply to Rene Burce [A7K2Q9]": the code ties the approval to this
// one draft, so an old or stray email can't send the wrong thing.
function approvalSubject(p, code) {
  return `Approve reply to ${p.contact_name || shortName(p.name)} [${code}]`;
}
const CODE = /\[([A-Z0-9]{6})\]/;

function replyNotice(p, theirText, { draftId, draftUrl, id = p.id, code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(), settings = {} } = {}) {
  const prof = profileOf(settings);
  const self = prof.sender_email || prof.notify_emails[0] || '';
  const who = p.contact_name ? `${p.contact_name} at ${shortName(p.name)}` : shortName(p.name);
  const subject = `${who} wants to talk. Your reply is ready`;
  const approve = `mailto:${self}?subject=${encodeURIComponent(approvalSubject(p, code))}&body=${encodeURIComponent('Send it.')}`;
  // The desk opens straight to this reply when its link ends in #send-<id>.
  const deskSend = prof.desk_url && id ? `${String(prof.desk_url).replace(/#.*$/, '')}#send-${id}` : null;
  const said = String(theirText || '').trim();
  const body = [
    `${who} (${p.email}) wrote back:`,
    `"${said}"`,
    "Here's the reply I wrote, with times you're free:",
    p.reply_draft,
    deskSend ? `To send it, open your desk on this reply and tap Send it: ${deskSend}` : `To approve, reply to this email with "send" (or send yourself an email with the subject "${approvalSubject(p, code)}"). It goes out at the next check, within the hour.`,
    `To change it first, open the draft in Gmail: ${draftUrl}`,
  ].join('\n\n');
  const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
<p>${esc(who)} (${esc(p.email)}) wrote back:</p>
<blockquote style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #ccc;color:#333">${esc(said).replace(/\n/g, '<br>')}</blockquote>
<p>Here's the reply I wrote, with times you're free:</p>
<div style="margin:0 0 16px;padding:12px;border:1px solid #ddd;border-radius:8px">${esc(p.reply_draft).replace(/\n/g, '<br>')}</div>
<p><a href="${esc(deskSend || approve)}" style="display:inline-block;padding:10px 18px;background:#1a7f37;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">${deskSend ? 'Send it' : 'Approve and send'}</a>
&nbsp; <a href="${esc(draftUrl)}" style="display:inline-block;padding:10px 18px;border:1px solid #999;color:#333;text-decoration:none;border-radius:6px">Change it first</a></p>
<p style="color:#666;font-size:12px">${deskSend ? '"Send it" opens your desk on this reply; tap Send it there and it goes from your Gmail right away. Nothing goes out until you do.' : '"Approve and send" opens a short email to yourself; hit send and the reply goes out at the next check, within the hour. Replying "send" to this email works too.'}</p>
</div>`;
  return { to: prof.notify_emails, subject, body, htmlBody, code, draft_id: draftId };
}

if (require.main === module) {
  const [doc, msgFile, draftId, draftUrl, code, settingsFile] = process.argv.slice(2);
  const j = JSON.parse(fs.readFileSync(doc, 'utf8'));
  const p = j.data || j;
  process.stdout.write(JSON.stringify(replyNotice(p, fs.readFileSync(msgFile, 'utf8'), { draftId, draftUrl, id: j.id || p.id, settings: loadSettings(settingsFile), ...(code ? { code } : {}) })));
}
module.exports = { replyNotice, approvalSubject, CODE };
