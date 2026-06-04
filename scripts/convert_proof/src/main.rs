// Converts a SnarkJS PLONK verification key + proof to Plutus Data CBOR
// suitable for `aiken blueprint apply` and for use as a minting redeemer.
//
// Usage:
//   convert_proof <vk.json> <proof.json> <public-input.json> <out-dir>

use std::env;
use std::fs;
use std::path::Path;

use blake2::{Blake2bVar, digest::{Update, VariableOutput}};
use num_bigint::BigUint;
use num_traits::One;
use serde_json::Value;

// ---------------------------------------------------------------------------
// BLS12-381 constants
// ---------------------------------------------------------------------------

fn fp() -> BigUint {
    BigUint::parse_bytes(
        b"4002409555221667393417789825735904156556882819939007885332058136124031650490837864442687629129015664037894272559787",
        10,
    ).unwrap()
}

fn fr() -> BigUint {
    BigUint::parse_bytes(
        b"52435875175126190479447740508185965837690552500527637822603658699938581184513",
        10,
    ).unwrap()
}

// ---------------------------------------------------------------------------
// Field element parsing (handles both "0x..." hex and plain decimal strings)
// ---------------------------------------------------------------------------

fn parse_field(s: &str) -> BigUint {
    let s = s.trim();
    if s.starts_with("0x") || s.starts_with("0X") {
        BigUint::parse_bytes(s[2..].as_bytes(), 16)
            .unwrap_or_else(|| panic!("invalid hex field: {}", s))
    } else {
        BigUint::parse_bytes(s.as_bytes(), 10)
            .unwrap_or_else(|| panic!("invalid decimal field: {}", s))
    }
}

// ---------------------------------------------------------------------------
// G1 / G2 compression (ZCash / BLST serialization)
// ---------------------------------------------------------------------------

fn compress_g1(x_str: &str, y_str: &str) -> Vec<u8> {
    let x = parse_field(x_str);
    let y = parse_field(y_str);
    let fp = fp();
    let mut val = x.clone();
    set_bit(&mut val, 383);
    if &y * 2u32 > fp {
        set_bit(&mut val, 381);
    }
    to_be_bytes_padded(&val, 48)
}

fn compress_g2(x_c0_str: &str, x_c1_str: &str, y_c0_str: &str, y_c1_str: &str) -> Vec<u8> {
    let x_c0 = parse_field(x_c0_str);
    let x_c1 = parse_field(x_c1_str);
    let y_c0 = parse_field(y_c0_str);
    let y_c1 = parse_field(y_c1_str);
    let fp = fp();

    // Layout: upper 48 bytes = c1, lower 48 bytes = c0
    let mut x_combined = x_c1.clone() << 384u32;
    x_combined |= &x_c0;
    set_bit(&mut x_combined, 767);
    let neg_y_c1 = (fp.clone() - &y_c1) % &fp;
    let neg_y_c0 = (fp.clone() - &y_c0) % &fp;
    if y_c1 > neg_y_c1 || (y_c1 == neg_y_c1 && y_c0 > neg_y_c0) {
        set_bit(&mut x_combined, 765);
    }
    to_be_bytes_padded(&x_combined, 96)
}

fn set_bit(n: &mut BigUint, bit: u32) {
    *n |= BigUint::one() << bit;
}

fn to_be_bytes_padded(n: &BigUint, len: usize) -> Vec<u8> {
    let mut bytes = n.to_bytes_be();
    while bytes.len() < len {
        bytes.insert(0, 0);
    }
    assert_eq!(bytes.len(), len, "value too large for {} bytes", len);
    bytes
}

// ---------------------------------------------------------------------------
// Scalar field helpers
// ---------------------------------------------------------------------------

fn mod_inverse(a: &BigUint, m: &BigUint) -> BigUint {
    let a = ((a % m) + m) % m;
    let exp = m - 2u32;
    a.modpow(&exp, m)
}

