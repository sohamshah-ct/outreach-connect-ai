// Your free time, from your published Outlook calendar (an .ics feed).
// The 7:23am pre-send run (which can reach outlook.office365.com) turns the
// feed into plain busy blocks and saves them on the desk; the reply check
// picks a couple of open times from them when someone agrees to a call.
// Only start/end times are kept: event names stay out of the desk.

const ZONE = 'America/New_York';

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

// Wall-clock time in New York -> UTC Date.
function nyToUtc(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = tzOffsetMinutes(new Date(guess));
  let t = guess - offset * 60000;
  const off2 = tzOffsetMinutes(new Date(t));
  if (off2 !== offset) t = guess - off2 * 60000;
  return new Date(t);
}
// Minutes New York is ahead of UTC at that instant (negative: -240 or -300).
function tzOffsetMinutes(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// "20261104T130000" (+ TZID or Z) or "20261104" (all day) -> { date, allDay }
function parseTime(value, params = '') {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { date: nyToUtc(+y, +mo, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  // Outlook writes TZID="Eastern Standard Time" or similar; feeds here are
  // Eastern. Floating times are treated as Eastern too.
  return { date: nyToUtc(+y, +mo, +d, +h, +mi, +s), allDay: false };
}

function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...rest] = line.slice(0, i).split(';');
    const params = rest.join(';');
    const value = line.slice(i + 1);
    if (name === 'DTSTART') { const t = parseTime(value, params); if (t) { cur.start = t.date; cur.allDay = t.allDay; } }
    else if (name === 'DTEND') { const t = parseTime(value, params); if (t) cur.end = t.date; }
    else if (name === 'RRULE') cur.rrule = Object.fromEntries(value.split(';').map(kv => kv.split('=')));
    else if (name === 'EXDATE') for (const v of value.split(',')) { const t = parseTime(v, params); if (t) cur.exdates.push(t.date.getTime()); }
    else if (name === 'RECURRENCE-ID') { const t = parseTime(value, params); if (t) cur.recurrenceId = t.date.getTime(); }
    else if (name === 'UID') cur.uid = value;
    else if (name === 'STATUS') cur.status = value;
    else if (name === 'TRANSP') cur.transp = value;
    else if (name === 'X-MICROSOFT-CDO-BUSYSTATUS') cur.busy = value;
  }
  return events;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const nyParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
  .formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));

// Every occurrence start of an event between from and to (UTC Dates).
function occurrences(ev, from, to) {
  const len = (ev.end || ev.start).getTime() - ev.start.getTime() || (ev.allDay ? 86400000 : 0);
  if (!ev.rrule) return ev.start < to && ev.start.getTime() + len > from ? [[ev.start.getTime(), ev.start.getTime() + len]] : [];
  const r = ev.rrule;
  const freq = r.FREQ;
  const interval = +(r.INTERVAL || 1);
  const until = r.UNTIL ? parseTime(r.UNTIL).date.getTime() : Infinity;
  const count = r.COUNT ? +r.COUNT : Infinity;
  const p = nyParts(ev.start);
  const [h, mi, s] = [+p.hour % 24, +p.minute, +p.second];
  const byday = r.BYDAY ? r.BYDAY.split(',').map(x => x.replace(/^[+-]?\d+/, '')) : [DAYS[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()]];
  const out = [];
  let n = 0;
  const startDay = Date.UTC(+p.year, +p.month - 1, +p.day);
  for (let dayMs = startDay, i = 0; i < 800; dayMs += 86400000, i++) {
    const day = new Date(dayMs);
    const weeks = Math.floor((dayMs - startDay) / (7 * 86400000));
    const daysSince = Math.round((dayMs - startDay) / 86400000);
    let hit = false;
    if (freq === 'DAILY') hit = daysSince % interval === 0;
    else if (freq === 'WEEKLY') hit = weeks % interval === 0 && byday.includes(DAYS[day.getUTCDay()]);
    else if (freq === 'MONTHLY') hit = day.getUTCDate() === +p.day;
    else hit = daysSince === 0;
    if (!hit) continue;
    const st = nyToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, s).getTime();
    if (st > until || n >= count) break;
    n++;
    if (ev.exdates.includes(st)) continue;
    if (st >= to.getTime()) break;
    if (st + len > from.getTime()) out.push([st, st + len]);
  }
  return out;
}

