// Telling two voices apart in a recording, without sending audio anywhere.
//
// While recording, the page measures the pitch and loudness of the mic every
// ~50 ms (pitchOf). Each stretch of text the browser writes down gets the
// median pitch and loudness of the sound heard while it was said (segFeatures).
// splitVoices then groups the stretches into two voices. On a call on speaker,
// the two voices usually differ in pitch, and the person holding the phone is
// louder than the one coming out of the speaker, so both count.
//
// It's a best guess. The desk then has Claude read the conversation and put
// names on the two voices (questions come from the student, answers about the
// business from the owner), fixing lines the sound got wrong.

(function (root) {
  'use strict';

  // Pitch (Hz) of one frame of audio, or 0 if it isn't a voice. Also returns its loudness (RMS).
  function pitchOf(buf, sampleRate) {
    // Work at ~12 kHz: plenty for voice pitch, and 16x less work than 48 kHz.
    const step = Math.max(1, Math.round(sampleRate / 12000));
    const n = Math.floor(buf.length / step);
    const x = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { x[i] = buf[i * step]; mean += x[i]; }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    const rms = Math.sqrt(energy / n);
    if (rms < 0.004) return { f: 0, rms };
    const sr = sampleRate / step;
    const minLag = Math.floor(sr / 400), maxLag = Math.min(n - 2, Math.ceil(sr / 70));
    let best = 0, bestLag = 0;
    const r = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let s = 0, a = 0, b = 0;
      for (let i = 0; i + lag < n; i++) { s += x[i] * x[i + lag]; a += x[i] * x[i]; b += x[i + lag] * x[i + lag]; }
      r[lag] = a && b ? s / Math.sqrt(a * b) : 0;
    }
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (r[lag] > best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { best = r[lag]; bestLag = lag; }
    }
    if (best < 0.55 || !bestLag) return { f: 0, rms };
    // The first peak close to the best one avoids reading a voice an octave low.
    for (let lag = minLag + 1; lag < bestLag; lag++) {
      if (r[lag] > best * 0.9 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { bestLag = lag; break; }
    }
    return { f: sr / bestLag, rms };
  }

  const median = a => { if (!a.length) return 0; const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Median pitch and loudness of the voiced frames between t0 and t1 (ms).
  function segFeatures(frames, t0, t1) {
    const v = frames.filter(fr => fr.t >= t0 && fr.t <= t1 && fr.f > 0);
    if (v.length < 4) return { f: 0, e: 0, n: v.length };
    return { f: Math.round(median(v.map(fr => fr.f))), e: +median(v.map(fr => fr.rms)).toFixed(5), n: v.length };
  }

  // Group stretches into two voices. Returns { voices: [1|2|null per seg], two: bool, pitch: [hz1, hz2], db }.
  function splitVoices(segs) {
    const idx = [], pts = [];
    segs.forEach((s, i) => { if (s.f > 0 && s.e > 0) { idx.push(i); pts.push([Math.log(s.f), Math.log(s.e)]); } });
    const none = { voices: segs.map(() => null), two: false, pitch: [], db: 0 };
    if (pts.length < 3) return none;
    const sd = d => { const m = pts.reduce((a, p) => a + p[d], 0) / pts.length; const v = pts.reduce((a, p) => a + (p[d] - m) ** 2, 0) / pts.length; return [m, Math.sqrt(v) || 1]; };
    const [m0, s0] = sd(0), [m1, s1] = sd(1);
    const z = pts.map(p => [(p[0] - m0) / s0, (p[1] - m1) / s1]);
    // Start from the lowest and highest voices, then settle.
    let lo = 0, hi = 0;
    pts.forEach((p, i) => { if (p[0] < pts[lo][0]) lo = i; if (p[0] > pts[hi][0]) hi = i; });
    if (lo === hi) return none;
    let c = [z[lo].slice(), z[hi].slice()], lab = [];
    for (let it = 0; it < 20; it++) {
      lab = z.map(p => ((p[0] - c[0][0]) ** 2 + (p[1] - c[0][1]) ** 2) <= ((p[0] - c[1][0]) ** 2 + (p[1] - c[1][1]) ** 2) ? 0 : 1);
      const nc = [0, 1].map(k => { const mem = z.filter((_, i) => lab[i] === k); return mem.length ? [mem.reduce((a, p) => a + p[0], 0) / mem.length, mem.reduce((a, p) => a + p[1], 0) / mem.length] : c[k]; });
      if (nc.every((p, k) => p[0] === c[k][0] && p[1] === c[k][1])) break;
      c = nc;
    }
    const raw = [0, 1].map(k => { const mem = pts.filter((_, i) => lab[i] === k); return mem.length ? [Math.exp(mem.reduce((a, p) => a + p[0], 0) / mem.length), Math.exp(mem.reduce((a, p) => a + p[1], 0) / mem.length)] : null; });
    if (!raw[0] || !raw[1]) return none;
    const ratio = Math.max(raw[0][0], raw[1][0]) / Math.min(raw[0][0], raw[1][0]);
    const db = Math.abs(20 * Math.log10(raw[0][1] / raw[1][1]));
    // Too close to call: probably one person talking.
    if (ratio < 1.12 && db < 4) return none;
    // Voice 1 is whoever speaks first.
    const first = lab[0];
    const voices = segs.map(() => null);
    idx.forEach((si, i) => { voices[si] = lab[i] === first ? 1 : 2; });
    const order = first === 0 ? [0, 1] : [1, 0];
    return { voices, two: true, pitch: order.map(k => Math.round(raw[k][0])), db: +db.toFixed(1) };
  }

  const api = { pitchOf, segFeatures, splitVoices };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Voices = api;
})(typeof window !== 'undefined' ? window : globalThis);
