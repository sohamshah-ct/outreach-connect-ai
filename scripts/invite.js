#!/usr/bin/env node
// Builds a calendar invite (.ics) that Outlook shows with Accept / Decline.
//
//   node scripts/invite.js --uid wet-pets-call --start 2026-11-12T15:15 --mins 30 \
//     --title "Call with Donald Allen (Wet Pets)" --notes "..." [--proposed] [--cancel] [--seq 1]
//
// --start is New York time. Prints JSON: {filename, mimeType, content (base64), summary}.
// Send it with Gmail send_message as an attachment to Soham's Outlook address.
// Reuse the same --uid (and a higher --seq) to move or cancel the same event.

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2), v = args[i + 1];
  if (v === undefined || v.startsWith('--')) opt[k] = true; else { opt[k] = v; i++; }
}
if (!opt.uid || !opt.start || !opt.title) {
  console.error('Need --uid, --start (YYYY-MM-DDTHH:MM, New York time) and --title');
  process.exit(1);
}

const ORGANIZER = opt.from || 'shahsoham689@gmail.com';
const ATTENDEE = opt.to || 'soham.shah@uconn.edu';

// New York local time -> UTC, without a timezone library.
function nyToUtc(local) {
  const [d, t] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = (t || '00:00').split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, da, h, mi);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const shown = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute);
    guess += Date.UTC(y, mo - 1, da, h, mi) - shown;
  }
  return new Date(guess);
}
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = [];
  let s = line;
  while (Buffer.byteLength(s) > 74) {
    let n = 74;
    while (Buffer.byteLength(s.slice(0, n)) > 74) n--;
    out.push(s.slice(0, n));
    s = ' ' + s.slice(n);
  }
  out.push(s);
  return out.join('\r\n');
}

const start = nyToUtc(opt.start);
const end = new Date(start.getTime() + (Number(opt.mins) || 30) * 60000);
const cancel = !!opt.cancel;
const proposed = !!opt.proposed;
const title = (cancel ? 'Canceled: ' : proposed ? 'Proposed: ' : '') + opt.title;

const lines = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Outreach desk//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:' + (cancel ? 'CANCEL' : 'REQUEST'),
  'BEGIN:VEVENT',
  'UID:' + opt.uid + '@outreach-desk',
  'SEQUENCE:' + (Number(opt.seq) || 0),
  'DTSTAMP:' + stamp(new Date()),
  'DTSTART:' + stamp(start),
  'DTEND:' + stamp(end),
  'SUMMARY:' + esc(title),
  'DESCRIPTION:' + esc(opt.notes || ''),
  opt.where ? 'LOCATION:' + esc(opt.where) : null,
  'STATUS:' + (cancel ? 'CANCELLED' : proposed ? 'TENTATIVE' : 'CONFIRMED'),
  'TRANSP:OPAQUE',
  'ORGANIZER;CN=Outreach desk:mailto:' + ORGANIZER,
  'ATTENDEE;CN=Soham Shah;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:' + ATTENDEE,
  cancel ? null : 'BEGIN:VALARM',
  cancel ? null : 'TRIGGER:-PT15M',
  cancel ? null : 'ACTION:DISPLAY',
  cancel ? null : 'DESCRIPTION:' + esc(title),
  cancel ? null : 'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].filter(Boolean).map(fold).join('\r\n') + '\r\n';

const when = start.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
process.stdout.write(JSON.stringify({
  filename: 'invite.ics',
  mimeType: 'text/calendar; method=' + (cancel ? 'CANCEL' : 'REQUEST'),
  content: Buffer.from(lines).toString('base64'),
  summary: title + ' · ' + when,
}));
