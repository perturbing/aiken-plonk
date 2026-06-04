# Sudoku Bounty

A challenge-and-solve system built on Cardano: anyone can publish a Sudoku puzzle on-chain with locked ADA as a bounty, and anyone who can solve it can claim that ADA — by submitting a zero-knowledge proof that they know a valid solution, without ever revealing what the solution is.

The verifier is a Cardano smart contract written in [Aiken](https://aiken-lang.org/). The prover runs entirely in the browser using [SnarkJS](https://github.com/iden3/snarkjs) and [Lucid Evolution](https://github.com/Lucid-Evolution/lucid-evolution). No backend server is required.

**Live demo:** https://perturbing.github.io/sudoku-bounty/

---

## What it does

The app has three flows:

### 1. Prove (local, free)
Enter a Sudoku puzzle and its solution. The browser generates a PLONK proof that:
- The solution satisfies all Sudoku constraints (rows, columns, boxes all 1–9 with no repeats).
- The solution is consistent with the given clues.
- The SHA-256 hash of the puzzle matches a public board ID (this ties the proof to a specific puzzle without revealing the solution).

Proof generation takes roughly 30–60 seconds and runs in a background Web Worker so the page stays responsive. The 208 MB proving key is downloaded once and cached in IndexedDB.

### 2. Publish a challenge
After proving your solution, you can lock ADA on-chain as a reward for anyone who can solve your puzzle. The clues are stored in the UTxO datum; the solution never leaves your browser.

### 3. Solve a challenge and claim the reward
Browse open challenges fetched from the script address. Load one into the Prove tab, generate a valid proof, then submit it on-chain with the Eternl wallet to claim the locked ADA.

Publishers can retract their own challenge at any time to reclaim the locked funds.

---

## Architecture

```
Browser
  └─ Prove tab
       ├─ boardId.js      SHA-256(encoded puzzle) mod Fr  →  public input
       ├─ prover-worker.js  snarkjs.plonk.fullProve()     →  proof JSON
       │    (uses sudoku.wasm + sudoku_final.zkey, 208 MB, cached in IndexedDB)
       └─ chain.js         Lucid + Blockfrost             →  Cardano tx

Cardano Preview testnet
  └─ plonk_challenge.spend (Aiken validator)
       ├─ Publisher path:  tx signed by publisher pkh  →  retract UTxO
       └─ Proof path:      verify_plonk_fast(vk, [boardId], proof)  →  claim UTxO
```

### On-chain verification

The validator is parameterised with the PLONK verification key (baked in via `aiken blueprint apply`). For each claim attempt it:

1. Decodes the `(pub_inputs, proof)` redeemer.
2. Checks `pub_inputs[0] == datum.board_id` — the proof is for *this* puzzle.
3. Runs a full PLONK verifier over BLS12-381: Fiat-Shamir challenges (Blake2b-224), polynomial evaluations, and a final KZG pairing check.
4. Validates the precomputed Lagrange inverses supplied in the proof (this optimisation avoids on-chain modular inversion; it will be replaced when CIP-109 lands).

### Circuit

The Circom circuit (`circom/sudoku/sudoku.circom`) encodes:
- `SHA-256(encoded_board) == boardId` — connects the public board ID to the actual clues.
- Each filled cell matches its clue.
- Every row, column, and 3×3 box contains the digits 1–9 exactly once.

~36 k R1CS constraints, expanded to ~124 k PLONK gates with a power-17 setup.

---

## Repository layout

```
sudoku-bounty/
├── validators/
│   └── plonk_challenge.ak   # On-chain spend validator
├── lib/plonk/
│   ├── types.ak             # Proof, PreInputs, ChallengeDatum types
│   ├── verifier.ak          # PLONK verifier (BLS12-381 / KZG)
│   └── verifier.test.ak     # Aiken unit test with hardcoded test vector
├── circom/sudoku/
│   └── sudoku.circom        # Sudoku ZK circuit
├── test-vectors/sudoku/
│   ├── sudoku.wasm          # Witness generation WASM
│   ├── sudoku_final.zkey    # Proving key (208 MB, Git LFS)
│   └── verification_key.json
├── scripts/
│   ├── generate_artifacts.sh  # End-to-end: compile circuit → ceremony → zkey → test vector
│   └── convert_proof.js       # SnarkJS proof → Plutus Data CBOR + Aiken blueprint param
├── frontend/
│   ├── index.html
│   └── js/
│       ├── main.js          # UI event handlers, proof generation flow
│       ├── chain.js         # Lucid transactions (deploy/fetch/claim/retract)
│       ├── sudoku-ui.js     # Grid rendering and validation
│       ├── boardId.js       # Board ID computation (SHA-256 mod Fr)
│       └── prover-worker.js # Web Worker wrapping snarkjs.plonk.fullProve
└── flake.nix                # Nix dev shell
```

---

## Using the live demo

### Prerequisites

- **Blockfrost API key (Preview testnet)** — needed to fetch challenges and submit transactions. Sign up at [blockfrost.io](https://blockfrost.io/), create a project for the **Preview** network, and copy the `previewXXXXXXXXXX` key. The key is only used client-side to talk to Blockfrost directly; it is never sent anywhere else.
- **Eternl wallet** — needed only for publishing or claiming. Install the [Eternl](https://eternl.io/) browser extension and switch it to the Preview testnet. You can get free Preview ADA from the [Cardano testnet faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

Generating and verifying a proof locally requires neither a key nor a wallet.

1. Open https://perturbing.github.io/sudoku-bounty/
2. Paste your Blockfrost Preview API key into the field at the top.

### Prove (no wallet needed)

1. Go to the **Prove** tab.
2. Enter clues, or click **Load Example** for a pre-filled puzzle.
3. Click **Set Puzzle**, then fill in the solution cells (or **Fill Example Solution**).
4. Click **Generate Proof**. The first run downloads the 208 MB zkey; subsequent runs use the browser cache.
5. The proof JSON is displayed when complete.

### Publish a challenge

1. Complete the **Prove** flow, then go to the **Publish** tab (or follow the hint link).
2. Enter clue cells and click **Set Puzzle**.
3. Fill in the full solution and click **Confirm Solution** to verify it is valid.
4. Enter the ADA amount to lock (minimum 2 ADA) and click **Connect Eternl & Publish**.
5. Approve the transaction in Eternl. The challenge appears in the **Challenges** tab once the transaction is confirmed.

### Solve a challenge and claim

1. Go to the **Challenges** tab and click **Fetch Challenges**.
2. Click **Solve & Claim** on any open challenge.
3. You are taken to the **Prove** tab with the puzzle pre-loaded.
4. Fill in a valid solution and click **Generate Proof**.
5. Click **Connect Eternl & Claim** and approve the transaction in Eternl.

### Retract your own challenge

In the **Challenges** tab, challenges you published show a **Retract** button. Click it, approve in Eternl, and the locked ADA is returned to your wallet.

---

## Building locally

Prerequisites: [Nix](https://nixos.org/) with flakes enabled.

```bash
# Enter the dev shell (installs Node.js, circom, aiken, snarkjs, etc.)
nix develop

# Run Aiken tests
aiken check

# Build the frontend
cd frontend
npm install
npm run dev      # dev server at http://localhost:5173/
npm run build    # production build → frontend/dist/
```

### Regenerating artifacts (circuit → zkey → test vector)

This re-runs the entire pipeline from scratch: compile the Circom circuit, run a local trusted setup ceremony, generate the proving and verification keys, produce a test proof, and emit the Aiken test literal.

```bash
export SETUP_ENTROPY="some random string"
nix develop --command bash scripts/generate_artifacts.sh
```

The ceremony uses single-party randomness, which is fine for development and testing but **not** suitable for production use.

> **Note:** Every run produces a fresh trusted setup, which changes the verification key. Because the verification key is baked into the Aiken validator as a parameter, a different setup yields a different script hash and a different script address. Any challenges published under the old address become unreachable by the new build. Only regenerate if you intend to redeploy the contract.

---

## Security

**This project is unaudited. Use at your own risk.**

- **Trusted setup.** The powers-of-tau ceremony was run by a single party (the author). In a PLONK trusted setup, anyone who knows the toxic waste from the ceremony can forge arbitrary proofs. A production deployment would require a multi-party ceremony where the setup is sound as long as at least one participant discards their randomness honestly.
- **No audit.** The Aiken verifier, the Circom circuit, and the frontend have not been independently audited. There may be bugs that allow invalid proofs to pass, or valid proofs to be front-run or replayed.

---

## Contract details (Preview testnet)

| | |
|---|---|
| Script hash | `e148dfba00dba24086d33451fd56fcf4db777c47472d27a9ec9cc81c` |
| Script address | `addr_test1wrs53ha6qrd6ysyx6v69rl2kln6dkamugarj6fafajwvs8qfymxns` |
| Network | Cardano Preview testnet |
| Wallet | Eternl (CIP-30) |
| Blockchain API | Blockfrost Preview |

---

## Acknowledgements

The Sudoku Circom circuit is based on the work by [Venture23](https://github.com/venture23-zkp/zkp-examples).
