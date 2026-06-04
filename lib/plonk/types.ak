/// Types for the PLONK fast verifier (SnarkJS / Cardano variant).
///
/// G1 elements are stored as compressed 48-byte ByteArrays.
/// G2 elements are stored as compressed 96-byte ByteArrays.
/// Scalar field elements are stored as plain Int values (mod BLS12-381 scalar prime).
/// Proof elements produced by SnarkJS for a PLONK circuit over BLS12-381.
/// The fast variant includes precomputed Lagrange inverses so they do not
/// need to be computed on-chain (CIP-109 removes this need, saving bytes).
pub type Proof {
  // Compressed G1 commitments (48 bytes each)
  commitment_a: ByteArray,
  commitment_b: ByteArray,
  commitment_c: ByteArray,
  commitment_z: ByteArray,
  t_low: ByteArray,
  t_mid: ByteArray,
  t_high: ByteArray,
  w_omega: ByteArray,
  w_omega_zeta: ByteArray,
  // Polynomial evaluations at zeta (integers in the scalar field)
  a_eval: Int,
  b_eval: Int,
  c_eval: Int,
  s_sig1_eval: Int,
  s_sig2_eval: Int,
  z_omega_eval: Int,
  // Precomputed inverses: lagrange_inverses[i] = 1 / (n * (zeta - gen^i))
  // One entry per public input plus one for L_1.  Checked on-chain.
  lagrange_inverses: List<Int>,
}

/// Verification key (pre-inputs) for a PLONK circuit.
/// All values are fixed for a given circuit after the trusted setup.
pub type PreInputs {
  // n = 2^power — upper bound on the number of constraints
  n: Int,
  // power such that n = 2^power
  power: Int,
  // Disjoint coset generators k1, k2
  k1: Int,
  k2: Int,
  // Compressed selector polynomial commitments (G1, 48 bytes each)
  q_m: ByteArray,
  q_l: ByteArray,
  q_r: ByteArray,
  q_o: ByteArray,
  q_c: ByteArray,
  // Compressed permutation polynomial commitments (G1, 48 bytes each)
  s_sig1: ByteArray,
  s_sig2: ByteArray,
  s_sig3: ByteArray,
  // SRS G2 element: [x]_2 in the KZG setup (96 bytes)
  x2: ByteArray,
  // Powers of the subgroup generator omega: [omega^0, omega^1, ..., omega^nPublic]
  // Stored as plain integers (elements of the scalar field).
  generators: List<Int>,
}
