// Run with: npm test
// Everything external (websites, the CT registry, Overpass, Gmail, the
// CRM) is faked, so these run offline and never send a real email.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { nameKey, businessDaysSince, nyStartOfDay, milesFromStorrs } = require('../lib/outreach/util');
const { osmToProspect, tidyPersonName, prettyBusinessName, pickColumn, _resetColumnCache } = require('../lib/outreach/sources');
const { extractPage, rankEmails, enrichProspect, siteMatchesBusiness, cleanEmail } = require('../lib/outreach/enrich');
const { scoreProspect } = require('../lib/outreach/score');
const { composeInitial, composeFollowup, validOpener } = require('../lib/outreach/compose');
const { classifyIncoming, freshText } = require('../lib/outreach/mailer');
const { readRpc } = require('../lib/outreach/crm');
const { MemoryStore } = require('../lib/outreach/store');
const engine = require('../lib/outreach/engine');
const { mergeSettings } = require('../lib/outreach/settings');

const fx = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function cfEncode(email, key = 0x42) {
  return key.toString(16).padStart(2, '0') + [...email].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
}

const SITE = {
  'https://willowcreekdental.com/': fx('dental-home.html'),
  'https://willowcreekdental.com/about-us': fx('dental-about.html'),
  'https://willowcreekdental.com/contact': fx('dental-contact.html').replace('ENCODED', cfEncode('frontdesk@willowcreekdental.com')),
  'https://hartwellcpa.com/': fx('accountant-site.html'),
};

function fakeResponse(body, { status = 200, type = 'text/html', url } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: k => (k.toLowerCase() === 'content-type' ? type : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

// Fake web: the fixture sites plus a tiny CT registry (Socrata) that has
// no match for anything, so enrichment relies on the website.
function fakeFetch(registryRows = []) {
  return async (url) => {
    const u = String(url);
    if (SITE[u]) return fakeResponse(SITE[u], { url: u });
    if (u.includes('/api/views/n7gp-d28j.json')) {
      return fakeResponse({ columns: [
        { fieldName: 'id', name: 'Id' }, { fieldName: 'name', name: 'Name' }, { fieldName: 'status', name: 'Status' },
        { fieldName: 'business_email_address', name: 'Business Email Address' }, { fieldName: 'naics_code', name: 'NAICS Code' },
        { fieldName: 'billingcity', name: 'Billing City' }, { fieldName: 'date_registration', name: 'Date Registration' },
      ] }, { type: 'application/json' });
    }
    if (u.includes('/api/views/ka36-64k6.json')) {
      return fakeResponse({ columns: [{ fieldName: 'business_key', name: 'Business Key' }, { fieldName: 'name__c', name: 'Name' }, { fieldName: 'designation', name: 'Designation' }] }, { type: 'application/json' });
    }
    if (u.includes('/resource/n7gp-d28j.json')) return fakeResponse(registryRows, { type: 'application/json' });
    if (u.includes('/resource/ka36-64k6.json')) return fakeResponse([{ business_key: '001', name__c: 'WHITFIELD, KAREN A', designation: 'Member' }], { type: 'application/json' });
    return fakeResponse('not found', { status: 404 });
  };
}

const okResolver = { resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }] };

// ---------- helpers ----------

test('nameKey matches the CRM seed keys', () => {
  assert.equal(nameKey('The Gold Trader, LLC'), 'gold trader');
  assert.equal(nameKey("Munson's Chocolates"), 'munsons chocolates');
  assert.equal(nameKey('K.L. Smith Agency LLC'), 'k l smith agency');
  assert.equal(nameKey('Clancy’s HIIT & Fit'), 'clancys hiit fit');
  assert.equal(nameKey('United Gear & Machine Co.'), 'united gear machine');
  assert.equal(nameKey('Dri-Air Industries'), 'dri air industries');
  // and the migration's seed rows use exactly these keys
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '007_outreach.sql'), 'utf8');
  for (const m of sql.matchAll(/\('([a-z0-9 ]+)', '((?:[^']|'')+)', 'In class CRM'\)/g)) {
    assert.equal(nameKey(m[2].replace(/''/g, "'")), m[1], `seed key for ${m[2]}`);
  }
});

test('business days and New York day boundaries', () => {
  // Fri → next Wed = 3 business days (Mon, Tue, Wed)
  assert.equal(businessDaysSince('2026-10-23T15:00:00Z', new Date('2026-10-28T15:00:00Z')), 3);
  // 1am UTC on Oct 29 is still Oct 28 in New York
  const start = nyStartOfDay(new Date('2026-10-29T01:00:00Z'));
  assert.equal(start.toISOString(), '2026-10-28T04:00:00.000Z');
  assert.ok(Math.abs(milesFromStorrs(41.7658, -72.6734) - 22) < 2, 'Hartford is ~22 miles from Storrs');
});

// ---------- sourcing ----------

test('OSM elements become prospects; chains and junk are dropped', () => {
  const good = osmToProspect({ type: 'node', id: 1, lat: 41.80, lon: -72.25, tags: { name: 'Willow Creek Family Dentistry', amenity: 'dentist', website: 'willowcreekdental.com', 'addr:street': 'Storrs Rd', 'addr:housenumber': '12' } }, 'Mansfield');
  assert.equal(good.category, 'Dentist');
  assert.equal(good.bucket, 'health');
  assert.equal(good.website, 'https://willowcreekdental.com/');
  assert.equal(good.domain, 'willowcreekdental.com');
  assert.equal(good.address, '12 Storrs Rd, Mansfield');
  assert.ok(good.miles_from_storrs < 1);

  assert.equal(osmToProspect({ type: 'node', id: 2, tags: { name: "Dunkin'", amenity: 'cafe', website: 'dunkin.com' } }, 'Mansfield'), null);
  assert.equal(osmToProspect({ type: 'node', id: 3, tags: { name: 'Some Cafe', amenity: 'cafe', website: 'x.com', 'brand:wikidata': 'Q1' } }, 'Mansfield'), null);
  assert.equal(osmToProspect({ type: 'node', id: 4, tags: { name: 'Town Bench', amenity: 'bench' } }, 'Mansfield'), null);
  assert.equal(osmToProspect({ type: 'node', id: 5, tags: { name: 'No Web Plumbing', craft: 'plumber' } }, 'Mansfield'), null, 'nothing to email and nowhere to look');
  const withEmail = osmToProspect({ type: 'way', id: 6, center: { lat: 41.7, lon: -72.3 }, tags: { name: 'Ace Plumbing', craft: 'plumber', email: 'Ace@AcePlumbingCT.com' } }, 'Coventry');
  assert.equal(withEmail.email, 'ace@aceplumbingct.com');
  assert.equal(withEmail.lat, 41.7);
});

test('registry helpers: names, columns', () => {
  assert.equal(tidyPersonName('WHITFIELD, KAREN A'), 'Karen Whitfield');
  assert.equal(tidyPersonName('JOHN MCDONALD'), 'John McDonald');
  assert.equal(tidyPersonName('ACME HOLDINGS LLC'), null);
  assert.equal(prettyBusinessName('WILLOW CREEK FAMILY DENTISTRY LLC'), 'Willow Creek Family Dentistry LLC');
  const cols = [{ field: 'id', name: 'Id' }, { field: 'name', name: 'Name' }, { field: 'name_of_agent', name: 'Agent Name' }, { field: 'billingcity', name: 'City' }];
  assert.equal(pickColumn(cols, [/^name$/i, /name/i], /agent/i), 'name');
  assert.equal(pickColumn(cols, [/city/i]), 'billingcity');
});

// ---------- enrichment ----------

test('email extraction: mailto, [at]/[dot], Cloudflare, and junk filtering', () => {
  const page = extractPage(SITE['https://willowcreekdental.com/contact'], 'https://willowcreekdental.com/contact');
  assert.ok(page.emails.includes('office@willowcreekdental.com'));
  assert.ok(page.emails.includes('karen@willowcreekdental.com'), 'deobfuscated [at]/[dot]');
  assert.ok(page.emails.includes('frontdesk@willowcreekdental.com'), 'decoded Cloudflare email');
  assert.ok(!page.emails.some(e => e.startsWith('noreply')));
  assert.equal(cleanEmail('logo@2x.png'), null);
  assert.equal(cleanEmail('mailto:Hello@Shop.com?subject=hi'), 'hello@shop.com');
});

test('email ranking prefers the owner, then the office, never the web designer', () => {
  const ranked = rankEmails(['hello@pixelbarn.design', 'office@willowcreekdental.com', 'karen@willowcreekdental.com', 'careers@willowcreekdental.com'], {
    domain: 'willowcreekdental.com',
    people: [{ name: 'Karen Whitfield', role: 'owner' }],
  });
  assert.deepEqual(ranked.map(r => r.email), ['karen@willowcreekdental.com', 'office@willowcreekdental.com', 'careers@willowcreekdental.com', 'hello@pixelbarn.design']);
  assert.ok(ranked[3].score < 30);
});

