// Writes the emails.
//
// What gets replies from small-business owners: short, plainly from a real
// person, about THEIR business, and asking to learn rather than selling.
// The sender is a student who wants to hear how these businesses run, so
// every email is:
//
//   1. Who I am (major and school, from the settings) + how I found you,
//      and one thing I actually noticed about your business
//   2. Why I'm writing: what the student is curious about in a business
//      like theirs, then their own background and reason for reaching out
//      (the settings' background and why, word for word). Never an
//      operations question (reads like a sales call), never a comparison
//      to big companies (reads like a put-down)
//   3. The ask for a call (Connect.AI waits until they reply)
//      either way. Close to campus? Offer to come by (only if offer_visit is on).
//   4. An easy way to say no.
//
// Plain text, no tracking pixel, one link. Wording rotates per business
// so a batch doesn't go out as identical copies.
//
// If GEMINI_API_KEY is set (free from Google AI Studio, no card), Gemini
// rewrites only the opening line using what was found on their site. Its
// output is checked and thrown away if it adds numbers or claims that
// weren't in the facts, gets long, or sounds like marketing.

const { BUCKETS } = require('./industries');
const { firstName, hashPick, stateOf, inClassArea, placeInWords, milesOf } = require('./util');
const { confirmName } = require('./factsources');
const { profileOf } = require('./settings');

const TOOL_NAMES = {
  calendly: 'Calendly', acuity: 'Acuity', square: 'Square', vagaro: 'Vagaro', mindbody: 'Mindbody', schedulicity: 'Schedulicity',
  zocdoc: 'Zocdoc', nexhealth: 'NexHealth', localmed: 'LocalMed', solutionreach: 'Solutionreach', weave: 'Weave', opentable: 'OpenTable',
  resy: 'Resy', tock: 'Tock', toast: 'Toast', chownow: 'ChowNow', housecallpro: 'Housecall Pro', servicetitan: 'ServiceTitan',
  jobber: 'Jobber', setmore: 'Setmore', simplybook: 'SimplyBook', booksy: 'Booksy', glossgenius: 'GlossGenius', fresha: 'Fresha',
  janeapp: 'Jane', boulevard: 'Boulevard', practicebetter: 'Practice Better', wellnessliving: 'WellnessLiving', clover: 'Clover',
  shopify: 'Shopify', woocommerce: 'WooCommerce', bigcommerce: 'BigCommerce', ecwid: 'Ecwid', square_online: 'Square',
  tawk: 'a chat widget', intercom: 'Intercom', drift: 'Drift', livechat: 'LiveChat', tidio: 'Tidio', podium: 'Podium',
  birdeye: 'Birdeye', hubspot: 'HubSpot', zendesk: 'Zendesk',
};

function senderFirst(settings) {
  const name = String((settings && settings.sender_name) || '').trim();
  return firstName(name) || name || '';
}

// "UConn student" (or just "student" when no school is set).
function studentLabel(settings) {
  const school = String((settings && settings.school_short) || '').trim();
  return school ? `${school} student` : 'student';
}

// "Lacerta Group, LLC" → "Lacerta Group": nobody writes the legal suffix in an email.
function shortName(name) {
  const n = String(name || '')
    .replace(/,?\s*\b(limited partnership|limited liability( company| partnership)?|l\.?\s?l\.?\s?c|inc|incorporated|corp|corporation|co|company|ltd|limited|p\.?\s?c|p\.?\s?l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?p|l\.?\s?p|ltd\.? liability co)\b\.?\s*$/i, '')
    .replace(/,?\s*\b(limited liability|limited partnership|l\.?\s?l\.?\s?c|inc|p\.?\s?c|s\.?\s?c)\b\.?\s*$/i, '')
    .replace(/[,\s]+$/, '')
    .trim();
  return n || String(name || '');
}

function placeName(p) {
  return placeInWords(p);
}

