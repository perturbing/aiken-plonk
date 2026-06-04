use aiken/builtin
use aiken/collection/list
use aiken/crypto
use aiken/crypto/bls12_381/g1
use aiken/crypto/bls12_381/g2
use aiken/crypto/bls12_381/pairing
use aiken/crypto/bls12_381/scalar
use aiken/primitive/bytearray
use plonk/types.{PreInputs, Proof}

// Concatenate a list of ByteArrays left-to-right.
fn concat_all(parts: List<ByteArray>) -> ByteArray {
  list.foldl(parts, #"", fn(x, acc) { bytearray.concat(acc, x) })
}

// CIP-109 makes it possible to do this onchain.
/// Fast PLONK verifier matching the SnarkJS/Cardano proof format over BLS12-381.
///
/// Corresponds to `verifyPlonkFastSnarkjs` in the Plutus reference implementation.
/// The `proof.lagrange_inverses` are precomputed off-chain and validated on-chain,
/// saving the cost of computing modular inverses inside the script.
pub fn verify_plonk_fast(
  pre: PreInputs,
  pub_inputs: List<Int>,
  proof: Proof,
) -> Bool {
  let PreInputs {
    n,
    power,
    k1,
    k2,
    q_m,
    q_l,
    q_r,
    q_o,
    q_c,
    s_sig1,
    s_sig2,
    s_sig3,
    x2,
    generators,
  } = pre

  let Proof {
    commitment_a,
    commitment_b,
    commitment_c,
    commitment_z,
    t_low,
    t_mid,
    t_high,
    w_omega,
    w_omega_zeta,
    a_eval,
    b_eval,
    c_eval,
    s_sig1_eval,
    s_sig2_eval,
    z_omega_eval,
    lagrange_inverses,
  } = proof

  // ---- Decompress verification key G1 points ----
  let g1_q_m = g1.decompress(q_m)
  let g1_q_l = g1.decompress(q_l)
  let g1_q_r = g1.decompress(q_r)
  let g1_q_o = g1.decompress(q_o)
  let g1_q_c = g1.decompress(q_c)
  let g1_s_sig3 = g1.decompress(s_sig3)
  let g2_x2 = g2.decompress(x2)

  // ---- Decompress proof G1 points ----
  let g1_comm_a = g1.decompress(commitment_a)
  let g1_comm_b = g1.decompress(commitment_b)
  let g1_comm_c = g1.decompress(commitment_c)
  let g1_comm_z = g1.decompress(commitment_z)
  let g1_t_low = g1.decompress(t_low)
  let g1_t_mid = g1.decompress(t_mid)
  let g1_t_high = g1.decompress(t_high)
  let g1_w_omega = g1.decompress(w_omega)
  let g1_w_omega_zeta = g1.decompress(w_omega_zeta)

  // Permutation commitments needed for [F]_1
  let g1_s_sig1 = g1.decompress(s_sig1)
  let g1_s_sig2 = g1.decompress(s_sig2)

  // ---- Wrap evaluations as scalar field elements ----
  let eval_a = scalar.from_int(a_eval)
  let eval_b = scalar.from_int(b_eval)
  let eval_c = scalar.from_int(c_eval)
  let eval_s1 = scalar.from_int(s_sig1_eval)
  let eval_s2 = scalar.from_int(s_sig2_eval)
  let eval_z_omega = scalar.from_int(z_omega_eval)

  // Precomputed Lagrange inverses from the proof
  let lags_inv = list.map(lagrange_inverses, scalar.from_int)

  // ---- Compute Fiat-Shamir challenges ----
  // beta = H(vk_selectors || vk_perms || pub_inputs || A || B || C)
  let pub_bytes =
    list.foldl(
      pub_inputs,
      #"",
      fn(x, acc) {
        bytearray.concat(acc, builtin.integer_to_bytearray(True, 32, x))
      },
    )

  let beta =
    scalar.from_bytes(
      crypto.blake2b_224(
        concat_all(
          [
            q_m, q_l, q_r, q_o, q_c, s_sig1, s_sig2, s_sig3, pub_bytes,
            commitment_a, commitment_b, commitment_c,
          ],
        ),
      ),
    )

  // gamma = H(beta)
  let gamma = scalar.from_bytes(crypto.blake2b_224(scalar.to_bytes(beta)))

  // alpha = H(beta || gamma || Z)
  let alpha =
    scalar.from_bytes(
      crypto.blake2b_224(
        concat_all(
          [scalar.to_bytes(beta), scalar.to_bytes(gamma), commitment_z],
        ),
      ),
    )

  // zeta = H(alpha || T_low || T_mid || T_high)
  let zeta =
    scalar.from_bytes(
      crypto.blake2b_224(
        concat_all([scalar.to_bytes(alpha), t_low, t_mid, t_high]),
      ),
    )

  // v = H(zeta || eval_a || eval_b || eval_c || eval_s1 || eval_s2 || eval_zw)
  let v =
    scalar.from_bytes(
      crypto.blake2b_224(
        concat_all(
          [
            scalar.to_bytes(zeta),
            builtin.integer_to_bytearray(True, 32, a_eval),
            builtin.integer_to_bytearray(True, 32, b_eval),
            builtin.integer_to_bytearray(True, 32, c_eval),
            builtin.integer_to_bytearray(True, 32, s_sig1_eval),
            builtin.integer_to_bytearray(True, 32, s_sig2_eval),
            builtin.integer_to_bytearray(True, 32, z_omega_eval),
          ],
        ),
      ),
    )

  // u = H(W_omega || W_omega_zeta)
  let u =
    scalar.from_bytes(
      crypto.blake2b_224(bytearray.concat(w_omega, w_omega_zeta)),
    )

  // ---- Polynomial evaluations ----
  // Z_H(zeta) = zeta^n - 1, computed via repeated squaring on power-of-two exponent
  let zeta_pow_n = scalar.scale2(zeta, power)
  let zero_poly = scalar.sub(zeta_pow_n, scalar.from_int(1))
  // zeta^(2n) = (zeta^n)^2
  let zeta_pow_2n = scalar.scale2(zeta_pow_n, 1)

  // Lagrange polynomials: L_i(zeta) = gen^i * Z_H(zeta) * lagInv_i
  let lag_polys =
    list.map2(
      generators,
      lags_inv,
      fn(gen_i, lag_inv) {
        scalar.mul(scalar.mul(scalar.from_int(gen_i), zero_poly), lag_inv)
      },
    )

  expect [lag_poly_1, ..lag_poly_xs] = lag_polys

  // PI(zeta) = sum of -pub_i * L_i(zeta)
  let neg_pubs = list.map(pub_inputs, fn(x) { scalar.neg(scalar.from_int(x)) })

  expect [w1, ..wxs] = neg_pubs

  let cross_terms =
    list.foldl(
      list.map2(wxs, lag_poly_xs, scalar.mul),
      scalar.from_int(0),
      fn(x, acc) { scalar.add(acc, x) },
    )

  let pi_zeta = scalar.add(scalar.mul(w1, lag_poly_1), cross_terms)

  // ---- Precomputed intermediates ----
  let alpha_sq = scalar.mul(alpha, alpha)
  let alpha_z_omega = scalar.mul(alpha, eval_z_omega)
  let beta_zeta = scalar.mul(beta, zeta)
  let eval_a_gamma = scalar.add(eval_a, gamma)
  let eval_b_gamma = scalar.add(eval_b, gamma)
  let eval_c_gamma = scalar.add(eval_c, gamma)
  let beta_s1 = scalar.mul(beta, eval_s1)
  let beta_s2 = scalar.mul(beta, eval_s2)

  // r_0 in the PLONK paper
  let r0 =
    scalar.sub(
      scalar.sub(pi_zeta, scalar.mul(lag_poly_1, alpha_sq)),
      scalar.mul(
        scalar.mul(
          scalar.mul(alpha_z_omega, scalar.add(eval_a_gamma, beta_s1)),
          scalar.add(eval_b_gamma, beta_s2),
        ),
        eval_c_gamma,
      ),
    )

  // ---- [D]_1: batch polynomial commitment ----
  let k1_s = scalar.from_int(k1)
  let k2_s = scalar.from_int(k2)

  // Coefficient for [Z]_1
  let z_coeff =
    scalar.add(
      scalar.add(
        scalar.mul(
          scalar.mul(
            scalar.mul(
              scalar.add(eval_a_gamma, beta_zeta),
              scalar.add(eval_b_gamma, scalar.mul(beta_zeta, k1_s)),
            ),
            scalar.add(eval_c_gamma, scalar.mul(beta_zeta, k2_s)),
          ),
          alpha,
        ),
        scalar.mul(lag_poly_1, alpha_sq),
      ),
      u,
    )

  // Coefficient for [S_sigma3]_1 (subtracted)
  let s3_coeff =
    scalar.mul(
      scalar.mul(
        scalar.mul(
          scalar.add(eval_a_gamma, beta_s1),
          scalar.add(eval_b_gamma, beta_s2),
        ),
        alpha_z_omega,
      ),
      beta,
    )

  // [T]_1 = T_low + zeta^n * T_mid + zeta^(2n) * T_high
  let t_commit =
    g1.add(
      g1.add(g1_t_low, g1.scale(g1_t_mid, zeta_pow_n)),
      g1.scale(g1_t_high, zeta_pow_2n),
    )

  let batch_poly_g1 =
    g1.sub(
      g1.sub(
        g1.add(
          g1.add(
            g1.add(
              g1.add(
                g1.add(
                  g1.scale(g1_q_m, scalar.mul(eval_a, eval_b)),
                  g1.scale(g1_q_l, eval_a),
                ),
                g1.scale(g1_q_r, eval_b),
              ),
              g1.scale(g1_q_o, eval_c),
            ),
            g1_q_c,
          ),
          g1.scale(g1_comm_z, z_coeff),
        ),
        g1.scale(g1_s_sig3, s3_coeff),
      ),
      g1.scale(t_commit, zero_poly),
    )

  // ---- [F]_1 = [D]_1 + v*(A + v*(B + v*(C + v*(S1 + v*S2)))) ----
  let batch_full =
    g1.add(
      batch_poly_g1,
      g1.scale(
        g1.add(
          g1_comm_a,
          g1.scale(
            g1.add(
              g1_comm_b,
              g1.scale(
                g1.add(
                  g1_comm_c,
                  g1.scale(g1.add(g1_s_sig1, g1.scale(g1_s_sig2, v)), v),
                ),
                v,
              ),
            ),
            v,
          ),
        ),
        v,
      ),
    )

  // ---- [E]_1 = (-r0 + v*(a + v*(b + v*(c + v*(s1 + v*s2)))) + u*z_omega) * G ----
  let e_coeff =
    scalar.add(
      scalar.add(
        scalar.neg(r0),
        scalar.mul(
          v,
          scalar.add(
            eval_a,
            scalar.mul(
              v,
              scalar.add(
                eval_b,
                scalar.mul(
                  v,
                  scalar.add(
                    eval_c,
                    scalar.mul(v, scalar.add(eval_s1, scalar.mul(v, eval_s2))),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      scalar.mul(u, eval_z_omega),
    )

  let group_eval = g1.scale(g1.generator, e_coeff)

  // generators[1] = omega (the primitive n-th root of unity)
  expect [_, gen_1_int, ..] = generators
  let gen_1 = scalar.from_int(gen_1_int)

  // ---- Final KZG pairing check ----
  let pairing_ok =
    pairing.final_exponentiation(
      pairing.miller_loop(
        g1.add(g1_w_omega, g1.scale(g1_w_omega_zeta, u)),
        g2_x2,
      ),
      pairing.miller_loop(
        g1.sub(
          g1.add(
            g1.add(
              g1.scale(g1_w_omega, zeta),
              g1.scale(g1_w_omega_zeta, scalar.mul(scalar.mul(u, zeta), gen_1)),
            ),
            batch_full,
          ),
          group_eval,
        ),
        g2.generator,
      ),
    )

  // ---- Validate precomputed Lagrange inverses ----
  // For each i: lagInv_i * n * (zeta - gen^i) == 1
  // With CIP-109 this is no longer needed.
  let n_s = scalar.from_int(n)
  let lags_valid =
    list.all(
      list.map2(
        lags_inv,
        list.map(generators, scalar.from_int),
        fn(lag_inv, gen_i) {
          scalar.to_int(
            scalar.mul(scalar.mul(lag_inv, n_s), scalar.sub(zeta, gen_i)),
          ) == 1
        },
      ),
      fn(b) { b },
    )

  pairing_ok && lags_valid
}
