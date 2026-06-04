#!/usr/bin/env node
// Converts a SnarkJS PLONK verification key + proof to Plutus Data CBOR
// suitable for `aiken blueprint apply` and for use as a minting redeemer.
//
// Usage:
//   node convert_proof.js <vk.json> <proof.json> <public-input.json> <out-dir>

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// BLS12-381 constants
// ---------------------------------------------------------------------------

const Fp = 4002409555221667393417789825735904156556882819939007885332058136124031650490837864442687629129015664037894272559787n;
const Fr = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

// ---------------------------------------------------------------------------
// G1 / G2 compression (ZCash / BLST serialization)
// ---------------------------------------------------------------------------

function compressG1(x_str, y_str) {
  const x = BigInt(x_str);
  const y = BigInt(y_str);
  let val = x | (1n << 383n);
  if (y * 2n > Fp) val |= (1n << 381n);
  const hex = val.toString(16).padStart(96, '0');
  return Buffer.from(hex, 'hex');
}

function compressG2(x_c0_str, x_c1_str, y_c0_str, y_c1_str) {
  const x_c0 = BigInt(x_c0_str);
  const x_c1 = BigInt(x_c1_str);
  const y_c0 = BigInt(y_c0_str);
  const y_c1 = BigInt(y_c1_str);
  // Layout: upper 48 bytes = c1, lower 48 bytes = c0
  const x_combined = (x_c1 << 384n) | x_c0;
  let val = x_combined | (1n << 767n);
  // Sign: y_c1 dominates; y_c0 as tiebreaker
  const neg_y_c1 = (Fp - y_c1) % Fp;
  const neg_y_c0 = (Fp - y_c0) % Fp;
  if (y_c1 > neg_y_c1 || (y_c1 === neg_y_c1 && y_c0 > neg_y_c0)) {
    val |= (1n << 765n);
  }
  const hex = val.toString(16).padStart(192, '0');
  return Buffer.from(hex, 'hex');
}

// ---------------------------------------------------------------------------
// Scalar field helpers
// ---------------------------------------------------------------------------

function modFr(n) { return ((n % Fr) + Fr) % Fr; }

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = result * base % mod;
    exp >>= 1n;
    base = base * base % mod;
  }
  return result;
}

function modInverse(a, m) { return modPow(((a % m) + m) % m, m - 2n, m); }

// [omega^0, omega^1, ..., omega^nPublic]
function generatorPowers(omega_str, nPublic) {
  const omega = BigInt(omega_str);
  const powers = [];
  let cur = 1n;
  for (let i = 0; i <= nPublic; i++) {
    powers.push(modFr(cur));
    cur = modFr(cur * omega);
  }
  return powers;
}

// ---------------------------------------------------------------------------
// Challenge computation (must match on-chain verifier exactly)
// ---------------------------------------------------------------------------

function computeChallenges(pre, proof_c, pubInputs) {
  const { blake2b } = require('@noble/hashes/blake2b');
  function blake2b224(buf) {
    return Buffer.from(blake2b(buf, { dkLen: 28 }));
  }

  function intToBE32(n) {
    const hex = n.toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
  }

  function bytesToBigInt(buf) {
    let n = 0n;
    for (const b of buf) { n = (n << 8n) | BigInt(b); }
    return n;
  }

  const pubBytes = Buffer.concat(pubInputs.map(x => intToBE32(x)));

  const betaInput = Buffer.concat([
    pre.q_m, pre.q_l, pre.q_r, pre.q_o, pre.q_c,
    pre.s_sig1, pre.s_sig2, pre.s_sig3,
    pubBytes,
    proof_c.commitment_a, proof_c.commitment_b, proof_c.commitment_c,
  ]);
  const beta = bytesToBigInt(blake2b224(betaInput)) % Fr;

  const gamma = bytesToBigInt(blake2b224(intToBE32(beta))) % Fr;

  const alphaInput = Buffer.concat([intToBE32(beta), intToBE32(gamma), proof_c.commitment_z]);
  const alpha = bytesToBigInt(blake2b224(alphaInput)) % Fr;

  const zetaInput = Buffer.concat([intToBE32(alpha), proof_c.t_low, proof_c.t_mid, proof_c.t_high]);
  const zeta = bytesToBigInt(blake2b224(zetaInput)) % Fr;

  return { beta, gamma, alpha, zeta };
}

