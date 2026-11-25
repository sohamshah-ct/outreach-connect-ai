// The 9:13pm "Outreach replies today" email, as a clean HTML email (plus a plain-text copy).
// One card per person: who they are, what they said, the drafted reply. Then a short
// "No thanks" list, what went cold, and how to answer. Email-safe: tables and inline
// styles only, no links, no images, readable in Outlook's dark mode.
//
//   node scripts/digest-email.js <items.json>   → { subject, body, htmlBody }
//
// items.json:
//   { "date": "2026-11-24",
//     "replies":    [{ "n": 1, "name": "Abram Moser", "business": "Moser Property Care", "town": "Ellington",
//                      "phone": "", "said": "…", "reply": "Hi Abram,\n\n…", "note": "", "first": false }],
//     "no_thanks":  [{ "name": "…", "business": "…", "said": "…", "note": "" }],
//     "tossed":     ["Business (no call since Nov 3)"],
//     "kept":       ["Business: why"],
//     "first_note": "" }

const fs = require('fs');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const br = s => esc(s).replace(/\r?\n/g, '<br>');

const C = { ink: '#14213D', muted: '#5D6E89', line: '#D9E1EC', wash: '#F3F6FA', accent: '#1D5FC4', quote: '#8EA2C2', ok: '#17794A', warn: '#8A6206' };
const FONT = "font-family:'Segoe UI',Helvetica,Arial,sans-serif;";

