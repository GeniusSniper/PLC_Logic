'use strict';

/* ============================================================
   Ladder Diagram (LD) — structural rung editor + power flow.
   A rung is a series list of blocks. A branch (BR) is a block
   holding parallel arms (each a series list) — power splits at
   its left bar and rejoins at its right bar (OR of the arms).
   Inserting a block pushes the blocks after it to the right.
   ============================================================ */

(function () {

const B = PLC.bool;
const CW = 96, CH = 76, PADL = 30, PADT = 12, MINCOLS = 8;

const CONTACTS = { NO: 1, NC: 1 };
const COILS = { COIL: 1, SCOIL: 1, RCOIL: 1 };
const FBTYPES = { TON: 1, TOF: 1, TP: 1, CTU: 1, CTD: 1, CTUD: 1 };

function emptyDoc() { return { rungs: [[], [], []] }; }

/* wire spacer cells — invisible padding so blocks can sit at any column */
function spacers(n) { return Array.from({ length: Math.max(0, n) }, () => ({ t: 'H' })); }

/* trailing spacers are indistinguishable from open wire — drop them */
function trimTrailing(a) { while (a.length && a[a.length - 1].t === 'H') a.pop(); }

/* ---------------- measurements (in cells) ---------------- */

function itemW(it) { return it.t === 'BR' ? Math.max(...it.arms.map(armW)) : 1; }
function armW(arm) { return Math.max(1, arm.reduce((s, x) => s + itemW(x), 0)); }
function itemH(it) { return it.t === 'BR' ? it.arms.reduce((s, a) => s + armH(a), 0) : 1; }
function armH(arm) { return arm.length ? Math.max(...arm.map(itemH)) : 1; }

/* path: [rung, idx] or [rung, idx, arm, idx, ...] — last entry is the
   index inside its container array (== length for a tail slot) */
function container(doc, p) {
  let arr = doc.rungs[p[0]];
  for (let k = 1; k + 1 < p.length - 1; k += 2) arr = arr[p[k]].arms[p[k + 1]];
  return arr;
}

const LD = {
  id: 'ld',
  title: 'Ladder Diagram',
  doc: emptyDoc(),
  tool: 'select',
  svgHost: null,
  sel: null,            // { p: path, slot: bool } — selection for Branch / editing
  history: [],
  future: [],

  /* ---------------- editor UI ---------------- */

  init(pane) {
    pane.innerHTML = `
      <div class="ed-toolbar" id="ld-toolbar">
        <button class="tool active" data-tool="select" title="Click a block to select it; double-click to edit">&#8598; Select</button>
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
        <button class="tool" data-tool="CTUD" title="Count up/down — power counts up, CD variable counts down">CTUD</button>
        <span class="sep"></span>
        <button class="tool" data-tool="CMP" title="Compare — conducts while A op B is true">CMP</button>
        <button class="tool" data-tool="MATH" title="Math — dest := A op B while powered">MATH</button>
        <button class="tool" data-tool="MOVE" title="Move — dest := source while powered">MOV</button>
        <span class="sep"></span>
        <button id="ld-branch" title="Insert a parallel branch block at the selection — add blocks onto its arms">&#9475; Branch</button>
        <button id="ld-erase" title="Erase the selected block (Delete). Erasing a branch keeps its blocks on the rung.">&#9003; Erase</button>
        <span class="sep"></span>
        <button id="ld-undo" title="Undo (Ctrl+Z)" disabled>&#8630; Undo</button>
        <button id="ld-redo" title="Redo (Ctrl+Y)" disabled>&#8631; Redo</button>
        <span class="sep"></span>
        <button id="ld-add-rung" title="Add a rung">+ Rung</button>
        <button id="ld-del-rung" title="Remove the last rung">&#8722; Rung</button>
        <button id="ld-clear" title="Clear the whole diagram">Clear</button>
        <span class="ed-hint" id="ld-hint">Click or drag a tool onto a rung — blocks push others right. Branch inserts at the selection.</span>
      </div>
      <div class="ed-canvas" id="ld-canvas"></div>`;

    this.svgHost = pane.querySelector('#ld-canvas');
    this._caret = document.createElement('div');   // live insertion marker for drags
    this._caret.className = 'ins-caret';
    this._caret.hidden = true;
    this.svgHost.appendChild(this._caret);

    pane.querySelector('#ld-toolbar').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.tool) {
        this.tool = btn.dataset.tool;
        pane.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === btn));
        const hints = {
          select: 'Click a block to select it, double-click to edit it, drag to move it.',
        };
        UI.status(hints[this.tool] || 'Click a rung (left/right half of a block = before/after it) to insert.');
      } else if (btn.id === 'ld-branch') {
        this.insertBranch();
      } else if (btn.id === 'ld-erase') {
        this.eraseSelected();
      } else if (btn.id === 'ld-undo') {
        this.undo();
      } else if (btn.id === 'ld-redo') {
        this.redo();
      } else if (btn.id === 'ld-add-rung') {
        this.pushHistory();
        this.doc.rungs.push([]);
        this.changed();
      } else if (btn.id === 'ld-del-rung') {
        if (this.doc.rungs.length > 1) {
          this.pushHistory();
          this.doc.rungs.pop();
          if (this.sel && this.sel.p[0] >= this.doc.rungs.length) this.sel = null;
          this.changed();
        }
      } else if (btn.id === 'ld-clear') {
        UI.confirm('Clear the whole ladder diagram?').then(ok => {
          if (ok) { this.pushHistory(); this.doc = emptyDoc(); this.sel = null; this.changed(); }
        });
      }
    });
    this.btnUndo = pane.querySelector('#ld-undo');
    this.btnRedo = pane.querySelector('#ld-redo');

    this.svgHost.addEventListener('click', e => {
      if (this._dragDone) { this._dragDone = false; return; }
      const hit = e.target.closest('[data-p]');
      if (!hit) {
        if (this.tool === 'select' && this.sel) { this.sel = null; this.render(); }
        return;
      }
      this.onHit(hit, e.clientX);
    });

    // double-click a block (Select mode) to edit it
    this.svgHost.addEventListener('dblclick', async e => {
      if (this.tool !== 'select') return;
      const hit = e.target.closest('[data-p]');
      if (!hit || hit.dataset.slot) return;
      const p = JSON.parse(hit.dataset.p);
      const arr = container(this.doc, p), it = arr[p[p.length - 1]];
      if (!it || it.t === 'BR') return;
      const upd = await this.promptItem(it.t, it);
      if (!upd) return;
      this.pushHistory();
      arr[p[p.length - 1]] = upd;
      this.changed();
    });

    // undo / redo / delete shortcuts while the ladder editor is active
    document.addEventListener('keydown', e => {
      if (UI.currentLang && UI.currentLang() !== 'ld') return;
      if (e.target.matches('input, textarea, select')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel && !this.sel.slot) {
        e.preventDefault();
        this.eraseSelected();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
    });

    // drag a palette button straight onto the diagram to insert the block
    pane.querySelectorAll('#ld-toolbar .tool').forEach(btn => {
      const t = btn.dataset.tool;
      if (t === 'select' || t === 'erase') return;
      btn.draggable = true;
      btn.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/ld-tool', t);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });
    this.svgHost.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/ld-tool')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.updateCaret(e.clientX, e.clientY, null);
    });
    this.svgHost.addEventListener('dragleave', () => this.hideCaret());
    this.svgHost.addEventListener('drop', e => {
      const t = e.dataTransfer.getData('text/ld-tool');
      this.hideCaret();
      if (!t) return;
      e.preventDefault();
      const slot = this.slotFromEvent(e);
      if (slot) this.placeAt(t, slot, e.clientX);
    });

    // in Select mode, drag a block to another spot to move it
    let drag = null;
    this.svgHost.addEventListener('pointerdown', e => {
      if (this.tool !== 'select' || e.button !== 0) return;
      const hit = e.target.closest('[data-p]');
      if (!hit || hit.dataset.slot) return;
      const p = JSON.parse(hit.dataset.p);
      if (hit.dataset.side) {                    // branch bar: dragging resizes the branch span
        drag = { resize: { p, side: hit.dataset.side }, sx: e.clientX, sy: e.clientY, active: false };
        return;
      }
      const arr = container(this.doc, p), it = arr[p[p.length - 1]];
      if (!it) return;
      drag = { p, sx: e.clientX, sy: e.clientY, active: false };
    });
    this.svgHost.addEventListener('pointermove', e => {
      if (!drag) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
        drag.active = true;
        this.svgHost.setPointerCapture(e.pointerId);
        this.svgHost.style.cursor = drag.resize ? 'ew-resize' : 'grabbing';
      }
      if (drag.resize) {                         // preview where the bar will land
        const plan = this.resizePlan(drag.resize.p, drag.resize.side, e.clientX);
        if (plan) {
          this._caret.style.left = (plan.barX - 1) + 'px';
          this._caret.style.top = (plan.y + 4) + 'px';
          this._caret.style.height = (plan.h - 8) + 'px';
          this._caret.hidden = false;
        }
        return;
      }
      this.updateCaret(e.clientX, e.clientY, drag.p);
    });
    const endDrag = (e, drop) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      this.hideCaret();
      this.svgHost.style.cursor = '';
      if (!d.active) return;
      this._dragDone = true;                     // swallow the click that follows
      if (!drop) return;
      if (d.resize) {
        this.resizeBranch(d.resize.p, d.resize.side, e.clientX);
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const hit = el && el.closest && el.closest('[data-p]');
      let dst;
      if (hit) {
        // never drop a block inside itself (a branch into its own arm)
        const dp = JSON.parse(hit.dataset.p);
        if (dp.length > d.p.length && d.p.every((v, i) => dp[i] === v)) return;
        dst = this.slotFromHit(hit, e.clientX);
      } else {
        dst = this.slotFromEvent({ target: this.svgHost, clientX: e.clientX, clientY: e.clientY });
      }
      if (!dst) return;
      const sArr = container(this.doc, d.p), sIdx = d.p[d.p.length - 1];
      const it = sArr[sIdx];
      if (!it) return;
      const snap = this.snapshot();
      // the vacated cell becomes a spacer so no other block changes column
      sArr.splice(sIdx, 1, { t: 'H' });
      let dArr = dst.arr, dIdx = dst.idx;
      if (dst.newRung) {
        this.doc.rungs.push([]);
        dArr = this.doc.rungs[this.doc.rungs.length - 1];
        const b = this.svgHost.getBoundingClientRect();
        const col = Math.floor((e.clientX - b.left + this.svgHost.scrollLeft - PADL) / CW);
        dArr.push(...spacers(col), it);
      } else if (dArr[dIdx] && dArr[dIdx].t === 'H') {
        dArr.splice(dIdx, 1, it);                                // fill the empty cell
      } else if (dIdx === dArr.length) {
        dArr.push(...spacers(this.padCells(dArr, dst.cpArr, e.clientX)), it);
      } else {
        dArr.splice(dIdx, 0, it);
      }
      trimTrailing(sArr);
      trimTrailing(dArr);
      if (JSON.stringify(this.save()) === JSON.stringify(snap)) { this.render(); return; }   // nothing really moved
      this.history.push(snap);
      if (this.history.length > 100) this.history.shift();
      this.future.length = 0;
      this.updateUndoBtns();
      this.sel = null;
      this.changed();
    };
    this.svgHost.addEventListener('pointerup', e => endDrag(e, true));
    this.svgHost.addEventListener('pointercancel', e => endDrag(e, false));

    this.render();
  },

  changed() {
    this.render();
    UI.docChanged();
  },

  /* ---------------- hit handling ---------------- */

  /* insertion index inside a container from the pointer's x position:
     count the container's blocks whose midpoint lies left of the pointer */
  indexByX(cpath, arrLen, clientX) {
    const b = this.svgHost.getBoundingClientRect();
    const x = clientX - b.left + this.svgHost.scrollLeft;
    const cp = JSON.stringify(cpath);
    let idx = 0;
    for (const h of this._hits) {
      if (!h.slot && h.cp === cp && x > h.x + h.w / 2) idx++;
    }
    return Math.min(idx, arrLen);
  },

  /* a hit rect + pointer x -> insertion point { arr, idx, cpArr } */
  slotFromHit(hit, clientX) {
    const p = JSON.parse(hit.dataset.p);
    const arr = container(this.doc, p);
    const cpArr = p.slice(0, -1);
    return { arr, idx: this.indexByX(cpArr, arr.length, clientX), cpArr };
  },

  slotFromEvent(e) {
    const hit = e.target.closest && e.target.closest('[data-p]');
    if (hit) return this.slotFromHit(hit, e.clientX);
    // blank canvas: use the rung band under the pointer, position by x
    const b = this.svgHost.getBoundingClientRect();
    const y = e.clientY - b.top + this.svgHost.scrollTop;
    const band = (this._rungY || []).find(rb => y >= rb.y0 && y < rb.y1);
    if (band) {
      const arr = this.doc.rungs[band.rung];
      return { arr, idx: this.indexByX([band.rung], arr.length, e.clientX), cpArr: [band.rung] };
    }
    // below the last rung: the drop creates a fresh rung
    const last = this._rungY && this._rungY[this._rungY.length - 1];
    if (last && y >= last.y1) return { newRung: true };
    return null;
  },

  /* spacer cells needed so an appended block lands at the pointer's column */
  padCells(arr, cpArr, clientX) {
    const b = this.svgHost.getBoundingClientRect();
    const x = clientX - b.left + this.svgHost.scrollLeft;
    const cp = JSON.stringify(cpArr);
    const hitList = this._hits.filter(h => h.cp === cp);
    if (!hitList.length) return 0;
    const startX = Math.min(...hitList.map(h => h.x));
    const natural = arr.reduce((s, it) => s + itemW(it), 0);
    const desired = Math.floor((x - startX) / CW);
    return Math.max(0, desired - natural);
  },

  async onHit(hit, clientX) {
    const p = JSON.parse(hit.dataset.p);
    const slot = !!hit.dataset.slot;
    const arr = container(this.doc, p);
    const it = slot ? null : arr[p[p.length - 1]];

    if (this.tool === 'select') {
      // while running, clicking a contact forces its variable (like an I/O switch)
      if (PLC.engine.running && PLC.engine.lang === 'ld' && it && (it.t === 'NO' || it.t === 'NC')) {
        try {
          PLC.writeVar(it.name, !B(PLC.readVar(it.name)));
          UI.refreshAll();
          UI.status(`${it.name} forced ${B(PLC.readVar(it.name)) ? 'TRUE' : 'FALSE'}.`);
        } catch (err) { UI.status(err.message, true); }
        return;
      }
      this.sel = { p, slot };
      this.render();
      UI.status(slot
        ? `Insertion point selected on rung ${p[0] + 1} — ║ Branch or a new block goes here.`
        : `Block selected on rung ${p[0] + 1} — ║ Branch inserts after it, Erase removes it.`);
      return;
    }

    const dst = this.slotFromHit(hit, clientX);
    await this.placeAt(this.tool, dst, clientX);
  },

  eraseSelected() {
    if (!this.sel || this.sel.slot) { UI.status('Select a block first (Select tool), then press Erase.', true); return; }
    const p = this.sel.p;
    const arr = container(this.doc, p);
    const it = arr[p[p.length - 1]];
    if (!it) { this.sel = null; return; }
    this.pushHistory();
    if (it.t === 'BR') {
      // unwrap: the branch goes away but its blocks stay on the rung
      arr.splice(p[p.length - 1], 1, ...it.arms.flat());
      UI.status('Branch removed — its blocks were kept in series on the rung.');
    } else if (it.t === 'H') {
      arr.splice(p[p.length - 1], 1);            // removing a spacer closes the gap
      UI.status('Empty cell removed.');
    } else {
      arr.splice(p[p.length - 1], 1, { t: 'H' });  // leave the cell empty; nothing shifts
      UI.status('Block erased.');
    }
    trimTrailing(arr);
    this.sel = null;
    this.changed();
  },

  async placeAt(type, slot, clientX) {
    const item = await this.promptItem(type, null);
    if (!item) return;
    this.pushHistory();
    if (slot.newRung) {
      this.doc.rungs.push([]);
      const arr = this.doc.rungs[this.doc.rungs.length - 1];
      const b = this.svgHost.getBoundingClientRect();
      const col = clientX == null ? 0 : Math.floor((clientX - b.left + this.svgHost.scrollLeft - PADL) / CW);
      arr.push(...spacers(col), item);
    } else {
      const { arr, idx } = slot;
      if (arr[idx] && arr[idx].t === 'H') arr.splice(idx, 1, item);                        // fill the empty cell
      else if (idx === arr.length && clientX != null) arr.push(...spacers(this.padCells(arr, slot.cpArr, clientX)), item);
      else arr.splice(idx, 0, item);
    }
    this.changed();
  },

  /* ---------------- selection, branch, undo/redo ---------------- */

  insertBranch() {
    if (!this.sel) {
      UI.status('Select a block (or a spot on a rung) first, then press ║ Branch.', true);
      return;
    }
    const p = this.sel.p;
    const arr = container(this.doc, p);
    const idx = Math.min(p[p.length - 1], arr.length);
    this.pushHistory();
    if (!this.sel.slot && arr[idx]) {
      // wrap the selected block: it becomes the upper arm, a new parallel arm opens below
      arr[idx] = { t: 'BR', arms: [[arr[idx]], []] };
      UI.status('Branch wrapped around the block — the lower arm is a parallel path; add blocks onto it.');
    } else {
      arr.splice(idx, 0, { t: 'BR', arms: [[], []] });
      UI.status('Branch inserted — click its arms with a tool to add blocks on them.');
    }
    this.sel = null;
    this.changed();
  },

  /* what a branch-bar drag would do at this pointer position: how many
     neighbouring blocks get absorbed into the upper arm, or how many arm
     blocks get released, and where the bar would end up (for the preview) */
  resizePlan(p, side, clientX) {
    const arr = container(this.doc, p);
    const i = p[p.length - 1];
    const br = arr[i];
    if (!br || br.t !== 'BR') return null;
    const b = this.svgHost.getBoundingClientRect();
    const x = clientX - b.left + this.svgHost.scrollLeft;
    const cp = JSON.stringify(p.slice(0, -1));
    const arm0cp = JSON.stringify(p.concat(0));
    const items = this._hits.filter(h => !h.slot && h.cp === cp);
    const arm0hits = this._hits.filter(h => !h.slot && h.cp === arm0cp);
    const ghost = items.find(h => h.idx === i && h.ghost);
    const mid = h => h.x + h.w / 2;
    let absorb = 0, release = 0, barX;

    if (side === 'R') {
      for (let k = i + 1; k < arr.length; k++) {
        const h = items.find(h2 => h2.idx === k);
        if (h && mid(h) < x) absorb++; else break;
      }
      if (!absorb) {
        for (let k = br.arms[0].length - 1; k >= 0; k--) {
          const h = arm0hits.find(h2 => h2.idx === k);
          if (h && mid(h) > x) release++; else break;
        }
      }
      if (absorb) { const h = items.find(h2 => h2.idx === i + absorb); barX = h.x + h.w; }
      else if (release) { barX = arm0hits.find(h2 => h2.idx === br.arms[0].length - release).x; }
      else barX = ghost ? ghost.x + ghost.w : x;
    } else {
      for (let k = i - 1; k >= 0; k--) {
        const h = items.find(h2 => h2.idx === k);
        if (h && mid(h) > x) absorb++; else break;
      }
      if (!absorb) {
        for (let k = 0; k < br.arms[0].length; k++) {
          const h = arm0hits.find(h2 => h2.idx === k);
          if (h && mid(h) < x) release++; else break;
        }
      }
      if (absorb) { barX = items.find(h2 => h2.idx === i - absorb).x; }
      else if (release) { const h = arm0hits.find(h2 => h2.idx === release - 1); barX = h.x + h.w; }
      else barX = ghost ? ghost.x : x;
    }
    return { arr, i, br, absorb, release, barX, y: ghost ? ghost.y : 0, h: ghost ? ghost.h : CH };
  },

  /* drag a branch bar: extend the branch over neighbouring blocks (they join
     the upper arm) or pull it back to release blocks out of the branch */
  resizeBranch(p, side, clientX) {
    const plan = this.resizePlan(p, side, clientX);
    if (!plan || (!plan.absorb && !plan.release)) return;
    const { arr, i, br, absorb, release } = plan;
    this.pushHistory();
    if (side === 'R') {
      if (absorb) br.arms[0].push(...arr.splice(i + 1, absorb));
      else arr.splice(i + 1, 0, ...br.arms[0].splice(br.arms[0].length - release, release));
    } else {
      if (absorb) br.arms[0].unshift(...arr.splice(i - absorb, absorb));
      else arr.splice(i, 0, ...br.arms[0].splice(0, release));
    }
    this.sel = null;
    this.changed();
    UI.status(absorb
      ? `Branch extended over ${absorb} block${absorb > 1 ? 's' : ''}.`
      : `Branch released ${release} block${release > 1 ? 's' : ''}.`);
  },

  snapshot() { return this.save(); },

  pushHistory() {
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
    this.future.length = 0;
    this.updateUndoBtns();
  },

  applySnap(d) {
    this.doc = { rungs: JSON.parse(JSON.stringify(d.rungs)) };
    this.sel = null;
    this.changed();
    this.updateUndoBtns();
  },

  undo() {
    if (!this.history.length) { UI.status('Nothing to undo.'); return; }
    this.future.push(this.snapshot());
    this.applySnap(this.history.pop());
    UI.status('Undone.');
  },

  redo() {
    if (!this.future.length) { UI.status('Nothing to redo.'); return; }
    this.history.push(this.snapshot());
    this.applySnap(this.future.pop());
    UI.status('Redone.');
  },

  updateUndoBtns() {
    if (this.btnUndo) this.btnUndo.disabled = !this.history.length;
    if (this.btnRedo) this.btnRedo.disabled = !this.future.length;
  },

  /* ---------------- block dialogs ---------------- */

  async promptItem(type, existing) {
    const bools = varOpts('bool'), nums = varOpts('num');

    if (CONTACTS[type] || COILS[type]) {
      const res = await UI.form(
        { NO: 'Normally-open contact', NC: 'Normally-closed contact', COIL: 'Coil', SCOIL: 'Set coil', RCOIL: 'Reset coil' }[type],
        [{ key: 'name', label: 'Variable name', value: existing ? existing.name : (COILS[type] ? 'Q0' : 'I0'), options: bools }]);
      if (!res || !res.name.trim()) return null;
      return { t: type, name: res.name.trim() };
    }
    if (type === 'TON' || type === 'TOF' || type === 'TP') {
      const res = await UI.form(`${type} timer`, [
        { key: 'name', label: 'Instance name', value: existing ? existing.name : 'T1' },
        { key: 'pt', label: 'Preset time PT (ms)', value: existing ? existing.pt : 1000, type: 'number' },
      ]);
      if (!res || !res.name.trim()) return null;
      return { t: type, name: res.name.trim(), pt: Math.max(0, +res.pt || 0) };
    }
    if (type === 'CTU' || type === 'CTD') {
      const res = await UI.form(`${type} counter`, [
        { key: 'name', label: 'Instance name', value: existing ? existing.name : 'C1' },
        { key: 'pv', label: 'Preset value PV', value: existing ? existing.pv : 5, type: 'number' },
        { key: 'aux', label: type === 'CTU' ? 'Reset variable (optional)' : 'Load variable (optional)', value: existing ? (existing.aux || '') : '', options: bools },
      ]);
      if (!res || !res.name.trim()) return null;
      return { t: type, name: res.name.trim(), pv: Math.max(0, +res.pv || 0), aux: res.aux.trim() };
    }
    if (type === 'CTUD') {
      const res = await UI.form('CTUD counter — rung power counts up', [
        { key: 'name', label: 'Instance name', value: existing ? existing.name : 'C1' },
        { key: 'pv', label: 'Preset value PV', value: existing ? existing.pv : 5, type: 'number' },
        { key: 'cd', label: 'Count-down variable (optional)', value: existing ? (existing.cd || '') : '', options: bools },
        { key: 'r', label: 'Reset variable (optional)', value: existing ? (existing.r || '') : '', options: bools },
        { key: 'ld', label: 'Load variable (optional)', value: existing ? (existing.ld || '') : '', options: bools },
      ]);
      if (!res || !res.name.trim()) return null;
      return { t: 'CTUD', name: res.name.trim(), pv: Math.max(0, +res.pv || 0), cd: res.cd.trim(), r: res.r.trim(), ld: res.ld.trim() };
    }
    if (type === 'CMP') {
      const res = await UI.form('Compare — passes power while A op B is true', [
        { key: 'a', label: 'A (variable or number)', value: existing ? existing.a : 'AI0', options: nums },
        { key: 'op', label: 'Operator', value: existing ? existing.op : '>', type: 'choice', options: ['>', '>=', '<', '<=', '=', { v: '<>', label: '<> / ≠ / !=' }] },
        { key: 'b', label: 'B (variable or number)', value: existing ? existing.b : '500', options: nums },
      ]);
      if (!res || !res.a.trim() || !res.b.trim()) return null;
      return { t: 'CMP', op: res.op, a: res.a.trim(), b: res.b.trim() };
    }
    if (type === 'MATH') {
      const res = await UI.form('Math — dest := A op B, while powered', [
        { key: 'dest', label: 'Destination variable', value: existing ? existing.dest : 'AQ0', options: nums },
        { key: 'a', label: 'A (variable or number)', value: existing ? existing.a : 'AI0', options: nums },
        { key: 'op', label: 'Operator', value: existing ? existing.op : '+', type: 'choice', options: ['+', '-', '*', '/', 'MOD'] },
        { key: 'b', label: 'B (variable or number)', value: existing ? existing.b : '1', options: nums },
      ]);
      if (!res || !res.dest.trim() || !res.a.trim() || !res.b.trim()) return null;
      return { t: 'MATH', op: res.op, dest: res.dest.trim(), a: res.a.trim(), b: res.b.trim() };
    }
    if (type === 'MOVE') {
      const res = await UI.form('Move — dest := source, while powered', [
        { key: 'dest', label: 'Destination variable', value: existing ? existing.dest : 'AQ0', options: nums },
        { key: 'a', label: 'Source (variable or number)', value: existing ? existing.a : '0', options: nums },
      ]);
      if (!res || !res.dest.trim() || !res.a.trim()) return null;
      return { t: 'MOVE', dest: res.dest.trim(), a: res.a.trim() };
    }
    return null;
  },

  /* ---------------- compile & scan ---------------- */

  compile() {
    let count = 0;
    const walk = (arm, where) => {
      arm.forEach((it, i) => {
        count++;
        const at = `${where}, block ${i + 1}`;
        if (it.t === 'BR') { it.arms.forEach((a, k) => walk(a, `${at} (arm ${k + 1})`)); return; }
        if ((CONTACTS[it.t] || COILS[it.t] || FBTYPES[it.t]) && !it.name) throw new Error(`${at}: element has no variable name`);
        if (it.t === 'CMP' && !(it.a && it.b)) throw new Error(`${at}: compare needs both operands`);
        if (it.t === 'MATH' && !(it.a && it.b && it.dest)) throw new Error(`${at}: math needs operands and a destination`);
        if (it.t === 'MOVE' && !(it.a && it.dest)) throw new Error(`${at}: move needs a source and a destination`);
        if (FBTYPES[it.t]) it._inst = PLC.getFB(it.name, it.t);
      });
    };
    this.doc.rungs.forEach((r, i) => walk(r, `Rung ${i + 1}`));
    if (!count) throw new Error('The ladder diagram is empty — place some contacts and coils first');
    const doc = this.doc;
    return { scan(dt) { doc.rungs.forEach(r => evalArm(r, true, dt)); } };
  },

  onStop() { this.render(); },
  onReset() { clearPower(this.doc); this.render(); },
  renderLive() { this.render(); },

  /* ---------------- rendering ---------------- */

  render() {
    if (!this.svgHost) return;
    const doc = this.doc;
    const running = PLC.engine.running && PLC.engine.lang === 'ld';
    if (this.sel && this.sel.p[0] >= doc.rungs.length) this.sel = null;

    const heights = doc.rungs.map(armH);
    const cols = Math.max(MINCOLS, ...doc.rungs.map(armW));
    const W = PADL * 2 + cols * CW;
    const H = PADT * 2 + Math.max(1, heights.reduce((s, h) => s + h, 0)) * CH;
    const RX = PADL + cols * CW;                  // right rail x
    this._hits = [];
    this._brHits = [];                            // branch bar handles, drawn on top
    this._rungY = [];

    let s = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;

    // selected rung band
    if (this.sel) {
      let yb = PADT;
      for (let i = 0; i < this.sel.p[0]; i++) yb += heights[i] * CH;
      s += `<rect class="rowsel" x="${PADL}" y="${yb}" width="${cols * CW}" height="${heights[this.sel.p[0]] * CH}"/>`;
    }

    s += `<line class="rail" x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${H - PADT}"/>`;
    s += `<line class="rail" x1="${RX}" y1="${PADT}" x2="${RX}" y2="${H - PADT}"/>`;

    let yTop = PADT;
    doc.rungs.forEach((rung, r) => {
      const h = heights[r];
      this._rungY.push({ rung: r, y0: yTop, y1: yTop + h * CH });
      s += this.renderArm(rung, PADL, yTop, RX, [r], running, true);
      s += `<text class="lbl2" x="${PADL - 18}" y="${yTop + CH / 2 + 4}">${r + 1}</text>`;
      yTop += h * CH;
    });

    // hit rects on top; selection marker for the chosen block / slot
    const selKey = this.sel ? JSON.stringify(this.sel.p) + (this.sel.slot ? 's' : '') : null;
    for (const hb of this._hits.concat(this._brHits)) {
      if (hb.ghost) continue;
      if (selKey && hb.key === selKey) {
        s += `<rect class="cellsel" x="${hb.x}" y="${hb.y}" width="${hb.w}" height="${hb.h}"/>`;
      }
      s += `<rect class="cellhit" data-p="${escAttr(hb.p)}"${hb.slot ? ' data-slot="1"' : ''}${hb.side ? ` data-side="${hb.side}"` : ''} x="${hb.x}" y="${hb.y}" width="${hb.w}" height="${hb.h}"/>`;
    }
    s += '</svg>';
    this.svgHost.innerHTML = s;
    if (this._caret) { this._caret.hidden = true; this.svgHost.appendChild(this._caret); }
  },

  /* series of blocks starting at x, wire line at yTop+CH/2, filling to xEnd */
  renderArm(arm, x, yTop, xEnd, basePath, running, powered) {
    const y = yTop + CH / 2;
    let s = '', curX = x;
    let pow = powered;   // fallback power state for wires when not running

    const cp = JSON.stringify(basePath);
    arm.forEach((it, i) => {
      const w = itemW(it) * CW;
      const pin = running && !!it._in, pout = running && !!it._out;
      const pj = JSON.stringify(basePath.concat(i));
      if (it.t === 'BR') {
        s += this.renderBranch(it, curX, yTop, basePath.concat(i), running);
        const bh = itemH(it) * CH;
        // layout ghost (no DOM rect) so x-position math sees the branch
        this._hits.push({ x: curX, y: yTop, w, h: bh, p: pj, slot: false, key: pj, cp, idx: i, ghost: true });
        // the branch's vertical bars select it and resize its span when dragged
        this._brHits.push(
          { x: curX - 7, y: yTop, w: 14, h: bh, p: pj, slot: false, key: pj, cp, idx: i, side: 'L' },
          { x: curX + w - 7, y: yTop, w: 14, h: bh, p: pj, slot: false, key: pj, cp, idx: i, side: 'R' },
        );
      } else {
        s += drawElement(it, curX, y, pin, pout, running);
        this._hits.push({ x: curX, y: yTop, w, h: itemH(it) * CH, p: pj, slot: false, key: pj, cp, idx: i });
      }
      pow = running ? pout : pow;
      curX += w;
    });

    // trailing wire to the section end
    if (curX < xEnd) {
      const on = running && (arm.length ? !!arm[arm.length - 1]._out : powered);
      s += `<line class="wire${on ? ' on' : ''}" x1="${curX}" y1="${y}" x2="${xEnd}" y2="${y}"/>`;
      this._hits.push({
        x: curX, y: yTop, w: xEnd - curX, h: CH,
        p: JSON.stringify(basePath.concat(arm.length)), slot: true,
        key: JSON.stringify(basePath.concat(arm.length)) + 's',
        cp, idx: arm.length,
      });
    }
    return s;
  },

  renderBranch(br, x, yTop, path, running) {
    const w = itemW(br) * CW;
    const inOn = running && !!br._in, outOn = running && !!br._out;
    let s = '';
    let armTop = yTop;
    let lastLine = yTop + CH / 2;
    br.arms.forEach((arm, k) => {
      const line = armTop + CH / 2;
      lastLine = line;
      s += this.renderArm(arm, x, armTop, x + w, path.concat(k), running, !!br._in);
      armTop += armH(arm) * CH;
    });
    const y0 = yTop + CH / 2;
    s += `<line class="wire${inOn ? ' on' : ''}" x1="${x}" y1="${y0}" x2="${x}" y2="${lastLine}"/>`;
    s += `<line class="wire${outOn ? ' on' : ''}" x1="${x + w}" y1="${y0}" x2="${x + w}" y2="${lastLine}"/>`;
    return s;
  },

  /* position the insertion caret at the boundary the pointer maps to */
  updateCaret(clientX, clientY, excludeP) {
    const el = document.elementFromPoint(clientX, clientY);
    const hit = el && el.closest && el.closest('[data-p]');
    let cpArr, idx;
    if (hit) {
      const p = JSON.parse(hit.dataset.p);
      if (excludeP && p.length > excludeP.length && excludeP.every((v, i) => p[i] === v)) { this.hideCaret(); return; }
      cpArr = p.slice(0, -1);
      idx = this.indexByX(cpArr, container(this.doc, p).length, clientX);
    } else {
      const b = this.svgHost.getBoundingClientRect();
      const y = clientY - b.top + this.svgHost.scrollTop;
      const band = (this._rungY || []).find(rb => y >= rb.y0 && y < rb.y1);
      if (!band) { this.hideCaret(); return; }
      cpArr = [band.rung];
      idx = this.indexByX(cpArr, this.doc.rungs[band.rung].length, clientX);
    }
    const cp = JSON.stringify(cpArr);
    const items = this._hits.filter(h => !h.slot && h.cp === cp).sort((a, b) => a.idx - b.idx);
    const tail = this._hits.find(h => h.slot && h.cp === cp);
    const arr = container(this.doc, cpArr.concat(0));
    const pad = idx >= arr.length ? this.padCells(arr, cpArr, clientX) * CW : 0;
    let x, y;
    if (idx < items.length) { x = items[idx].x; y = items[idx].y; }
    else if (items.length) { const t = items[items.length - 1]; x = t.x + t.w + pad; y = t.y; }
    else if (tail) { x = tail.x + pad; y = tail.y; }
    else { this.hideCaret(); return; }
    this._caret.style.left = (x - 1) + 'px';
    this._caret.style.top = (y + 6) + 'px';
    this._caret.style.height = (CH - 12) + 'px';
    this._caret.hidden = false;
  },

  hideCaret() { if (this._caret) this._caret.hidden = true; },

  /* ---------------- persistence ---------------- */

  save() {
    const strip = it => it.t === 'BR'
      ? { t: 'BR', arms: it.arms.map(a => a.map(strip)) }
      : (({ _inst, _in, _out, ...rest }) => rest)(it);
    return { rungs: this.doc.rungs.map(r => r.map(strip)) };
  },

  load(d) {
    if (d && Array.isArray(d.rungs)) {
      this.doc = { rungs: JSON.parse(JSON.stringify(d.rungs)) };
    } else if (d && Array.isArray(d.cells)) {
      // migrate the old grid format: keep each row's elements in order
      this.doc = { rungs: d.cells.map(row => row.filter(c => c && c.t && c.t !== 'H').map(c => ({ ...c }))) };
      if (!this.doc.rungs.length) this.doc = emptyDoc();
    } else {
      this.doc = emptyDoc();
    }
    this.sel = null;
    this.render();
  },

  example() {
    this.pushHistory();
    this.load(PLC.EXAMPLES.ld);
    UI.docChanged();
  },
};