test('enrichProspect reads the whole site and finds the owner, email and facts', async () => {
  _resetColumnCache();
  const p = { name: 'Willow Creek Family Dentistry', name_key: 'willow creek family dentistry', bucket: 'health', category: 'Dentist', website: 'https://willowcreekdental.com/', domain: 'willowcreekdental.com', town: 'Mansfield', source: 'osm', facts: {} };
  const patch = await enrichProspect(p, { fetchImpl: fakeFetch([]), resolver: okResolver });
  assert.equal(patch.email, 'karen@willowcreekdental.com');
  assert.equal(patch.email_confidence, 'high');
  assert.equal(patch.contact_name, 'Karen Whitfield');
  assert.match(patch.contact_title, /Owner|DMD/);
  const f = patch.facts;
  assert.equal(f.founded, 1998);
  assert.equal(f.family_owned, true);
  assert.equal(f.phone_first, true);
  assert.equal(f.paper_forms, true);
  assert.equal(f.hiring, true);
  assert.equal(f.team_size_text, 9);
  assert.equal(f.site_year, 2019);
  assert.equal(f.platform, 'wix');
  assert.deepEqual(f.socials.sort(), ['facebook', 'instagram']);
  assert.equal(f.pages_read.length, 3);
});

test('a registry email on someone else\'s domain (their accountant) is thrown out', async () => {
  _resetColumnCache();
  const p = { name: 'Maple Ridge Landscaping', name_key: 'maple ridge landscaping', bucket: 'trades', website: 'https://hartwellcpa.com/', domain: 'hartwellcpa.com', town: 'Tolland', source: 'registry', email: 'info@hartwellcpa.com', email_source: 'registry', registry: { id: '9', email: 'info@hartwellcpa.com', principals: [] }, facts: {} };
  const pages = [extractPage(SITE['https://hartwellcpa.com/'], 'https://hartwellcpa.com/')];
  assert.equal(siteMatchesBusiness(pages, p.name), false);
  const patch = await enrichProspect(p, { fetchImpl: fakeFetch([]), resolver: okResolver });
  assert.equal(patch.website, null);
  assert.equal(patch.email, null);
  assert.ok(patch.facts.enrich_notes.some(n => /different business/.test(n)));
});

// ---------- scoring ----------

test('fit score rewards reachable, nearby, manual-heavy small businesses', () => {
  const strong = scoreProspect({ bucket: 'health', category: 'Dentist', email: 'karen@willowcreekdental.com', email_confidence: 'high', email_source: 'website', contact_name: 'Karen Whitfield', miles_from_storrs: 3,
    facts: { pages_read: ['x'], phone_first: true, paper_forms: true, hiring: true, booking_tools: [], founded: 1998, years_in_business: 28, family_owned: true, team_size_text: 9, socials: ['facebook', 'instagram'] } });
  const weak = scoreProspect({ bucket: 'retail', category: 'Gift shop', email: 'x@gmail.com', email_confidence: 'medium', email_source: 'registry', miles_from_storrs: 80, facts: {} });
  const none = scoreProspect({ bucket: 'trades', email: null, miles_from_storrs: 10, facts: { pages_read: ['x'] } });
  assert.ok(strong.fit_score >= 85, `strong ${strong.fit_score}`);
  assert.ok(weak.fit_score <= 25, `weak ${weak.fit_score}`);
  assert.ok(none.fit_score < 30, `no email ${none.fit_score}`);
  assert.ok(strong.fit_reasons.some(r => /Karen Whitfield/.test(r.why)));
  assert.ok(weak.fit_reasons.some(r => /too far/.test(r.why)));
});

// ---------- composing ----------

// One student's profile, the way a classmate fills in their settings.
const SOHAM = {
  sender_name: 'Soham Shah',
  sender_major: 'accounting',
  school_email: 'soham.shah@uconn.edu',
  sender_email: 'shahsoham689@gmail.com',
  linkedin_url: 'https://www.linkedin.com/in/soham-shah-uconn/',
  background: "I interned in accounting at Henkel this past summer and I'll be at Andersen next summer.",
  why: "Eventually I want to start my own business, so I've been trying to talk with people who have.",
};
const settings = mergeSettings(SOHAM);
const dentist = { id: 'abc', name: 'Willow Creek Family Dentistry', town: 'Mansfield', bucket: 'health', category: 'Dentist', contact_name: 'Karen Whitfield', contact_title: 'Owner', email: 'karen@willowcreekdental.com', miles_from_storrs: 3,
  facts: { founded: 1998, family_owned: true, phone_first: true, booking_tools: [],
    people: [{ name: 'Karen Whitfield', role: 'owner', how: 'site text', url: 'https://willowcreekdental.com/about', doctor_url: 'https://willowcreekdental.com/about' }] } };

test('initial email is personal, honest, short, and has an easy no', () => {
  const { subject, body } = composeInitial(dentist, settings);
  assert.ok(subject.length < 60);
  assert.match(body, /^Hi Dr. Whitfield,/);
  assert.match(body, /Willow Creek Family Dentistry/);
  assert.doesNotMatch(body, /Connect\.AI/, "no class pitch in a first email");
  assert.doesNotMatch(body, /connect-ai\.world\/apply|free AI-readiness|build it for free/);
  assert.doesNotMatch(body, /Small Business Development Center/);
  assert.match(body, /accounting major/);
  assert.doesNotMatch(body.split('Thanks,')[0], /https?:|linkedin/i);
  assert.match(body, /soham\.shah@uconn\.edu · linkedin\.com\/in\/soham-shah-uconn$/);
  assert.match(body, /Henkel/, 'mentions his internship');
  assert.doesNotMatch(body, /been at it|been around since|doing this for/i, 'says plainly how long they have been in business');
  assert.doesNotMatch(body, /big[- ]compan|textbook|actually built/i, 'no big-company comparison or stock lines');
  assert.doesNotMatch(body, /hiring/i, 'never claims they are hiring');
  assert.match(body, /start (my own|something of my own)|run my own business/);
  assert.match(body, /15 minutes/);
  assert.match(body, /stop by|come by/);
  assert.match(body, /no worries at all/);
  assert.match(subject, /UConn/);
  assert.match(subject, /Willow Creek Family Dentistry/);
  assert.match(body, /(interested in|curious about) how small practices run as businesses/);
  assert.doesNotMatch(body, /How (do|does) your|what takes (up )?(the )?most/, 'no sales-call questions');
  assert.doesNotMatch(body, /while looking at|businesses around/);
  assert.doesNotMatch(body, /\{|\}|undefined|null/);
  const words = body.split(/\s+/).length;
  assert.ok(words < 190, `email is ${words} words`);
});

test('wording varies between businesses', () => {
  const variants = new Set();
  for (let i = 0; i < 12; i++) variants.add(composeInitial({ ...dentist, id: `id-${i}`, name: `Biz ${i}` }, settings).body.split('\n\n')[1].replace(/Biz \d+/, 'X'));
  assert.ok(variants.size >= 3, `only ${variants.size} opener variants`);
});

test('no name found → the team, never "Hi there"; far away → no offer to drop by', () => {
  const { body } = composeInitial({ ...dentist, contact_name: null, miles_from_storrs: 60, facts: {} }, settings);
  assert.match(body, /^Hi Willow Creek Family Dentistry team,/);
  assert.doesNotMatch(body, /in person/);
});

test('follow-up threads under the first subject', () => {
  const fu = composeFollowup(dentist, settings, 'A question for Willow Creek Family Dentistry');
  assert.equal(fu.subject, 'Re: A question for Willow Creek Family Dentistry');
  assert.match(fu.body, /bumping/);
  assert.match(fu.body, /bumping this/);
});

test('Gemini output is rejected if it invents numbers or sounds like marketing', () => {
  assert.equal(validOpener('I came across Willow Creek while looking at Mansfield dentists, and saw you have been around since 1998.', dentist), true);
  assert.equal(validOpener('I came across Willow Creek and saw you have served 5,000 patients.', dentist), false);
  assert.equal(validOpener('Willow Creek could unlock huge growth with AI!', dentist), false);
});

// ---------- inbox classification ----------

