// When a business owner says yes to a call, this writes your answer:
// two open times from your calendar (meta/calendar on the desk), Teams or
// whatever's easiest. No pitch: Connect.AI comes up on the call itself. The reply check saves it as a Gmail draft in their thread for
// you to send. It's signed with the first name from the settings.
//
//   node scripts/meeting-reply.js <prospect JSON file> <calendar JSON file> [settings JSON file] [prospects folder]
//     → { body, slots: [iso...], slot_text: [...], draft_slots } or { skip: reason }
// Save draft_slots on the prospect with the draft, so the desk knows which times it holds.
// Days off (settings.blocked_days), call hours (call_from/call_to) and times held for
// other businesses (see heldBusy) are never offered.

const fs = require('fs');
const { callOptions, slotText, heldBusy, dateToNyLocal } = require('../lib/outreach/calendar');
const { shortName } = require('../lib/outreach/crmnotes');
const { profileOf, loadSettings } = require('../lib/outreach/settings');

function firstName(p) {
  const greet = (/^Hi ([^\n,]+),/.exec(p.body || '') || [])[1] || '';
  if (!greet || / team$/i.test(greet)) return null;
  return greet.replace(/^Dr\.\s+/, 'Dr. ');
}

// Same hash the desk page uses to tell which wording draft_slots belongs to.
const textKey = t => { let h = 0; for (const c of String(t || '').trim()) h = (h * 31 + c.charCodeAt(0)) | 0; return String(h); };

// others: the desk's other prospects, so times held for them aren't offered again.
function meetingReply(p, cal, { now = new Date(), settings = {}, others = [] } = {}) {
  const ageH = cal && cal.fetched_at ? (now - new Date(cal.fetched_at)) / 3600000 : Infinity;
  const booking = String(profileOf(settings).booking_url || '').trim();
  if (/^https?:\/\/\S+$/.test(booking) && !booking.includes('...')) {
    // With a booking page they pick an open time themselves: no back-and-forth.
    const prof = profileOf(settings);
    const name = firstName(p);
    const body = [
      name ? `Hi ${name},` : 'Hi,',
      `Thanks so much for getting back to me, I really appreciate you making time. Just reply with a day and time that works for you and the best number to reach you, and I'll give you a call then.\n\nIf it's easier, you can also pick a time on my calendar here: ${booking}`,
      `Really looking forward to hearing how ${shortName(p.name)} got started.`,
      prof.first_name ? `Thanks,\n${prof.first_name}` : 'Thanks,',
    ].join('\n\n');
    return { body, slots: [], slot_text: [], booking_url: booking };
  }
  if (!cal || !Array.isArray(cal.busy)) return { skip: "Your calendar hasn't been read yet" };
  if (ageH > 72) return { skip: "Your calendar is more than 3 days old; the 7:23am run may not be reading it" };
  const s = settings.settings || settings;
  const busy = [...cal.busy, ...heldBusy(others, { exceptId: p.id, now })];
  const slots = callOptions(busy, { now, skipDays: Array.isArray(s.blocked_days) ? s.blocked_days : [], callFrom: s.call_from, callTo: s.call_to }).slice(0, 3);
  if (slots.length < 2) return { skip: 'Not enough open times in the next two weeks' };
  const prof = profileOf(settings);
  const me = prof.first_name;
  const phone = String(prof.phone || '').trim();
  const name = firstName(p);
  const biz = shortName(p.name);
  const texts = slots.map(slotText);
  const body = [
    name ? `Hi ${name},` : 'Hi,',
    `Thanks so much for getting back to me, I really appreciate you making time. Would any of these work for you?\n\n${texts.map(t => `- ${t}`).join('\n')}\n\nIf another time is easier, just let me know what works better for you. ${String(prof.video_apps || 'Teams or Google Meet').replace(' or ', ', ')} or phone all work for me, and I'm happy to send the invite.${phone ? ` If it's easier to just call, my number is ${phone}.` : ''}`,
    `Really looking forward to hearing how ${biz} got started.`,
    me ? `Thanks,\n${me}` : 'Thanks,',
  ].join('\n\n');
  const draft_slots = { key: textKey(body), slots: slots.map(d => ({ start: dateToNyLocal(d), end: dateToNyLocal(new Date(d.getTime() + 30 * 60000)) })), read_at: now.toISOString() };
  return { body, slots: slots.map(d => d.toISOString()), slot_text: texts, draft_slots };
}

if (require.main === module) {
  const read = f => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.data || j; };
  // Optional 4th: a folder of the desk's prospect JSON files (or one JSON array), for times held for others.
  const othersArg = process.argv[5];
  let others = [];
  if (othersArg && fs.existsSync(othersArg)) {
    others = fs.statSync(othersArg).isDirectory()
      ? fs.readdirSync(othersArg).filter(f => f.endsWith('.json') && !f.startsWith('.')).map(f => { const j = read(require('path').join(othersArg, f)); j.id = j.id || f.slice(0, -5); return j; })
      : [].concat(read(othersArg));
  }
  process.stdout.write(JSON.stringify(meetingReply(read(process.argv[2]), read(process.argv[3]), { settings: loadSettings(process.argv[4]), others })));
}
module.exports = { meetingReply };
