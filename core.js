// Flash Comm core: encoders, decoders, and the receiver's signal processing. No DOM in here.
(function (root) {
  const MORSE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
    K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
    U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', '/': '-..-.', '@': '.--.-.', '-': '-....-',
    ':': '---...', "'": '.----.', '(': '-.--.', ')': '-.--.-', '=': '-...-', '+': '.-.-.', '"': '.-..-.',
    ';': '-.-.-.', '&': '.-...', '_': '..--.-',
  };
  const REV = {};
  for (const k in MORSE) REV[MORSE[k]] = k;

  // A "run" is {on: bool, units: n} when encoding, {on, dur: ms} when decoding.
  function pusher(out) {
    return (on, u) => {
      if (out.length && out[out.length - 1].on === on) out[out.length - 1].units += u;
      else out.push({ on, units: u });
    };
  }

  function encodeMorse(text) {
    const out = [], push = pusher(out);
    const words = text.toUpperCase().trim().split(/\s+/);
    let firstWord = true;
    for (const w of words) {
      let firstCh = true, any = false;
      for (const ch of w) {
        const code = MORSE[ch];
        if (!code) continue;
        if (!any && !firstWord) push(false, 7);
        else if (!firstCh) push(false, 3);
        firstCh = false; any = true;
        [...code].forEach((s, i) => { if (i) push(false, 1); push(true, s === '.' ? 1 : 3); });
      }
      if (any) firstWord = false;
    }
    return out;
  }

  const HEADER = [1, 0, 1, 0, 1, 1, 0, 0];
  function encodeBinary(text) {
    const bytes = Array.from(new TextEncoder().encode(text)).slice(0, 255);
    const bits = HEADER.slice();
    const putByte = (b) => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); };
    putByte(bytes.length);
    let x = 0;
    for (const b of bytes) { putByte(b); x ^= b; }
    putByte(x);
    bits.push(1); // trailer so the last data bit is bounded by an edge
    const out = [], push = pusher(out);
    for (const b of bits) push(!!b, 1);
    return out;
  }

  function decodeMorse(runs, unit) {
    let text = '', raw = '', cur = '';
    const flush = () => { if (cur) { text += REV[cur] || '?'; raw += cur; cur = ''; } };
    for (const r of runs) {
      const u = r.dur / unit;
      if (r.on) cur += u < 2 ? '.' : '-';
      else if (u >= 5) { flush(); text += ' '; raw += ' / '; }
      else if (u >= 2) { flush(); raw += ' '; }
    }
    flush();
    return { text: text.trim(), raw, ok: !text.includes('?'), note: text.includes('?') ? 'unknown symbol' : '' };
  }

  function decodeBinary(runs, unit) {
    const bits = [];
    for (const r of runs) {
      const n = Math.max(1, Math.round(r.dur / unit));
      for (let i = 0; i < n && bits.length < 4000; i++) bits.push(r.on ? 1 : 0);
    }
    const raw = bits.join('');
    if (bits.length < 8) return { text: '', raw, ok: false, note: 'syncing...' };
    if (HEADER.some((b, i) => bits[i] !== b)) return { text: '', raw, ok: false, note: 'no sync (wrong tick?)' };
    if (bits.length < 16) return { text: '', raw, ok: false, note: 'receiving...' };
    const rd = (o) => { let v = 0; for (let i = 0; i < 8; i++) v = v * 2 + bits[o + i]; return v; };
    const len = rd(8);
    const dataEnd = 16 + len * 8;
    const have = Math.floor((Math.min(bits.length, dataEnd) - 16) / 8);
    const bytes = [];
    for (let i = 0; i < have; i++) bytes.push(rd(16 + i * 8));
    const text = new TextDecoder().decode(new Uint8Array(bytes));
    if (bits.length < dataEnd + 8) return { text, raw, ok: false, note: 'incomplete' };
    const x = bytes.reduce((a, b) => a ^ b, 0);
    const good = x === rd(dataEnd) && bytes.length === len;
    return { text, raw, ok: good, note: good ? 'checksum ok' : 'checksum FAILED' };
  }

  function decode(mode, runs, unit) {
    return mode === 'morse' ? decodeMorse(runs, unit) : decodeBinary(runs, unit);
  }

  // Turns a stream of (time, brightness) samples into on/off edges, then into messages.
  // cfg() -> {mode, unit (ms), gate (min brightness swing 0..255 to count as a signal)}
  class Receiver {
    constructor(cfg, cb) { this.cfg = cfg; this.cb = cb || {}; this.reset(true); }
    reset(full) {
      this.state = false; this.lastEdge = null; this.runs = []; this.cross = null;
      if (full) { this.prevT = null; this.prevL = null; this.env = { min: 0, max: 0 }; this.thr = 0; this.contrast = 0; }
    }
    edge(on, t) {
      if (this.lastEdge == null) {
        if (!on) return;
        this.lastEdge = t; this.runs = [];
      } else {
        this.runs.push({ on: !on, dur: t - this.lastEdge });
        this.lastEdge = t;
      }
      const c = this.cfg();
      if (this.cb.onLive) this.cb.onLive(decode(c.mode, this.runs, c.unit), this.runs);
    }
    finish() {
      const c = this.cfg(), runs = this.runs;
      this.lastEdge = null; this.runs = []; this.state = false;
      if (runs.length && this.cb.onMessage) this.cb.onMessage(decode(c.mode, runs, c.unit), runs);
    }
    sample(t, L) {
      const c = this.cfg(), e = this.env;
      if (this.prevT == null) { e.min = e.max = L; }
      else {
        if (t < this.prevT) t = this.prevT;
        const k = 1 - Math.exp(-(t - this.prevT) / 10000);
        e.max = L > e.max ? L : e.max + (L - e.max) * k;
        e.min = L < e.min ? L : e.min + (L - e.min) * k;
      }
      const contrast = e.max - e.min, thr = (e.max + e.min) / 2;
      this.thr = thr; this.contrast = contrast;
      // remember the most recent threshold crossing so edge time can be interpolated between frames
      if (this.prevL != null && (this.prevL <= thr) !== (L <= thr)) {
        this.cross = { pt: this.prevT, pl: this.prevL, t, L, thr };
      }
      let ns = this.state;
      if (contrast >= c.gate) {
        const h = contrast * 0.12;
        if (!this.state && L > thr + h) ns = true;
        else if (this.state && L < thr - h) ns = false;
      }
      if (ns !== this.state) {
        let te = t;
        const x = this.cross;
        if (x && x.L !== x.pl) {
          const f = Math.min(1, Math.max(0, (x.thr - x.pl) / (x.L - x.pl)));
          te = x.pt + f * (x.t - x.pt);
        }
        this.state = ns;
        this.edge(ns, te);
      }
      if (this.lastEdge != null) {
        const idle = t - this.lastEdge;
        if (!this.state && idle > Math.max(12 * c.unit, 150)) this.finish();
        else if (this.state && idle > Math.max(40 * c.unit, 400)) { this.reset(false); if (this.cb.onReset) this.cb.onReset(); }
      }
      this.prevT = t; this.prevL = L;
      return { thr, contrast, state: this.state };
    }
  }

  const api = { MORSE, encodeMorse, encodeBinary, decode, decodeMorse, decodeBinary, Receiver };
  root.FC = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