// Busy blocks [{start, end}] (ISO) between from and to, merged and sorted.
function busyBlocks(icsText, from, to) {
  const events = parseIcs(icsText).filter(e => e.status !== 'CANCELLED' && e.transp !== 'TRANSPARENT' && e.busy !== 'FREE');
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
  const spans = [];
  for (const e of events) {
    if (e.recurrenceId) { spans.push(...occurrences({ ...e, rrule: null }, from, to)); continue; }
    for (const [st, en] of occurrences(e, from, to)) if (!overrides.has(`${e.uid}|${st}`)) spans.push([st, en]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [st, en] of spans) {
    const last = merged[merged.length - 1];
    if (last && st <= last[1]) last[1] = Math.max(last[1], en); else merged.push([st, en]);
  }
  return merged.map(([st, en]) => ({ start: new Date(st).toISOString(), end: new Date(en).toISOString() }));
}

// Two or three open 30-minute times, weekdays 9am-4:30pm Eastern (no late-Friday asks), at least a
// day out, on different days, with a 15-minute cushion around anything busy.
function openSlots(busy, { now = new Date(), count = 2, minutes = 30, days = 10, startHour = 9, endHour = 18, hours = [14, 15, 16, 10, 11, 13, 9], skipDays = [] } = {}) {
  // 15 minutes before anything, 45 after (time to get from class to a desk).
  const blocks = busy.map(b => [Date.parse(b.start) - 15 * 60000, Date.parse(b.end) + 45 * 60000]);
  const earliest = now.getTime() + 24 * 3600000;
  const picks = [];
  const today = nyParts(now);
  for (let i = 1; i <= days && picks.length < count; i++) {
    const day = new Date(Date.UTC(+today.year, +today.month - 1, +today.day + i));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (skipDays.includes(day.toISOString().slice(0, 10))) continue;
    // Prefer afternoons, then mornings, on the hour or half hour.
    const starts = hours.flatMap(h => [h, h + 0.5]).filter(h => h >= startHour && h + minutes / 60 <= endHour);
    for (const hour of starts) {
      const st = nyToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(hour), (hour % 1) * 60).getTime();
      const en = st + minutes * 60000;
      if (st < earliest) continue;
      if (blocks.some(([bs, be]) => st < be && en > bs)) continue;
      picks.push(new Date(st));
      break;
    }
  }
  return picks;
}

function slotText(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  const time = `${p.hour}${p.minute === '00' ? '' : ':' + p.minute}${p.dayPeriod.toLowerCase()}`;
  return `${p.weekday}, ${p.month} ${p.day} at ${time}`;
}

// Daytime times plus one early evening (for owners with day jobs), on different days.
// With call hours set (settings.call_from/call_to, e.g. "14:00"-"18:00") it keeps to
// those hours instead and offers no evening time. skipDays: days off (YYYY-MM-DD).
function callOptions(busy, { now = new Date(), skipDays = [], callFrom = null, callTo = null } = {}) {
  const hm = x => { const m = /^(\d{1,2}):(\d{2})/.exec(String(x || '')); return m ? +m[1] + +m[2] / 60 : null; };
  const a = hm(callFrom), b = hm(callTo);
  if (a != null && b != null && b - a >= 0.5) {
    const hours = []; for (let h = Math.ceil(a); h < b; h++) hours.push(h);
    if (a % 1) hours.unshift(Math.floor(a));
    return openSlots(busy, { now, count: 3, startHour: a, endHour: b, hours, skipDays });
  }
  const day = openSlots(busy, { now, count: 2, skipDays });
  const nyDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(d);
  const evening = openSlots(busy, { now, count: 1, hours: [18, 18.5, 19], endHour: 20, skipDays: [...skipDays, ...day.map(nyDay)] });
  return [...day, ...evening].sort((a, b) => a - b);
}

// New York wall-clock "2026-11-23T16:30" → Date.
function nyLocalToDate(str) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(String(str || ''));
  return m ? nyToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}
// Date → New York wall-clock "2026-11-23T16:30".
function dateToNyLocal(d) {
  const p = nyParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
// Times other businesses are holding, as busy blocks: confirmed calls, times offered in a
// sent reply they haven't picked from yet (offered_slots), and times in replies still
// waiting to go out (draft_slots). The desk page keeps the same list, so neither side
// offers one person a time already offered to someone else.
function heldBusy(prospects, { exceptId = null, now = new Date() } = {}) {
  const out = [];
  const add = (s, e) => { const a = nyLocalToDate(s), b = nyLocalToDate(e); if (a && b && b > now) out.push({ start: a.toISOString(), end: b.toISOString() }); };
  for (const p of prospects || []) {
    if (!p || p.id === exceptId) continue;
    const inv = p.invite || {};
    if (p.call_at && (p.call_confirmed_at || inv.start === p.call_at) && !inv.canceled_at) {
      const st = nyLocalToDate(p.call_at);
      if (st && st > now) out.push({ start: st.toISOString(), end: new Date(st.getTime() + (inv.mins || 30) * 60000).toISOString() });
    }
    if (p.status !== 'replied') continue;
    if (p.snooze_until && String(p.snooze_until) > dateToNyLocal(now).slice(0, 10)) continue;
    const picked = p.call_confirmed_at && String(p.call_confirmed_at) >= String(p.offered_at || '');
    if (Array.isArray(p.offered_slots) && !picked) for (const x of p.offered_slots) add(x.start, x.end);
    const ds = p.draft_slots && Array.isArray(p.draft_slots.slots) ? p.draft_slots.slots : [];
    if (p.reply_draft && !p.answered_at) for (const x of ds) add(x.start, x.end);
  }
  return out;
}

module.exports = { parseIcs, busyBlocks, openSlots, callOptions, slotText, nyToUtc, heldBusy, nyLocalToDate, dateToNyLocal };