// Facts worth one sentence, best first. Each is something we actually saw.
function factSentences(p) {
  const f = p.facts || {};
  const out = [];
  const thisYear = new Date().getUTCFullYear();
  if (f.founded && thisYear - f.founded >= 8) out.push(`I saw you've been in business since ${f.founded}.`);
  if (f.family_owned) out.push('I saw it\'s family-owned.');
  // Store tools (WooCommerce, Shopify...) only mean something for a shop or
  // restaurant; on a contractor's site they're usually leftover plugins.
  const sells = ['retail', 'food'].includes(p.bucket);
  const modern = [...(f.booking_tools || []), ...(sells ? f.shop_tools || [] : [])].map(k => TOOL_NAMES[k]).filter(Boolean);
  if (modern.length) out.push(`I noticed you use ${modern[0]}, and I'm curious how that's worked out for you.`);
  if (f.phone_first) out.push('I noticed most things still go through a phone call, which made me curious how you keep up with it.');
  if (f.quote_requests) out.push('I saw you take estimate requests through your site.');
  if (f.catering) out.push('I saw you take catering and event orders too.');
  if (!out.length && f.years_claimed >= 10) out.push(`I saw you've been in business for over ${f.years_claimed} years.`);
  return out;
}

function templateOpener(p, seed, me) {
  const place = placeName(p);
  const found = [
    `I came across ${p.name} while looking at small businesses around ${place}.`,
    `I was looking at businesses around ${place} this week and ${p.name} stood out.`,
    `I found ${p.name} while looking at businesses around ${place}.`,
  ][hashPick(`${seed}:found`, 3)];
  const facts = factSentences(p);
  const fact = facts.length ? facts[hashPick(`${seed}:fact`, Math.min(2, facts.length))] : '';
  return [me, found, fact].filter(Boolean).join(' ');
}

function interestFor(p) {
  const b = BUCKETS[p.bucket] || BUCKETS.other;
  const cat = String(p.category || 'local').toLowerCase();
  return (b.interest || BUCKETS.other.interest).replace('{cat}', cat);
}

const ROLE_INBOX = /^(info|office|contact|hello|hi|admin|mail|service|services|sales|team|frontdesk|reception|appointments?|scheduling|inquiries|inquiry|support|help|owner|billing|accounts|orders)$/;

// Is this address someone other than the contact? ("kaker@" when we know "James Pennoyer")
function addressedToSomeoneElse(p) {
  if (!p.email || !p.contact_name) return false;
  const local = p.email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (ROLE_INBOX.test(local)) return false;
  const parts = p.contact_name.toLowerCase().split(/\s+/).map(x => x.replace(/[^a-z]/g, '')).filter(x => x.length > 1);
  if (!parts.length) return false;
  const first = parts[0], last = parts[parts.length - 1];
  if (local.includes(first) || local.includes(last) || local === first[0] + last || local.startsWith(first[0] + last.slice(0, 4))) return false;
  // A free-mail address listed for the business is usually the owner's own, whatever it's called.
  return !/@(gmail|yahoo|aol|hotmail|outlook|icloud|comcast|att|sbcglobal|snet|cox|verizon|optonline)\./.test(p.email);
}