function computeLagrangeInverses(n_val, zeta, gens) {
  return gens.map(gen_i => {
    const diff = modFr(zeta - gen_i);
    return modInverse(modFr(BigInt(n_val) * diff), Fr);
  });
}

// ---------------------------------------------------------------------------
// Minimal CBOR encoder for Plutus Data
//
// Plutus integers can be up to 255 bits; CBOR encodes them as bignums
// (tag 2 for positive, tag 3 for negative) when they exceed 2^64.
// ---------------------------------------------------------------------------

function cborBytesHeader(byteLen) {
  // Encode the length of a byte string (major type 2 header)
  const n = BigInt(byteLen);
  if (n < 24n)           return Buffer.from([0x40 | Number(n)]);
  if (n < 0x100n)        return Buffer.from([0x58, Number(n)]);
  if (n < 0x10000n)      { const b = Buffer.alloc(3); b[0]=0x59; b.writeUInt16BE(Number(n),1); return b; }
  /* lengths > 65535 not expected here */
  throw new Error('byte string too long');
}

function bigintToBytes(n) {
  // Big-endian minimal byte representation of a positive BigInt
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
}

function cborUInt(n) {
  // Standard CBOR unsigned integer (major type 0) or bignum tag 2
  if (n < 24n)                  return Buffer.from([Number(n)]);
  if (n < 0x100n)               return Buffer.from([0x18, Number(n)]);
  if (n < 0x10000n)             { const b=Buffer.alloc(3); b[0]=0x19; b.writeUInt16BE(Number(n),1); return b; }
  if (n < 0x100000000n)         { const b=Buffer.alloc(5); b[0]=0x1a; b.writeUInt32BE(Number(n),1); return b; }
  if (n < 0x10000000000000000n) {
    const b = Buffer.alloc(9); b[0] = 0x1b;
    b.writeUInt32BE(Number(n >> 32n), 1);
    b.writeUInt32BE(Number(n & 0xffffffffn), 5);
    return b;
  }
  // Tag 2: positive bignum
  const valueBytes = bigintToBytes(n);
  const header = cborBytesHeader(valueBytes.length);
  return Buffer.concat([Buffer.from([0xc2]), header, valueBytes]);
}

function cborInt(n) {
  if (n >= 0n) return cborUInt(n);
  // Negative: encode -(n+1) with major type 1 (or tag 3 for bignum)
  const m = -(n + 1n);
  if (m < 0x10000000000000000n) {
    const unsigned = cborUInt(m);
    unsigned[0] |= 0x20; // flip to major type 1
    return unsigned;
  }
  // Tag 3: negative bignum
  const valueBytes = bigintToBytes(m);
  const header = cborBytesHeader(valueBytes.length);
  return Buffer.concat([Buffer.from([0xc3]), header, valueBytes]);
}

function cborBytes(buf) {
  return Buffer.concat([cborBytesHeader(buf.length), buf]);
}

function cborArray(items) {
  const n = BigInt(items.length);
  let header;
  if (n < 24n)      header = Buffer.from([0x80 | Number(n)]);
  else if (n < 256n) header = Buffer.from([0x98, Number(n)]);
  else               header = Buffer.from([0x99, Number(n >> 8n), Number(n & 0xffn)]);
  return Buffer.concat([header, ...items]);
}

// Plutus Constr 0 = CBOR tag 121 = 0xD879
function cborConstr0(fields) {
  return Buffer.concat([Buffer.from([0xd8, 0x79]), cborArray(fields)]);
}

// ---------------------------------------------------------------------------
// Encode PreInputs as Plutus Data
// ---------------------------------------------------------------------------

function encodePreInputs(pre) {
  return cborConstr0([
    cborInt(BigInt(pre.n)),
    cborInt(BigInt(pre.power)),
    cborInt(pre.k1),
    cborInt(pre.k2),
    cborBytes(pre.q_m),
    cborBytes(pre.q_l),
    cborBytes(pre.q_r),
    cborBytes(pre.q_o),
    cborBytes(pre.q_c),
    cborBytes(pre.s_sig1),
    cborBytes(pre.s_sig2),
    cborBytes(pre.s_sig3),
    cborBytes(pre.x2),
    cborArray(pre.generators.map(g => cborInt(g))),
  ]);
}

// ---------------------------------------------------------------------------
// Encode Proof as Plutus Data
// ---------------------------------------------------------------------------