// [omega^0, omega^1, ..., omega^nPublic]  (nPublic+1 elements)
fn generator_powers(omega_str: &str, n_public: usize) -> Vec<BigUint> {
    let fr = fr();
    let omega = parse_field(omega_str);
    let mut powers = Vec::with_capacity(n_public + 1);
    let mut cur = BigUint::one();
    for _ in 0..=n_public {
        powers.push(&cur % &fr);
        cur = (&cur * &omega) % &fr;
    }
    powers
}

// ---------------------------------------------------------------------------
// blake2b_224: 28-byte blake2b output (Plutus-mandated)
// ---------------------------------------------------------------------------

fn blake2b_224(data: &[u8]) -> [u8; 28] {
    let mut hasher = Blake2bVar::new(28).expect("valid output size");
    hasher.update(data);
    let mut out = [0u8; 28];
    hasher.finalize_variable(&mut out).unwrap();
    out
}

fn scalar_to_bytes(n: &BigUint) -> Vec<u8> {
    to_be_bytes_padded(n, 32)
}

fn int_to_be32(n: &BigUint) -> Vec<u8> {
    to_be_bytes_padded(n, 32)
}

// ---------------------------------------------------------------------------
// Challenge computation (must match on-chain verifier exactly)
// ---------------------------------------------------------------------------

struct Challenges {
    zeta: BigUint,
}

fn compute_challenges(
    pre: &PreInputs,
    proof_c: &ProofCompressed,
    pub_inputs: &[BigUint],
) -> Challenges {
    let fr = fr();

    let pub_bytes: Vec<u8> = pub_inputs.iter().flat_map(|x| int_to_be32(x)).collect();

    let beta_input: Vec<u8> = [
        pre.q_m.as_slice(),
        pre.q_l.as_slice(),
        pre.q_r.as_slice(),
        pre.q_o.as_slice(),
        pre.q_c.as_slice(),
        pre.s_sig1.as_slice(),
        pre.s_sig2.as_slice(),
        pre.s_sig3.as_slice(),
        pub_bytes.as_slice(),
        proof_c.commitment_a.as_slice(),
        proof_c.commitment_b.as_slice(),
        proof_c.commitment_c.as_slice(),
    ]
    .concat();
    let beta = BigUint::from_bytes_be(&blake2b_224(&beta_input)) % &fr;

    let gamma = BigUint::from_bytes_be(&blake2b_224(&scalar_to_bytes(&beta))) % &fr;

    let alpha_input: Vec<u8> = [
        scalar_to_bytes(&beta).as_slice(),
        scalar_to_bytes(&gamma).as_slice(),
        proof_c.commitment_z.as_slice(),
    ]
    .concat();
    let alpha = BigUint::from_bytes_be(&blake2b_224(&alpha_input)) % &fr;

    let zeta_input: Vec<u8> = [
        scalar_to_bytes(&alpha).as_slice(),
        proof_c.t_low.as_slice(),
        proof_c.t_mid.as_slice(),
        proof_c.t_high.as_slice(),
    ]
    .concat();
    let zeta = BigUint::from_bytes_be(&blake2b_224(&zeta_input)) % &fr;

    Challenges { zeta }
}

