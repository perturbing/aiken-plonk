#!/usr/bin/env node
// Generates an Aiken test literal for verifier.test.ak from snarkjs JSON outputs.
//
// Usage:
//   node gen_aiken_test.js <vk.json> <proof.json> <public-input.json>

'use strict';

const fs = require('fs');

const Fp = 4002409555221667393417789825735904156556882819939007885332058136124031650490837864442687629129015664037894272559787n;
const Fr = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

function compressG1(x_str, y_str) {
  const x = BigInt(x_str);
  const y = BigInt(y_str);
  let val = x | (1n << 383n);
  if (y * 2n > Fp) val |= (1n << 381n);
  return val.toString(16).padStart(96, '0');
}

function compressG2(x_c0_str, x_c1_str, y_c0_str, y_c1_str) {
  const x_c0 = BigInt(x_c0_str);
  const x_c1 = BigInt(x_c1_str);
  const y_c0 = BigInt(y_c0_str);
  const y_c1 = BigInt(y_c1_str);
  const x_combined = (x_c1 << 384n) | x_c0;
  let val = x_combined | (1n << 767n);
  const neg_y_c1 = (Fp - y_c1) % Fp;
  const neg_y_c0 = (Fp - y_c0) % Fp;
  if (y_c1 > neg_y_c1 || (y_c1 === neg_y_c1 && y_c0 > neg_y_c0)) {
    val |= (1n << 765n);
  }
  return val.toString(16).padStart(192, '0');
}

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

function computeChallenges(pre_c, proof_c, pubInputs) {
  const { blake2b } = require('@noble/hashes/blake2b');

  function blake2b224(buf) {
    return Buffer.from(blake2b(buf, { dkLen: 28 }));
  }

  function intToBE32(n) {
    return Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
  }

  function bytesToBigInt(buf) {
    let n = 0n;
    for (const b of buf) { n = (n << 8n) | BigInt(b); }
    return n;
  }

  const pubBytes = Buffer.concat(pubInputs.map(x => intToBE32(x)));

  const betaInput = Buffer.concat([
    Buffer.from(pre_c.q_m, 'hex'), Buffer.from(pre_c.q_l, 'hex'),
    Buffer.from(pre_c.q_r, 'hex'), Buffer.from(pre_c.q_o, 'hex'),
    Buffer.from(pre_c.q_c, 'hex'), Buffer.from(pre_c.s_sig1, 'hex'),
    Buffer.from(pre_c.s_sig2, 'hex'), Buffer.from(pre_c.s_sig3, 'hex'),
    pubBytes,
    Buffer.from(proof_c.commitment_a, 'hex'), Buffer.from(proof_c.commitment_b, 'hex'),
    Buffer.from(proof_c.commitment_c, 'hex'),
  ]);
  const beta = bytesToBigInt(blake2b224(betaInput)) % Fr;

  function intToBE32FromBigInt(n) {
    return Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
  }

  const gamma = bytesToBigInt(blake2b224(intToBE32FromBigInt(beta))) % Fr;

  const alphaInput = Buffer.concat([
    intToBE32FromBigInt(beta), intToBE32FromBigInt(gamma),
    Buffer.from(proof_c.commitment_z, 'hex'),
  ]);
  const alpha = bytesToBigInt(blake2b224(alphaInput)) % Fr;

  const zetaInput = Buffer.concat([
    intToBE32FromBigInt(alpha),
    Buffer.from(proof_c.t_low, 'hex'), Buffer.from(proof_c.t_mid, 'hex'),
    Buffer.from(proof_c.t_high, 'hex'),
  ]);
  const zeta = bytesToBigInt(blake2b224(zetaInput)) % Fr;

  return { beta, gamma, alpha, zeta };
}

function computeLagrangeInverses(n_val, zeta, gens) {
  return gens.map(gen_i => {
    const diff = modFr(zeta - gen_i);
    return modInverse(modFr(BigInt(n_val) * diff), Fr);
  });
}

const [,, vkFile, proofFile, publicFile] = process.argv;
if (!vkFile || !proofFile || !publicFile) {
  process.stderr.write('Usage: gen_aiken_test.js <vk.json> <proof.json> <public-input.json>\n');
  process.exit(1);
}

const vk     = JSON.parse(fs.readFileSync(vkFile,    'utf8'));
const proof  = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
const pubRaw = JSON.parse(fs.readFileSync(publicFile,'utf8'));
const pubInputs = pubRaw.map(s => BigInt(s));