function encodeProof(p) {
  return cborConstr0([
    cborBytes(p.commitment_a),
    cborBytes(p.commitment_b),
    cborBytes(p.commitment_c),
    cborBytes(p.commitment_z),
    cborBytes(p.t_low),
    cborBytes(p.t_mid),
    cborBytes(p.t_high),
    cborBytes(p.w_omega),
    cborBytes(p.w_omega_zeta),
    cborInt(p.a_eval),
    cborInt(p.b_eval),
    cborInt(p.c_eval),
    cborInt(p.s_sig1_eval),
    cborInt(p.s_sig2_eval),
    cborInt(p.z_omega_eval),
    cborArray(p.lagrange_inverses.map(li => cborInt(li))),
  ]);
}

// Redeemer = 2-tuple (pub_inputs, proof)
function encodeRedeemer(pubInputs, proof) {
  return cborArray([
    cborArray(pubInputs.map(x => cborInt(x))),
    encodeProof(proof),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [,, vkFile, proofFile, publicFile, outDir] = process.argv;
if (!vkFile || !proofFile || !publicFile || !outDir) {
  console.error('Usage: convert_proof.js <vk.json> <proof.json> <public-input.json> <out-dir>');
  process.exit(1);
}

const vk     = JSON.parse(fs.readFileSync(vkFile,    'utf8'));
const proof  = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
const pubRaw = JSON.parse(fs.readFileSync(publicFile,'utf8'));
const pubInputs = pubRaw.map(s => BigInt(s));

// Build pre_inputs (VK)
const pre = {
  n:      Math.pow(2, vk.power),
  power:  vk.power,
  k1:     BigInt(vk.k1),
  k2:     BigInt(vk.k2),
  q_m:    compressG1(vk.Qm[0], vk.Qm[1]),
  q_l:    compressG1(vk.Ql[0], vk.Ql[1]),
  q_r:    compressG1(vk.Qr[0], vk.Qr[1]),
  q_o:    compressG1(vk.Qo[0], vk.Qo[1]),
  q_c:    compressG1(vk.Qc[0], vk.Qc[1]),
  s_sig1: compressG1(vk.S1[0], vk.S1[1]),
  s_sig2: compressG1(vk.S2[0], vk.S2[1]),
  s_sig3: compressG1(vk.S3[0], vk.S3[1]),
  x2:     compressG2(vk.X_2[0][0], vk.X_2[0][1], vk.X_2[1][0], vk.X_2[1][1]),
  generators: generatorPowers(vk.w, vk.nPublic),
};

// Build proof_c (compressed proof)
const proof_c = {
  commitment_a: compressG1(proof.A[0],   proof.A[1]),
  commitment_b: compressG1(proof.B[0],   proof.B[1]),
  commitment_c: compressG1(proof.C[0],   proof.C[1]),
  commitment_z: compressG1(proof.Z[0],   proof.Z[1]),
  t_low:        compressG1(proof.T1[0],  proof.T1[1]),
  t_mid:        compressG1(proof.T2[0],  proof.T2[1]),
  t_high:       compressG1(proof.T3[0],  proof.T3[1]),
  w_omega:      compressG1(proof.Wxi[0], proof.Wxi[1]),
  w_omega_zeta: compressG1(proof.Wxiw[0],proof.Wxiw[1]),
  a_eval:       BigInt(proof.eval_a),
  b_eval:       BigInt(proof.eval_b),
  c_eval:       BigInt(proof.eval_c),
  s_sig1_eval:  BigInt(proof.eval_s1),
  s_sig2_eval:  BigInt(proof.eval_s2),
  z_omega_eval: BigInt(proof.eval_zw),
};

// Compute Lagrange inverses
const { zeta } = computeChallenges(pre, proof_c, pubInputs);
const lagrange_inverses = computeLagrangeInverses(pre.n, zeta, pre.generators);
proof_c.lagrange_inverses = lagrange_inverses;

console.log('Zeta:', zeta.toString());
console.log('Lagrange inverses computed:', lagrange_inverses.length);

// Encode
const preInputsCbor = encodePreInputs(pre);
const redeemerCbor  = encodeRedeemer(pubInputs, proof_c);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'pre_inputs.cbor'),  preInputsCbor.toString('hex'));
fs.writeFileSync(path.join(outDir, 'redeemer.cbor'),    redeemerCbor.toString('hex'));

console.log('Written:');
console.log('  pre_inputs.cbor  — CBOR hex for `aiken blueprint apply`');
console.log('  redeemer.cbor    — CBOR hex of the minting redeemer');