fn compute_lagrange_inverses(n_val: &BigUint, zeta: &BigUint, gens: &[BigUint]) -> Vec<BigUint> {
    let fr = fr();
    gens.iter()
        .map(|gen_i| {
            // diff = (zeta - gen_i) mod Fr  (add Fr to avoid underflow)
            let diff = ((zeta + &fr) - gen_i) % &fr;
            let nd = (n_val * &diff) % &fr;
            mod_inverse(&nd, &fr)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

struct PreInputs {
    n: u64,
    power: u32,
    k1: BigUint,
    k2: BigUint,
    q_m: Vec<u8>,
    q_l: Vec<u8>,
    q_r: Vec<u8>,
    q_o: Vec<u8>,
    q_c: Vec<u8>,
    s_sig1: Vec<u8>,
    s_sig2: Vec<u8>,
    s_sig3: Vec<u8>,
    x2: Vec<u8>,
    generators: Vec<BigUint>,
}

struct ProofCompressed {
    commitment_a: Vec<u8>,
    commitment_b: Vec<u8>,
    commitment_c: Vec<u8>,
    commitment_z: Vec<u8>,
    t_low: Vec<u8>,
    t_mid: Vec<u8>,
    t_high: Vec<u8>,
    w_omega: Vec<u8>,
    w_omega_zeta: Vec<u8>,
    a_eval: BigUint,
    b_eval: BigUint,
    c_eval: BigUint,
    s_sig1_eval: BigUint,
    s_sig2_eval: BigUint,
    z_omega_eval: BigUint,
    lagrange_inverses: Vec<BigUint>,
}

// ---------------------------------------------------------------------------
// Minimal CBOR encoder for Plutus Data
// ---------------------------------------------------------------------------

fn cbor_bytes_header(byte_len: usize) -> Vec<u8> {
    if byte_len < 24 {
        vec![0x40 | byte_len as u8]
    } else if byte_len < 0x100 {
        vec![0x58, byte_len as u8]
    } else if byte_len < 0x10000 {
        vec![0x59, (byte_len >> 8) as u8, (byte_len & 0xff) as u8]
    } else {
        panic!("byte string too long: {}", byte_len);
    }
}

fn cbor_uint(n: &BigUint) -> Vec<u8> {
    if *n < BigUint::from(24u32) {
        vec![n.to_u64_digits().first().copied().unwrap_or(0) as u8]
    } else if *n < BigUint::from(0x100u32) {
        let v = n.to_u64_digits()[0] as u8;
        vec![0x18, v]
    } else if *n < BigUint::from(0x10000u32) {
        let padded = to_be_bytes_padded(n, 2);
        vec![0x19, padded[0], padded[1]]
    } else if *n < BigUint::from(0x100000000u64) {
        let padded = to_be_bytes_padded(n, 4);
        let mut out = vec![0x1a];
        out.extend_from_slice(&padded);
        out
    } else if *n < BigUint::from(0x10000000000000000u128) {
        let padded = to_be_bytes_padded(n, 8);
        let mut out = vec![0x1b];
        out.extend_from_slice(&padded);
        out
    } else {
        // Tag 2: positive bignum
        let value_bytes = n.to_bytes_be();
        let header = cbor_bytes_header(value_bytes.len());
        let mut out = vec![0xc2];
        out.extend_from_slice(&header);
        out.extend_from_slice(&value_bytes);
        out
    }
}

fn cbor_bytes(buf: &[u8]) -> Vec<u8> {
    let mut out = cbor_bytes_header(buf.len());
    out.extend_from_slice(buf);
    out
}

fn cbor_array(items: &[Vec<u8>]) -> Vec<u8> {
    let n = items.len();
    let mut out = if n < 24 {
        vec![0x80 | n as u8]
    } else if n < 256 {
        vec![0x98, n as u8]
    } else {
        vec![0x99, (n >> 8) as u8, (n & 0xff) as u8]
    };
    for item in items {
        out.extend_from_slice(item);
    }
    out
}

// Plutus Constr 0 = CBOR tag 121 = 0xD879
fn cbor_constr0(fields: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![0xd8, 0x79];
    out.extend_from_slice(&cbor_array(fields));
    out
}

// ---------------------------------------------------------------------------
// Encode PreInputs as Plutus Data
// ---------------------------------------------------------------------------

fn encode_pre_inputs(pre: &PreInputs) -> Vec<u8> {
    cbor_constr0(&[
        cbor_uint(&BigUint::from(pre.n)),
        cbor_uint(&BigUint::from(pre.power)),
        cbor_uint(&pre.k1),
        cbor_uint(&pre.k2),
        cbor_bytes(&pre.q_m),
        cbor_bytes(&pre.q_l),
        cbor_bytes(&pre.q_r),
        cbor_bytes(&pre.q_o),
        cbor_bytes(&pre.q_c),
        cbor_bytes(&pre.s_sig1),
        cbor_bytes(&pre.s_sig2),
        cbor_bytes(&pre.s_sig3),
        cbor_bytes(&pre.x2),
        cbor_array(&pre.generators.iter().map(|g| cbor_uint(g)).collect::<Vec<_>>()),
    ])
}

// ---------------------------------------------------------------------------
// Encode Proof as Plutus Data
// ---------------------------------------------------------------------------

fn encode_proof(p: &ProofCompressed) -> Vec<u8> {
    cbor_constr0(&[
        cbor_bytes(&p.commitment_a),
        cbor_bytes(&p.commitment_b),
        cbor_bytes(&p.commitment_c),
        cbor_bytes(&p.commitment_z),
        cbor_bytes(&p.t_low),
        cbor_bytes(&p.t_mid),
        cbor_bytes(&p.t_high),
        cbor_bytes(&p.w_omega),
        cbor_bytes(&p.w_omega_zeta),
        cbor_uint(&p.a_eval),
        cbor_uint(&p.b_eval),
        cbor_uint(&p.c_eval),
        cbor_uint(&p.s_sig1_eval),
        cbor_uint(&p.s_sig2_eval),
        cbor_uint(&p.z_omega_eval),
        cbor_array(&p.lagrange_inverses.iter().map(|li| cbor_uint(li)).collect::<Vec<_>>()),
    ])
}

// Redeemer = 2-tuple (pub_inputs, proof)
fn encode_redeemer(pub_inputs: &[BigUint], proof: &ProofCompressed) -> Vec<u8> {
    cbor_array(&[
        cbor_array(&pub_inputs.iter().map(|x| cbor_uint(x)).collect::<Vec<_>>()),
        encode_proof(proof),
    ])
}

// ---------------------------------------------------------------------------
// JSON field helpers
// ---------------------------------------------------------------------------

fn g1_xy_z(v: &Value) -> (&str, &str, &str) {
    let arr = v.as_array().unwrap();
    (arr[0].as_str().unwrap(), arr[1].as_str().unwrap(), arr[2].as_str().unwrap())
}

fn compress_g1_json(v: &Value) -> Vec<u8> {
    let (x, y, z) = g1_xy_z(v);
    if z.trim() == "0" {
        // Point at infinity: compressed flag + infinity flag, rest zeros
        let mut out = vec![0u8; 48];
        out[0] = 0xc0;
        return out;
    }
    compress_g1(x, y)
}

fn compress_g2_json(v: &Value) -> Vec<u8> {
    let arr = v.as_array().unwrap();
    // G2 point: [[x_c0, x_c1], [y_c0, y_c1], [z_c0, z_c1]]
    let z = arr[2].as_array().unwrap();
    let z_c0 = z[0].as_str().unwrap().trim();
    let z_c1 = z[1].as_str().unwrap().trim();
    if z_c0 == "0" && z_c1 == "0" {
        let mut out = vec![0u8; 96];
        out[0] = 0xc0;
        return out;
    }
    let x = arr[0].as_array().unwrap();
    let y = arr[1].as_array().unwrap();
    compress_g2(
        x[0].as_str().unwrap(),
        x[1].as_str().unwrap(),
        y[0].as_str().unwrap(),
        y[1].as_str().unwrap(),
    )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 {
        eprintln!("Usage: convert_proof <vk.json> <proof.json> <public-input.json> <out-dir>");
        std::process::exit(1);
    }

    let vk: Value = serde_json::from_str(&fs::read_to_string(&args[1]).unwrap()).unwrap();
    let proof: Value = serde_json::from_str(&fs::read_to_string(&args[2]).unwrap()).unwrap();
    let pub_raw: Value = serde_json::from_str(&fs::read_to_string(&args[3]).unwrap()).unwrap();
    let out_dir = Path::new(&args[4]);

    let pub_inputs: Vec<BigUint> = pub_raw
        .as_array()
        .unwrap()
        .iter()
        .map(|s| parse_field(s.as_str().unwrap()))
        .collect();

    let power: u32 = vk["power"].as_u64().unwrap() as u32;
    let n_val: u64 = 1u64 << power;
    let n_public: usize = vk["nPublic"].as_u64().unwrap() as usize;

    // Build pre_inputs (VK)
    let omega_str = vk["w"].as_str().unwrap();
    let generators = generator_powers(omega_str, n_public);

    let pre = PreInputs {
        n: n_val,
        power,
        k1: parse_field(vk["k1"].as_str().unwrap()),
        k2: parse_field(vk["k2"].as_str().unwrap()),
        q_m: compress_g1_json(&vk["Qm"]),
        q_l: compress_g1_json(&vk["Ql"]),
        q_r: compress_g1_json(&vk["Qr"]),
        q_o: compress_g1_json(&vk["Qo"]),
        q_c: compress_g1_json(&vk["Qc"]),
        s_sig1: compress_g1_json(&vk["S1"]),
        s_sig2: compress_g1_json(&vk["S2"]),
        s_sig3: compress_g1_json(&vk["S3"]),
        x2: compress_g2_json(&vk["X_2"]),
        generators,
    };

    // Build proof_c (compressed proof)
    let mut proof_c = ProofCompressed {
        commitment_a: compress_g1_json(&proof["A"]),
        commitment_b: compress_g1_json(&proof["B"]),
        commitment_c: compress_g1_json(&proof["C"]),
        commitment_z: compress_g1_json(&proof["Z"]),
        t_low: compress_g1_json(&proof["T1"]),
        t_mid: compress_g1_json(&proof["T2"]),
        t_high: compress_g1_json(&proof["T3"]),
        w_omega: compress_g1_json(&proof["Wxi"]),
        w_omega_zeta: compress_g1_json(&proof["Wxiw"]),
        a_eval: parse_field(proof["eval_a"].as_str().unwrap()),
        b_eval: parse_field(proof["eval_b"].as_str().unwrap()),
        c_eval: parse_field(proof["eval_c"].as_str().unwrap()),
        s_sig1_eval: parse_field(proof["eval_s1"].as_str().unwrap()),
        s_sig2_eval: parse_field(proof["eval_s2"].as_str().unwrap()),
        z_omega_eval: parse_field(proof["eval_zw"].as_str().unwrap()),
        lagrange_inverses: vec![],
    };

    let challenges = compute_challenges(&pre, &proof_c, &pub_inputs);
    let n_big = BigUint::from(n_val);
    proof_c.lagrange_inverses = compute_lagrange_inverses(&n_big, &challenges.zeta, &pre.generators);

    eprintln!("Zeta: {}", challenges.zeta);
    eprintln!("Lagrange inverses computed: {}", proof_c.lagrange_inverses.len());

    let pre_inputs_cbor = encode_pre_inputs(&pre);
    let redeemer_cbor = encode_redeemer(&pub_inputs, &proof_c);

    fs::create_dir_all(out_dir).unwrap();
    fs::write(out_dir.join("pre_inputs.cbor"), hex::encode(&pre_inputs_cbor)).unwrap();
    fs::write(out_dir.join("redeemer.cbor"), hex::encode(&redeemer_cbor)).unwrap();

    eprintln!("Written:");
    eprintln!("  pre_inputs.cbor  — CBOR hex for `aiken blueprint apply`");
    eprintln!("  redeemer.cbor    — CBOR hex of the minting redeemer");
}
