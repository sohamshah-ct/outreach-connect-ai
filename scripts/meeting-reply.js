// When a business owner says yes to a call, this writes your answer:
// two open times from your calendar (meta/calendar on the desk), Teams or
// whatever's easiest. No pitch: Connect.AI comes up on the call itself. The reply check saves it as a Gmail draft in their thread for
// you to send. It's signed with the first name from the settings.
//
//   node scripts/meeting-reply.js <prospect JSON file> <calendar JSON file> [settings JSON file]
//     → { body, slots: [iso...], slot_text: [...] } or { skip: reason }

const fs = require('fs');
const { callOptions, slotText } = require('../lib/outreach/calendar');
const { shortName } = require('../lib/outreach/crmnotes');
const { profileOf, loadSettings } = require('../lib/outreach/settings');

function firstName(p) {
  const greet = (/^Hi ([^\n,]+),/.exec(p.body || '') || [])[1] || '';
  if (!greet || / team$/i.test(greet)) return null;
  return greet.replace(/^Dr\.\s+/, 'Dr. ');
}

function meetingReply(p, cal, { now = new Date(), settings = {} } = {}) {
  const ageH = cal && cal.fetched_at ? (now - new Date(cal.fetched_at)) / 3600000 : Infinity;
  const booking = String(profileOf(settings).booking_url || '').trim();
  if (/^https?:\/\/\S+$/.test(booking) && !booking.includes('...')) {
    // With a booking page they pick an open time themselves: no back-and-forth.
    const prof = profileOf(settings);
    const name = firstName(p);
    const body = [
      name ? `Hi ${name},` : 'Hi,',
      `Thanks so much for getting back to me, I really appreciate you making time. You can grab whatever time works best for you here: ${booking}\n\nIf none of those work, just let me know a time that's easier and I'll make it work. Phone or Zoom, whichever you prefer.`,
      `Really looking forward to hearing how ${shortName(p.name)} got started.`,
      prof.first_name ? `Thanks,\n${prof.first_name}` : 'Thanks,',
    ].join('\n\n');
    return { body, slots: [], slot_text: [], booking_url: booking };
  }
  if (!cal || !Array.isArray(cal.busy)) return { skip: "Your calendar hasn't been read yet" };
  if (ageH > 72) return { skip: "Your calendar is more than 3 days old; the 7:23am run may not be reading it" };
  const slots = callOptions(cal.busy, { now });
  if (slots.length < 2) return { skip: 'Not enough open times in the next two weeks' };
  const prof = profileOf(settings);
  const me = prof.first_name;
  const phone = String(prof.phone || '').trim();
  const name = firstName(p);
  const biz = shortName(p.name);
  const texts = slots.map(slotText);
  const body = [
    name ? `Hi ${name},` : 'Hi,',
    `Thanks so much for getting back to me, I really appreciate you making time. Would any of these work for you?\n\n${texts.map(t => `- ${t}`).join('\n')}\n\nIf another time is easier, just let me know what works better for you. Teams, Zoom or phone all work for me, and I'm happy to send the invite.${phone ? ` If it's easier to just call, my number is ${phone}.` : ''}`,
    `Really looking forward to hearing how ${biz} got started.`,
    me ? `Thanks,\n${me}` : 'Thanks,',
  ].join('\n\n');
  return { body, slots: slots.map(d => d.toISOString()), slot_text: texts };
}

if (require.main === module) {
  const read = f => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.data || j; };
  process.stdout.write(JSON.stringify(meetingReply(read(process.argv[2]), read(process.argv[3]), { settings: loadSettings(process.argv[4]) })));
}
module.exports = { meetingReply };
