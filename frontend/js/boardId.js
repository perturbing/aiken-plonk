// BLS12-381 scalar field prime
const Fr = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

// Minimal self-contained SHA-256 (no dependencies, browser-safe).
function sha256(msg) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  const len = msg.length;
  const padLen = (len + 9 + 63) & ~63;
  const p = new Uint8Array(padLen);
  p.set(msg);
  p[len] = 0x80;
  new DataView(p.buffer).setUint32(padLen - 4, (len * 8) >>> 0, false);
  const w = new Uint32Array(64);
  for (let i = 0; i < padLen; i += 64) {
    const blk = new DataView(p.buffer, i, 64);
    for (let j = 0; j < 16; j++) w[j] = blk.getUint32(j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = r(w[j-15], 7) ^ r(w[j-15], 18) ^ (w[j-15] >>> 3);
      const s1 = r(w[j-2],  17) ^ r(w[j-2],  19) ^ (w[j-2]  >>> 10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let j = 0; j < 64; j++) {
      const S1  = r(e, 6)  ^ r(e, 11) ^ r(e, 25);
      const ch  = (e & f)  ^ (~e & g);
      const t1  = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0  = r(a, 2)  ^ r(a, 13) ^ r(a, 22);
      const maj = (a & b)  ^ (a & c)  ^ (b & c);
      const t2  = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]+a)>>>0; H[1] = (H[1]+b)>>>0; H[2] = (H[2]+c)>>>0; H[3] = (H[3]+d)>>>0;
    H[4] = (H[4]+e)>>>0; H[5] = (H[5]+f)>>>0; H[6] = (H[6]+g)>>>0; H[7] = (H[7]+h)>>>0;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, H[i], false);
  return out;
}

// Encode a 9×9 board as 41 bytes:
//   4 zero padding bits + 81 cells × 4 bits, big-endian nibble packing.
function encodeBoard(board) {
  const bytes = new Uint8Array(41);
  bytes[0] = board[0][0];
  for (let k = 1; k <= 40; k++) {
    const cell1 = board[Math.floor((2 * k - 1) / 9)][(2 * k - 1) % 9];
    const cell2 = board[Math.floor((2 * k) / 9)][(2 * k) % 9];
    bytes[k] = (cell1 << 4) | cell2;
  }
  return bytes;
}

export function computeBoardId(board) {
  const hash = sha256(encodeBoard(board));
  let n = 0n;
  for (const b of hash) n = (n << 8n) | BigInt(b);
  return (n % Fr).toString();
}
