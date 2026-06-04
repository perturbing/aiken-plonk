import { SudokuUI } from './sudoku-ui.js';
import { computeBoardId } from './boardId.js';
// chain.js is loaded lazily so its WASM (Lucid/CML) initialises in its own
// chunk and doesn't block or race with the main module during startup.
const chain = () => import('./chain.js');

// Classic sudoku puzzle used as the repo's test vector.
const EXAMPLE_PUZZLE = [
  [5, 3, 0, 0, 7, 0, 0, 0, 0],
  [6, 0, 0, 1, 9, 5, 0, 0, 0],
  [0, 9, 8, 0, 0, 0, 0, 6, 0],
  [8, 0, 0, 0, 6, 0, 0, 0, 3],
  [4, 0, 0, 8, 0, 3, 0, 0, 1],
  [7, 0, 0, 0, 2, 0, 0, 0, 6],
  [0, 6, 0, 0, 0, 0, 2, 8, 0],
  [0, 0, 0, 4, 1, 9, 0, 0, 5],
  [0, 0, 0, 0, 8, 0, 0, 7, 9],
];
const EXAMPLE_SOLVED = [
  [5, 3, 4, 6, 7, 8, 9, 1, 2],
  [6, 7, 2, 1, 9, 5, 3, 4, 8],
  [1, 9, 8, 3, 4, 2, 5, 6, 7],
  [8, 5, 9, 7, 6, 1, 4, 2, 3],
  [4, 2, 6, 8, 5, 3, 7, 9, 1],
  [7, 1, 3, 9, 2, 4, 8, 5, 6],
  [9, 6, 1, 5, 3, 7, 2, 8, 4],
  [2, 8, 7, 4, 1, 9, 6, 3, 5],
  [3, 4, 5, 2, 8, 6, 1, 7, 9],
];

const ZKEY_URL = 'https://media.githubusercontent.com/media/perturbing/sudoku-bounty/main/test-vectors/sudoku/sudoku_final.zkey';
const IDB_DB   = 'plonk-zkey-store';
const IDB_KEY  = 'sudoku_final';

// ---------------------------------------------------------------------------
// Global API key
// ---------------------------------------------------------------------------

function getKey() { return document.getElementById('global-blockfrost-key').value.trim(); }

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('zkeys');
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function loadFromIDB() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('zkeys', 'readonly');
    const req = tx.objectStore('zkeys').get(IDB_KEY);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}

async function saveToIDB(buffer) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('zkeys', 'readwrite');
    const req = tx.objectStore('zkeys').put(buffer, IDB_KEY);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ---------------------------------------------------------------------------
// zkey fetching with progress
// ---------------------------------------------------------------------------

