'use strict';

/* ============================================================
   Ladder Diagram (LD) — grid editor + power-flow solver.
   Grid of cells between vertical node columns; vertical links
   join adjacent rungs to form branches. Live power shown green.
   ============================================================ */

(function () {

const B = PLC.bool;
const COLS = 8, CW = 96, CH = 76, PADL = 30, PADT = 12;

const CONTACTS = { NO: 1, NC: 1 };
const COILS = { COIL: 1, SCOIL: 1, RCOIL: 1 };
const FBTYPES = { TON: 1, TOF: 1, TP: 1, CTU: 1, CTD: 1 };

function emptyDoc() {
  return {
    rows: 5,
    cells: Array.from({ length: 5 }, () => Array(COLS).fill(null)),
    vlinks: [],   // [row, boundaryCol]: joins node (r,c) with node (r+1,c)
  };
}

const LD = {
  id: 'ld',
  title: 'Ladder Diagram',
  doc: emptyDoc(),
  tool: 'select',
  lastNodes: null,
  svgHost: null,

  /* ---------------- editor UI ---------------- */

  init(pane) {
    pane.innerHTML = `
      <div class="ed-toolbar" id="ld-toolbar">
        <button class="tool active" data-tool="select" title="Click an element to edit it">&#8598; Select</button>
        <span class="sep"></span>
        <button class="tool" data-tool="NO" title="Normally-open contact">&#8212;| |&#8212;</button>
        <button class="tool" data-tool="NC" title="Normally-closed contact">&#8212;|/|&#8212;</button>
        <button class="tool" data-tool="COIL" title="Output coil">&#8212;( )&#8212;</button>
        <button class="tool" data-tool="SCOIL" title="Set (latch) coil">(S)</button>
        <button class="tool" data-tool="RCOIL" title="Reset (unlatch) coil">(R)</button>
        <span class="sep"></span>
        <button class="tool" data-tool="TON" title="On-delay timer">TON</button>
        <button class="tool" data-tool="TOF" title="Off-delay timer">TOF</button>
        <button class="tool" data-tool="TP" title="Pulse timer">TP</button>
        <button class="tool" data-tool="CTU" title="Count up">CTU</button>
        <button class="tool" data-tool="CTD" title="Count down">CTD</button>
        <span class="sep"></span>
        <button class="tool" data-tool="H" title="Horizontal wire">&#8212;</button>
        <button class="tool" data-tool="V" title="Vertical branch link (joins this rung to the one below, at the cell's left edge)">&#9475; Branch</button>
        <button class="tool" data-tool="erase" title="Erase a cell / branch link">&#9003; Erase</button>
        <span class="sep"></span>
        <button id="ld-add-rung" title="Add a rung">+ Rung</button>
        <button id="ld-del-rung" title="Remove the last rung">&#8722; Rung</button>
        <button id="ld-clear" title="Clear the whole diagram">Clear</button>
        <span class="ed-hint" id="ld-hint">Pick a tool, then click a grid cell.</span>
      </div>
      <div class="ed-canvas" id="ld-canvas"></div>`;

    this.svgHost = pane.querySelector('#ld-canvas');

    pane.querySelector('#ld-toolbar').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.tool) {
        this.tool = btn.dataset.tool;
        pane.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === btn));
        const hints = {
          select: 'Click an element to edit its variable / presets.',
          V: 'Click a cell: a branch link is added at its LEFT edge, down to the next rung.',
          erase: 'Click a cell to erase it (erases the branch link too).',
        };
        UI.status(hints[this.tool] || 'Click a grid cell to place the element.');
      } else if (btn.id === 'ld-add-rung') {
        this.doc.rows++;
        this.doc.cells.push(Array(COLS).fill(null));
        this.changed();
      } else if (btn.id === 'ld-del-rung') {
        if (this.doc.rows > 1) {
          this.doc.rows--;
          this.doc.cells.pop();
          this.doc.vlinks = this.doc.vlinks.filter(([r]) => r < this.doc.rows - 1);
          this.changed();
        }
      } else if (btn.id === 'ld-clear') {
        UI.confirm('Clear the whole ladder diagram?').then(ok => {
          if (ok) { this.doc = emptyDoc(); this.changed(); }
        });
      }
    });

    this.svgHost.addEventListener('click', e => {
      const hit = e.target.closest('[data-r]');
      if (!hit) return;
      this.onCellClick(+hit.dataset.r, +hit.dataset.c);
    });

    this.render();
  },

  changed() {
    this.render();
    UI.docChanged();
  },

  async onCellClick(r, c) {
    const doc = this.doc;
    const cell = doc.cells[r][c];
    const t = this.tool;

    if (t === 'erase') {
      doc.cells[r][c] = null;
      doc.vlinks = doc.vlinks.filter(([vr, vc]) => !(vr === r && vc === c) && !(vr === r - 1 && vc === c));
      this.changed();
      return;
    }
    if (t === 'V') {
      if (r >= doc.rows - 1) { UI.status('Branch links go downward — click a cell that has a rung below it.', true); return; }
      const i = doc.vlinks.findIndex(([vr, vc]) => vr === r && vc === c);
      if (i >= 0) doc.vlinks.splice(i, 1); else doc.vlinks.push([r, c]);
      this.changed();
      return;
    }
    if (t === 'H') { doc.cells[r][c] = { t: 'H' }; this.changed(); return; }
    if (t === 'select') {
      if (cell && cell.t !== 'H') await this.editCell(r, c, cell.t, cell);
      return;
    }
    await this.editCell(r, c, t, cell && cell.t === t ? cell : null);
  },

  async editCell(r, c, type, existing) {
    if (CONTACTS[type] || COILS[type]) {
      const res = await UI.form(
        { NO: 'Normally-open contact', NC: 'Normally-closed contact', COIL: 'Coil', SCOIL: 'Set coil', RCOIL: 'Reset coil' }[type],
        [{ key: 'name', label: 'Variable name', value: existing ? existing.name : (COILS[type] ? 'Q0' : 'I0') }]);
      if (!res || !res.name.trim()) return;
      this.doc.cells[r][c] = { t: type, name: res.name.trim() };
      this.changed();
    } else if (type === 'TON' || type === 'TOF' || type === 'TP') {
      const res = await UI.form(`${type} timer`, [
        { key: 'name', label: 'Instance name', value: existing ? existing.name : 'T1' },
        { key: 'pt', label: 'Preset time PT (ms)', value: existing ? existing.pt : 1000, type: 'number' },
      ]);
      if (!res || !res.name.trim()) return;
      this.doc.cells[r][c] = { t: type, name: res.name.trim(), pt: Math.max(0, +res.pt || 0) };
      this.changed();
    } else if (type === 'CTU' || type === 'CTD') {
      const res = await UI.form(`${type} counter`, [
        { key: 'name', label: 'Instance name', value: existing ? existing.name : 'C1' },
        { key: 'pv', label: 'Preset value PV', value: existing ? existing.pv : 5, type: 'number' },
        { key: 'aux', label: type === 'CTU' ? 'Reset variable (optional)' : 'Load variable (optional)', value: existing ? (existing.aux || '') : '' },
      ]);
      if (!res || !res.name.trim()) return;
      this.doc.cells[r][c] = { t: type, name: res.name.trim(), pv: Math.max(0, +res.pv || 0), aux: res.aux.trim() };
      this.changed();
    }
  },

  /* ---------------- compile & scan ---------------- */

  compile() {
    const doc = this.doc;
    let hasAny = false;
    for (let r = 0; r < doc.rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = doc.cells[r][c];
        if (!cell) continue;
        hasAny = true;
        if (cell.t !== 'H' && !cell.name) throw new Error(`Rung ${r + 1}, column ${c + 1}: element has no variable name`);
        if (FBTYPES[cell.t]) {
          const type = cell.t;
          cell._inst = PLC.getFB(cell.name, type);
        }
      }
    }
    if (!hasAny) throw new Error('The ladder diagram is empty — place some contacts and coils first');
    const self = this;
    return {
      scan(dt) {
        const nodes = self.solve();
        // effects, left-to-right / top-to-bottom
        for (let r = 0; r < doc.rows; r++) {
          for (let c = 0; c < COLS; c++) {
            const cell = doc.cells[r][c];
            if (!cell) continue;
            const inP = nodes[r][c];
            switch (cell.t) {
              case 'COIL': PLC.writeVar(cell.name, inP); break;
              case 'SCOIL': if (inP) PLC.writeVar(cell.name, true); break;
              case 'RCOIL': if (inP) PLC.writeVar(cell.name, false); break;
              case 'TON': case 'TOF': case 'TP':
                cell._inst.invoke({ IN: inP, PT: cell.pt }, dt);
                break;
              case 'CTU':
                cell._inst.invoke({ CU: inP, R: cell.aux ? B(PLC.readVar(cell.aux)) : false, PV: cell.pv });
                break;
              case 'CTD':
                cell._inst.invoke({ CD: inP, LD: cell.aux ? B(PLC.readVar(cell.aux)) : false, PV: cell.pv });
                break;
            }
          }
        }
        self.lastNodes = nodes;
      },
    };
  },

  /* Fixed-point power-flow solve. FB cells pass their previous-scan Q
     (the instance is updated once per scan in the effects pass). */
  solve() {
    const doc = this.doc;
    const nodes = Array.from({ length: doc.rows }, () => Array(COLS + 1).fill(false));
    for (let r = 0; r < doc.rows; r++) nodes[r][0] = true;

    let changed = true, iter = 0;
    while (changed && iter++ < 300) {
      changed = false;
      for (let r = 0; r < doc.rows; r++) {
        for (let c = 0; c < COLS; c++) {
          const cell = doc.cells[r][c];
          if (!cell) continue;
          const inP = nodes[r][c];
          let out = false;
          switch (cell.t) {
            case 'H': case 'COIL': case 'SCOIL': case 'RCOIL': out = inP; break;
            case 'NO': out = inP && B(PLC.readVar(cell.name)); break;
            case 'NC': out = inP && !B(PLC.readVar(cell.name)); break;
            default: out = cell._inst ? !!cell._inst.Q : false;   // timer/counter output
          }
          if (out && !nodes[r][c + 1]) { nodes[r][c + 1] = true; changed = true; }
        }
      }
      for (const [r, c] of doc.vlinks) {
        if (r + 1 >= doc.rows) continue;
        const p = nodes[r][c] || nodes[r + 1][c];
        if (p && !nodes[r][c]) { nodes[r][c] = true; changed = true; }
        if (p && !nodes[r + 1][c]) { nodes[r + 1][c] = true; changed = true; }
      }
    }
    return nodes;
  },

  onStop() { this.lastNodes = null; this.render(); },
  onReset() { this.lastNodes = null; this.render(); },
  renderLive() { this.render(); },

  /* ---------------- rendering ---------------- */

  render() {
    if (!this.svgHost) return;
    const doc = this.doc;
    const nodes = this.lastNodes;
    const W = PADL * 2 + COLS * CW, H = PADT * 2 + doc.rows * CH;
    const rowY = r => PADT + r * CH + CH / 2;
    const on = (r, c) => !!(nodes && nodes[r] && nodes[r][c]);
    const running = PLC.engine.running && PLC.engine.lang === 'ld';

    let s = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    s += `<line class="rail" x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${H - PADT}"/>`;
    s += `<line class="rail" x1="${PADL + COLS * CW}" y1="${PADT}" x2="${PADL + COLS * CW}" y2="${H - PADT}"/>`;

    for (const [r, c] of doc.vlinks) {
      if (r + 1 >= doc.rows) continue;
      const x = PADL + c * CW;
      s += `<line class="wire${on(r, c) ? ' on' : ''}" x1="${x}" y1="${rowY(r)}" x2="${x}" y2="${rowY(r + 1)}"/>`;
    }

    for (let r = 0; r < doc.rows; r++) {
      const y = rowY(r);
      for (let c = 0; c < COLS; c++) {
        const x = PADL + c * CW, cx = x + CW / 2;
        const cell = doc.cells[r][c];
        if (cell) {
          const pin = on(r, c), pout = on(r, c + 1);
          const wIn = `wire${pin ? ' on' : ''}`, wOut = `wire${pout ? ' on' : ''}`;
          const symOn = running && pout ? ' on' : '';
          switch (cell.t) {
            case 'H':
              s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
              break;
            case 'NO': case 'NC': {
              const varOn = running && B(safeRead(cell.name));
              const closed = cell.t === 'NO' ? varOn : (running && !varOn);
              s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 8}" y2="${y}"/>`;
              s += `<line class="${wOut}" x1="${cx + 8}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
              s += `<line class="sym${closed ? ' on' : ''}" x1="${cx - 8}" y1="${y - 13}" x2="${cx - 8}" y2="${y + 13}"/>`;
              s += `<line class="sym${closed ? ' on' : ''}" x1="${cx + 8}" y1="${y - 13}" x2="${cx + 8}" y2="${y + 13}"/>`;
              if (cell.t === 'NC') s += `<line class="sym${closed ? ' on' : ''}" x1="${cx - 12}" y1="${y + 13}" x2="${cx + 12}" y2="${y - 13}"/>`;
              s += `<text class="lbl" x="${cx}" y="${y - 20}">${esc(cell.name)}</text>`;
              break;
            }
            case 'COIL': case 'SCOIL': case 'RCOIL': {
              s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 10}" y2="${y}"/>`;
              s += `<line class="${wOut}" x1="${cx + 10}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
              s += `<path class="sym${running && pin ? ' on' : ''}" d="M ${cx - 5} ${y - 12} A 16 16 0 0 0 ${cx - 5} ${y + 12}"/>`;
              s += `<path class="sym${running && pin ? ' on' : ''}" d="M ${cx + 5} ${y - 12} A 16 16 0 0 1 ${cx + 5} ${y + 12}"/>`;
              if (cell.t !== 'COIL') s += `<text class="lbl" x="${cx}" y="${y + 4}" style="fill:#cfd8e3">${cell.t === 'SCOIL' ? 'S' : 'R'}</text>`;
              s += `<text class="lbl" x="${cx}" y="${y - 20}">${esc(cell.name)}</text>`;
              break;
            }
            default: {   // timers & counters
              const inst = PLC.fbs.get(PLC.U(cell.name));
              const qOn = running && inst && inst.Q;
              s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 34}" y2="${y}"/>`;
              s += `<line class="wire${qOn ? ' on' : ''}" x1="${cx + 34}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
              s += `<rect class="fbbox${qOn ? ' on' : ''}" x="${cx - 34}" y="${y - 26}" width="68" height="52" rx="4"/>`;
              s += `<text class="fbtitle" x="${cx}" y="${y - 11}">${cell.t}</text>`;
              s += `<text class="lbl" x="${cx}" y="${y - 32}">${esc(cell.name)}</text>`;
              if (FBTYPES[cell.t] && (cell.t[0] === 'T')) {
                s += `<text class="lbl2" x="${cx}" y="${y + 6}">PT ${cell.pt}ms</text>`;
                s += `<text class="lbl2${qOn ? ' on' : ''}" x="${cx}" y="${y + 19}">${running && inst ? 'ET ' + Math.round(inst.ET) : ''}</text>`;
              } else {
                s += `<text class="lbl2" x="${cx}" y="${y + 6}">PV ${cell.pv}</text>`;
                s += `<text class="lbl2${qOn ? ' on' : ''}" x="${cx}" y="${y + 19}">${running && inst ? 'CV ' + inst.CV : ''}</text>`;
              }
              break;
            }
          }
        } else {
          s += `<line x1="${x}" y1="${y}" x2="${x + CW}" y2="${y}" stroke="#232a34" stroke-width="1" stroke-dasharray="3 5"/>`;
        }
        s += `<rect class="cellhit" data-r="${r}" data-c="${c}" x="${x}" y="${PADT + r * CH}" width="${CW}" height="${CH}"/>`;
      }
      s += `<text class="lbl2" x="${PADL - 18}" y="${y + 4}">${r + 1}</text>`;
    }
    s += '</svg>';
    this.svgHost.innerHTML = s;
  },

  save() {
    return {
      rows: this.doc.rows,
      cells: this.doc.cells.map(row => row.map(c => {
        if (!c) return null;
        const { _inst, ...rest } = c;
        return rest;
      })),
      vlinks: this.doc.vlinks,
    };
  },

  load(d) {
    if (!d || !Array.isArray(d.cells)) { this.doc = emptyDoc(); }
    else {
      this.doc = {
        rows: d.rows || d.cells.length,
        cells: d.cells.map(row => {
          const r = row.slice(0, COLS).map(c => (c && c.t ? { ...c } : null));
          while (r.length < COLS) r.push(null);
          return r;
        }),
        vlinks: Array.isArray(d.vlinks) ? d.vlinks.map(v => [v[0], v[1]]) : [],
      };
      this.doc.rows = this.doc.cells.length;
    }
    this.lastNodes = null;
    this.render();
  },

  example() {
    this.load(PLC.EXAMPLES.ld);
    UI.docChanged();
  },
};

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function safeRead(name) { try { return PLC.readVar(name); } catch { return false; } }

PLC.registerModule(LD);

})();