/* ---------------- evaluation ---------------- */

function evalArm(arm, inP, dt) {
  let p = inP;
  for (const it of arm) p = evalItem(it, p, dt);
  return p;
}

function evalItem(it, inP, dt) {
  it._in = inP;
  let out;
  switch (it.t) {
    case 'NO': out = inP && B(PLC.readVar(it.name)); break;
    case 'NC': out = inP && !B(PLC.readVar(it.name)); break;
    case 'CMP': out = inP && cmpEval(it); break;
    case 'COIL': PLC.writeVar(it.name, inP); out = inP; break;
    case 'SCOIL': if (inP) PLC.writeVar(it.name, true); out = inP; break;
    case 'RCOIL': if (inP) PLC.writeVar(it.name, false); out = inP; break;
    case 'MATH': if (inP) PLC.writeVar(it.dest, mathEval(it)); out = inP; break;
    case 'MOVE': if (inP) PLC.writeVar(it.dest, opVal(it.a)); out = inP; break;
    case 'TON': case 'TOF': case 'TP':
      it._inst.invoke({ IN: inP, PT: it.pt }, dt);
      out = !!it._inst.Q;
      break;
    case 'CTU':
      it._inst.invoke({ CU: inP, R: it.aux ? B(PLC.readVar(it.aux)) : false, PV: it.pv });
      out = !!it._inst.Q;
      break;
    case 'CTD':
      it._inst.invoke({ CD: inP, LD: it.aux ? B(PLC.readVar(it.aux)) : false, PV: it.pv });
      out = !!it._inst.Q;
      break;
    case 'CTUD':
      it._inst.invoke({
        CU: inP,
        CD: it.cd ? B(PLC.readVar(it.cd)) : false,
        R: it.r ? B(PLC.readVar(it.r)) : false,
        LD: it.ld ? B(PLC.readVar(it.ld)) : false,
        PV: it.pv,
      });
      out = !!it._inst.Q;
      break;
    case 'BR': {
      let o = false;
      for (const arm of it.arms) o = evalArm(arm, inP, dt) || o;
      out = o;
      break;
    }
    default: out = inP;
  }
  it._out = out;
  return out;
}

