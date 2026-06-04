#!/usr/bin/env bash
# End-to-end: Sudoku SHA256 circuit → PLONK prove → Plutus Data → aiken blueprint apply
#
# The circuit proves knowledge of (board, solved) s.t.:
#   SHA256(board) == boardId   (public input, single field element)
#   solved is a valid Sudoku solution for board
#
# Prerequisites (provided by `nix develop`):
#   circom, snarkjs, node, jq, aiken, cargo
#
# Run from the repo root:
#   nix develop --command bash scripts/generate_artifacts.sh

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
CIRCUIT_DIR="$REPO_ROOT/circom/sudoku"
VECTORS_DIR="$REPO_ROOT/test-vectors/sudoku"
SETUP_DIR="$REPO_ROOT/test-vectors/setup"
ASSETS_DIR="$REPO_ROOT/assets/sudoku"

mkdir -p "$SETUP_DIR" "$VECTORS_DIR" "$ASSETS_DIR"

# ---------------------------------------------------------------------------
# 1. Install Node.js dependencies
# ---------------------------------------------------------------------------
echo "==> Installing circomlib..."
(cd "$CIRCUIT_DIR" && npm install --silent)

echo "==> Installing script dependencies (@noble/hashes)..."
(cd "$REPO_ROOT/scripts" && npm install --silent)

# ---------------------------------------------------------------------------
# 2. Compile Sudoku SHA256 circuit
# ---------------------------------------------------------------------------
echo "==> Compiling Sudoku SHA256 circuit (SHA256 + puzzle constraints)..."
circom "$CIRCUIT_DIR/sudoku.circom" \
  --r1cs --wasm --sym \
  --prime bls12381 \
  -o "$CIRCUIT_DIR"

# ---------------------------------------------------------------------------
# 3. Powers of tau (power=17 supports up to 131072 PLONK gates)
#    PLONK expands ~36k R1CS constraints to ~124k gates, requiring power=17
#
#    Single-party ceremony.  Set SETUP_ENTROPY to your chosen randomness before
#    running for the first time.  The resulting pot17_final.ptau and
#    sudoku_final.zkey are tracked via Git LFS and treated as permanent —
#    ceremony metadata is recorded in test-vectors/setup/setup_metadata.json.
# ---------------------------------------------------------------------------
PTAU="$SETUP_DIR/pot17_final.ptau"

if [ ! -f "$PTAU" ]; then
  if [ -z "${SETUP_ENTROPY:-}" ]; then
    echo "Error: SETUP_ENTROPY must be set to run the trusted setup ceremony."
    echo "  SETUP_ENTROPY='your randomness here' bash scripts/generate_artifacts.sh"
    exit 1
  fi
  echo "==> Generating powers of tau (power=17, BLS12-381) — this takes several minutes..."
  snarkjs powersoftau new bls12-381 17 "$SETUP_DIR/pot17_0000.ptau" -v
  snarkjs powersoftau contribute "$SETUP_DIR/pot17_0000.ptau" "$SETUP_DIR/pot17_0001.ptau" \
    --name="First contribution" -v -e="$SETUP_ENTROPY"
  snarkjs powersoftau prepare phase2 "$SETUP_DIR/pot17_0001.ptau" "$PTAU" -v
fi

# ---------------------------------------------------------------------------
# 4. Circuit-specific proving key
# ---------------------------------------------------------------------------
ZKEY="$VECTORS_DIR/sudoku_final.zkey"
VK="$VECTORS_DIR/verification_key.json"

if [ -s "$ZKEY" ]; then
  echo "==> Reusing existing zkey — delete manually to regenerate."
else
  echo "==> Generating PLONK proving key (may take 1-2 min)..."
  snarkjs plonk setup "$CIRCUIT_DIR/sudoku.r1cs" "$PTAU" "$ZKEY"

  echo "==> Exporting verification key..."
  snarkjs zkey export verificationkey "$ZKEY" "$VK"

  # Record ceremony metadata
  PTAU_SHA=$(sha256sum "$PTAU" | awk '{print $1}')
  ZKEY_SHA=$(sha256sum "$ZKEY" | awk '{print $1}')
  ENTROPY_SHA=$(echo -n "${SETUP_ENTROPY:-}" | sha256sum | awk '{print $1}')
  cat > "$SETUP_DIR/setup_metadata.json" <<METADATA_EOF
{
  "ceremony": "single-party",
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "entropy_sha256": "$ENTROPY_SHA",
  "ptau_sha256": "$PTAU_SHA",
  "zkey_sha256": "$ZKEY_SHA"
}
METADATA_EOF
  echo "==> Setup metadata written to test-vectors/setup/setup_metadata.json"
fi

if [ ! -f "$VK" ]; then
  echo "==> Exporting verification key..."
  snarkjs zkey export verificationkey "$ZKEY" "$VK"
fi

# ---------------------------------------------------------------------------
# 5. Compute boardId and write input.json
# ---------------------------------------------------------------------------
echo "==> Computing boardId (SHA256 of puzzle encoding)..."
node - <<'BOARDID_EOF' > "$VECTORS_DIR/input.json"
const crypto = require('crypto');

// Classic sudoku puzzle (0 = empty cell)
const board = [
  [5, 3, 0, 0, 7, 0, 0, 0, 0],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9]
];

