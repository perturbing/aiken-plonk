use aiken/collection/list
use cardano/transaction.{
  InlineDatum, Input, OutputReference, Transaction,
}
use plonk/types.{ChallengeDatum, PreInputs, Proof}
use plonk/verifier

/// Spend validator for on-chain sudoku challenges.
///
/// A challenge is a UTxO locked at this address whose inline datum encodes the
/// puzzle (board_id + board_encoded) and the publisher's payment key hash.
///
/// Spending paths:
///   1. Publisher retract — publisher_pkh signs the tx (covers retraction,
///      expired/abandoned challenges, and invalid board_id cases).
///   2. Normal claim — a valid PLONK proof is supplied whose public input
///      matches the board_id recorded in the datum.
///
/// UTxOs with a datum hash (instead of inline datum), or no datum, or an
/// unrecognised datum structure, are spendable by anyone.  This prevents
/// unrenderable challenges from locking funds permanently.
///
/// The verification key (PreInputs) is baked in as a validator parameter so
/// each circuit/setup produces a distinct script address.
///
/// To apply the verification key:
///   aiken blueprint apply -v plonk_challenge.spend '<cbor_hex_of_pre_inputs>'
validator plonk_challenge(pre: PreInputs) {
  spend(
    datum: Option<ChallengeDatum>,
    redeemer: (List<Int>, Proof),
    oref: OutputReference,
    ctx: Transaction,
  ) -> Bool {
    // Resolve the UTxO being spent to inspect its datum type.
    expect Some(input) =
      ctx.inputs
        |> list.find(fn(i: Input) { i.output_reference == oref })

    when input.output.datum is {
      // Only inline datums are valid challenge markers.
      InlineDatum(_) ->
        when datum is {
          Some(d) -> {
            let signed_by_publisher =
              list.has(ctx.extra_signatories, d.publisher_pkh)
            if signed_by_publisher {
              True
            } else {
              let (pub_inputs, proof) = redeemer
              expect [bid, ..] = pub_inputs
              // The PLONK circuit enforces pub_inputs[0] == SHA256(board) mod Fr,
              // so checking bid == d.board_id is sufficient without re-hashing on-chain.
              bid == d.board_id && verifier.verify_plonk_fast(pre, pub_inputs, proof)
            }
          }
          // Inline datum present but did not decode as ChallengeDatum — anyone can spend.
          None -> True
        }
      // DatumHash or NoDatum — anyone can spend.
      _ -> True
    }
  }

  else(_) {
    fail
  }
}
