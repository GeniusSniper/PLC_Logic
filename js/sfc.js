'use strict';

/* ============================================================
   Sequential Function Chart (SFC) — steps, transitions, actions.
   Step actions are ST statements executed while the step is
   active; transition conditions are ST expressions. Each step
   exposes .X (active) and .T (ms active) e.g.  S1.T >= T#3s
   ============================================================ */

(function () {

const B = PLC.bool;
const SW = 110, SH = 44;

function emptyDoc() { return { steps: [], trans: [], nextId: 1 }; }

/* pseudo function block registered per step so ST can read S1.X / S1.T */
class StepFB {
  constructor(name) { this.name = name; this.TYPE = 'STEP'; this.X = false; this.T = 0; }
  reset() { this.X = false; this.T = 0; }
  invoke() { return this.X; }
  info() { return `X=${this.X ? 1 : 0} T=${Math.round(this.T)}ms`; }
}

const SFC = {
  id: 'sfc',
  title: 'Sequential Function Chart',
  doc: emptyDoc(),
  svgHost: null,
  propsBar: null,
  sel: null,          // {kind:'step'|'trans', id}
  tool: 'select',
  transFrom: null,
  drag: null,
  active: new Set(),  // active step ids while running
  enabledTr: new Set(),

  init(pane) {
    pane.innerHTML = `
      <div class="ed-toolbar" id="sfc-toolbar">
        <button class="tool active" data-tool="select" title="Select / drag steps">&#8598; Select</button>
        <button class="tool" data-tool="step" title="Click empty canvas to add a step">+ Step</button>
        <button class="tool" data-tool="trans" title="Click a source step, then a target step">&#8594; Transition</button>
        <span class="sep"></span>
        <button id="sfc-initial" title="Make the selected step the initial step">Set initial</button>
        <button id="sfc-del">Delete selected</button>
        <button id="sfc-clear">Clear</button>
        <span class="ed-hint">Steps run their ST actions while active · conditions are ST expressions · use S1.T for time in step</span>
      </div>
      <div class="props-bar" id="sfc-props" hidden></div>
      <div class="ed-canvas" id="sfc-canvas"></div>`;

    this.svgHost = pane.querySelector('#sfc-canvas');
    this.propsBar = pane.querySelector('#sfc-props');

    pane.querySelector('#sfc-toolbar').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.tool) {
        this.tool = btn.dataset.tool;
        this.transFrom = null;
        pane.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === btn));
        const hints = {
          step: 'Click empty canvas to place a new step.',
          trans: 'Click the SOURCE step, then the TARGET step.',
        };
        if (hints[this.tool]) UI.status(hints[this.tool]);
      } else if (btn.id === 'sfc-initial') {
        if (this.sel && this.sel.kind === 'step') {
          this.doc.steps.forEach(st => { st.initial = st.id === this.sel.id; });
          this.changed();
        } else UI.status('Select a step first.', true);
      } else if (btn.id === 'sfc-del') {
        this.deleteSelected();
      } else if (btn.id === 'sfc-clear') {
        UI.confirm('Clear the whole chart?').then(ok => {
          if (ok) { this.doc = emptyDoc(); this.sel = null; this.active.clear(); this.showProps(); this.changed(); }
        });
      }
    });

    const svgPoint = e => {
      const r = this.svgHost.getBoundingClientRect();
      return { x: e.clientX - r.left + this.svgHost.scrollLeft, y: e.clientY - r.top + this.svgHost.scrollTop };
    };

    this.svgHost.addEventListener('pointerdown', e => {
      const p = svgPoint(e);
      const stepEl = e.target.closest('[data-sid]');
      const trEl = e.target.closest('[data-tid]');

      if (this.tool === 'step' && !stepEl && !trEl) {
        this.addStep(p.x - SW / 2, p.y - SH / 2);
        return;
      }
      if (this.tool === 'trans' && stepEl) {
        const id = +stepEl.dataset.sid;
        if (this.transFrom === null) {
          this.transFrom = id;
          UI.status('Source selected — now click the TARGET step.');
          this.render();
        } else if (this.transFrom !== id) {
          this.doc.trans.push({ id: this.doc.nextId++, from: this.transFrom, to: id, condition: 'TRUE' });
          const t = this.doc.trans[this.doc.trans.length - 1];
          this.transFrom = null;
          this.sel = { kind: 'trans', id: t.id };
          this.showProps();
          this.changed();
          UI.status('Transition added — edit its condition above the canvas.');
        }
        return;
      }
      if (stepEl) {
        const st = this.doc.steps.find(x => x.id === +stepEl.dataset.sid);
        this.sel = { kind: 'step', id: st.id };
        this.drag = { st, dx: p.x - st.x, dy: p.y - st.y, moved: false };
        this.showProps();
        this.render();
        return;
      }
      if (trEl) {
        this.sel = { kind: 'trans', id: +trEl.dataset.tid };
        this.showProps();
        this.render();
        return;
      }
      this.sel = null;
      this.transFrom = null;
      this.showProps();
      this.render();
    });

    this.svgHost.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const p = svgPoint(e);
      this.drag.st.x = Math.max(0, Math.round(p.x - this.drag.dx));
      this.drag.st.y = Math.max(0, Math.round(p.y - this.drag.dy));
      this.drag.moved = true;
      this.render();
    });
    this.svgHost.addEventListener('pointerup', () => {
      if (this.drag && this.drag.moved) UI.docChanged();
      this.drag = null;
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Delete') return;
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (UI.currentLang && UI.currentLang() !== 'sfc') return;
      this.deleteSelected();
    });

    this.render();
  },

  changed() { this.render(); UI.docChanged(); },

  addStep(x, y) {
    const id = this.doc.nextId++;
    const st = {
      id,
      name: 'S' + id,
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      initial: this.doc.steps.length === 0,
      actions: '',
    };
    this.doc.steps.push(st);
    this.sel = { kind: 'step', id };
    this.showProps();
    this.changed();
  },

  deleteSelected() {
    if (!this.sel) return;
    if (this.sel.kind === 'step') {
      const id = this.sel.id;
      this.doc.steps = this.doc.steps.filter(s => s.id !== id);
      this.doc.trans = this.doc.trans.filter(t => t.from !== id && t.to !== id);
    } else {
      this.doc.trans = this.doc.trans.filter(t => t.id !== this.sel.id);
    }
    this.sel = null;
    this.showProps();
    this.changed();
  },

  showProps() {
    const bar = this.propsBar;
    if (!bar) return;
    if (!this.sel) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    if (this.sel.kind === 'step') {
      const st = this.doc.steps.find(s => s.id === this.sel.id);
      if (!st) { bar.hidden = true; return; }
      bar.innerHTML = `
        <label>Step name</label><input id="sfc-p-name" value="${escAttr(st.name)}" size="10">
        <label>Actions (ST, run while active)</label><textarea id="sfc-p-act" spellcheck="false">${escHtml(st.actions)}</textarea>
        <button id="sfc-p-apply">Apply</button>`;
      bar.querySelector('#sfc-p-apply').addEventListener('click', () => {
        const name = bar.querySelector('#sfc-p-name').value.trim();
        if (name) st.name = name;
        st.actions = bar.querySelector('#sfc-p-act').value;
        this.changed();
        UI.status('Step updated.');
      });
    } else {
      const tr = this.doc.trans.find(t => t.id === this.sel.id);
      if (!tr) { bar.hidden = true; return; }
      bar.innerHTML = `
        <label>Transition condition (ST expression)</label>
        <input id="sfc-p-cond" value="${escAttr(tr.condition)}" size="46">
        <button id="sfc-p-apply">Apply</button>`;
      const apply = () => {
        tr.condition = bar.querySelector('#sfc-p-cond').value.trim() || 'TRUE';
        this.changed();
        UI.status('Transition updated.');
      };
      bar.querySelector('#sfc-p-apply').addEventListener('click', apply);
      bar.querySelector('#sfc-p-cond').addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    }
  },

  /* ---------------- compile & scan ---------------- */

  compile() {
    const doc = this.doc;
    if (!doc.steps.length) throw new Error('The chart is empty — add at least one step');
    const names = new Set();
    for (const st of doc.steps) {
      const key = PLC.U(st.name);
      if (names.has(key)) throw new Error(`Duplicate step name '${st.name}'`);
      names.add(key);
    }
    // register step pseudo-FBs so conditions can use S1.X / S1.T
    for (const st of doc.steps) {
      let fb = PLC.fbs.get(PLC.U(st.name));
      if (!fb || fb.TYPE !== 'STEP') {
        fb = new StepFB(st.name);
        PLC.fbs.set(PLC.U(st.name), fb);
        PLC.varsDirty = true;
      }
      st._fb = fb;
      try {
        st._act = st.actions.trim() ? PLC.ST.compileStmts(st.actions) : null;
      } catch (e) {
        throw new Error(`Step '${st.name}' actions: ${e.message}`);
      }
    }
    for (const tr of doc.trans) {
      const from = doc.steps.find(s => s.id === tr.from);
      const to = doc.steps.find(s => s.id === tr.to);
      if (!from || !to) throw new Error('A transition points at a deleted step — delete the transition');
      try {
        tr._cond = PLC.ST.compileExpr(tr.condition || 'TRUE');
      } catch (e) {
        throw new Error(`Transition ${from.name} → ${to.name}: ${e.message}`);
      }
    }

    const initials = doc.steps.filter(s => s.initial);
    this.active = new Set((initials.length ? initials : [doc.steps[0]]).map(s => s.id));
    doc.steps.forEach(st => { st._fb.X = this.active.has(st.id); st._fb.T = 0; });

    const self = this;
    return {
      scan(dt) {
        const ctx = { dt, ops: 0 };
        for (const st of doc.steps) if (self.active.has(st.id)) st._fb.T += dt;

        const fired = [];
        self.enabledTr = new Set();
        for (const tr of doc.trans) {
          if (!self.active.has(tr.from)) continue;
          if (B(tr._cond(ctx))) { fired.push(tr); self.enabledTr.add(tr.id); }
        }
        if (fired.length) {
          for (const tr of fired) self.active.delete(tr.from);
          for (const tr of fired) {
            if (!self.active.has(tr.to)) {
              self.active.add(tr.to);
              const to = doc.steps.find(s => s.id === tr.to);
              to._fb.T = 0;
            }
          }
          doc.steps.forEach(st => { st._fb.X = self.active.has(st.id); });
        }
        for (const st of doc.steps) {
          if (self.active.has(st.id) && st._act) st._act(ctx);
        }
      },
    };
  },

  onStop() { this.enabledTr.clear(); this.render(); },
  onReset() {
    this.active.clear();
    this.enabledTr.clear();
    this.doc.steps.forEach(st => { if (st._fb) { st._fb.X = false; st._fb.T = 0; } });
    this.render();
  },
  renderLive() { this.render(); },

  /* ---------------- rendering ---------------- */

  render() {
    if (!this.svgHost) return;
    const doc = this.doc;
    const running = PLC.engine.running && PLC.engine.lang === 'sfc';
    let maxX = 600, maxY = 400;
    doc.steps.forEach(st => { maxX = Math.max(maxX, st.x + SW + 220); maxY = Math.max(maxY, st.y + SH + 120); });

    let s = `<svg width="${maxX}" height="${maxY}" xmlns="http://www.w3.org/2000/svg">`;

    for (const tr of doc.trans) {
      const from = doc.steps.find(x => x.id === tr.from);
      const to = doc.steps.find(x => x.id === tr.to);
      if (!from || !to) continue;
      const x1 = from.x + SW / 2, y1 = from.y + SH;
      const x2 = to.x + SW / 2, y2 = to.y;
      let pts, bar;
      if (y2 >= y1 + 24) {           // forward (downward) transition
        const my = (y1 + y2) / 2;
        pts = `${x1},${y1} ${x1},${my} ${x2},${my} ${x2},${y2}`;
        bar = { x: x1, y: y1 + Math.min(20, (my - y1) / 2) };
      } else {                        // loop back upward
        const lx = Math.min(from.x, to.x) - 46;
        pts = `${x1},${y1} ${x1},${y1 + 18} ${lx},${y1 + 18} ${lx},${y2 - 18} ${x2},${y2 - 18} ${x2},${y2}`;
        bar = { x: x1, y: y1 + 12 };
      }
      const en = running && this.enabledTr.has(tr.id);
      const selCls = this.sel && this.sel.kind === 'trans' && this.sel.id === tr.id ? ' sel' : '';
      s += `<polyline class="tr-line" points="${pts}"/>`;
      s += `<line class="tr-bar${selCls}${en ? ' enabled' : ''}" data-tid="${tr.id}" x1="${bar.x - 13}" y1="${bar.y}" x2="${bar.x + 13}" y2="${bar.y}"/>`;
      s += `<rect data-tid="${tr.id}" x="${bar.x - 16}" y="${bar.y - 8}" width="32" height="16" fill="transparent" style="cursor:pointer"/>`;
      s += `<text class="tr-cond" data-tid="${tr.id}" x="${bar.x + 20}" y="${bar.y + 4}" style="cursor:pointer">${escHtml(tr.condition)}</text>`;
    }

    for (const st of doc.steps) {
      const isActive = running && this.active.has(st.id);
      const selCls = this.sel && this.sel.kind === 'step' && this.sel.id === st.id ? ' sel' : '';
      const srcCls = this.transFrom === st.id ? ' step-src' : '';
      s += `<g class="${srcCls}">`;
      s += `<rect class="step-box${isActive ? ' active' : ''}${selCls}" data-sid="${st.id}" x="${st.x}" y="${st.y}" width="${SW}" height="${SH}" rx="5"/>`;
      if (st.initial) s += `<rect class="step-init" x="${st.x + 4}" y="${st.y + 4}" width="${SW - 8}" height="${SH - 8}" rx="3"/>`;
      s += `<text class="step-name" x="${st.x + SW / 2}" y="${st.y + (isActive ? 19 : 27)}">${escHtml(st.name)}</text>`;
      if (isActive && st._fb) s += `<text class="step-time" x="${st.x + SW / 2}" y="${st.y + 36}">${(st._fb.T / 1000).toFixed(1)}s</text>`;
      s += `</g>`;
      if (st.actions.trim()) {
        const first = st.actions.trim().split('\n')[0];
        s += `<text class="tr-cond" x="${st.x + SW + 8}" y="${st.y + SH / 2 + 4}">${escHtml(first.length > 30 ? first.slice(0, 30) + '…' : first)}</text>`;
      }
    }

    s += '</svg>';
    this.svgHost.innerHTML = s;
  },

  save() {
    return {
      steps: this.doc.steps.map(({ _fb, _act, ...st }) => st),
      trans: this.doc.trans.map(({ _cond, ...tr }) => tr),
      nextId: this.doc.nextId,
    };
  },

  load(d) {
    if (!d || !Array.isArray(d.steps)) { this.doc = emptyDoc(); }
    else {
      this.doc = {
        steps: d.steps.map(st => ({ actions: '', ...st })),
        trans: (d.trans || []).map(tr => ({ condition: 'TRUE', ...tr })),
        nextId: d.nextId || 1,
      };
    }
    this.sel = null;
    this.transFrom = null;
    this.active.clear();
    this.showProps();
    this.render();
  },

  example() { this.load(PLC.EXAMPLES.sfc); UI.docChanged(); },
};

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

PLC.registerModule(SFC);

})();
