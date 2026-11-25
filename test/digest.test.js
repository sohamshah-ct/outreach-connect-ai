const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../scripts/digest-email');

test('digest email: one card per reply, escaped text, no links, plain copy', () => {
  const out = build({
    date: '2026-11-24',
    replies: [{ n: 1, name: 'Abram Moser', business: 'Moser Property Care', town: 'Ellington', said: 'What are you <looking> for?', reply: "Hi Abram,\n\nThanks!", note: '' },
      { n: 2, name: 'Jim Blair', business: 'James Blair', phone: '860-428-2916', said: 'Noon works', reply: 'Hi Jim', note: 'He prefers noon.' }],
    no_thanks: [{ name: 'Richard', business: 'Pursuance', said: 'Not available.' }],
    tossed: ['Levareit (nothing since Nov 3)'], kept: [],
  });
  assert.strictEqual(out.subject, 'Outreach replies today (3)');
  assert.match(out.htmlBody, /&lt;looking&gt;/);
  assert.doesNotMatch(out.htmlBody, /<a\s/i);
  assert.match(out.htmlBody, /Hi Abram,<br><br>Thanks!/);
  assert.match(out.htmlBody, /send 2/);
  assert.match(out.body, /2\. Jim Blair, James Blair · 860-428-2916/);
  assert.match(out.body, /No thanks\n- Richard, Pursuance/);
  assert.match(out.body, /Taken off the desk/);
});
