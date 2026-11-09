// Defaults for everything the dashboard's Settings panel can change.
// Saved overrides live in outreach_settings.data and are merged on top.

const DEFAULT_SETTINGS = {
  // About you, the student sending. Each classmate fills these in for their
  // own copy; nothing personal is built in. Empty fields are left out of the
  // emails (see profileOf below for what's filled in automatically).
  sender_name: '',        // full name, e.g. "Maya Lin"
  sender_major: '',       // e.g. "accounting"
  school_short: 'UConn',
  school_long: 'University of Connecticut',
  campus: 'Storrs',
  school_email: '',       // your @uconn.edu address: cc'd on follow-ups, in the signature
  sender_email: '',       // the Gmail you send from
  notify_emails: [],      // where "someone wrote back" emails go; empty = school_email + sender_email
  linkedin_url: '',
  offer_visit: false,     // true to offer to stop by in person when they're close to campus
  booking_url: '',        // your booking page (Microsoft Bookings, Calendly); replies send this instead of listing times
  phone: '',              // only goes in replies to people who wrote back, never in first emails or follow-ups
  calendar_ics_url: '',
  desk_url: '',           // your own desk's claude.ai link, for the "Open the desk" button   // your published Outlook calendar (.ics), for offering call times
  // First person, said plainly, e.g. "I interned in accounting at X this
  // past summer." Left blank, the email skips it.
  background: '',
  // Why you're reaching out, e.g. "Eventually I want to start my own
  // business, so I've been trying to talk with people who have."
  why: '',
  // Contact details in the signature, not a link in the body: owners who want
  // to check you're a real student can, without the email asking them to.
  // Left blank, it's built from your name, major, school, email and LinkedIn.
  signature: '',
  apply_url: 'connect-ai.world/apply',
  // One optional sentence about timing, e.g. "We're picking partners for
  // the spring semester now." Left blank, the email doesn't mention timing.
  offer_note: '',

  // Sending. A new Gmail account that suddenly sends 100 cold emails a
  // day gets flagged; 15–25/day with a slow ramp is the safe range.
  daily_cap: 20,
  per_tick: 4,
  send_start_hour: 8,   // New York time
  send_end_hour: 16,
  send_weekdays_only: true,

  followups_enabled: true,
  followup_after_days: 4, // business days with no reply

  // Off: every email waits for you to read it and click Approve.
  // On: drafts at or above the fit score below queue themselves (never
  // guessed addresses).
  auto_queue: false,
  auto_queue_min_fit: 70,

  // Sourcing
  max_miles: 45,
  min_pipeline: 40,     // keep at least this many found/ready prospects on hand
  use_osm: true,
  use_registry: true,
};

function mergeSettings(saved) {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

const clean = v => String(v ?? '').trim();

// "https://www.linkedin.com/in/maya-lin/" → "linkedin.com/in/maya-lin"
function linkedinShort(url) {
  return clean(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

function firstNameOf(full) {
  const f = clean(full).replace(/^(dr|mr|mrs|ms|miss)\.?\s+/i, '').split(/\s+/)[0] || '';
  return f;
}

// "Maya Lin\nFinance, University of Connecticut\nmaya.lin@uconn.edu · linkedin.com/in/maya-lin"
function buildSignature(s) {
  const major = clean(s.sender_major);
  const school = clean(s.school_long) || clean(s.school_short);
  const studies = [major ? major[0].toUpperCase() + major.slice(1) : '', school].filter(Boolean).join(', ');
  const contact = [clean(s.school_email), linkedinShort(s.linkedin_url)].filter(Boolean).join(' · ');
  // Nothing about you set: no signature at all, not just a school name.
  if (!clean(s.sender_name) && !contact) return '';
  return [clean(s.sender_name), studies, contact].filter(Boolean).join('\n');
}

// The settings with everything derived filled in, so callers don't repeat it:
// first_name, signature (built when blank), notify_emails (defaulted),
// linkedin_short.
function profileOf(settings) {
  const s = mergeSettings(settings);
  const listed = (Array.isArray(s.notify_emails) ? s.notify_emails : String(s.notify_emails || '').split(/[,\s]+/)).map(clean).filter(Boolean);
  return {
    ...s,
    sender_name: clean(s.sender_name),
    first_name: firstNameOf(s.sender_name),
    signature: clean(s.signature) || buildSignature(s),
    notify_emails: listed.length ? listed : [...new Set([clean(s.school_email), clean(s.sender_email)].filter(Boolean))],
    linkedin_short: linkedinShort(s.linkedin_url),
  };
}

// A settings JSON file (plain, or a desk document with the settings under
// "data") merged over the defaults. No file: just the defaults.
// With no file given, the student's own profile.json at the repo root (made
// at setup, never committed, and shipped inside their desk's code bundle) is
// used, so scheduled runs that don't pass --settings still write as them.
const PROFILE_FILE = require('path').join(__dirname, '..', '..', 'profile.json');
function loadSettings(file) {
  if (!file && !process.env.OUTREACH_NO_PROFILE && require('fs').existsSync(PROFILE_FILE)) file = PROFILE_FILE;
  if (!file) return mergeSettings({});
  const j = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  return mergeSettings(j && j.data && typeof j.data === 'object' ? j.data : j);
}

module.exports = { DEFAULT_SETTINGS, mergeSettings, loadSettings, profileOf, buildSignature, linkedinShort };