test('incoming mail is sorted into reply / no thanks / auto-reply / bounce', () => {
  const h = {};
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'Re: hi', headers: h, text: 'Sure, call me Tuesday.\n\nOn Mon, Oct 26, 2026 at 9:00 AM Soham wrote:\n> no thanks' }), 'reply');
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'Re: hi', headers: h, text: 'No thanks, we are all set.' }), 'not_interested');
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'Automatic reply: hi', headers: h, text: 'I am away' }), 'auto_reply');
  assert.equal(classifyIncoming({ fromAddress: 'karen@x.com', subject: 'hi', headers: { 'auto-submitted': 'auto-replied' }, text: 'away' }), 'auto_reply');
  assert.equal(classifyIncoming({ fromAddress: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', headers: h, text: '' }), 'bounce');
  assert.equal(freshText('Sounds good!\n\nOn Tue, Oct 27, 2026, Soham wrote:\n> quoted'), 'Sounds good!');
});

test('CRM client reads JSON and SSE responses', async () => {
  const sse = { headers: { get: () => 'text/event-stream' }, text: async () => 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n' };
  assert.deepEqual((await readRpc(sse)).result, { ok: true });
  const json = { headers: { get: () => 'application/json' }, text: async () => '{"jsonrpc":"2.0","id":1,"result":{"x":2}}' };
  assert.deepEqual((await readRpc(json)).result, { x: 2 });
});

// ---------- the whole loop ----------

function fakeMailer() {
  const sent = [];
  let inbox = [];
  return {
    sent,
    setInbox: items => { inbox = items; },
    mailConfig: () => ({ configured: true, user: 'soham@example.com' }),
    sendMail: async m => { sent.push(m); return { messageId: `<m${sent.length}@example.com>` }; },
    checkInbox: async () => inbox,
  };
}

const noCrm = { crmConfig: () => ({ configured: false }) };

test('end to end: source → enrich → draft → approve → send → follow up → reply', async () => {
  _resetColumnCache();
  const store = new MemoryStore();
  await store.upsertTown({ town: 'Mansfield', enabled: true });
  await store.upsertExcluded([{ name_key: 'mansfield family dental', name: 'Mansfield Family Dental', reason: 'In class CRM' }]);
  const mailer = fakeMailer();
  let clock = new Date('2026-10-27T14:00:00Z'); // Tue 10am New York
  const deps = {
    fetchImpl: fakeFetch([]),
    resolver: okResolver,
    now: () => clock,
    sleep: async () => {},
    mailer,
    crm: noCrm,
    sourceOsm: async town => [
      osmToProspect({ type: 'node', id: 1, lat: 41.80, lon: -72.25, tags: { name: 'Willow Creek Family Dentistry', amenity: 'dentist', website: 'https://willowcreekdental.com/' } }, town),
      osmToProspect({ type: 'node', id: 2, lat: 41.80, lon: -72.25, tags: { name: 'Mansfield Family Dental', amenity: 'dentist', website: 'https://mfd.example/' } }, town),
    ],
    sourceRegistry: async () => [],
    draft: async (p, s) => composeInitial(p, s),
  };

  // 1. a tick finds, researches and drafts — but sends nothing (nothing approved)
  let report = await engine.tick(store, deps);
  assert.equal(report.source.added, 1, 'excluded CRM business is skipped');
  assert.equal(report.enrich.enriched, 1);
  assert.equal(mailer.sent.length, 0);
  const [p] = await store.listProspects({ statuses: ['ready'] });
  assert.equal(p.email, 'karen@willowcreekdental.com');
  assert.ok(p.fit_score >= 80);
  const draft = (await store.listMessages(p.id))[0];
  assert.equal(draft.status, 'draft');
  assert.match(draft.body, /^Hi (Karen|Dr\. Whitfield),/);

  // 2. approve → next tick sends it
  assert.equal(await store.claim(p.id, 'ready', 'queued'), true);
  report = await engine.tick(store, deps);
  assert.equal(report.send.sent, 1);
  assert.equal(mailer.sent[0].to, 'karen@willowcreekdental.com');
  assert.equal((await store.getProspect(p.id)).status, 'sent');

  // outside sending hours: nothing goes out
  clock = new Date('2026-10-28T02:00:00Z'); // 10pm New York
  report = await engine.tick(store, deps);
  assert.equal(report.send.skipped, 'Outside sending hours');

  // 3. four business days later with no reply → one follow-up, threaded
  clock = new Date('2026-11-02T15:00:00Z'); // Mon
  report = await engine.tick(store, deps);
  assert.equal(report.send.results[0].kind, 'followup');
  assert.equal(mailer.sent[1].inReplyTo, '<m1@example.com>');
  assert.match(mailer.sent[1].subject, /^Re: /);
  assert.equal((await store.getProspect(p.id)).status, 'followed_up');

  // ...and never a second follow-up
  clock = new Date('2026-11-10T15:00:00Z');
  await engine.tick(store, deps);
  assert.equal(mailer.sent.length, 2);

  // 4. they reply → marked replied, reply saved, shows in activity
  mailer.setInbox([{ prospectId: p.id, kind: 'reply', messageId: '<r1@x.com>', fromAddress: 'karen@willowcreekdental.com', subject: 'Re: ...', snippet: 'Sure, happy to chat. Thursday?', date: clock.toISOString() }]);
  report = await engine.tick(store, deps);
  assert.equal(report.inbox.new, 1);
  const after = await store.getProspect(p.id);
  assert.equal(after.status, 'replied');
  const msgs = await store.listMessages(p.id);
  assert.equal(msgs.filter(m => m.direction === 'in').length, 1);
  assert.ok((await store.listEvents()).some(e => e.kind === 'replied' && /happy to chat/.test(e.body)));

  // the same reply seen again isn't double-counted
  report = await engine.tick(store, deps);
  assert.equal(report.inbox.new, 0);
});

test('daily cap, auto-queue rules, and overlapping runs never double-send', async () => {
  const store = new MemoryStore();
  await store.saveSettings({ daily_cap: 2, per_tick: 5, auto_queue: true, auto_queue_min_fit: 60 });
  const mailer = fakeMailer();
  const clock = new Date('2026-10-27T14:00:00Z');
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const [row] = await store.insertProspects([{ name: `Biz ${i}`, name_key: `biz ${i}`, town: 'Mansfield', email: `owner${i}@biz${i}.com`, status: 'queued', fit_score: 70 + i, source: 'osm' }]);
    await store.updateProspect(row.id, { status: 'queued' });
    await store.insertMessage({ prospect_id: row.id, kind: 'initial', direction: 'out', status: 'draft', subject: 's', body: 'b' });
    ids.push(row.id);
  }
  const deps = { ...engine.defaultDeps(), now: () => clock, sleep: async () => {}, mailer, crm: noCrm };
  const s = await store.getSettings();
  const [a, b] = await Promise.all([engine.sendStep(store, s, deps), engine.sendStep(store, s, deps)]);
  assert.ok(mailer.sent.length <= 3, `sent ${mailer.sent.length} with a cap of 2`);
  assert.equal(new Set(mailer.sent.map(m => m.to)).size, mailer.sent.length, 'no address emailed twice');
  // highest fit goes first
  assert.equal(mailer.sent[0].to, 'owner3@biz3.com');
  const c = await engine.sendStep(store, s, deps);
  assert.match(c.skipped, /Daily cap/);

  // auto-queue: a guessed address is never auto-queued
  const store2 = new MemoryStore();
  await store2.saveSettings({ auto_queue: true, auto_queue_min_fit: 10 });
  const [g] = await store2.insertProspects([{ name: 'Guess Co', name_key: 'guess co', town: 'Mansfield', source: 'osm', bucket: 'trades' }]);
  await engine.enrichStep(store2, await store2.getSettings(), {
    ...deps,
    enrich: async () => ({ email: 'bob@guessco.com', email_source: 'guess', email_confidence: 'low', facts: { pages_read: ['x'] } }),
    draft: async (p, st) => composeInitial(p, st),
  }, { ids: [g.id] });
  assert.equal((await store2.getProspect(g.id)).status, 'ready');
});

// ---------- CRM notes ----------

const { buildCrmNotes, hasSubstance } = require('../lib/outreach/crmnotes');

test('CRM notes say something real about the business, each with its source link', () => {
  const site = 'https://willowcreekdental.com/';
  const about = 'https://willowcreekdental.com/about';
  const notes = buildCrmNotes({
    name: 'Willow Creek Family Dentistry, LLC', town: 'Mansfield', address: '12 Storrs Rd, Mansfield', miles_from_storrs: 2.1,
    website: site, contact_name: 'Karen Whitfield', contact_title: 'Owner', source: 'osm', source_ref: 'node/42',
    email: 'karen@willowcreekdental.com', email_source: 'website', email_url: about, phone: '(860) 555-0142', phone_url: site, fit_score: 88, category: 'Dentist',
    facts: {
      about: 'We are a family-owned practice serving Mansfield since 1998.', team_size_text: 9, founded: 1998, phone_first: true, family_owned: true, hiring: true,
      people: [{ name: 'Karen Whitfield', role: 'owner', how: 'site text', url: about }],
      sources: { about, team_size_text: about, founded: about, phone_first: site, family_owned: about },
    },
  });
  assert.match(notes, /What they do: We are a family-owned practice.* \(source: https:\/\/willowcreekdental\.com\/about\)/);
  assert.match(notes, /Size: about 9 people, per their website \(source: /);
  assert.match(notes, /In business since: 1998/);
  assert.match(notes, /Where: 12 Storrs Rd, Mansfield, CT \(2 mi from Storrs\) \(source: https:\/\/www\.openstreetmap\.org\/node\/42\)/);
  assert.match(notes, /Website: https:\/\/willowcreekdental\.com\//);
  assert.match(notes, /Contact: Karen Whitfield \(Owner\) \(source: https:\/\/willowcreekdental\.com\/about\)/);
  assert.match(notes, /Email: karen@willowcreekdental\.com \(source: /);
  assert.match(notes, /books appointments\/orders by phone \(https:/);
  assert.doesNotMatch(notes, /hiring/, 'a fact with no source is left out');
  assert.doesNotMatch(notes, /undefined|null/);

  const reg = buildCrmNotes({ name: 'Rusty Mowers LLC', town: 'Mansfield', contact_name: 'Yasmine DelRio', email: 'rustymowersllc@gmail.com', email_source: 'registry', registry_id: '001ABC', source: 'registry',
    facts: { naics: 'Landscaping Services (561730)', registered_year: 2019, people: [{ name: 'Yasmine DelRio', how: 'state filing', business_id: '001ABC' }] } });
  assert.match(reg, /What they do: Landscaping Services \(the industry they filed with the state\) \(source: https:\/\/data\.ct\.gov\/resource\/n7gp-d28j\.json\?id=001ABC\)/);
  assert.match(reg, /one person listed on the state filing.*ka36-64k6\.json\?business_id=001ABC/);
  assert.match(reg, /registered with the CT Secretary of the State in 2019/);
  assert.match(reg, /Contact: Yasmine DelRio \(source: https:\/\/data\.ct\.gov\/resource\/ka36-64k6/);
  assert.doesNotMatch(reg, /Website:/);
});

test('addresses and shell names never go to the CRM', () => {
  assert.equal(hasSubstance({ name: '424 Storrs Road, LLC', email: 'x@gmail.com', contact_name: 'Greg Z', facts: { naics: 'Lessors (531)' } }), false);
  assert.equal(hasSubstance({ name: 'JJC 1232 LLC', email: 'x@gmail.com', contact_name: 'J C', facts: { naics: 'Something (1)' } }), false);
  assert.equal(hasSubstance({ name: 'CBJK, LLC', email: 'x@gmail.com', contact_name: 'C B', facts: {} }), false);
  assert.equal(hasSubstance({ name: 'Rusty Mowers LLC', email: 'r@gmail.com', contact_name: 'Yasmine DelRio', category: 'Landscaping', facts: {} }), true);
  assert.equal(hasSubstance({ name: 'CBJK', website: 'https://cbjk.com', facts: {} }), true, 'a real website makes it real');
});

test('a listed website that is some other business is dropped, not trusted', async () => {
  _resetColumnCache();
  const p = { name: 'Maple Ridge Landscaping', name_key: 'maple ridge landscaping', bucket: 'trades', website: 'https://hartwellcpa.com/', domain: 'hartwellcpa.com', town: 'Tolland', source: 'osm', email: 'mike@mapleridge.com', email_source: 'osm', facts: {} };
  const patch = await enrichProspect(p, { fetchImpl: fakeFetch([]), resolver: okResolver, findWebsite: false });
  assert.equal(patch.website_verified, false);
  assert.equal(patch.website, null);
  assert.equal(patch.facts.website_unverified, 'https://hartwellcpa.com/');
  assert.ok(patch.facts.enrich_notes.some(n => /for a different business/.test(n)));
  const ok = await enrichProspect({ name: 'Willow Creek Family Dentistry', bucket: 'health', website: 'https://willowcreekdental.com/', domain: 'willowcreekdental.com', town: 'Mansfield', source: 'osm', facts: {} }, { fetchImpl: fakeFetch([]), resolver: okResolver });
  assert.equal(ok.website_verified, true);
});

test('CRM card line says what kind of business it is and fits on the card', () => {
  const { cardLine } = require('../lib/outreach/crmnotes');
  assert.equal(cardLine({ facts: { naics: 'Nail Salons (812113)' }, category: 'salon' }), 'Nail salon');
  assert.equal(cardLine({ facts: { naics: 'Residential Remodelers' }, category: 'Builder' }), 'Home remodeling contractor');
  assert.equal(cardLine({ category: 'restaurant' }), 'Restaurant');
  assert.equal(cardLine({ card_line: 'Vegan BBQ food truck', category: 'restaurant' }), 'Vegan BBQ food truck');
  assert.equal(cardLine({}), 'Local business');
});

test('emails that belong to someone else are not used', () => {
  const { emailBelongsElsewhere: e } = require('../lib/outreach/enrich');
  assert.equal(e('rob@dubielcpa.com', 'registry', 'Northeastern Estate Cleanouts & Liquidations'), true);
  assert.equal(e('investorrelations@snapon.com', 'website', 'FCV Tool Supply'), true);
  assert.equal(e('ars@rasi.com', 'registry', 'NES Group'), true);
  assert.equal(e('jordan@apmacct.com', 'registry', 'APM Accounting LLC'), false);
  assert.equal(e('patrick.salkind@coloniallifesales.com', 'registry', 'Salkind Benefit Partners'), false);
  assert.equal(e('owner@gmail.com', 'registry', 'Anything LLC'), false);
});

test('class area: CT, Boston, New York and New England; others stay on the desk', () => {
  const { inClassArea, parsePlace, placeLabel } = require('../lib/outreach/util');
  assert.deepEqual(parsePlace('Boston, MA'), { town: 'Boston', state: 'MA' });
  assert.deepEqual(parsePlace('Mansfield'), { town: 'Mansfield', state: 'CT' });
  assert.equal(inClassArea({ state: 'NY' }), true);
  assert.equal(inClassArea({}), true);
  assert.equal(inClassArea({ state: 'TX' }), false);
  assert.equal(placeLabel({ town: 'Mansfield', state: 'MA' }), 'Mansfield, MA');
  const { composeInitial } = require('../lib/outreach/compose');
  const tx = composeInitial({ id: 't', name: 'Sellmark', town: 'Mansfield', state: 'TX', bucket: 'manufacturing', email: 'a@b.com' }, settings).body;
  assert.doesNotMatch(tx, /Connect\.AI|stop by/);
  const ma = composeInitial({ id: 'm', name: 'Boardwalk Storage', town: 'Mansfield', state: 'MA', bucket: 'trades', email: 'a@b.com' }, settings).body;
  assert.match(ma, /Phone or Zoom|call or do Zoom/);
  assert.doesNotMatch(ma, /stop by/);
});

test('emails read right for businesses in other states', () => {
  const { composeInitial, shortName } = require('../lib/outreach/compose');
  assert.equal(shortName('S.J. Louis Construction of Texas, Limited Partnership'), 'S.J. Louis Construction of Texas');
  const { subject, body } = composeInitial({ id: 'sj', name: 'S.J. Louis Construction of Texas, Limited Partnership', town: 'Mansfield', state: 'TX', bucket: 'trades', email: 'a@b.com', facts: { shop_tools: ['woocommerce'] } }, settings);
  assert.doesNotMatch(subject + body, /Limited Partnership|WooCommerce/);
  assert.doesNotMatch(body, /Connect\.AI/);
  const { parsePlace, stateCode } = require('../lib/outreach/util');
  assert.deepEqual(parsePlace('*, TX'), { town: null, state: 'TX' });
  assert.equal(stateCode('Massachusetts'), 'MA');
});

test('back-office, filing-service and company "names" are not used as contacts', () => {
  const { isFilingAgentEmail } = require('../lib/outreach/sources');
  for (const e of ['accounting@x.com', 'payables@x.com', 'statelicensing@x.com', 'taxdept@x.com', 'info@capitolservices.com', 'ap@x.org']) assert.equal(isFilingAgentEmail(e), true, e);
  for (const e of ['info@rubiconbuilders.com', 'april@x.com', 'jordan@apmacct.com']) assert.equal(isFilingAgentEmail(e), false, e);
  const { cleanPersonName } = require('../lib/outreach/enrich');
  assert.equal(cleanPersonName('Pc Bennett Law Office'), null);
  assert.equal(cleanPersonName('Jason SteelePresident'), 'Jason Steele');
  assert.equal(cleanPersonName('Peter Ponzini Co'), 'Peter Ponzini');
});

test('map businesses: no college departments, no CT filings from other towns, clean emails', () => {
  const { classifyOsm, isChain } = require('../lib/outreach/industries');
  assert.equal(classifyOsm({ name: 'Clark Labs', office: 'yes', website: 'https://www.clarku.edu/geospatial-analytics/' }), null);
  assert.equal(classifyOsm({ name: 'International Center', office: 'yes', email: 'x@springfield.edu' }), null);
  assert.equal(classifyOsm({ name: 'OrthoLazer', healthcare: 'yes' }).category, 'Healthcare practice');
  assert.equal(isChain('Pizzeria Uno'), true);
  const { registryIsLocal, cleanPersonName } = require('../lib/outreach/enrich');
  assert.equal(registryIsLocal({ name: 'FLOUR LLC', city: 'Woodstock', state: 'CT' }, { name: 'Flour', town: 'Cambridge', state: 'MA' }), false);
  assert.equal(registryIsLocal({ name: 'GIOVANNI LLC', city: 'Danbury', state: 'CT' }, { name: 'Giovanni', town: 'Manhattan', state: 'NY' }), false);
  assert.equal(registryIsLocal({ name: 'X LLC', city: 'New York', state: 'NY' }, { name: 'X', town: 'Manhattan', state: 'NY' }), true);
  assert.equal(registryIsLocal({ name: 'X LLC', city: 'Mansfield', state: 'CT' }, { name: 'X', town: 'Mansfield' }), true);
  assert.equal(cleanEmail('hire844-394-2692info@1stoprecruiting.com'), 'info@1stoprecruiting.com');
  assert.equal(cleanEmail('431-7682fireflypotterynh@gmail.com'), 'fireflypotterynh@gmail.com');
  assert.equal(cleanEmail('02909info@thermiapvd.com'), 'info@thermiapvd.com');
  assert.equal(cleanEmail('jamie311@gmail.com'), 'jamie311@gmail.com');
  assert.equal(cleanPersonName('Mark Murphy Mark'), 'Mark Murphy');
});

test('CT businesses from the registry still get the come-by-in-person line', () => {
  const { composeInitial } = require('../lib/outreach/compose');
  const vernon = composeInitial({ id: 'v', name: 'Forte Accounting, LLC', town: 'Vernon', bucket: 'professional', email: 'a@b.com' }, settings).body;
  assert.match(vernon, /stop by|come by/);
  const far = composeInitial({ id: 'f', name: 'Far Shop', town: 'Greenwich', bucket: 'retail', email: 'a@b.com' }, settings).body;
  assert.doesNotMatch(far, /stop by/);
  assert.match(far, /Phone or Zoom|call or do Zoom/);
});

test("a website for a different business with a shared common word doesn't count", () => {
  const whale = [{ title: 'Plumbing, Heating & Air | Call the Whale', text: 'Call the Whale is a top-rated plumbing, heating and air service provider in Burlington, Vermont.' }];
  assert.equal(siteMatchesBusiness(whale, 'Call the Frog LLC'), false);
  assert.equal(siteMatchesBusiness(whale, 'Call the Whale LLC'), true);
  const plumber = [{ title: 'Smith Plumbing', text: 'Smith Plumbing and Heating serves Coventry.' }];
  assert.equal(siteMatchesBusiness(plumber, 'Smith Plumbing & Heating LLC'), true);
  assert.equal(siteMatchesBusiness(plumber, 'Jones Plumbing LLC'), false);
});

test('drafts that might be the wrong business go to "needs a look", not review', () => {
  const { readinessProblems } = require('../lib/outreach/verify');
  const frog = { name: 'Call the Frog LLC', town: 'Williston', state: 'VT', source: 'registry', email: 'info@callthewhale.com', domain: null,
    registry: { location_from: 'mailing', mailing_state: 'VT' } };
  assert.equal(readinessProblems(frog).length, 2);
  const frogCT = { ...frog, town: 'Groton', state: 'CT' };
  assert.equal(readinessProblems(frogCT).length, 2);
  assert.deepEqual(readinessProblems({ name: "Joe's Pizza LLC", town: 'Mansfield', state: 'CT', email: 'joe@joespizzact.com', domain: 'joespizzact.com' }), []);
  assert.deepEqual(readinessProblems({ name: 'Smith Plumbing', town: 'Coventry', state: 'CT', email: 'smithplumbing@gmail.com' }), []);
  assert.deepEqual(readinessProblems({ name: 'Brand Pet Company LLC', town: 'Vernon', state: 'CT', email: 'cbrandaci@gmail.com', source: 'registry', registry: { location_from: 'office' } }), []);
  const { siteMatchesPlace } = require('../lib/outreach/enrich');
  const whale = [{ title: 'Call the Whale', text: 'Serving the greater Burlington, Vermont area. 4735 Williston Rd #30, Williston, VT 05495' }];
  assert.equal(siteMatchesPlace(whale, { town: 'Groton', state: 'CT' }), false);
  assert.equal(siteMatchesPlace(whale, { town: 'Williston', state: 'VT' }), true);
});

test('greets by name only when the name is confirmed, not just from the state filing', () => {
  const { composeInitial } = require('../lib/outreach/compose');
  const base = { id: 'ac', name: 'Air Control Mechanical LLC', town: 'Ellington', bucket: 'trades', contact_name: 'Antonio Melendez', registry_id: 'r1' };
  const filingOnly = { ...base, email: 'office@aircontrolmech.com', facts: { people: [{ name: 'Antonio Melendez', how: 'state filing' }, { name: 'Jordan Vallee', how: 'state filing' }] } };
  // On the filing but not tied to office@: not used.
  assert.match(composeInitial(filingOnly, settings).body, /^Hi Air Control Mechanical team,/);
  // The filing also lists this email, and it has two people: both are greeted.
  assert.match(composeInitial({ ...filingOnly, email_source: 'registry' }, settings).body, /^Hi Antonio and Jordan,/);
  assert.match(composeInitial({ ...filingOnly, email: 'jessicam@aircontrolmech.com' }, settings).body, /^Hi Air Control Mechanical team,/);
  assert.match(composeInitial({ ...filingOnly, facts: { people: [] } }, settings).body, /^Hi Air Control Mechanical team,/);
  assert.match(composeInitial({ ...filingOnly, email_source: 'registry', facts: { people: [{ name: 'Antonio Melendez', how: 'state filing' }] } }, settings).body, /^Hi Antonio,/);
  assert.match(composeInitial({ ...filingOnly, facts: { people: [{ name: 'A B', how: 'state filing' }, { name: 'C D', how: 'state filing' }, { name: 'E F', how: 'state filing' }] } }, settings).body, /^Hi Air Control Mechanical team,/);
  const onSite = { ...filingOnly, facts: { people: [{ name: 'Antonio Melendez', how: 'site text', url: 'https://aircontrolmech.com/about' }] } };
  assert.match(composeInitial(onSite, settings).body, /^Hi Antonio,/);
  const ownEmail = { ...base, email: 'amelendez@aircontrolmech.com', facts: { people: [{ name: 'Antonio Melendez', how: 'state filing' }] } };
  assert.match(composeInitial(ownEmail, settings).body, /^Hi Antonio,/);
});

test('larger companies are caught by what their own site says', () => {
  const { bigCompanySignals } = require('../lib/outreach/enrich');
  const { readinessProblems } = require('../lib/outreach/verify');
  const nexdine = 'NEXDINE Hospitality serves corporate dining, education and senior living clients across six states. Leadership: David Lanci, Chief Executive Officer. David Chechik, Chief Growth Officer. Over 1,500 team members.';
  const sig = bigCompanySignals(nexdine);
  assert.ok(sig.length >= 3, sig.join(' | '));
  assert.equal(readinessProblems({ name: 'Nexdine LLC', town: 'Mansfield', state: 'MA', email: 'david@nexdinehospitality.com', domain: 'nexdinehospitality.com', facts: { big_signals: sig } }).length, 1);
  assert.deepEqual(bigCompanySignals("Family-owned since 1998. Our team of 8 serves Coventry and Tolland. Call us at 860-555-1212. We're hiring!"), []);
  assert.deepEqual(bigCompanySignals('We have served 2,500 happy customers in Connecticut.'), []);
});

test('every fact read off a website keeps the page it came from; facts with no page are dropped', () => {
  const { extractFacts, factSources, keepSourced } = require('../lib/outreach/enrich');
  const page = (url, text, links = []) => ({ url, text, html: text, paragraphs: [], jsonld: [], links, emails: [] });
  const pages = [
    page('https://x.com/', 'Welcome. Request a free estimate today. © 2026', [{ url: 'https://facebook.com/xco', label: 'fb' }]),
    page('https://x.com/about', 'We are a family-owned shop, established in 1987. Now hiring!'),
  ];
  const facts = extractFacts(pages, 'trades');
  facts.sources = factSources(pages, 'trades', facts);
  assert.equal(facts.sources.quote_requests, 'https://x.com/');
  assert.equal(facts.sources.family_owned, 'https://x.com/about');
  assert.equal(facts.sources.founded, 'https://x.com/about');
  assert.equal(facts.sources.hiring, 'https://x.com/about');
  assert.equal(facts.sources['socials:facebook'], 'https://facebook.com/xco');
  const kept = keepSourced({ ...facts, catering: true, sources: { ...facts.sources } });
  assert.equal(kept.catering, undefined, 'no page says it, so it goes');
  assert.equal(kept.family_owned, true);
});

test('Dr. is used only when a source shows the person is a doctor; otherwise a practice gets the team greeting', () => {
  const { greeting } = require('../lib/outreach/compose');
  const { doctorEvidence } = require('../lib/outreach/enrich');
  const filed = (...people) => ({ people: people.map(x => ({ how: 'state filing', role: 'principal', business_id: 'x', ...(typeof x === 'string' ? { name: x } : x) })) });
  const ortho = { name: 'Mansfield Orthodontics PLLC', category: 'Dentist', email: 'info@mansfieldorthodonticsct.com' };
  assert.equal(greeting({ ...ortho, facts: filed('Susan Davis') }), 'Hi Mansfield Orthodontics team,', 'no source says she is the doctor');
  assert.equal(greeting({ ...ortho, facts: filed({ name: 'Susan Davis', doctor_url: 'https://mansfieldorthodonticsct.com/about' }) }), 'Hi Dr. Davis,');
  assert.equal(greeting({ name: 'Ralph J Laguardia M.D.', email: 'r@gmail.com', facts: filed('Ralph Laguardia') }), 'Hi Dr. Laguardia,', 'the registered business name says M.D.');
  assert.equal(greeting({ name: 'Eastside Family Dental', email: 'office@eastside.com', facts: filed({ name: 'Ann Lee', doctor_url: 'u' }, { name: 'Raj Patel', doctor_url: 'u' }) }), 'Hi Dr. Lee and Dr. Patel,');
  assert.equal(greeting({ name: 'Air Control Mechanical LLC', email: 'office@aircontrolmech.com', email_source: 'registry', facts: filed('Antonio Melendez', 'Jordan Vallee') }), 'Hi Antonio and Jordan,', 'everyone else keeps first names');
  const page = text => [{ url: 'https://x.com/team', text }];
  assert.equal(doctorEvidence('Susan Davis', page('Meet Dr. Susan Davis, our orthodontist')), 'https://x.com/team');
  assert.equal(doctorEvidence('Susan Davis', page('Susan M. Davis, D.M.D.')), 'https://x.com/team');
  assert.equal(doctorEvidence('Susan Davis', page('Susan Davis, office manager')), null);
  assert.equal(doctorEvidence('Susan Davis', page('Dr. Smith and Susan Davis')), null);
});

test('opens are matched to the email that was sent, and automatic loads are marked', () => {
  const { opensFor } = require('../scripts/outreach-opens');
  const doc = { tracked: [{ id: 'acme.i1', kind: 'intro', at: '2026-10-30T13:00:00.000Z' }] };
  const hits = [
    { id: 'acme.i1', at: '2026-10-30T13:01:00.000Z', network: 'Google LLC', agent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' },
    { id: 'acme.i1', at: '2026-10-30T15:20:00.000Z', network: 'Microsoft Corporation', city: 'Hartford', agent: 'Mozilla/5.0' },
    { id: 'acme.i1', at: '2026-10-30T16:00:00.000Z', network: 'Apple Inc.', agent: 'Mozilla/5.0' },
    { id: 'other.i1', at: '2026-10-30T16:00:00.000Z', network: 'Google LLC', agent: 'x' },
  ];
  const opens = opensFor(doc, hits);
  assert.equal(opens.length, 3);
  assert.equal(opens[0].likely_auto, true, 'a minute after sending: your own copy or a scanner');
  assert.equal(opens[1].likely_auto, undefined);
  assert.equal(opens[1].where, 'Outlook / Microsoft, Hartford');
  assert.equal(opens[1].what, 'intro email opened');
  assert.equal(opens[2].likely_auto, true, 'Apple Mail privacy proxy');
});

test('reply check: people count, auto-responders do not, and Soham gets an email', () => {
  const { planReplies } = require('../lib/outreach/replies');
  const docs = [
    { id: 'rab', name: 'Recycle-a-Bike', email: 'shop@recycleabike.org', status: 'sent', log: [] },
    { id: 'buzz', name: 'Buzz Beads, LLC', email: 'kts.santiago@gmail.com', contact_name: 'Karen Santiago', status: 'sent', crm_org_id: 'org1', log: [] },
    { id: 'kl', name: 'Katie Louise Photography LLC', email: 'katie@katielouise.co', status: 'sent', log: [] },
    { id: 'old', name: 'Old Reply Co', email: 'a@old.com', status: 'replied', replied_at: '2026-10-30T10:00:00Z', reply_snippet: 'Sure', reply_msg_ids: ['m0'], log: [] },
  ];
  const threads = [
    { id: 't1', messages: [{ id: 'm1', sender: 'shop@recycleabike.org', subject: 'Thank you for contacting RAB! Re: UConn student', snippet: 'We got your message' }] },
    { id: 't2', messages: [{ id: 'm2', sender: 'Karen <kts.santiago@gmail.com>', subject: 'Re: UConn student question about Buzz Beads', snippet: 'Thanks for reaching out! Tuesday works.' }] },
    { id: 't3', messages: [{ id: 'm3', sender: 'katie@katielouise.co', subject: 'Re: UConn student', snippet: 'No thanks, we are all set.' }] },
  ];
  const { updates, notify } = planReplies(docs, threads, '2026-10-30T15:00:00.000Z', SOHAM);
  const by = id => updates.find(u => u.id === id).data;
  assert.equal(by('rab').status, undefined, 'auto-reply leaves the status alone');
  assert.ok(by('rab').auto_reply_at);
  assert.equal(by('buzz').status, 'replied');
  assert.equal(by('kl').status, 'not_interested');
  assert.equal(by('old').reply_notified_at, '2026-10-30T15:00:00.000Z', 'a reply the desk caught earlier still gets an email');
  assert.deepEqual(notify.map(n => n.id).sort(), ['buzz', 'kl', 'old']);
  const buzz = notify.find(n => n.id === 'buzz');
  assert.deepEqual(buzz.to, ['soham.shah@uconn.edu', 'shahsoham689@gmail.com']);
  assert.match(buzz.subject, /Karen Santiago at Buzz Beads replied/);
  assert.match(buzz.body, /mail\.google\.com\/mail\/u\/0\/#all\/t2/);
  assert.equal(buzz.crm.org, 'org1');
  const fixed = planReplies([{ id: 'r', name: 'RAB', email: 'shop@rab.org', status: 'replied', replied_at: '2026-10-30T14:30:00Z', reply_snippet: 'Thank you for contacting RAB! Re: UConn student', reply_msg_ids: ['x'], log: [] }], [], '2026-10-30T15:00:00Z');
  assert.equal(fixed.notify.length, 0, 'no email about an auto-reply');
  assert.equal(fixed.updates[0].data.status, 'sent');
  // Running again finds nothing new.
  const after = docs.map(d => ({ ...d, ...(updates.find(u => u.id === d.id) || {}).data }));
  assert.equal(planReplies(after, threads).notify.length, 0);
});

test('follow-ups: one, in the same thread, after 4 business days with no reply', () => {
  const { planFollowups } = require('../scripts/outreach-followups');
  const now = new Date('2026-11-03T13:15:00Z'); // Tuesday
  const base = { email: 'x@y.com', thread_id: 't', subject: 'UConn student question about Buzz Beads', body: 'Dr. Smith,\n\nhi', log: [] };
  const docs = [
    { ...base, id: 'due', name: 'Buzz Beads, LLC', status: 'sent', sent_at: '2026-10-28T12:20:00Z', body: 'Hi Karen,\n\nI\'m Soham', crm_org_id: 'o1' },
    { ...base, id: 'fresh', name: 'Fresh', status: 'sent', sent_at: '2026-10-30T12:20:00Z' },
    { ...base, id: 'replied', name: 'Replied', status: 'replied', sent_at: '2026-10-20T12:20:00Z' },
    { ...base, id: 'done', name: 'Done', status: 'followed_up', sent_at: '2026-10-20T12:20:00Z', followup_at: '2026-10-26T12:00:00Z' },
  ];
  const plan = planFollowups(docs, { now, settings: mergeSettings(SOHAM) });
  assert.deepEqual(plan.map(p => p.id), ['due']);
  const f = plan[0];
  assert.equal(f.subject, 'Re: UConn student question about Buzz Beads');
  assert.equal(f.thread_id, 't');
  assert.match(f.body, /^Hi Karen,\n\nJust bumping this/);
  assert.doesNotMatch(f.body, /;/);
  assert.equal(f.after.status, 'followed_up');
  assert.equal(f.crm.update.next_step_due, '2026-11-10');
});

test('pre-send check: names must fit the address, and nothing passes without loading the site', async () => {
  const { nameFitsAddress, preflight } = require('../scripts/outreach-preflight');
  assert.equal(nameFitsAddress('Steve Smith', 'barry@fentonrivergrill.com'), false);
  assert.equal(nameFitsAddress('Karen Santiago', 'kts.santiago@gmail.com'), true);
  assert.equal(nameFitsAddress('Jennifer Dubois', 'jenn@mindoverbody-fitness.com'), true);
  assert.equal(nameFitsAddress('Katie Wilcock', 'katie@katielouise.co'), true);
  assert.equal(nameFitsAddress('Michael Lamothe', 'info@pizzamikes.com'), true);
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('blocked'); };
  try {
    await assert.rejects(preflight({ id: 'x', name: 'X Co', town: 'Mansfield', state: 'CT', source: 'osm', website: 'https://x.example', email: 'info@x.example', email_source: 'website', status: 'ready', body: 'Hi X team,\n\nhi', log: [] }, {}), /couldn't load/);
  } finally { global.fetch = realFetch; }
});

test('greeting uses the short name the business goes by, never a random word', () => {
  const { greeting } = require('../lib/outreach/compose');
  const g = (n, c) => greeting({ name: n, contact_name: c, email: 'a@gmail.com', email_source: 'registry', facts: { people: [{ name: c, how: 'state filing', business_id: 'x' }] }, registry_id: 'x' });
  assert.equal(g('Doug Victor Electric LLC', 'Douglas Victor'), 'Hi Doug,');
  assert.equal(g('Man Cave Barbershop', 'Manuel Ortiz'), 'Hi Manuel,');
});

test('a name from the state filing is used only when it can be tied to the email address', () => {
  const { confirmName } = require('../lib/outreach/factsources');
  const fp = [{ name: 'Julie Gauthier', how: 'state filing', business_id: 'b' }];
  assert.match(confirmName({ email: 'juliegauthiernyc@gmail.com', email_source: 'website', facts: { people: fp } }, 'Julie Gauthier').how, /email address is theirs/);
  assert.equal(confirmName({ email: 'info@x.com', email_source: 'website', facts: { people: fp } }, 'Julie Gauthier'), null);
  assert.match(confirmName({ email: 'x@gmail.com', email_source: 'registry', facts: { people: fp } }, 'Julie Gauthier').how, /only person on the state filing/);
  const three = ['A Bee', 'C Dee', 'E Eff'].map(name => ({ name, how: 'state filing', business_id: 'b' }));
  assert.equal(confirmName({ email: 'x@gmail.com', email_source: 'registry', facts: { people: three } }, 'A Bee'), null);
});

test('a name is never used when the address is clearly someone else\'s', () => {
  const { confirmName } = require('../lib/outreach/factsources');
  const steve = { name: 'Fenton River Grill, LLC', email: 'barry@fentonrivergrill.com', facts: { people: [{ name: 'Steve Smith', url: 'https://fentonrivergrill.com/about' }] } };
  assert.equal(confirmName(steve, 'Steve Smith'), null);
  assert.ok(confirmName({ ...steve, email: 'info@fentonrivergrill.com' }, 'Steve Smith'));
  const doc = { name: 'Ralph J Laguardia M.D.', email: 'rjlpc7@gmail.com', email_source: 'registry', facts: { people: [{ name: 'Ralph Laguardia', how: 'state filing', business_id: 'b' }] } };
  assert.ok(confirmName(doc, 'Ralph Laguardia'), 'initials of the business name');
});


test('emails are spread across the day, a share per hourly run', () => {
  const { sendSlot } = require('../scripts/send-slot');
  const at = h => new Date(`2026-11-09T${String(h + 5).padStart(2, '0')}:17:00Z`); // EST
  const first = sendSlot({ limit: 40, sentToday: 0, followupsDue: 9, now: at(8), random: () => 0.5 });
  assert.equal(first.slots_left, 8);
  assert.equal(first.first_quota, 5);
  assert.equal(first.followup_quota, 2);
  assert.equal(first.gaps_min.length, 6);
  assert.ok(first.gaps_min.every(g => g >= 3 && g <= 8));
  assert.ok(first.first_run && !first.last_run);
  const last = sendSlot({ limit: 40, sentToday: 37, followupsDue: 1, now: at(15) });
  assert.equal(last.first_quota, 3);
  assert.ok(last.last_run);
  assert.equal(sendSlot({ limit: 30, sentToday: 30, now: at(12) }).first_quota, 0);
});

test('CRM notes say the email went out, and the timeline gets the whole email', () => {
  const { crmNotesNow, emailStatus } = require('../lib/outreach/crmnotes');
  const { crmEntry } = require('../scripts/crm-entry');
  const p = { name: 'Car Corner LLC', email: 'carcorner@aol.com', subject: 'UConn student question about Car Corner', body: 'Hi Car Corner team,\n\nHello.',
    crm_notes: "What they do: used cars (source: x)\nFound by Soham's outreach research (fit 70/100). Intro email drafted; not sent yet." };
  assert.match(emailStatus({ ...p, sent_at: '2026-11-02T14:00:00Z', status: 'sent' }), /Intro email sent Nov 2 to carcorner@aol.com\. No reply yet\./);
  const notes = crmNotesNow({ ...p, sent_at: '2026-11-02T14:00:00Z', followup_at: '2026-11-06T15:00:00Z', status: 'followed_up' });
  assert.doesNotMatch(notes, /not sent yet/);
  assert.match(notes, /fit 70\/100\)\. Intro email sent Nov 2 to carcorner@aol\.com\. Followed up Nov 6\. No reply yet\.$/);
  const e = crmEntry(p, { sentAt: '2026-11-02T14:00:00Z' });
  assert.match(e.touchpoint.body, /Subject: UConn student question about Car Corner\n\nHi Car Corner team,/);
  assert.equal(e.add_contact.full_name, 'Car Corner (main email)');
  assert.equal(e.add_contact.email, 'carcorner@aol.com');
  assert.equal(crmEntry(p, { hasContacts: true }).add_contact, null);
});

test('no email line compares a business to big chains or competitors', () => {
  const { PUT_DOWN } = require('../scripts/outreach-preflight');
  const { BUCKETS } = require('../lib/outreach/industries');
  const lines = Object.entries(BUCKETS).map(([k, v]) => [k, v.interest || '']);
  assert.ok(lines.length > 3);
  for (const [k, line] of lines) assert.doesNotMatch(line, PUT_DOWN, k);
  assert.match('how independent shops keep going against the big chains and online stores', PUT_DOWN);
});

test('a CT business id in source_ref links to the filing, never to a fake map URL', () => {
  const { sourceUrl } = require('../lib/outreach/factsources');
  const p = { source: 'registry', source_ref: '0018y00000Ab6epAAB', address: '57 Parker Road', facts: {} };
  const u = sourceUrl(p, 'address');
  assert.doesNotMatch(String(u), /openstreetmap/);
  assert.match(String(u), /data\.ct\.gov.*0018y00000Ab6epAAB/);
});

test("open times come from Soham's calendar, skip busy blocks, and the reply doesn't pitch Connect.AI", () => {
  const { busyBlocks, openSlots, slotText } = require('../lib/outreach/calendar');
  const { meetingReply } = require('../scripts/meeting-reply');
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Eastern Standard Time:20260901T140000\r\nDTEND;TZID=Eastern Standard Time:20260901T151500\r\nRRULE:FREQ=WEEKLY;UNTIL=20261211T050000Z;BYDAY=TU,TH\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Private thing\r\nDTSTART;TZID=Eastern Standard Time:20261104T140000\r\nDTEND;TZID=Eastern Standard Time:20261104T150000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const now = new Date('2026-11-03T16:00:00Z');
  const busy = busyBlocks(ics, now, new Date('2026-11-20T00:00:00Z'));
  assert.ok(busy.some(b => b.start === '2026-11-05T19:00:00.000Z'), 'Thursday class at 2pm');
  assert.ok(!JSON.stringify(busy).includes('Private'), 'no event names');
  const slots = openSlots(busy, { now }).map(slotText);
  assert.deepEqual(slots, ['Wednesday, Nov 4 at 4pm', 'Thursday, Nov 5 at 4pm']);
  const r = meetingReply({ name: 'Levareit LLC', body: 'Hi Rene,\n\n...' }, { busy, fetched_at: now.toISOString() }, { now, settings: SOHAM });
  assert.match(r.body, /^Hi Rene,/);
  assert.match(r.body, /- Wednesday, Nov 4 at 4pm\n- Thursday, Nov 5 at 4pm/);
  assert.equal(r.slot_text.length, 3);
  assert.match(r.slot_text.join(' '), /at (6|6:30|7)pm/);
  assert.doesNotMatch(r.body, /Connect\.AI/);
  assert.match(r.body, /Levareit got started/);
  assert.ok(meetingReply({ name: 'X', body: 'Hi X,' }, { busy, fetched_at: '2026-10-01T00:00:00Z' }, { now }).skip);
});

test('the reply-ready email shows the draft and carries an approve link tied to that one draft', () => {
  const { replyNotice, CODE } = require('../scripts/reply-notice');
  const p = { name: 'Levareit LLC', contact_name: 'Rene Burce', email: 'reneburce@yahoo.com', reply_draft: 'Hi Rene,\n\nHere are a few times...' };
  const n = replyNotice(p, 'Hi Soham, sure, we can connect via Teams.', { draftId: 'r1', draftUrl: 'https://mail.google.com/x', code: 'A7K2Q9', settings: SOHAM });
  assert.equal(n.subject, 'Rene Burce at Levareit wants to talk. Your reply is ready');
  assert.match(n.body, /sure, we can connect via Teams/);
  assert.match(n.body, /Here are a few times/);
  assert.match(n.htmlBody, /mailto:shahsoham689@gmail\.com\?subject=Approve%20reply%20to%20Rene%20Burce%20%5BA7K2Q9%5D/);
  assert.equal(CODE.exec('Approve reply to Rene Burce [A7K2Q9]')[1], 'A7K2Q9');
  assert.deepEqual(n.to, ['soham.shah@uconn.edu', 'shahsoham689@gmail.com']);
});

test('with a desk link, the reply-ready email has a Send it button that opens the desk on that reply', () => {
  const { replyNotice } = require('../scripts/reply-notice');
  const p = { id: 'levareit-ellington', name: 'Levareit LLC', contact_name: 'Rene Burce', email: 'r@y.com', reply_draft: 'Hi Rene' };
  const n = replyNotice(p, 'Sure', { draftUrl: 'https://mail.google.com/x', code: 'A7K2Q9', settings: { ...SOHAM, desk_url: 'https://claude.ai/artifact/abc' } });
  assert.match(n.htmlBody, /href="https:\/\/claude\.ai\/artifact\/abc#send-levareit-ellington"[^>]*>Send it</);
  assert.doesNotMatch(n.htmlBody, /mailto:shahsoham689/);
  assert.match(n.body, /tap Send it: https:\/\/claude\.ai\/artifact\/abc#send-levareit-ellington/);
});

test('a reply from a different address in the same Gmail thread still counts', () => {
  const { planReplies } = require('../lib/outreach/replies');
  const p = { id: 'wet-pets', name: 'Wet Pets', email: 'donscleanaquarium@gmail.com', contact_name: 'Donald Allen', status: 'sent', thread_id: 't9', log: [] };
  const threads = [{ id: 't9', messages: [
    { id: 'm1', sender: 'shahsoham689@gmail.com', labelIds: ['SENT'], snippet: 'Hi Wet Pets team' },
    { id: 'm2', sender: 'don@wetpetsemporium.com', labelIds: ['INBOX'], snippet: 'Give me a call today' },
  ] }];
  const { updates, notify } = planReplies([p], threads, '2026-11-06T16:00:00Z', SOHAM);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields ? updates[0].fields.status : (updates[0].data || updates[0]).status, 'replied');
  assert.equal(notify.length, 1);
  // The student's own messages in the thread never count as a reply.
  assert.equal(planReplies([p], [{ id: 't9', messages: [threads[0].messages[0]] }], '2026-11-06T16:00:00Z', SOHAM).updates.length, 0);
});

// ---------- each student's own profile ----------

const MAYA = {
  sender_name: 'Maya Lin', sender_major: 'finance',
  school_email: 'maya.lin@uconn.edu', sender_email: 'mayalin.outreach@gmail.com',
  linkedin_url: 'https://linkedin.com/in/maya-lin',
  background: '', why: "I'd like to run a business of my own one day.",
};
const NOT_SOHAM = /soham|henkel|andersen|shahsoham/i;

test("Soham's profile builds the same signature he had written by hand", () => {
  const { profileOf } = require('../lib/outreach/settings');
  const p = profileOf(SOHAM);
  assert.equal(p.signature, 'Soham Shah\nAccounting, University of Connecticut\nsoham.shah@uconn.edu · linkedin.com/in/soham-shah-uconn');
  assert.equal(p.first_name, 'Soham');
  assert.deepEqual(p.notify_emails, ['soham.shah@uconn.edu', 'shahsoham689@gmail.com']);
  assert.deepEqual(profileOf({ ...SOHAM, notify_emails: ['me@x.com'] }).notify_emails, ['me@x.com']);
  assert.equal(profileOf({ ...SOHAM, signature: 'Just me' }).signature, 'Just me');
});

test("another student's profile leaves no trace of Soham anywhere", () => {
  const { profileOf } = require('../lib/outreach/settings');
  const { notifyTo, planReplies } = require('../lib/outreach/replies');
  const { buildCrmNotes, crmNotesNow } = require('../lib/outreach/crmnotes');
  const { planFollowups } = require('../scripts/outreach-followups');
  const { meetingReply } = require('../scripts/meeting-reply');
  const { replyNotice } = require('../scripts/reply-notice');
  const { mailBodies } = require('../scripts/mail-bodies');
  const maya = mergeSettings(MAYA);
  assert.equal(profileOf(maya).signature, 'Maya Lin\nFinance, University of Connecticut\nmaya.lin@uconn.edu · linkedin.com/in/maya-lin');
  assert.deepEqual(notifyTo(maya), ['maya.lin@uconn.edu', 'mayalin.outreach@gmail.com']);

  for (let i = 0; i < 9; i++) {
    const { subject, body } = composeInitial({ ...dentist, id: `maya-${i}`, name: `Shop ${i}` }, maya);
    assert.doesNotMatch(subject + body, NOT_SOHAM);
    assert.match(subject, /UConn student/);
    assert.match(body, /Maya/);
    assert.match(body, /finance/);
    assert.match(body, /run a business of my own one day/);
    assert.match(body, /Thanks,\nMaya Lin\nFinance, University of Connecticut\nmaya\.lin@uconn\.edu · linkedin\.com\/in\/maya-lin$/);
    assert.doesNotMatch(body, / {2}|\n{3}|undefined|null| \./);
  }
  assert.match(composeFollowup(dentist, maya, 'Hi').body, /Thanks,\nMaya$/);

  const notes = buildCrmNotes({ name: 'Shop', town: 'Mansfield', fit_score: 60 }, maya);
  assert.match(notes, /Found by Maya Lin's outreach research \(fit 60\/100\)\./);
  assert.match(crmNotesNow({ crm_notes: notes, email: 'a@b.com', sent_at: '2026-11-02T14:00:00Z', status: 'sent' }, maya), /Found by Maya Lin's outreach research \(fit 60\/100\)\. Intro email sent Nov 2/);
  assert.match(buildCrmNotes({ name: 'Shop', town: 'Mansfield' }), /Found by outreach research\./);

  const now = new Date('2026-11-03T13:15:00Z');
  const [f] = planFollowups([{ id: 'd', name: 'Buzz Beads', email: 'x@y.com', thread_id: 't', subject: 'S', body: 'Hi Karen,\n\nhi', status: 'sent', sent_at: '2026-10-28T12:20:00Z', log: [] }], { now, settings: maya });
  assert.deepEqual(f.cc, ['maya.lin@uconn.edu']);
  assert.doesNotMatch(JSON.stringify(f), NOT_SOHAM);
  assert.deepEqual(planFollowups([{ id: 'd', name: 'B', email: 'x@y.com', thread_id: 't', subject: 'S', status: 'sent', sent_at: '2026-10-28T12:20:00Z', log: [] }], { now, settings: mergeSettings({}) })[0].cc, [], 'no school email, no cc');

  const busy = [];
  const r = meetingReply({ name: 'Levareit LLC', body: 'Hi Rene,\n\n...' }, { busy, fetched_at: now.toISOString() }, { now, settings: maya });
  assert.match(r.body, /Thanks,\nMaya$/);
  assert.match(meetingReply({ name: 'X' }, null, { now }).skip, /^Your calendar/);

  const n = replyNotice({ name: 'Levareit LLC', contact_name: 'Rene Burce', email: 'r@y.com', reply_draft: 'Hi Rene' }, 'Sure', { draftUrl: 'u', code: 'A7K2Q9', settings: maya });
  assert.match(n.htmlBody, /mailto:mayalin\.outreach@gmail\.com\?/);
  assert.deepEqual(n.to, ['maya.lin@uconn.edu', 'mayalin.outreach@gmail.com']);

  const { notify } = planReplies([{ id: 'b', name: 'Buzz', email: 'k@b.com', status: 'sent', log: [] }],
    [{ id: 't', messages: [{ id: 'm', sender: 'k@b.com', subject: 'Re: hi', snippet: 'Tuesday works.' }] }], '2026-10-30T15:00:00Z', maya);
  assert.deepEqual(notify[0].to, ['maya.lin@uconn.edu', 'mayalin.outreach@gmail.com']);
  assert.doesNotMatch(JSON.stringify(notify), NOT_SOHAM);

  const mb = mailBodies('Thanks,\nMaya Lin\nmaya.lin@uconn.edu · https://www.linkedin.com/in/maya-lin/', maya);
  assert.match(mb.body, /maya\.lin@uconn\.edu · linkedin\.com\/in\/maya-lin$/);
  assert.match(mb.htmlBody, /<a href="mailto:maya\.lin@uconn\.edu">maya\.lin@uconn\.edu<\/a> · <a href="https:\/\/www\.linkedin\.com\/in\/maya-lin">LinkedIn<\/a>/);
  assert.equal(mailBodies('plain text', {}).htmlBody, '<div>plain text</div>');
});

test('an empty background (or an empty profile) is skipped cleanly', () => {
  const blankAll = mergeSettings({});
  for (let i = 0; i < 9; i++) {
    const p = { ...dentist, id: `blank-${i}`, name: `Place ${i}` };
    const noBg = composeInitial(p, mergeSettings({ ...SOHAM, background: '' })).body;
    assert.doesNotMatch(noBg, /Henkel|Andersen/);
    assert.match(noBg, /start my own business/);
    assert.doesNotMatch(noBg, / {2}|\n{3}| \./);
    const empty = composeInitial(p, blankAll);
    assert.doesNotMatch(empty.subject + empty.body, NOT_SOHAM);
    assert.doesNotMatch(empty.body, / {2}|\n{3}|undefined|null| \.|I'm ,|My name's ,/);
    assert.match(empty.body, /student at UConn|I'm a student/);
    assert.match(empty.body, /\n\nThanks,$/);
    assert.match(empty.subject, /UConn student/);
  }
});