const solved = [
  [5, 3, 4, 6, 7, 8, 9, 1, 2],
  [6, 7, 2, 1, 9, 5, 3, 4, 8],
  [1, 9, 8, 3, 4, 2, 5, 6, 7],
  [8, 5, 9, 7, 6, 1, 4, 2, 3],
  [4, 2, 6, 8, 5, 3, 7, 9, 1],
  [7, 1, 3, 9, 2, 4, 8, 5, 6],
  [9, 6, 1, 5, 3, 7, 2, 8, 4],
  [2, 8, 7, 4, 1, 9, 6, 3, 5],
  [3, 4, 5, 2, 8, 6, 1, 7, 9]
];

// Encode board as 328 bits (4 zero padding bits + 81 cells × 4 bits, big-endian nibbles)
// Byte 0: 0x0? (upper nibble = 0, lower nibble = board[0][0])
// Byte k (k>=1): upper nibble = board cell 2k-1, lower nibble = board cell 2k
const bytes = Buffer.alloc(41, 0);
bytes[0] = board[0][0];
for (let k = 1; k <= 40; k++) {
  const cell1 = board[Math.floor((2*k-1)/9)][(2*k-1)%9];
  const cell2 = board[Math.floor((2*k)/9)][(2*k)%9];
  bytes[k] = (cell1 << 4) | cell2;
}

const hash = crypto.createHash('sha256').update(bytes).digest();
const hashBigInt = BigInt('0x' + hash.toString('hex'));

// Reduce modulo BLS12-381 scalar field prime
const Fr = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const boardId = (hashBigInt % Fr).toString();

process.stdout.write(JSON.stringify({ boardId, board, solved }, null, 2) + '\n');
BOARDID_EOF

echo "  boardId = $(node -e "console.log(JSON.parse(require('fs').readFileSync('$VECTORS_DIR/input.json')).boardId)")"

# ---------------------------------------------------------------------------
# 6. Generate witness
# ---------------------------------------------------------------------------
echo "==> Generating witness..."
node "$CIRCUIT_DIR/sudoku_js/generate_witness.js" \
  "$CIRCUIT_DIR/sudoku_js/sudoku.wasm" \
  "$VECTORS_DIR/input.json" \
  "$VECTORS_DIR/witness.wtns"

# ---------------------------------------------------------------------------
# 7. Generate and verify PLONK proof
# ---------------------------------------------------------------------------
echo "==> Generating PLONK proof (may take 1-2 min)..."
snarkjs plonk prove \
  "$ZKEY" \
  "$VECTORS_DIR/witness.wtns" \
  "$VECTORS_DIR/proof.json" \
  "$VECTORS_DIR/public-input.json"

echo "==> Verifying proof with snarkjs..."
snarkjs plonk verify "$VK" "$VECTORS_DIR/public-input.json" "$VECTORS_DIR/proof.json"

# ---------------------------------------------------------------------------
# 8. Convert VK + proof to Plutus Data CBOR
# ---------------------------------------------------------------------------
echo "==> Converting to Plutus Data..."
node "$REPO_ROOT/scripts/convert_proof.js" \
  "$VK" \
  "$VECTORS_DIR/proof.json" \
  "$VECTORS_DIR/public-input.json" \
  "$ASSETS_DIR"

# ---------------------------------------------------------------------------
# 9. Generate Aiken test literal
# ---------------------------------------------------------------------------
echo "==> Generating Aiken test vectors..."
node "$REPO_ROOT/scripts/gen_aiken_test.js" \
  "$VK" \
  "$VECTORS_DIR/proof.json" \
  "$VECTORS_DIR/public-input.json" \
  > "$ASSETS_DIR/verify_sudoku_test.ak"

# ---------------------------------------------------------------------------
# 10. Build Aiken project and apply VK to blueprint
# ---------------------------------------------------------------------------
echo "==> Building Aiken project..."
cd "$REPO_ROOT"
aiken build

echo "==> Applying VK to blueprint..."
aiken blueprint apply \
  -m plonk_challenge \
  -v plonk_challenge \
  --out "$ASSETS_DIR/plutus_applied.json" \
  "$(cat "$ASSETS_DIR/pre_inputs.cbor")"

# ---------------------------------------------------------------------------
# 11. Prepare browser frontend assets
# ---------------------------------------------------------------------------
echo "==> Installing frontend npm dependencies..."
(cd "$REPO_ROOT/frontend" && npm install --silent)

echo "==> Copying circuit artifacts to frontend/public/..."
mkdir -p "$REPO_ROOT/frontend/public"
cp "$CIRCUIT_DIR/sudoku_js/sudoku.wasm" "$REPO_ROOT/frontend/public/"
cp "$VECTORS_DIR/verification_key.json"  "$REPO_ROOT/frontend/public/"

echo ""
echo "Done! Artifacts written to $ASSETS_DIR/"
echo "  pre_inputs.cbor          — VK as Plutus Data CBOR (for blueprint apply)"
echo "  redeemer.cbor            — Redeemer CBOR for the minting transaction"
echo "  plutus_applied.json      — Applied blueprint with VK baked in"
echo "  verify_sudoku_test.ak    — Aiken test literal (copy into verifier.test.ak)"
echo ""
echo "Frontend assets written to frontend/public/"
echo "  sudoku.wasm              — Circuit WASM for browser proving"
