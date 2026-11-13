// Browsers record WebM without writing how long it is, so players show the wrong
// length and can stop early. This writes the length (in ms) into the file's Info
// section. Works in the browser (window.WebmDuration) and in Node (module.exports).
(function (root) {
  'use strict';
  const EBML = 0x1A45DFA3, SEGMENT = 0x18538067, INFO = 0x1549A966, DURATION = 0x4489, CLUSTER = 0x1F43B675;

  function vlen(b) { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0; }
  function readId(u, p) {
    const n = vlen(u[p]); if (!n || n > 4) throw new Error('bad id');
    let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u[p + i];
    return { v, n };
  }
  function readSize(u, p) {
    const n = vlen(u[p]); if (!n) throw new Error('bad size');
    let v = u[p] & (0xFF >> n), unknown = v === (0xFF >> n);
    for (let i = 1; i < n; i++) { v = v * 256 + u[p + i]; if (u[p + i] !== 0xFF) unknown = false; }
    return { v, n, unknown };
  }
  function writeSize(v, minLen) {
    let n = Math.max(1, minLen || 1);
    while (n < 8 && v >= Math.pow(2, 7 * n) - 1) n++;
    const out = new Uint8Array(n);
    let x = v;
    for (let i = n - 1; i >= 0; i--) { out[i] = x % 256; x = Math.floor(x / 256); }
    out[0] |= 0x80 >> (n - 1);
    return out;
  }
  function float64(ms) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, ms); return b; }
  function concat(parts) {
    let len = 0; for (const p of parts) len += p.length;
    const out = new Uint8Array(len); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Returns a new Uint8Array with the duration written, or the input unchanged if it can't.
  function fix(input, ms) {
    const u = input instanceof Uint8Array ? input : new Uint8Array(input);
    try {
      let p = 0;
      let id = readId(u, p); if (id.v !== EBML) return u;
      let sz = readSize(u, p + id.n); p += id.n + sz.n + sz.v;
      id = readId(u, p); if (id.v !== SEGMENT) return u;
      const segSizeAt = p + id.n, seg = readSize(u, segSizeAt);
      p = segSizeAt + seg.n;
      const segEnd = seg.unknown ? u.length : Math.min(u.length, p + seg.v);
      while (p < segEnd) {
        id = readId(u, p);
        if (id.v === CLUSTER) return u;
        const sizeAt = p + id.n; sz = readSize(u, sizeAt);
        const dataAt = sizeAt + sz.n, dataEnd = dataAt + sz.v;
        if (id.v !== INFO) { if (sz.unknown) return u; p = dataEnd; continue; }
        // Inside Info: overwrite Duration if it's there.
        let q = dataAt;
        while (q < dataEnd) {
          const cid = readId(u, q), csz = readSize(u, q + cid.n), cAt = q + cid.n + csz.n;
          if (cid.v === DURATION) {
            const out = u.slice();
            if (csz.v === 8) new DataView(out.buffer).setFloat64(cAt, ms);
            else if (csz.v === 4) new DataView(out.buffer).setFloat32(cAt, ms);
            return out;
          }
          q = cAt + csz.v;
        }
        // Otherwise add it at the end of Info and grow the sizes around it.
        const dur = concat([new Uint8Array([0x44, 0x89, 0x88]), float64(ms)]);
        const newInfoSize = writeSize(sz.v + dur.length, sz.n);
        const grow = dur.length + (newInfoSize.length - sz.n);
        let segSizeBytes = u.subarray(segSizeAt, segSizeAt + seg.n);
        if (!seg.unknown) {
          const ns = writeSize(seg.v + grow, seg.n);
          if (ns.length !== seg.n) return u; // would shift everything; leave it
          segSizeBytes = ns;
        }
        return concat([
          u.subarray(0, segSizeAt), segSizeBytes, u.subarray(segSizeAt + seg.n, sizeAt),
          newInfoSize, u.subarray(dataAt, dataEnd), dur, u.subarray(dataEnd),
        ]);
      }
    } catch (e) { /* not a file we understand: leave it */ }
    return u;
  }

  const api = { fix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WebmDuration = api;
})(typeof window !== 'undefined' ? window : this);