function dayLabel(iso) {
  const d = iso ? new Date(iso + 'T12:00:00') : new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function card(r) {
  const meta = [r.business, r.town, r.phone].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  return `
  <tr><td style="padding:0 0 16px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px;border-collapse:separate;">
      <tr><td style="padding:16px 18px 6px 18px;${FONT}">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:top;padding-right:12px;"><div style="width:28px;height:28px;line-height:28px;border-radius:14px;background:${C.accent};color:#ffffff;text-align:center;font-weight:700;font-size:14px;${FONT}">${esc(r.n)}</div></td>
          <td style="vertical-align:top;${FONT}">
            <div style="font-size:17px;font-weight:700;color:${C.ink};">${esc(r.name)}</div>
            <div style="font-size:13px;color:${C.muted};padding-top:2px;">${meta}</div>
          </td></tr></table>
      </td></tr>
      ${r.first ? `<tr><td style="padding:4px 18px 0 18px;${FONT}font-size:12px;font-weight:700;color:${C.ok};text-transform:uppercase;letter-spacing:.06em;">${esc(r.first)}</td></tr>` : ''}
      <tr><td style="padding:10px 18px 0 18px;${FONT}">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};padding-bottom:6px;">They said</div>
        <div style="border-left:3px solid ${C.quote};padding:2px 0 2px 12px;font-size:15px;line-height:1.5;color:${C.ink};font-style:italic;">${br(r.said)}</div>
      </td></tr>
      <tr><td style="padding:14px 18px 0 18px;${FONT}">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};padding-bottom:6px;">Your reply</div>
        <div style="background:${C.wash};border-radius:8px;padding:12px 14px;font-size:14.5px;line-height:1.55;color:${C.ink};">${br(r.reply)}</div>
      </td></tr>
      ${r.note ? `<tr><td style="padding:10px 18px 0 18px;${FONT}font-size:13px;line-height:1.45;color:${C.warn};">${br(r.note)}</td></tr>` : ''}
      <tr><td style="padding:14px 18px 16px 18px;${FONT}font-size:13px;color:${C.muted};">Reply <b style="color:${C.ink};">send ${esc(r.n)}</b> &nbsp;or&nbsp; <b style="color:${C.ink};">change ${esc(r.n)}: …</b> &nbsp;or&nbsp; <b style="color:${C.ink};">skip ${esc(r.n)}</b></td></tr>
    </table>
  </td></tr>`;
}

function section(title, rowsHtml) {
  return `
  <tr><td style="padding:8px 0 8px 0;${FONT}font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};">${esc(title)}</td></tr>
  <tr><td style="padding:0 0 18px 0;">${rowsHtml}</td></tr>`;
}

function build(d) {
  const replies = d.replies || [], no = d.no_thanks || [], tossed = d.tossed || [], kept = d.kept || [];
  const n = replies.length + no.length;
  const subject = `Outreach replies today (${n})`;
  const counts = [replies.length ? `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'} to send` : '', no.length ? `${no.length} no thanks` : ''].filter(Boolean).join(' · ') || 'Nothing new';

  const noRows = no.map(x => `<div style="${FONT}font-size:14px;line-height:1.5;color:${C.ink};padding:0 0 8px 0;"><b>${esc(x.name)}</b>, ${esc(x.business)}<br><span style="color:${C.muted};font-style:italic;">“${esc(x.said)}”</span>${x.note ? `<br><span style="color:${C.muted};font-size:13px;">${esc(x.note)}</span>` : ''}</div>`).join('');
  const coldRows = [
    tossed.length ? `<div style="${FONT}font-size:14px;color:${C.ink};padding-bottom:6px;">Taken off the desk (no call set in 2+ weeks): ${tossed.map(esc).join(', ')}</div>` : '',
    ...kept.map(k => `<div style="${FONT}font-size:14px;color:${C.ink};padding-bottom:6px;">Kept: ${esc(k)}</div>`),
  ].join('');

  const htmlBody = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;">
  <tr><td style="padding:0 0 4px 0;${FONT}font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};">${esc(dayLabel(d.date))}</td></tr>
  <tr><td style="padding:0 0 4px 0;${FONT}font-size:24px;font-weight:700;color:${C.ink};">Outreach replies</td></tr>
  <tr><td style="padding:0 0 20px 0;${FONT}font-size:15px;color:${C.muted};">${esc(counts)}</td></tr>
  ${d.first_note ? `<tr><td style="padding:0 0 16px 0;${FONT}font-size:14px;line-height:1.5;color:${C.ink};background:${C.wash};border-radius:8px;"><div style="padding:12px 14px;">${br(d.first_note)}</div></td></tr>` : ''}
  ${replies.map(card).join('')}
  ${no.length ? section('No thanks', noRows) : ''}
  ${tossed.length || kept.length ? section('Gone cold', coldRows) : ''}
  <tr><td style="padding:6px 0 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.line};"><tr><td style="padding:14px 0 0 0;${FONT}font-size:13.5px;line-height:1.6;color:${C.muted};">
      <b style="color:${C.ink};">To answer, reply to this email with</b><br>
      <b style="color:${C.ink};">send all</b> &nbsp;·&nbsp; <b style="color:${C.ink};">send 1 3</b> &nbsp;·&nbsp; <b style="color:${C.ink};">change 2: what to change</b> &nbsp;·&nbsp; <b style="color:${C.ink};">skip 3</b><br>
      You can also edit and send any of them on your desk.
    </td></tr></table>
  </td></tr>
</table></td></tr></table></body></html>`;

  const t = [];
  t.push(`Outreach replies, ${dayLabel(d.date)}`, counts, '');
  if (d.first_note) t.push(d.first_note, '');
  for (const r of replies) {
    t.push(`${r.n}. ${r.name}, ${[r.business, r.town, r.phone].filter(Boolean).join(' · ')}`);
    t.push(`They said: "${r.said}"`, '', 'Your reply:', r.reply, '');
    if (r.note) t.push(r.note, '');
    t.push(`Reply "send ${r.n}", "change ${r.n}: ..." or "skip ${r.n}"`, '', '----------', '');
  }
  if (no.length) { t.push('No thanks'); for (const x of no) t.push(`- ${x.name}, ${x.business}: "${x.said}"${x.note ? ' ' + x.note : ''}`); t.push(''); }
  if (tossed.length) t.push(`Taken off the desk (no call set in 2+ weeks): ${tossed.join(', ')}`);
  for (const k of kept) t.push(`Kept: ${k}`);
  t.push('', 'To answer, reply with "send all", "send 1 3", "change 2: what to change" or "skip 3". You can also edit and send any of them on your desk.');
  return { subject, body: t.join('\n'), htmlBody };
}

module.exports = { build };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/digest-email.js <items.json>'); process.exit(1); }
  process.stdout.write(JSON.stringify(build(JSON.parse(fs.readFileSync(file, 'utf8')))));
}
