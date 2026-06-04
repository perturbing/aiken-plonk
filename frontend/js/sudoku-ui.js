// Renders and manages the 9×9 sudoku grid.
// Phase "puzzle": all cells editable (0/blank = empty clue).
// Phase "solve":  given clues locked; empty cells editable.

export class SudokuUI {
  constructor(containerEl) {
    this.container = containerEl;
    this.board = Array.from({ length: 9 }, () => Array(9).fill(0));
    this.phase = 'puzzle';
    this._build();
  }

  _build() {
    this.container.innerHTML = '';
    this.container.className = 'sudoku-grid';
    this.inputs = [];
    for (let r = 0; r < 9; r++) {
      const rowInputs = [];
      for (let c = 0; c < 9; c++) {
        const cell = document.createElement('input');
        cell.type = 'text';
        cell.inputMode = 'numeric';
        cell.maxLength = 1;
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.addEventListener('input', (e) => this._onInput(e, r, c));
        cell.addEventListener('keydown', (e) => this._onKeydown(e, r, c));
        this.container.appendChild(cell);
        rowInputs.push(cell);
      }
      this.inputs.push(rowInputs);
    }
  }

  _onInput(e, r, c) {
    const val = e.target.value.replace(/[^1-9]/g, '');
    e.target.value = val;
    this.board[r][c] = val ? parseInt(val, 10) : 0;
    this.onChange?.();
  }

  _onKeydown(e, r, c) {
    const moves = { ArrowUp: [-1,0], ArrowDown: [1,0], ArrowLeft: [0,-1], ArrowRight: [0,1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      const nr = Math.max(0, Math.min(8, r + dr));
      const nc = Math.max(0, Math.min(8, c + dc));
      this.inputs[nr][nc].focus();
    }
  }

  // Pre-fill the grid with a puzzle (in puzzle-entry phase).
  preload(board) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const v = board[r][c];
        this.board[r][c] = v;
        this.inputs[r][c].value = v !== 0 ? String(v) : '';
      }
    }
    this.onChange?.();
  }

  // Fill all unlocked (empty) cells with the given solution values.
  fillSolution(solved) {
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (!this.inputs[r][c].disabled) {
          const v = solved[r][c];
          this.board[r][c] = v;
          this.inputs[r][c].value = String(v);
        }
      }
    }
    this.onChange?.();
  }

  // Lock the current non-zero values as the puzzle clues.
  // Returns the locked board (0 = empty cell to solve).
  lockPuzzle() {
    this.phase = 'solve';
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cell = this.inputs[r][c];
        if (this.board[r][c] !== 0) {
          cell.disabled = true;
          cell.classList.add('given');
        } else {
          cell.value = '';
          cell.classList.remove('given');
        }
      }
    }
    return this.board.map(row => [...row]);
  }

  reset() {
    this.phase = 'puzzle';
    this.board = Array.from({ length: 9 }, () => Array(9).fill(0));
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const cell = this.inputs[r][c];
        cell.disabled = false;
        cell.value = '';
        cell.classList.remove('given', 'error');
      }
    }
    this.onChange?.();
  }

  // Returns a 9×9 array with the current solution values (only non-given cells).
  getSolution() {
    return this.board.map(row => [...row]);
  }

  // Highlights cells that violate row/col/box uniqueness (values 1-9 only).
  validate() {
    const errors = new Set();
    const check = (indices) => {
      const seen = {};
      for (const [r, c] of indices) {
        const v = this.board[r][c];
        if (v === 0) continue;
        const key = `${r},${c}`;
        if (seen[v] !== undefined) {
          errors.add(key);
          errors.add(seen[v]);
        } else {
          seen[v] = key;
        }
      }
    };
    for (let i = 0; i < 9; i++) {
      check(Array.from({ length: 9 }, (_, j) => [i, j]));
      check(Array.from({ length: 9 }, (_, j) => [j, i]));
      const br = Math.floor(i / 3) * 3, bc = (i % 3) * 3;
      check([[br,bc],[br,bc+1],[br,bc+2],[br+1,bc],[br+1,bc+1],[br+1,bc+2],[br+2,bc],[br+2,bc+1],[br+2,bc+2]]);
    }
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        this.inputs[r][c].classList.toggle('error', errors.has(`${r},${c}`));
      }
    }
    return errors.size === 0;
  }

  // True when every cell is filled (1-9) and no errors.
  isComplete() {
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++)
        if (this.board[r][c] === 0) return false;
    return this.validate();
  }
}