const n = Math.pow(2, vk.power);

const pre_c = {
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

const proof_c = {
  commitment_a: compressG1(proof.A[0],    proof.A[1]),
  commitment_b: compressG1(proof.B[0],    proof.B[1]),
  commitment_c: compressG1(proof.C[0],    proof.C[1]),
  commitment_z: compressG1(proof.Z[0],    proof.Z[1]),
  t_low:        compressG1(proof.T1[0],   proof.T1[1]),
  t_mid:        compressG1(proof.T2[0],   proof.T2[1]),
  t_high:       compressG1(proof.T3[0],   proof.T3[1]),
  w_omega:      compressG1(proof.Wxi[0],  proof.Wxi[1]),
  w_omega_zeta: compressG1(proof.Wxiw[0], proof.Wxiw[1]),
  a_eval:       BigInt(proof.eval_a),
  b_eval:       BigInt(proof.eval_b),
  c_eval:       BigInt(proof.eval_c),
  s_sig1_eval:  BigInt(proof.eval_s1),
  s_sig2_eval:  BigInt(proof.eval_s2),
  z_omega_eval: BigInt(proof.eval_zw),
};

const { zeta } = computeChallenges(pre_c, proof_c, pubInputs);
const lagrange_inverses = computeLagrangeInverses(n, zeta, pre_c.generators);

const k1 = BigInt(vk.k1);
const k2 = BigInt(vk.k2);
const gens = pre_c.generators;

const lines = [];
lines.push(`// ── Sudoku SHA256: prove solution for puzzle committed by boardId ────────────`);
lines.push(`// Public:  boardId = SHA256(board) as field element   nPublic=1`);
lines.push(`// Private: board[9][9] (puzzle), solved[9][9] (solution)`);
lines.push(`test verify_sudoku() {`);
lines.push(`  let pre =`);
lines.push(`    PreInputs {`);
lines.push(`      n: ${n},`);
lines.push(`      power: ${vk.power},`);
lines.push(`      k1: ${k1},`);
lines.push(`      k2: ${k2},`);
lines.push(`      q_m: #"${pre_c.q_m}",`);
lines.push(`      q_l: #"${pre_c.q_l}",`);
lines.push(`      q_r: #"${pre_c.q_r}",`);
lines.push(`      q_o: #"${pre_c.q_o}",`);
lines.push(`      q_c: #"${pre_c.q_c}",`);
lines.push(`      s_sig1: #"${pre_c.s_sig1}",`);
lines.push(`      s_sig2: #"${pre_c.s_sig2}",`);
lines.push(`      s_sig3: #"${pre_c.s_sig3}",`);
lines.push(`      x2: #"${pre_c.x2}",`);
lines.push(`      generators: [${gens.join(', ')}],`);
lines.push(`    }`);
lines.push(`  let pub_inputs =`);
lines.push(`    [${pubInputs.join(', ')}]`);
lines.push(`  let proof =`);
lines.push(`    Proof {`);
lines.push(`      commitment_a: #"${proof_c.commitment_a}",`);
lines.push(`      commitment_b: #"${proof_c.commitment_b}",`);
lines.push(`      commitment_c: #"${proof_c.commitment_c}",`);
lines.push(`      commitment_z: #"${proof_c.commitment_z}",`);
lines.push(`      t_low: #"${proof_c.t_low}",`);
lines.push(`      t_mid: #"${proof_c.t_mid}",`);
lines.push(`      t_high: #"${proof_c.t_high}",`);
lines.push(`      w_omega: #"${proof_c.w_omega}",`);
lines.push(`      w_omega_zeta: #"${proof_c.w_omega_zeta}",`);
lines.push(`      a_eval: ${proof_c.a_eval},`);
lines.push(`      b_eval: ${proof_c.b_eval},`);
lines.push(`      c_eval: ${proof_c.c_eval},`);
lines.push(`      s_sig1_eval: ${proof_c.s_sig1_eval},`);
lines.push(`      s_sig2_eval: ${proof_c.s_sig2_eval},`);
lines.push(`      z_omega_eval: ${proof_c.z_omega_eval},`);
lines.push(`      lagrange_inverses: [${lagrange_inverses.join(', ')}],`);
lines.push(`    }`);
lines.push(`  verifier.verify_plonk_fast(pre, pub_inputs, proof)`);
lines.push(`}`);

process.stdout.write(lines.join('\n') + '\n');
