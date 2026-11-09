const test = require('node:test');
const assert = require('node:assert');
const { pitchOf, segFeatures, splitVoices } = require('../recorder/voices');

// A voice-like sound: a fundamental plus a few harmonics, with a little noise.
function voice(hz, amp, sr = 48000, n = 2048, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = amp * (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.3 * Math.sin(6 * Math.PI * hz * t)) + amp * 0.05 * rnd();
  }
  return out;
}

test('pitchOf finds the pitch of a low and a high voice', () => {
  for (const hz of [95, 120, 180, 230]) {
    const { f } = pitchOf(voice(hz, 0.2), 48000);
    assert.ok(Math.abs(f - hz) / hz < 0.06, `${hz} Hz read as ${f}`);
  }
});

test('pitchOf says silence and noise are not a voice', () => {
  assert.strictEqual(pitchOf(new Float32Array(2048), 48000).f, 0);
  let s = 7; const noise = Float32Array.from({ length: 2048 }, () => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 0.3; });
  assert.strictEqual(pitchOf(noise, 48000).f, 0);
});

test('splitVoices separates a near, low voice from a quieter, higher one', () => {
  const frames = [];
  const segs = [];
  // Alternating turns, 3 seconds each: voice A 115 Hz loud (holding the phone), voice B 205 Hz quieter (on speaker).
  for (let turn = 0; turn < 8; turn++) {
    const a = turn % 2 === 0;
    const t0 = turn * 3000, t1 = t0 + 3000;
    for (let t = t0; t < t1; t += 50) {
      const r = pitchOf(voice(a ? 115 + (t % 7) : 205 + (t % 11), a ? 0.25 : 0.06, 48000, 2048, t + 3), 48000);
      frames.push({ t, f: r.f, rms: r.rms });
    }
    segs.push({ t0, t1, text: `turn ${turn}`, ...segFeatures(frames, t0, t1) });
  }
  const out = splitVoices(segs);
  assert.ok(out.two, 'should hear two voices');
  assert.deepStrictEqual(out.voices, [1, 2, 1, 2, 1, 2, 1, 2]);
  assert.ok(out.pitch[0] < out.pitch[1]);
});

test('splitVoices says one voice when everything sounds the same', () => {
  const segs = [0, 1, 2, 3, 4].map(i => ({ t0: i, t1: i + 1, f: 140 + i, e: 0.1 + i * 0.002 }));
  const out = splitVoices(segs);
  assert.strictEqual(out.two, false);
  assert.deepStrictEqual(out.voices, [null, null, null, null, null]);
});
