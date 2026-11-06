// A one-page PDF to read before calling an owner who wrote back: who they
// are, what the business does (each fact with where it came from), what they
// said, what you've sent them, and a few questions to ask. Attached to the
// "wrote back" email and the text to your phone. Built with the PDF's own
// fonts so the file stays a few KB (it gets passed through Gmail each time).
//
//   node scripts/call-brief.js <prospect JSON> <their message .txt> <out.pdf> [settings JSON] [--at <ISO time they replied>] [--phone <their number>]
//     → writes the PDF and prints {"pdf": "<path>", "bytes": n}

const fs = require('fs');
const { profileOf, loadSettings } = require('../lib/outreach/settings');

const day = iso => iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
// The built-in PDF fonts only cover Latin-1 (plus a few quotes and dashes).
const latin = s => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
const bizName = n => String(n || '').replace(/,?\s+(LLC|L\.L\.C\.|Inc\.?|PLLC|Corp\.?)$/i, '');

// "What they do: ... (source: https://...)" lines from the research notes.
function factLines(p) {
  const out = [];
  for (const line of String(p.crm_notes || '').split('\n')) {
    const m = /^([^:]{2,40}):\s*(.+?)(?:\s*\(source:\s*(\S+?)\))?\s*$/.exec(line.trim());
    if (!m || /^(Email|Contact)$/i.test(m[1]) || /^Found by/i.test(line.trim())) continue;
    out.push({ label: m[1], text: m[2], src: m[3] || null });
  }
  if (!out.length) {
    if (p.card_line) out.push({ label: 'What they do', text: p.card_line, src: p.website || null });
    if (p.address || p.town) out.push({ label: 'Where', text: p.address || p.town, src: null });
    if (p.facts && p.facts.founded) out.push({ label: 'In business since', text: String(p.facts.founded), src: (p.facts.sources || {}).founded || null });
  }
  return out.slice(0, 8);
}

function questions(p) {
  const f = p.facts || {};
  const qs = [
    `How did you get started with ${bizName(p.name) || 'the business'}? Did you work for someone else first?`,
    'What made you decide to go out on your own?',
    'What does a normal week look like, and how much of it is the business side (quotes, invoices, scheduling)?',
    'What part of running it do you like least?',
    'What do you wish you had known when you started?',
  ];
  if (!p.website) qs.splice(3, 0, 'How do new customers find you without a website? Word of mouth?');
  else if (f.booking_tools && !f.booking_tools.length) qs.splice(3, 0, 'How do people book or reach you right now, mostly by phone?');
  return qs.slice(0, 6);
}

function writeBrief(p, message, out, { settings = {}, receivedAt = null, phone = null } = {}) {
  const PDFDocument = require('pdfkit');
  const prof = profileOf(settings);
  const who = p.contact_name || 'the owner';
  const first = who.split(' ')[0];
  const doc = new PDFDocument({ size: 'LETTER', margin: 46, compress: true, info: { Title: latin(`Call brief: ${p.name || ''}`) } });
  const done = new Promise((res, rej) => { const s = fs.createWriteStream(out); s.on('finish', res); s.on('error', rej); doc.pipe(s); });
  const W = doc.page.width - 92;
  const h2 = t => { doc.moveDown(0.8).font('Helvetica-Bold').fontSize(9).fillColor('#444').text(latin(t).toUpperCase(), { characterSpacing: 0.6 }); const y = doc.y + 2; doc.moveTo(46, y).lineTo(46 + W, y).lineWidth(0.5).strokeColor('#bbb').stroke(); doc.moveDown(0.5).fillColor('#111'); };

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(latin(p.name || 'Business'));
  doc.font('Helvetica').fontSize(10.5).fillColor('#555').text(latin([who + (p.contact_title ? `, ${p.contact_title}` : ''), p.town && `${p.town}, ${p.state || 'CT'}`, p.website && host(p.website)].filter(Boolean).join('  |  ')));

  // The number, big, in a box.
  doc.moveDown(0.6);
  const boxY = doc.y;
  doc.roundedRect(46, boxY, W, 44, 6).lineWidth(1.5).strokeColor('#111').stroke();
  doc.font('Helvetica').fontSize(10).fillColor('#111').text(latin(phone ? `Call ${first}` : `Email ${first}`), 58, boxY + 9);
  doc.fillColor('#555').text(latin(p.email || ''), 58, boxY + 23);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text(latin(phone || 'No number given'), 46, boxY + 13, { width: W - 12, align: 'right' });
  doc.x = 46; doc.y = boxY + 50;

  h2(`What they said${receivedAt ? ` - ${day(receivedAt)}` : ''}`);
  doc.font('Helvetica-Oblique').fontSize(10.5).text(latin(String(message || '').trim()), { width: W });

  h2('About the business');
  for (const f of factLines(p)) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#555').text(latin(f.label), 46, y, { width: 105 });
    doc.font('Helvetica').fontSize(10).fillColor('#111').text(latin(f.text), 156, y, { width: W - 110 });
    if (f.src) doc.fontSize(7.5).fillColor('#888').text(latin(`Source: ${f.src}`), 156, doc.y, { width: W - 110, link: f.src });
    doc.x = 46; doc.moveDown(0.35);
  }

  h2('Questions to ask');
  doc.font('Helvetica').fontSize(10.5).fillColor('#111');
  questions(p).forEach((q, i) => doc.text(latin(`${i + 1}.  ${q}`), { width: W, indent: 0 }).moveDown(0.2));
  doc.moveDown(0.3).fontSize(9.5).fillColor('#555').text("You're there to listen and learn. Don't pitch the class on this call, but note anything they say takes up a lot of their time.", { width: W });

  const sent = [
    p.sent_at && { at: p.sent_at, what: 'Your first email', body: p.body },
    p.followup_at && { at: p.followup_at, what: 'Your follow-up', body: p.followup_body },
  ].filter(m => m && m.body);
  if (sent.length) {
    h2("What you've sent them");
    for (const m of sent) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(latin(`${m.what} - ${day(m.at)}`));
      doc.font('Helvetica').fontSize(8.5).fillColor('#444').text(latin(String(m.body).split('\n').filter(l => !/^(Accounting|soham|linkedin|University)/i.test(l)).join('\n').replace(/\n{2,}/g, '\n')), { width: W }).moveDown(0.5);
    }
  }
  doc.moveDown(0.6).font('Helvetica').fontSize(7.5).fillColor('#888').text(latin(`Made for ${prof.sender_name || 'you'} by the outreach desk. Facts come from public records and their own website, with the source under each one.`), { width: W });
  doc.end();
  return done;
}

if (require.main === module) {
  (async () => {
    const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
    const flag = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
    const raw = JSON.parse(fs.readFileSync(pos[0], 'utf8'));
    const p = { id: raw.id, ...(raw.data || raw) };
    await writeBrief(p, fs.readFileSync(pos[1], 'utf8'), pos[2], { settings: loadSettings(pos[3]), receivedAt: flag('at'), phone: flag('phone') });
    process.stdout.write(JSON.stringify({ pdf: pos[2], bytes: fs.statSync(pos[2]).size }) + '\n');
  })().catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { writeBrief, questions, factLines };