async function fetchZkey(progressEl, statusEl) {
  const cached = await loadFromIDB();
  if (cached) return cached;

  setStatus(statusEl, 'Downloading proving key (200 MB)…');
  progressEl.hidden = false;
  progressEl.value  = 0;

  const resp = await fetch(ZKEY_URL);
  if (!resp.ok) throw new Error(`Failed to fetch zkey: ${resp.status} ${resp.statusText}`);

  const total  = parseInt(resp.headers.get('Content-Length') || '0', 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) progressEl.value = received / total;
  }

  progressEl.hidden = true;
  const buf = await new Blob(chunks).arrayBuffer();
  await saveToIDB(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(el, msg) { el.textContent = msg; }

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function activateTab(name) {
  for (const t of ['challenges', 'prove', 'publish']) {
    document.getElementById(`tab-btn-${t}`).classList.toggle('active', t === name);
    document.getElementById(`tab-${t}`).hidden = t !== name;
  }
}

document.getElementById('tab-btn-challenges').addEventListener('click', () => activateTab('challenges'));
document.getElementById('tab-btn-prove').addEventListener('click',      () => activateTab('prove'));
document.getElementById('tab-btn-publish').addEventListener('click',    () => activateTab('publish'));

document.getElementById('link-to-publish').addEventListener('click', (e) => {
  e.preventDefault();
  if (puzzleBoard) {
    pubReset();
    pubUi.preload(puzzleBoard);
    pubBoard = pubUi.lockPuzzle();
    pubBtnValidate.disabled = !pubUi.isComplete();
    document.getElementById('pub-phase-puzzle').hidden = true;
    document.getElementById('pub-phase-solve').hidden  = false;
  }
  activateTab('publish');
});

// ---------------------------------------------------------------------------
// Prove tab state
// ---------------------------------------------------------------------------

const gridEl       = document.getElementById('grid');
const btnSet       = document.getElementById('btn-set-puzzle');
const btnExample   = document.getElementById('btn-load-example');
const btnFill      = document.getElementById('btn-fill-solution');
const btnProve     = document.getElementById('btn-prove');
const btnReset     = document.getElementById('btn-reset');
const statusEl     = document.getElementById('status');
const progressEl   = document.getElementById('progress');
const outputEl     = document.getElementById('output');
const proofJsonEl  = document.getElementById('proof-json');
const btnCopy      = document.getElementById('btn-copy');
const claimSectionEl  = document.getElementById('claim-section');
const claimStatusEl   = document.getElementById('claim-status');
const publishHintEl   = document.getElementById('publish-hint');

const ui = new SudokuUI(gridEl);
let puzzleBoard  = null;
let lastProof    = null;
let lastBoardId  = null;
let pendingClaim = null;  // { challenge } when solving a fetched challenge

ui.onChange = () => {
  if (ui.phase === 'solve') btnProve.disabled = !ui.isComplete();
};

// ---------------------------------------------------------------------------
// Phase navigation (Prove tab)
// ---------------------------------------------------------------------------

btnExample.addEventListener('click', () => {
  ui.preload(EXAMPLE_PUZZLE);
  puzzleBoard = ui.lockPuzzle();
  pendingClaim = null;
  document.getElementById('phase-puzzle').hidden = true;
  document.getElementById('phase-solve').hidden  = false;
  btnProve.disabled = true;
  setStatus(statusEl, 'Example loaded. Click "Fill Example Solution" or solve it yourself.');
});

btnFill.addEventListener('click', () => { ui.fillSolution(EXAMPLE_SOLVED); });

btnSet.addEventListener('click', () => {
  puzzleBoard = ui.lockPuzzle();
  pendingClaim = null;
  document.getElementById('phase-puzzle').hidden = true;
  document.getElementById('phase-solve').hidden  = false;
  btnProve.disabled = !ui.isComplete();
  setStatus(statusEl, 'Fill in the solution, then click "Generate Proof".');
});

btnReset.addEventListener('click', () => {
  ui.reset();
  puzzleBoard = null;
  lastProof   = null;
  lastBoardId = null;
  pendingClaim = null;
  document.getElementById('phase-puzzle').hidden = false;
  document.getElementById('phase-solve').hidden  = true;
  outputEl.hidden = true;
  claimSectionEl.hidden = true;
  publishHintEl.hidden = true;
  setStatus(statusEl, '');
});

btnCopy.addEventListener('click', () => {
  proofJsonEl.select();
  document.execCommand('copy');
  btnCopy.textContent = 'Copied!';
  setTimeout(() => { btnCopy.textContent = 'Copy'; }, 2000);
});

// ---------------------------------------------------------------------------
// Generate proof
// ---------------------------------------------------------------------------

btnProve.addEventListener('click', async () => {
  btnProve.disabled = true;
  btnReset.disabled = true;
  outputEl.hidden   = true;
  claimSectionEl.hidden = true;
  publishHintEl.hidden = true;

  try {
    setStatus(statusEl, 'Preparing zkey…');
    const zkeyBuffer = await fetchZkey(progressEl, statusEl);

    setStatus(statusEl, 'Computing boardId…');
    lastBoardId = pendingClaim ? pendingClaim.challenge.boardId : computeBoardId(puzzleBoard);

    setStatus(statusEl, 'Generating proof… (this can take 30–60 s)');
    const solved = ui.getSolution();

    const zkeyClone = zkeyBuffer.slice(0);
    const result = await new Promise((res, rej) => {
      const worker = new Worker(import.meta.env.BASE_URL + 'prover-worker.js');
      worker.onmessage = ({ data }) => {
        worker.terminate();
        data.error ? rej(new Error(data.error)) : res(data);
      };
      worker.onerror = (e) => { worker.terminate(); rej(e); };
      worker.postMessage(
        { board: puzzleBoard, solved, boardId: lastBoardId, zkeyBuffer: zkeyClone },
        [zkeyClone],
      );
    });

    lastProof = result.proof;
    proofJsonEl.value = JSON.stringify({ proof: result.proof, publicSignals: result.publicSignals }, null, 2);
    outputEl.hidden = false;

    if (pendingClaim) {
      const ada = (Number(pendingClaim.challenge.lovelace) / 1_000_000).toFixed(2);
      document.getElementById('claim-ada-display').textContent = ada;
      claimSectionEl.hidden = false;
      setStatus(statusEl, `Proof generated. Claim the ${ada} ₳ reward below.`);
    } else {
      publishHintEl.hidden = false;
      setStatus(statusEl, 'Proof generated successfully.');
    }
  } catch (err) {
    setStatus(statusEl, `Error: ${err.message}`);
    console.error(err);
  } finally {
    btnProve.disabled = false;
    btnReset.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Claim challenge
// ---------------------------------------------------------------------------

document.getElementById('btn-claim').addEventListener('click', async () => {
  if (!pendingClaim || !lastProof) return;

  const key = getKey();
  if (!key) { claimStatusEl.textContent = 'Please enter a Blockfrost API key above.'; return; }

  document.getElementById('btn-claim').disabled = true;
  claimStatusEl.textContent = 'Connecting wallet and submitting claim…';

  try {
    const { claimChallenge } = await chain();
    const txHash = await claimChallenge(key, pendingClaim.challenge, lastProof);
    claimStatusEl.textContent = `Claimed! Tx: ${txHash}`;
    pendingClaim = null;
  } catch (err) {
    claimStatusEl.textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    document.getElementById('btn-claim').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Challenges tab
// ---------------------------------------------------------------------------

document.getElementById('btn-fetch').addEventListener('click', async () => {
  const key = getKey();
  if (!key) {
    document.getElementById('challenges-status').textContent = 'Please enter a Blockfrost API key above.';
    return;
  }

  const listEl = document.getElementById('challenges-list');
  listEl.innerHTML = '';
  document.getElementById('challenges-status').textContent = 'Fetching…';
  document.getElementById('btn-fetch').disabled = true;

  try {
    const { fetchChallenges } = await chain();
    const challenges = await fetchChallenges(key);
    if (!challenges.length) {
      document.getElementById('challenges-status').textContent = 'No active challenges found.';
    } else {
      document.getElementById('challenges-status').textContent = `Found ${challenges.length} challenge(s).`;
      for (const c of challenges) listEl.appendChild(renderChallengeCard(c));
    }
  } catch (err) {
    document.getElementById('challenges-status').textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    document.getElementById('btn-fetch').disabled = false;
  }
});

function renderChallengeCard(challenge) {
  const ada = (Number(challenge.lovelace) / 1_000_000).toFixed(2);
  const card = document.createElement('div');
  card.className = 'challenge-card';

  const miniGrid = document.createElement('div');
  miniGrid.className = 'mini-grid';
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('span');
      const val = challenge.board[r][c];
      if (val !== 0) { cell.textContent = val; cell.classList.add('given'); }
      miniGrid.appendChild(cell);
    }
  }

  const info = document.createElement('div');
  info.className = 'info';
  info.innerHTML = `
    <div class="ada">${ada} ₳</div>
    <p>Board ID: ${challenge.boardId.slice(0, 12)}…</p>
    <p>UTxO: ${challenge.txHash.slice(0, 10)}…#${challenge.outputIndex}</p>
    <p>Publisher: <code style="font-size:0.78rem">${challenge.publisherPkh.slice(0, 12)}…</code></p>
  `;

  const btnSolve = document.createElement('button');
  btnSolve.className = 'btn-primary';
  btnSolve.style.marginTop = '0.5rem';
  btnSolve.textContent = 'Solve & Claim';
  btnSolve.addEventListener('click', () => loadChallengeIntoProver(challenge));
  info.appendChild(btnSolve);

  const btnRetract = document.createElement('button');
  btnRetract.className = 'btn-neutral';
  btnRetract.style.cssText = 'margin-top:0.5rem;margin-left:0.5rem;';
  btnRetract.textContent = 'Retract';
  const retractStatus = document.createElement('div');
  retractStatus.style.cssText = 'font-size:0.8rem;margin-top:0.3rem;word-break:break-all;color:#555;';
  btnRetract.addEventListener('click', async () => {
    const key = getKey();
    if (!key) { retractStatus.textContent = 'Enter a Blockfrost API key above first.'; return; }
    btnRetract.disabled = true;
    retractStatus.textContent = 'Connecting wallet…';
    try {
      const { retractChallenge } = await chain();
      const txHash = await retractChallenge(key, challenge);
      retractStatus.style.color = '#2e9e5b';
      retractStatus.textContent = `Retracted! Tx: ${txHash}`;
    } catch (err) {
      retractStatus.style.color = '#c00';
      retractStatus.textContent = err.message;
      btnRetract.disabled = false;
    }
  });
  info.appendChild(btnRetract);
  info.appendChild(retractStatus);

  card.appendChild(miniGrid);
  card.appendChild(info);
  return card;
}

function loadChallengeIntoProver(challenge) {
  activateTab('prove');

  ui.reset();
  puzzleBoard  = null;
  lastProof    = null;
  lastBoardId  = null;
  outputEl.hidden = true;
  claimSectionEl.hidden = true;
  publishHintEl.hidden = true;

  pendingClaim = { challenge };

  ui.preload(challenge.board);
  puzzleBoard = ui.lockPuzzle();

  document.getElementById('phase-puzzle').hidden = true;
  document.getElementById('phase-solve').hidden  = false;
  btnProve.disabled = true;

  const ada = (Number(challenge.lovelace) / 1_000_000).toFixed(2);
  setStatus(statusEl, `Challenge loaded (${ada} ₳ reward). Solve it, then generate a proof to claim.`);
}

// ---------------------------------------------------------------------------
// Publish tab
// ---------------------------------------------------------------------------

const pubGridEl       = document.getElementById('pub-grid');
const pubUi           = new SudokuUI(pubGridEl);
const pubBtnValidate  = document.getElementById('pub-btn-validate');
const pubSolveStatus  = document.getElementById('pub-solve-status');
const publishStatusEl = document.getElementById('publish-status');
let pubBoard = null;  // locked clues (what goes on-chain)

pubUi.onChange = () => {
  if (pubUi.phase === 'solve') pubBtnValidate.disabled = !pubUi.isComplete();
};

function pubReset() {
  pubUi.reset();
  pubBoard = null;
  pubBtnValidate.disabled = true;
  pubSolveStatus.textContent = '';
  publishStatusEl.textContent = '';
  document.getElementById('pub-phase-puzzle').hidden  = false;
  document.getElementById('pub-phase-solve').hidden   = true;
  document.getElementById('pub-phase-publish').hidden = true;
}

function pubLockPuzzle() {
  pubBoard = pubUi.lockPuzzle();
  pubBtnValidate.disabled = !pubUi.isComplete();
  document.getElementById('pub-phase-puzzle').hidden = true;
  document.getElementById('pub-phase-solve').hidden  = false;
  pubSolveStatus.textContent = '';
}

document.getElementById('pub-btn-set').addEventListener('click', pubLockPuzzle);

document.getElementById('pub-btn-example').addEventListener('click', () => {
  pubUi.preload(EXAMPLE_PUZZLE);
  pubLockPuzzle();
});

document.getElementById('pub-btn-fill-solution').addEventListener('click', () => { pubUi.fillSolution(EXAMPLE_SOLVED); });
document.getElementById('pub-btn-reset').addEventListener('click', pubReset);
document.getElementById('pub-btn-reset2').addEventListener('click', pubReset);

pubBtnValidate.addEventListener('click', () => {
  const valid = pubUi.validate();
  if (!valid) {
    pubSolveStatus.textContent = 'Solution has conflicts — check highlighted cells.';
    return;
  }
  pubSolveStatus.textContent = '';
  document.getElementById('pub-phase-solve').hidden   = true;
  document.getElementById('pub-phase-publish').hidden = false;
  publishStatusEl.textContent = '';
});

document.getElementById('btn-publish').addEventListener('click', async () => {
  const key      = getKey();
  const ada      = parseFloat(document.getElementById('pub-ada').value) || 5;
  const lovelace = Math.round(ada * 1_000_000);

  if (!key)      { publishStatusEl.textContent = 'Please enter a Blockfrost API key above.'; return; }
  if (!pubBoard) { publishStatusEl.textContent = 'No puzzle set.'; return; }
  if (lovelace < 2_000_000) { publishStatusEl.textContent = 'Minimum 2 ADA to cover min-UTxO.'; return; }

  document.getElementById('btn-publish').disabled = true;
  publishStatusEl.textContent = 'Connecting wallet and building transaction…';

  try {
    const { deployChallenge } = await chain();
    const boardId = computeBoardId(pubBoard);
    const txHash  = await deployChallenge(key, pubBoard, boardId, lovelace);
    publishStatusEl.textContent = `Published! Tx: ${txHash}`;
  } catch (err) {
    publishStatusEl.textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    document.getElementById('btn-publish').disabled = false;
  }
});
