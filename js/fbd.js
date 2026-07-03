'use strict';

/* ============================================================
   Function Block Diagram (FBD) — draggable blocks, pin wiring.
   Blocks evaluate in creation order each scan; feedback loops
   naturally use the previous scan's value.
   ============================================================ */

(function () {

const B = PLC.bool, N = PLC.num, OPS = PLC.ops;

const DEFS = {
  VAR_IN:  { ins: [], outs: ['OUT'], group: 'I/O' },
  VAR_OUT: { ins: ['IN'], outs: [], group: 'I/O' },
  CONST:   { ins: [], outs: ['OUT'], group: 'I/O' },
  AND: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Logic' },
  OR:  { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Logic' },
  XOR: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Logic' },
  NOT: { ins: ['IN'], outs: ['OUT'], group: 'Logic' },
  SR:  { ins: ['S1', 'R'], outs: ['Q'], fb: true, group: 'Bistable' },
  RS:  { ins: ['S', 'R1'], outs: ['Q'], fb: true, group: 'Bistable' },
  R_TRIG: { ins: ['CLK'], outs: ['Q'], fb: true, group: 'Edge' },
  F_TRIG: { ins: ['CLK'], outs: ['Q'], fb: true, group: 'Edge' },
  TON: { ins: ['IN', 'PT'], outs: ['Q', 'ET'], fb: true, group: 'Timers' },
  TOF: { ins: ['IN', 'PT'], outs: ['Q', 'ET'], fb: true, group: 'Timers' },
  TP:  { ins: ['IN', 'PT'], outs: ['Q', 'ET'], fb: true, group: 'Timers' },
  CTU: { ins: ['CU', 'R', 'PV'], outs: ['Q', 'CV'], fb: true, group: 'Counters' },
  CTD: { ins: ['CD', 'LD', 'PV'], outs: ['Q', 'CV'], fb: true, group: 'Counters' },
  ADD: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Math' },
  SUB: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Math' },
  MUL: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Math' },
  DIV: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Math' },
  MOD: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Math' },
  GT: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Compare' },
  GE: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Compare' },
  EQ: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Compare' },
  NE: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Compare' },
  LE: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Compare' },
  LT: { ins: ['IN1', 'IN2'], outs: ['OUT'], group: 'Compare' },
  SEL: { ins: ['G', 'IN0', 'IN1'], outs: ['OUT'], group: 'Select' },
};

const BW = 108, HEAD = 22, PINSP = 18;

function blockH(type) {
  const d = DEFS[type];
  return HEAD + Math.max(d.ins.length, d.outs.length, 1) * PINSP + 6;
}
function pinPos(b, dir, idx) {
  return {
    x: dir === 'in' ? b.x : b.x + BW,
    y: b.y + HEAD + 10 + idx * PINSP,
  };
}

function emptyDoc() { return { blocks: [], conns: [], nextId: 1 }; }

const FBD = {
  id: 'fbd',
  title: 'Function Block Diagram',
  doc: emptyDoc(),
  svgHost: null,
  sel: null,            // {kind:'block'|'conn', id}
  wireFrom: null,       // {bid, pin}
  mouse: null,
  drag: null,

  init(pane) {
    const groups = {};
    Object.keys(DEFS).forEach(t => (groups[DEFS[t].group] = groups[DEFS[t].group] || []).push(t));
    const opts = Object.entries(groups)
      .map(([g, ts]) => `<optgroup label="${g}">` + ts.map(t => `<option value="${t}">${t}</option>`).join('') + '</optgroup>')
      .join('');

    pane.innerHTML = `
      <div class="ed-toolbar">
        <select id="fbd-type">${opts}</select>
        <button id="fbd-add">+ Add block</button>
        <span class="sep"></span>
        <button id="fbd-del">Delete selected</button>
        <button id="fbd-clear">Clear</button>
        <span class="ed-hint">Drag blocks · click an output pin then an input pin to wire · double-click a block to configure · Del key deletes</span>
      </div>
      <div class="ed-canvas" id="fbd-canvas"></div>`;

    this.svgHost = pane.querySelector('#fbd-canvas');

    pane.querySelector('#fbd-add').addEventListener('click', () => this.addBlock(pane.querySelector('#fbd-type').value));
    pane.querySelector('#fbd-del').addEventListener('click', () => this.deleteSelected());
    pane.querySelector('#fbd-clear').addEventListener('click', () => {
      UI.confirm('Clear the whole diagram?').then(ok => { if (ok) { this.doc = emptyDoc(); this.sel = null; this.changed(); } });
    });

    const svgPoint = e => {
      const r = this.svgHost.getBoundingClientRect();
      return { x: e.clientX - r.left + this.svgHost.scrollLeft, y: e.clientY - r.top + this.svgHost.scrollTop };
    };

    this.svgHost.addEventListener('pointerdown', e => {
      const pinEl = e.target.closest('.pin');
      if (pinEl) {
        const bid = +pinEl.dataset.bid, pin = pinEl.dataset.pin, dir = pinEl.dataset.dir;
        if (dir === 'out') {
          this.wireFrom = { bid, pin };
          UI.status(`Wiring from ${pin} — now click an input pin (click empty space to cancel).`);
        } else if (this.wireFrom) {
          this.doc.conns = this.doc.conns.filter(cn => !(cn.to[0] === bid && cn.to[1] === pin));
          this.doc.conns.push({ id: this.doc.nextId++, from: [this.wireFrom.bid, this.wireFrom.pin], to: [bid, pin] });
          this.wireFrom = null;
          UI.status('Connected.');
          this.changed();
        } else {
          UI.status('Start a wire from an output pin (right side of a block) first.', true);
        }
        this.render();
        return;
      }
      const connEl = e.target.closest('.conn');
      if (connEl) {
        this.sel = { kind: 'conn', id: +connEl.dataset.cid };
        this.wireFrom = null;
        this.render();
        return;
      }
      const blkEl = e.target.closest('[data-bid]');
      if (blkEl && blkEl.classList.contains('blk')) {
        const b = this.doc.blocks.find(x => x.id === +blkEl.dataset.bid);
        this.sel = { kind: 'block', id: b.id };
        const p = svgPoint(e);
        this.drag = { b, dx: p.x - b.x, dy: p.y - b.y, moved: false };
        this.svgHost.setPointerCapture && e.target.setPointerCapture(e.pointerId);
        this.render();
        return;
      }
      // empty space
      this.sel = null;
      if (this.wireFrom) { this.wireFrom = null; UI.status('Wire cancelled.'); }
      this.render();
    });

    this.svgHost.addEventListener('pointermove', e => {
      const p = svgPoint(e);
      if (this.drag) {
        this.drag.b.x = Math.max(0, Math.round(p.x - this.drag.dx));
        this.drag.b.y = Math.max(0, Math.round(p.y - this.drag.dy));
        this.drag.moved = true;
        this.render();
      } else if (this.wireFrom) {
        this.mouse = p;
        this.render();
      }
    });

    this.svgHost.addEventListener('pointerup', () => {
      if (this.drag) {
        if (this.drag.moved) UI.docChanged();
        this.drag = null;
      }
    });

    this.svgHost.addEventListener('dblclick', e => {
      const blkEl = e.target.closest('[data-bid]');
      if (!blkEl) return;
      const b = this.doc.blocks.find(x => x.id === +blkEl.dataset.bid);
      if (b) this.configBlock(b);
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (UI.currentLang && UI.currentLang() !== 'fbd') return;
      if (e.key === 'Backspace' && !this.sel) return;
      this.deleteSelected();
    });

    this.render();
  },

  changed() { this.render(); UI.docChanged(); },

  addBlock(type) {
    const d = DEFS[type];
    if (!d) return;
    const id = this.doc.nextId++;
    const b = { id, type, x: 40 + (this.doc.blocks.length % 6) * 40, y: 30 + (this.doc.blocks.length % 8) * 30, name: '', params: {} };
    if (type === 'VAR_IN') b.name = 'I0';
    else if (type === 'VAR_OUT') b.name = 'Q0';
    else if (type === 'CONST') b.params.value = 1;
    else if (d.fb) b.name = type + id;
    if (d.ins.includes('PT')) b.params.PT = 1000;
    if (d.ins.includes('PV')) b.params.PV = 5;
    this.doc.blocks.push(b);
    this.sel = { kind: 'block', id };
    this.changed();
    if (type === 'VAR_IN' || type === 'VAR_OUT' || type === 'CONST') this.configBlock(b);
  },

  async configBlock(b) {
    const d = DEFS[b.type];
    const fields = [];
    if (b.type === 'CONST') fields.push({ key: 'value', label: 'Constant value (number, TRUE or FALSE)', value: String(b.params.value) });
    else if (b.type === 'VAR_IN' || b.type === 'VAR_OUT') fields.push({ key: 'name', label: 'Variable name', value: b.name });
    else if (d.fb) fields.push({ key: 'name', label: 'Instance name', value: b.name });
    if (d.ins.includes('PT')) fields.push({ key: 'PT', label: 'Default PT (ms, used when pin not wired)', value: b.params.PT, type: 'number' });
    if (d.ins.includes('PV')) fields.push({ key: 'PV', label: 'Default PV (used when pin not wired)', value: b.params.PV, type: 'number' });
    if (!fields.length) return;
    const res = await UI.form(`${b.type} block`, fields);
    if (!res) return;
    if ('name' in res && res.name.trim()) b.name = res.name.trim();
    if ('value' in res) {
      const v = res.value.trim().toUpperCase();
      b.params.value = v === 'TRUE' ? true : v === 'FALSE' ? false : (parseFloat(res.value) || 0);
    }
    if ('PT' in res) b.params.PT = Math.max(0, +res.PT || 0);
    if ('PV' in res) b.params.PV = Math.max(0, +res.PV || 0);
    this.changed();
  },

  deleteSelected() {
    if (!this.sel) return;
    if (this.sel.kind === 'block') {
      const id = this.sel.id;
      this.doc.blocks = this.doc.blocks.filter(b => b.id !== id);
      this.doc.conns = this.doc.conns.filter(cn => cn.from[0] !== id && cn.to[0] !== id);
    } else {
      this.doc.conns = this.doc.conns.filter(cn => cn.id !== this.sel.id);
    }
    this.sel = null;
    this.changed();
  },

  /* ---------------- compile & scan ---------------- */

  compile() {
    const doc = this.doc;
    if (!doc.blocks.length) throw new Error('The diagram is empty — add some blocks first');
    for (const b of doc.blocks) {
      const d = DEFS[b.type];
      if ((b.type === 'VAR_IN' || b.type === 'VAR_OUT') && !b.name) throw new Error(`A ${b.type} block has no variable name`);
      if (d.fb) b._inst = PLC.getFB(b.name || (b.type + b.id), b.type);
      b._out = b._out || {};
    }
    const srcOf = {};
    for (const cn of doc.conns) srcOf[cn.to[0] + ':' + cn.to[1]] = cn.from;

    const pinVal = (b, pin) => {
      const src = srcOf[b.id + ':' + pin];
      if (src) {
        const sb = doc.blocks.find(x => x.id === src[0]);
        return sb ? sb._out[src[1]] : undefined;
      }
      if (pin === 'PT') return b.params.PT;
      if (pin === 'PV') return b.params.PV;
      return false;
    };

    return {
      scan(dt) {
        for (const b of doc.blocks) {
          const out = {};
          switch (b.type) {
            case 'VAR_IN': out.OUT = PLC.readVar(b.name); break;
            case 'VAR_OUT': PLC.writeVar(b.name, pinVal(b, 'IN') ?? false); break;
            case 'CONST': out.OUT = b.params.value; break;
            case 'AND': out.OUT = OPS.AND(pinVal(b, 'IN1'), pinVal(b, 'IN2')); break;
            case 'OR':  out.OUT = OPS.OR(pinVal(b, 'IN1'), pinVal(b, 'IN2')); break;
            case 'XOR': out.OUT = OPS.XOR(pinVal(b, 'IN1'), pinVal(b, 'IN2')); break;
            case 'NOT': out.OUT = !B(pinVal(b, 'IN')); break;
            case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'MOD':
            case 'GT': case 'GE': case 'EQ': case 'NE': case 'LE': case 'LT':
              out.OUT = OPS[b.type](pinVal(b, 'IN1'), pinVal(b, 'IN2'));
              break;
            case 'SEL': out.OUT = B(pinVal(b, 'G')) ? pinVal(b, 'IN1') : pinVal(b, 'IN0'); break;
            case 'SR': b._inst.invoke({ S1: pinVal(b, 'S1'), R: pinVal(b, 'R') }); out.Q = b._inst.Q; break;
            case 'RS': b._inst.invoke({ S: pinVal(b, 'S'), R1: pinVal(b, 'R1') }); out.Q = b._inst.Q; break;
            case 'R_TRIG': case 'F_TRIG':
              b._inst.invoke({ CLK: pinVal(b, 'CLK') }); out.Q = b._inst.Q; break;
            case 'TON': case 'TOF': case 'TP':
              b._inst.invoke({ IN: pinVal(b, 'IN'), PT: pinVal(b, 'PT') }, dt);
              out.Q = b._inst.Q; out.ET = b._inst.ET;
              break;
            case 'CTU':
              b._inst.invoke({ CU: pinVal(b, 'CU'), R: pinVal(b, 'R'), PV: pinVal(b, 'PV') });
              out.Q = b._inst.Q; out.CV = b._inst.CV;
              break;
            case 'CTD':
              b._inst.invoke({ CD: pinVal(b, 'CD'), LD: pinVal(b, 'LD'), PV: pinVal(b, 'PV') });
              out.Q = b._inst.Q; out.CV = b._inst.CV;
              break;
          }
          b._out = out;
        }
      },
    };
  },

  onStop() { this.render(); },
  onReset() { this.doc.blocks.forEach(b => { b._out = {}; }); this.render(); },
  renderLive() { this.render(); },

  /* ---------------- rendering ---------------- */

  render() {
    if (!this.svgHost) return;
    const doc = this.doc;
    const running = PLC.engine.running && PLC.engine.lang === 'fbd';
    let maxX = 600, maxY = 400;
    doc.blocks.forEach(b => { maxX = Math.max(maxX, b.x + BW + 160); maxY = Math.max(maxY, b.y + blockH(b.type) + 80); });

    const findB = id => doc.blocks.find(x => x.id === id);
    const pinXY = (bid, pin, dir) => {
      const b = findB(bid);
      if (!b) return { x: 0, y: 0 };
      const d = DEFS[b.type];
      const list = dir === 'in' ? d.ins : d.outs;
      return pinPos(b, dir, Math.max(0, list.indexOf(pin)));
    };
    const fmt = v => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : (typeof v === 'number' ? (Math.round(v * 100) / 100) : '');

    let s = `<svg width="${maxX}" height="${maxY}" xmlns="http://www.w3.org/2000/svg">`;

    for (const cn of doc.conns) {
      const p1 = pinXY(cn.from[0], cn.from[1], 'out');
      const p2 = pinXY(cn.to[0], cn.to[1], 'in');
      const srcB = findB(cn.from[0]);
      const v = srcB && srcB._out ? srcB._out[cn.from[1]] : undefined;
      const cls = 'conn' + (running && B(v) && typeof v === 'boolean' ? ' on' : '') + (this.sel && this.sel.kind === 'conn' && this.sel.id === cn.id ? ' sel' : '');
      const mx = (p1.x + p2.x) / 2;
      s += `<path class="${cls}" data-cid="${cn.id}" d="M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}"/>`;
    }

    if (this.wireFrom && this.mouse) {
      const p1 = pinXY(this.wireFrom.bid, this.wireFrom.pin, 'out');
      s += `<path class="conn-pending" d="M ${p1.x} ${p1.y} L ${this.mouse.x} ${this.mouse.y}"/>`;
    }

    for (const b of doc.blocks) {
      const d = DEFS[b.type];
      const h = blockH(b.type);
      const selCls = this.sel && this.sel.kind === 'block' && this.sel.id === b.id ? ' sel' : '';
      s += `<rect class="blk${selCls}" data-bid="${b.id}" x="${b.x}" y="${b.y}" width="${BW}" height="${h}" rx="6"/>`;
      const title = b.type === 'VAR_IN' || b.type === 'VAR_OUT' ? esc(b.name || '?')
                  : b.type === 'CONST' ? esc(String(fmt(b.params.value)))
                  : b.type;
      s += `<text class="blk-title" x="${b.x + BW / 2}" y="${b.y + 15}">${title}</text>`;
      if (d.fb && b.name) s += `<text class="blk-name" x="${b.x + BW / 2}" y="${b.y - 5}">${esc(b.name)}</text>`;
      if (b.type === 'VAR_IN' || b.type === 'VAR_OUT') s += `<text class="blk-name" x="${b.x + BW / 2}" y="${b.y - 5}">${b.type === 'VAR_IN' ? 'READ' : 'WRITE'}</text>`;

      d.ins.forEach((pin, i) => {
        const p = pinPos(b, 'in', i);
        const v = pinValLive(doc, b, pin);
        const onCls = running && typeof v === 'boolean' && v ? ' on' : '';
        s += `<circle class="pin${onCls}" data-bid="${b.id}" data-pin="${pin}" data-dir="in" cx="${p.x}" cy="${p.y}" r="5"/>`;
        s += `<text class="pin-lbl" x="${p.x + 9}" y="${p.y + 3}">${pin}</text>`;
      });
      d.outs.forEach((pin, i) => {
        const p = pinPos(b, 'out', i);
        const v = b._out ? b._out[pin] : undefined;
        const onCls = running && typeof v === 'boolean' && v ? ' on' : '';
        const srcCls = this.wireFrom && this.wireFrom.bid === b.id && this.wireFrom.pin === pin ? ' src' : '';
        s += `<circle class="pin${onCls}${srcCls}" data-bid="${b.id}" data-pin="${pin}" data-dir="out" cx="${p.x}" cy="${p.y}" r="5"/>`;
        s += `<text class="pin-lbl" x="${p.x - 9}" y="${p.y + 3}" text-anchor="end">${pin}</text>`;
        if (running && typeof v === 'number') s += `<text class="pin-val" x="${p.x + 9}" y="${p.y + 3}">${fmt(v)}</text>`;
      });
    }
    s += '</svg>';
    this.svgHost.innerHTML = s;
  },

  save() {
    return {
      blocks: this.doc.blocks.map(({ _inst, _out, ...b }) => b),
      conns: this.doc.conns,
      nextId: this.doc.nextId,
    };
  },

  load(d) {
    if (!d || !Array.isArray(d.blocks)) { this.doc = emptyDoc(); }
    else {
      this.doc = {
        blocks: d.blocks.filter(b => DEFS[b.type]).map(b => ({ params: {}, ...b })),
        conns: (d.conns || []).map(cn => ({ ...cn })),
        nextId: d.nextId || 1,
      };
    }
    this.sel = null;
    this.wireFrom = null;
    this.render();
  },

  example() { this.load(PLC.EXAMPLES.fbd); UI.docChanged(); },
};

// live input-pin value (for colouring only)
function pinValLive(doc, b, pin) {
  for (const cn of doc.conns) {
    if (cn.to[0] === b.id && cn.to[1] === pin) {
      const sb = doc.blocks.find(x => x.id === cn.from[0]);
      return sb && sb._out ? sb._out[cn.from[1]] : undefined;
    }
  }
  return undefined;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

PLC.registerModule(FBD);

})();