function clearPower(doc) {
  const walk = arm => arm.forEach(it => {
    delete it._in; delete it._out;
    if (it.t === 'BR') it.arms.forEach(walk);
  });
  doc.rungs.forEach(walk);
}

/* ---------------- element drawing ---------------- */

function drawElement(it, x, y, pin, pout, running) {
  const cx = x + CW / 2;
  const wIn = `wire${pin ? ' on' : ''}`, wOut = `wire${pout ? ' on' : ''}`;
  let s = '';
  switch (it.t) {
    case 'H':   // wire spacer cell
      s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
      break;
    case 'NO': case 'NC': {
      const varOn = running && B(safeRead(it.name));
      const closed = it.t === 'NO' ? varOn : (running && !varOn);
      s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 8}" y2="${y}"/>`;
      s += `<line class="${wOut}" x1="${cx + 8}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
      s += `<line class="sym${closed ? ' on' : ''}" x1="${cx - 8}" y1="${y - 13}" x2="${cx - 8}" y2="${y + 13}"/>`;
      s += `<line class="sym${closed ? ' on' : ''}" x1="${cx + 8}" y1="${y - 13}" x2="${cx + 8}" y2="${y + 13}"/>`;
      if (it.t === 'NC') s += `<line class="sym${closed ? ' on' : ''}" x1="${cx - 12}" y1="${y + 13}" x2="${cx + 12}" y2="${y - 13}"/>`;
      s += `<text class="lbl" x="${cx}" y="${y - 20}">${esc(it.name)}</text>`;
      break;
    }
    case 'COIL': case 'SCOIL': case 'RCOIL': {
      s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 10}" y2="${y}"/>`;
      s += `<line class="${wOut}" x1="${cx + 10}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
      s += `<path class="sym${pin ? ' on' : ''}" d="M ${cx - 5} ${y - 12} A 16 16 0 0 0 ${cx - 5} ${y + 12}"/>`;
      s += `<path class="sym${pin ? ' on' : ''}" d="M ${cx + 5} ${y - 12} A 16 16 0 0 1 ${cx + 5} ${y + 12}"/>`;
      if (it.t !== 'COIL') s += `<text class="lbl" x="${cx}" y="${y + 4}" style="fill:#cfd8e3">${it.t === 'SCOIL' ? 'S' : 'R'}</text>`;
      s += `<text class="lbl" x="${cx}" y="${y - 20}">${esc(it.name)}</text>`;
      break;
    }
    case 'CMP': {
      s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 40}" y2="${y}"/>`;
      s += `<line class="${wOut}" x1="${cx + 40}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
      s += `<rect class="fbbox${pout ? ' on' : ''}" x="${cx - 40}" y="${y - 20}" width="80" height="40" rx="4"/>`;
      s += `<text class="fbtitle" x="${cx}" y="${y - 5}">CMP</text>`;
      s += `<text class="lbl2${pout ? ' on' : ''}" x="${cx}" y="${y + 11}">${esc(it.a)} ${esc(it.op)} ${esc(it.b)}</text>`;
      break;
    }
    case 'MATH': case 'MOVE': {
      s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 40}" y2="${y}"/>`;
      s += `<line class="${wOut}" x1="${cx + 40}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
      s += `<rect class="fbbox${pin ? ' on' : ''}" x="${cx - 40}" y="${y - 24}" width="80" height="48" rx="4"/>`;
      s += `<text class="fbtitle" x="${cx}" y="${y - 9}">${it.t === 'MATH' ? 'MATH' : 'MOV'}</text>`;
      s += `<text class="lbl2" x="${cx}" y="${y + 5}">${esc(it.dest)} :=</text>`;
      s += `<text class="lbl2" x="${cx}" y="${y + 17}">${esc(it.t === 'MATH' ? `${it.a} ${it.op} ${it.b}` : it.a)}</text>`;
      break;
    }
    default: {   // timers & counters
      const inst = PLC.fbs.get(PLC.U(it.name));
      const qOn = running && inst && inst.Q;
      s += `<line class="${wIn}" x1="${x}" y1="${y}" x2="${cx - 34}" y2="${y}"/>`;
      s += `<line class="wire${qOn ? ' on' : ''}" x1="${cx + 34}" y1="${y}" x2="${x + CW}" y2="${y}"/>`;
      s += `<rect class="fbbox${qOn ? ' on' : ''}" x="${cx - 34}" y="${y - 26}" width="68" height="52" rx="4"/>`;
      s += `<text class="fbtitle" x="${cx}" y="${y - 11}">${it.t}</text>`;
      s += `<text class="lbl" x="${cx}" y="${y - 32}">${esc(it.name)}</text>`;
      if (it.t[0] === 'T') {
        s += `<text class="lbl2" x="${cx}" y="${y + 6}">PT ${it.pt}ms</text>`;
        s += `<text class="lbl2${qOn ? ' on' : ''}" x="${cx}" y="${y + 19}">${running && inst ? 'ET ' + Math.round(inst.ET) : ''}</text>`;
      } else {
        s += `<text class="lbl2" x="${cx}" y="${y + 6}">PV ${it.pv}</text>`;
        s += `<text class="lbl2${qOn ? ' on' : ''}" x="${cx}" y="${y + 19}">${running && inst ? 'CV ' + inst.CV : ''}</text>`;
      }
      break;
    }
  }
  return s;
}

/* ---------------- helpers ---------------- */

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
function safeRead(name) { try { return PLC.readVar(name); } catch { return false; } }

/* existing variable names for the dialog suggestion lists */
function varOpts(kind) {
  const names = [];
  PLC.vars.forEach(v => {
    if (kind === 'bool' && typeof v.value !== 'boolean') return;
    if (kind === 'num' && typeof v.value === 'boolean') return;
    names.push(v.name);
  });
  return names;
}

/* operand: numeric literal or variable name */
function opVal(s) {
  const n = Number(s);
  return Number.isNaN(n) ? PLC.num(PLC.readVar(s)) : n;
}

function cmpEval(it) {
  const a = opVal(it.a), b = opVal(it.b);
  switch (it.op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '=': case '==': return a === b;
    case '<>': case '≠': case '!=': return a !== b;
  }
  return false;
}

function mathEval(it) {
  const a = opVal(it.a), b = opVal(it.b);
  switch (it.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? 0 : a / b;
    case 'MOD': return b === 0 ? 0 : a % b;
  }
  return 0;
}

PLC.registerModule(LD);

})();