// Greet someone by name only when we know they're the right person: their
// name is on the business's own website, or the email address is theirs.
// A name that only comes from the state filing may be an old owner or a
// silent partner, and the wrong first name is the surest sign of a mass email.
function nameConfirmed(p) {
  if (!p.contact_name) return false;
  const key = String(p.contact_name).toLowerCase();
  if ((p.facts?.people || []).some(x => String(x.name || '').toLowerCase() === key && x.how && x.how !== 'state filing')) return true;
  const local = String(p.email || '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const parts = key.split(/\s+/).map(x => x.replace(/[^a-z]/g, '')).filter(x => x.length > 1);
  if (!local || parts.length < 2) return false;
  const first = parts[0], last = parts[parts.length - 1];
  return local.includes(last) || local === first || local.startsWith(first[0] + last.slice(0, 4)) || (first.length >= 4 && local.startsWith(first));
}

// Who the email is addressed to, in order:
//  1. someone confirmed as running the place (named on their own site, or
//     the email address is theirs): "Hi Antonio,"
//  2. the people on the state filing, when there are one or two (in a small
//     LLC that's usually the owners): "Hi Antonio and Jordan,"
//  3. otherwise the team: "Hi Air Control Mechanical team,"
// Never "Hi there". If the address is clearly some other person's (jessicam@
// when the filing lists Antonio and Jordan), the team greeting is used, since
// someone else will be reading it.
// "Dr. Lastname" is used only when a source shows that person is a doctor:
// their own website ("Dr. Susan Davis", "Susan Davis, DMD"; research saves
// that page as doctor_url) or the business's registered name ("Ralph J
// Laguardia M.D."). In a medical or dental practice where nothing confirms
// who the doctor is, the email greets the team: a first name could be rude
// to a doctor, and "Dr." could be wrong for a manager.
const DOCTOR_PRACTICE = /dent(ist|al|istry)|orthodont|endodont|periodont|oral (and |& )?(maxillofacial |implant )?surg|oral surgery|physician|medical (practice|group|associates)|family medicine|internal medicine|pediatric|dermatolog|cardiolog|podiatr|chiropract|optometr|ophthalmolog|eye (care|doctor)|veterinar|animal hospital|\b(md|do|dds|dmd|dpm|dc|od|dvm)\b|offices of (physicians|dentists|chiropractors|optometrists)/i;
function isDoctorPractice(p) {
  const f = p.facts || {};
  return DOCTOR_PRACTICE.test([p.name, p.category, p.card_line, f.naics].filter(Boolean).join(' ').replace(/\./g, ''));
}
const lastName = n => String(n || '').trim().replace(/,?\s+(jr|sr|ii|iii|iv|md|dds|dmd|do|dc|od|dvm)\.?$/i, '').split(/\s+/).pop();
// Is this person shown to be a doctor? Returns the source, or null.
function doctorSource(p, name) {
  const key = String(name || '').toLowerCase();
  const rec = ((p.facts || {}).people || []).find(x => String(x.name || '').toLowerCase() === key && x.doctor_url);
  if (rec) return rec.doctor_url;
  const last = lastName(name).toLowerCase();
  const biz = String(p.name || '').toLowerCase().replace(/\./g, '');
  if (last.length > 1 && biz.includes(last) && /\b(md|dds|dmd|do|dc|od|dvm|dpm)\b/.test(biz)) return 'business name';
  return null;
}
// How to address one person, or null when we shouldn't guess.
const NICKNAMES = new Set('doug dan dave mike matt chris tom jim joe rob steve andy tony nick ben sam alex jen jenn kate liz pat rick rich greg jeff ken ron don jon nate phil ray vince zach josh jake sue deb dom fred frank gabe al tim ted walt'.split(' '));

function hello(p, name) {
  const clean = String(name || '').replace(/^dr\.?\s+/i, '');
  if (doctorSource(p, clean)) { const l = lastName(clean); return l ? `Dr. ${l[0].toUpperCase()}${l.slice(1).toLowerCase()}` : null; }
  if (isDoctorPractice(p)) return null;
  const first = firstName(clean) || null;
  // "Doug Victor Electric" filed under Douglas Victor: he goes by Doug.
  const short = first && String(p.name || '').split(/[^A-Za-z]+/).find(w => NICKNAMES.has(w.toLowerCase()) && w.length < first.length && first.toLowerCase().startsWith(w.toLowerCase()));
  return short ? short[0].toUpperCase() + short.slice(1).toLowerCase() : first;
}

function greeting(p) {
  const team = `Hi ${shortName(p.name || '') || 'there'} team,`;
  // One of two owners on the filing: greet both (below), not just one.
  const c = confirmName(p, p.contact_name);
  if (nameConfirmed(p) || (c && !/one of the two/.test(c.how))) {
    const h = hello(p, p.contact_name);
    if (h) return `Hi ${h},`;
    if (isDoctorPractice(p)) return team;
  }
  const filed = [...new Map(((p.facts || {}).people || [])
    .filter(x => x.how === 'state filing' && x.name)
    .map(x => [String(x.name).toLowerCase(), x])).values()];
  const [local, dom] = String(p.email || '').toLowerCase().split('@');
  const free = /^(gmail|yahoo|aol|hotmail|outlook|icloud|comcast|att|sbcglobal|snet|cox|verizon|optonline|live|msn|me)\./.test(dom || '');
  // A named inbox at their domain that isn't anyone on the filing: someone else's.
  if (local && !free && !ROLE_INBOX.test(local) && filed.length && !filed.some(x => nameConfirmed({ ...p, contact_name: x.name, facts: {} }))) return team;
  // Only people we can tie to this email address (see confirmName).
  if (filed.some(x => !confirmName(p, x.name))) return team;
  const names = filed.map(x => hello(p, x.name));
  if (!names.length || names.some(n => !n)) return team;
  if (names.length === 1) return `Hi ${names[0]},`;
  if (names.length === 2) return `Hi ${names[0]} and ${names[1]},`;
  return team;
}

// Every subject names their business and the student's school: a stranger
// opens an email that's clearly about them and clearly not spam. The desk
// shows the reply rate for each wording, so the weaker ones can be dropped later.
function subjectFor(p, seed, settings) {
  const biz = shortName(p.name);
  const who = studentLabel(settings);
  const Who = who[0].toUpperCase() + who.slice(1);
  const options = [
    `Question about ${biz} from a ${who}`,
    `${Who} question about ${biz}`,
    `${Who} hoping to learn about ${biz}`,
  ];
  const pick = options[hashPick(`${seed}:subject`, options.length)];
  // Long names get cut off in phone inboxes; fall back to the shortest wording.
  if (pick.length <= 60) return pick;
  return options[1].length <= 60 ? options[1] : `A question from a ${who}`;
}

// One real detail from their own website, said the way a person would.
// Only facts that kept a source link reach here (see enrich.keepSourced).
function humanDetail(p, seed) {
  const f = p.facts || {};
  const year = new Date().getUTCFullYear();
  const out = [];
  if (f.founded && year - f.founded >= 8) {
    out.push(f.founded <= year - 21
      ? `I saw you've been in business since ${f.founded}, which is longer than I've been alive.`
      : `I saw you've been in business since ${f.founded}.`);
  } else if (f.years_claimed >= 10) out.push(`I saw you've been in business for more than ${f.years_claimed} years.`);
  if (f.family_owned) out.push(`I saw it's a family business, and that's part of why I'm writing.`);
  else if (f.locally_owned) out.push(`I saw it's locally owned, and that's part of why I'm writing.`);
  return out.length ? out[hashPick(`${seed}:detail`, out.length)] : '';
}

function composeInitial(p0, settings, opener) {
  const prof = profileOf(settings);
  const p = { ...p0, name: shortName(p0.name) };
  const seed = p0.id || p0.name;
  const me = senderFirst(prof);
  const school = prof.school_short || prof.school_long || '';
  const atSchool = school ? ` at ${school}` : '';
  const major = String(prof.sender_major || '').trim();
  const aMajor = major ? `${/^[aeiou]/i.test(major) ? 'an' : 'a'} ${major} major` : 'a student';
  const biz = p.name;
  const interest = interestFor(p);
  const detail = opener || humanDetail(p, seed);
  const miles = milesOf(p);
  const near = stateOf(p) === 'CT' && miles != null && miles <= 30;
  const campus = String(prof.campus || '').trim();
  const nearBy = near && campus ? `, about ${Math.max(5, Math.round(miles / 5) * 5)} miles from you in ${campus}` : '';
  const intro = (me ? [
    `My name's ${me}, and I'm ${aMajor}${atSchool}.`,
    `I'm ${me}, ${aMajor}${atSchool}${nearBy}.`,
    major ? `I'm ${me}. I study ${major}${atSchool}.` : `I'm ${me}, ${aMajor}${atSchool}.`,
  ] : [
    `I'm ${aMajor}${atSchool}.`,
    `I'm ${aMajor}${atSchool}${nearBy}.`,
    major ? `I study ${major}${atSchool}.` : `I'm ${aMajor}${atSchool}.`,
  ])[hashPick(`${seed}:intro`, 3)];
  const curious = [
    `I've always been curious about ${interest}.`,
    `I've always been interested in ${interest}.`,
    `Lately I've gotten really curious about ${interest}.`,
  ][hashPick(`${seed}:curious`, 3)];
  // Background and why, in the student's own words from the settings. Just
  // facts about them; never set against the business ("big-company work").
  // Either one left blank is simply skipped.
  const story = [prof.background, prof.why].map(x => String(x || '').trim()).filter(Boolean).join(' ');
  const want = [
    `I'd really like to hear how ${biz} got started and what it's like to run it.`,
    `I'd like to hear the story behind ${biz} and what a normal week looks like for you.`,
    `I'd love to hear how you got ${biz} going and what you wish you'd known at the start.`,
  ][hashPick(`${seed}:want`, 3)];
  const ask = [
    `Would you have 15 minutes for a call sometime? ${near && prof.offer_visit ? 'Phone, Zoom, or I can stop by, whatever works.' : 'Phone or Zoom, whatever works.'}`,
    `Any chance you'd have 15 minutes to talk sometime? ${near && prof.offer_visit ? 'Happy to call, do Zoom, or come by.' : 'Happy to call or do Zoom.'}`,
  ][hashPick(`${seed}:ask`, 2)];
  // No mention of Connect.AI in a first email: it reads like a pitch tacked
  // onto a "can I learn from you" note. It comes up once they write back.
  const course = '';
  const no = 'If now isn\'t a good time, no worries at all.';

  // Three shapes, so no two businesses get the same email with the name swapped.
  const shape = hashPick(`${seed}:shape`, 3);
  const line = (...parts) => parts.filter(Boolean).join(' ');
  const paras = shape === 0
    ? [line(intro, curious, detail), line(story, want), ask + course]
    : shape === 1
      ? [line(intro, story), line(curious, detail, want), ask + course]
      : [line(intro, curious), line(story, detail, want), ask + course];

  const body = [
    greeting(p),
    ...paras,
    no,
    prof.signature ? `Thanks,\n${prof.signature}` : 'Thanks,',
  ].filter(Boolean).join('\n\n');

  return { subject: subjectFor(p, seed, prof), body };
}

// The one follow-up, sent in the same thread when there's no reply. Same
// greeting as the first email, so a "Dr." or a name is never re-guessed.
const FOLLOWUP_LINE = 'Just bumping this in case it got buried. If you have 10 minutes sometime in the next couple of weeks, I\'d still really like to hear how you got started.';

function composeFollowup(p0, settings, originalSubject) {
  const p = { ...p0, name: shortName(p0.name) };
  const me = senderFirst(profileOf(settings));
  const subject = /^re:/i.test(originalSubject || '') ? originalSubject : `Re: ${originalSubject || p.name}`;
  const body = [
    (/^Hi [^\n]+,/.exec(p0.body || '') || [greeting(p)])[0],
    FOLLOWUP_LINE,
    'If now isn\'t a good time, no worries at all.',
    me ? `Thanks,\n${me}` : 'Thanks,',
  ].join('\n\n');
  return { subject, body };
}

// ---------- optional Gemini polish ----------

const BANNED = /(revolutioniz|synerg|leverag|cutting[- ]edge|game[- ]chang|unlock|empower|hope this (email|message) finds you|i wanted to reach out|elevate|seamless|streamline your|transform your|in today's|!|https?:|www\.)/i;

function factBlock(p) {
  const f = p.facts || {};
  return JSON.stringify({
    business: p.name,
    town: p.town,
    category: p.category,
    owner_or_contact: p.contact_name || null,
    site_title: f.site_title || null,
    site_description: f.description || null,
    founded: f.founded || null,
    family_owned: !!f.family_owned,
    books_by_phone: !!f.phone_first,
    takes_quote_requests: !!f.quote_requests,
    hiring: !!f.hiring,
    tools_on_site: [...(f.booking_tools || []), ...(f.shop_tools || [])].map(k => TOOL_NAMES[k]).filter(Boolean),
  });
}

function validOpener(text, p) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  const words = t.split(/\s+/).length;
  if (words < 8 || words > 48) return false;
  if ((t.match(/[.?]/g) || []).length > 3) return false;
  if (BANNED.test(t)) return false;
  // Every number in the output must appear in the facts we gave it.
  const allowed = factBlock(p);
  for (const n of t.match(/\d+/g) || []) if (!allowed.includes(n)) return false;
  if (!t.includes(p.name.split(' ')[0]) && !/your (business|shop|practice|firm|team|restaurant|office)/i.test(t)) return false;
  return true;
}

async function geminiOpener(p, fetchImpl = fetch, settings = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const school = String(profileOf(settings).school_short || '').trim();
  const prompt = `You write the first 1-2 sentences of a short, friendly email from a ${school ? `${school} ` : ''}college student to a small local business owner.
Facts we found on the business's own website (use ONLY these, never invent anything):
${factBlock(p)}

Write how the student came across the business and mention ONE specific, real detail from the facts above in a natural way.
Rules: plain everyday language, like a real student would write. No flattery beyond one light touch. No exclamation marks. No links.
No marketing words (streamline, leverage, unlock, transform, elevate, seamless). Do not mention AI, the course, or any offer. Max 40 words.
Return JSON: {"opener": "..."}`;
  try {
    const resp = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 200, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '';
    const opener = JSON.parse(raw).opener;
    return validOpener(opener, p) ? opener.trim() : null;
  } catch (e) {
    return null;
  }
}

async function draftInitial(p, settings, fetchImpl = fetch) {
  const opener = await geminiOpener(p, fetchImpl, settings);
  return { ...composeInitial(p, settings, opener), polished: !!opener };
}

module.exports = { isDoctorPractice, doctorSource, nameConfirmed, shortName, composeInitial, composeFollowup, FOLLOWUP_LINE, draftInitial, templateOpener, factSentences, validOpener, greeting, TOOL_NAMES };
