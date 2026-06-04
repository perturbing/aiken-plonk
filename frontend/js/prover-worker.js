// Web Worker: generates a PLONK proof using snarkjs-cardano.
// Receives: { board, solved, boardId, zkeyBuffer }
// Posts back: { proof, publicSignals } or { error }

importScripts('/snarkjs.min.js');

self.onmessage = async ({ data }) => {
  try {
    const { board, solved, boardId, zkeyBuffer } = data;

    const input = {
      boardId,
      board: board.map(row => row.map(String)),
      solved: solved.map(row => row.map(String)),
    };

    // public/ is served at / by Vite (and by the generate_artifacts.sh copy step)
    const wasmUrl = new URL('/sudoku.wasm', self.location.origin).href;
    const zkeyBlob = new Blob([zkeyBuffer], { type: 'application/octet-stream' });
    const zkeyUrl  = URL.createObjectURL(zkeyBlob);

    let proof, publicSignals;
    try {
      ({ proof, publicSignals } = await snarkjs.plonk.fullProve(input, wasmUrl, zkeyUrl));
    } finally {
      URL.revokeObjectURL(zkeyUrl);
    }

    self.postMessage({ proof, publicSignals });
  } catch (err) {
    self.postMessage({ error: err.message ?? String(err) });
  }
};
