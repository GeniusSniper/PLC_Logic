'use strict';

/* ============================================================
   PLC Logic Studio — core runtime
   Variables, IEC 61131-3 standard function blocks, scan engine
   ============================================================ */

const PLC = window.PLC = {};

PLC.U = s => String(s).trim().toUpperCase();
PLC.bool = v => (v === undefined || v === null) ? false : (typeof v === 'number' ? v !== 0 : !!v);
PLC.num = v => typeof v === 'boolean' ? (v ? 1 : 0)
             : typeof v === 'number' ? v
             : (v === undefined || v === null) ? 0 : (Number(v) || 0);

const B = PLC.bool, N = PLC.num;

/* Shared operator semantics: logic ops are boolean when either side is
   boolean, bitwise on integers otherwise; comparisons are numeric. */
PLC.ops = {
  AND: (a, b) => (typeof a === 'boolean' || typeof b === 'boolean') ? (B(a) && B(b)) : ((N(a) | 0) & (N(b) | 0)),
  OR:  (a, b) => (typeof a === 'boolean' || typeof b === 'boolean') ? (B(a) || B(b)) : ((N(a) | 0) | (N(b) | 0)),
  XOR: (a, b) => (typeof a === 'boolean' || typeof b === 'boolean') ? (B(a) !== B(b)) : ((N(a) | 0) ^ (N(b) | 0)),
  NOT: a => typeof a === 'boolean' ? !a : (~(N(a) | 0)),
  ADD: (a, b) => N(a) + N(b),
  SUB: (a, b) => N(a) - N(b),
  MUL: (a, b) => N(a) * N(b),
  DIV: (a, b) => { const d = N(b); if (d === 0) throw new Error('Division by zero'); return N(a) / d; },
  MOD: (a, b) => { const d = N(b); if (d === 0) throw new Error('Division by zero (MOD)'); return N(a) % d; },
  GT: (a, b) => N(a) >  N(b),
  GE: (a, b) => N(a) >= N(b),
  EQ: (a, b) => N(a) === N(b),
  NE: (a, b) => N(a) !== N(b),
  LE: (a, b) => N(a) <= N(b),
  LT: (a, b) => N(a) <  N(b),
};

/* ---------------- Variables ---------------- */

PLC.vars = new Map();   // UPPER name -> {name, kind, init, value}
PLC.fbs  = new Map();   // UPPER name -> function block instance
PLC.varsDirty = true;   // tells the UI to rebuild its tables

PLC.defineVar = function (name, kind, init) {
  const key = PLC.U(name);
  if (!key || !/^[A-Z_][A-Z0-9_.]*$/i.test(key)) throw new Error(`Invalid variable name '${name}'`);
  let v = PLC.vars.get(key);
  if (v) {
    if (kind) v.kind = kind;
    if (init !== undefined) v.init = init;
    return v;
  }
  if (init === undefined) init = false;
  v = { name: String(name).trim(), kind: kind || 'memory', init, value: init };
  PLC.vars.set(key, v);
  PLC.varsDirty = true;
  return v;
};

PLC.deleteVar = function (name) {
  PLC.vars.delete(PLC.U(name));
  PLC.varsDirty = true;
};

PLC.readVar = function (name) {
  const key = PLC.U(name);
  let v = PLC.vars.get(key);
  if (!v) v = PLC.defineVar(name, 'memory', false);   // typos surface in the variable table
  return v.value;
};

PLC.writeVar = function (name, val) {
  const key = PLC.U(name);
  let v = PLC.vars.get(key);
  if (!v) v = PLC.defineVar(name, 'memory', typeof val === 'boolean' ? false : 0);
  v.value = val;
};

PLC.readMember = function (base, m) {
  const fb = PLC.fbs.get(PLC.U(base));
  if (!fb) throw new Error(`'${base}' is not a function block instance`);
  const mm = PLC.U(m);
  if (!(mm in fb)) throw new Error(`'${base}' (${fb.TYPE}) has no member '${m}'`);
  return fb[mm];
};

PLC.writeMember = function (base, m, val) {
  const fb = PLC.fbs.get(PLC.U(base));
  if (!fb) throw new Error(`'${base}' is not a function block instance`);
  const mm = PLC.U(m);
  if (!(mm in fb)) throw new Error(`'${base}' (${fb.TYPE}) has no member '${m}'`);
  fb[mm] = val;
};

PLC.resetState = function () {
  PLC.vars.forEach(v => { v.value = v.init; });
  PLC.fbs.forEach(fb => fb.reset && fb.reset());
  PLC.varsDirty = true;
};

PLC.initDefaults = function () {
  for (let i = 0; i < 8; i++) PLC.defineVar('I' + i, 'input', false);
  for (let i = 0; i < 8; i++) PLC.defineVar('Q' + i, 'output', false);
  for (let i = 0; i < 8; i++) PLC.defineVar('M' + i, 'memory', false);
  for (let i = 0; i < 2; i++) PLC.defineVar('AI' + i, 'input', 0);
  for (let i = 0; i < 2; i++) PLC.defineVar('AQ' + i, 'output', 0);
};

/* ---------------- Standard function blocks ---------------- */

class FBase {
  constructor(name, type) { this.name = name; this.TYPE = type; }
  reset() {}
  info() { return ''; }
}

class TON extends FBase {
  constructor(n) { super(n, 'TON'); this.IN = false; this.PT = 1000; this.ET = 0; this.Q = false; }
  reset() { this.IN = false; this.ET = 0; this.Q = false; }
  invoke(a, dt) {
    if ('PT' in a) this.PT = N(a.PT);
    if ('IN' in a) this.IN = B(a.IN);
    if (!this.IN) { this.ET = 0; this.Q = false; }
    else { this.ET = Math.min(this.ET + dt, this.PT); this.Q = this.ET >= this.PT; }
    return this.Q;
  }
  info() { return `IN=${this.IN ? 1 : 0} ET=${Math.round(this.ET)}/${this.PT}ms Q=${this.Q ? 1 : 0}`; }
}

class TOF extends FBase {
  constructor(n) { super(n, 'TOF'); this.IN = false; this.PT = 1000; this.ET = 0; this.Q = false; }
  reset() { this.IN = false; this.ET = 0; this.Q = false; }
  invoke(a, dt) {
    if ('PT' in a) this.PT = N(a.PT);
    if ('IN' in a) this.IN = B(a.IN);
    if (this.IN) { this.Q = true; this.ET = 0; }
    else if (this.Q) {
      this.ET = Math.min(this.ET + dt, this.PT);
      if (this.ET >= this.PT) this.Q = false;
    }
    return this.Q;
  }
  info() { return `IN=${this.IN ? 1 : 0} ET=${Math.round(this.ET)}/${this.PT}ms Q=${this.Q ? 1 : 0}`; }
}

class TP extends FBase {
  constructor(n) { super(n, 'TP'); this.IN = false; this.PT = 1000; this.ET = 0; this.Q = false; this._run = false; this._prev = false; }
  reset() { this.IN = false; this.ET = 0; this.Q = false; this._run = false; this._prev = false; }
  invoke(a, dt) {
    if ('PT' in a) this.PT = N(a.PT);
    if ('IN' in a) this.IN = B(a.IN);
    if (this._run) {
      this.ET = Math.min(this.ET + dt, this.PT);
      if (this.ET >= this.PT) { this.Q = false; if (!this.IN) this._run = false; }
    } else if (this.IN && !this._prev) {
      this._run = true; this.ET = 0; this.Q = true;
    } else if (!this.IN) {
      this.ET = 0;
    }
    this._prev = this.IN;
    return this.Q;
  }
  info() { return `IN=${this.IN ? 1 : 0} ET=${Math.round(this.ET)}/${this.PT}ms Q=${this.Q ? 1 : 0}`; }
}

class CTU extends FBase {
  constructor(n) { super(n, 'CTU'); this.CU = false; this.R = false; this.PV = 1; this.CV = 0; this.Q = false; this._prev = false; }
  reset() { this.CU = false; this.R = false; this.CV = 0; this.Q = false; this._prev = false; }
  invoke(a) {
    if ('PV' in a) this.PV = N(a.PV);
    if ('CU' in a) this.CU = B(a.CU);
    if ('R'  in a) this.R  = B(a.R);
    if (this.R) this.CV = 0;
    else if (this.CU && !this._prev) this.CV++;
    this._prev = this.CU;
    this.Q = this.CV >= this.PV;
    return this.Q;
  }
  info() { return `CV=${this.CV}/${this.PV} Q=${this.Q ? 1 : 0}`; }
}

class CTD extends FBase {
  constructor(n) { super(n, 'CTD'); this.CD = false; this.LD = false; this.PV = 1; this.CV = 0; this.Q = true; this._prev = false; }
  reset() { this.CD = false; this.LD = false; this.CV = 0; this.Q = this.CV <= 0; this._prev = false; }
  invoke(a) {
    if ('PV' in a) this.PV = N(a.PV);
    if ('CD' in a) this.CD = B(a.CD);
    if ('LD' in a) this.LD = B(a.LD);
    if (this.LD) this.CV = this.PV;
    else if (this.CD && !this._prev && this.CV > 0) this.CV--;
    this._prev = this.CD;
    this.Q = this.CV <= 0;
    return this.Q;
  }
  info() { return `CV=${this.CV} (PV=${this.PV}) Q=${this.Q ? 1 : 0}`; }
}

class CTUD extends FBase {
  constructor(n) { super(n, 'CTUD'); this.CU = false; this.CD = false; this.R = false; this.LD = false; this.PV = 1; this.CV = 0; this.QU = false; this.QD = true; this.Q = false; this._pu = false; this._pd = false; }
  reset() { this.CU = this.CD = this.R = this.LD = false; this.CV = 0; this.QU = false; this.QD = true; this.Q = false; this._pu = this._pd = false; }
  invoke(a) {
    if ('PV' in a) this.PV = N(a.PV);
    if ('CU' in a) this.CU = B(a.CU);
    if ('CD' in a) this.CD = B(a.CD);
    if ('R'  in a) this.R  = B(a.R);
    if ('LD' in a) this.LD = B(a.LD);
    if (this.R) this.CV = 0;
    else if (this.LD) this.CV = this.PV;
    else {
      if (this.CU && !this._pu) this.CV++;
      if (this.CD && !this._pd) this.CV--;
    }
    this._pu = this.CU; this._pd = this.CD;
    this.QU = this.CV >= this.PV; this.QD = this.CV <= 0; this.Q = this.QU;
    return this.Q;
  }
  info() { return `CV=${this.CV}/${this.PV} QU=${this.QU ? 1 : 0} QD=${this.QD ? 1 : 0}`; }
}

class SR extends FBase {
  constructor(n) { super(n, 'SR'); this.S1 = false; this.R = false; this.Q = false; }
  reset() { this.S1 = false; this.R = false; this.Q = false; }
  invoke(a) {
    if ('S1' in a) this.S1 = B(a.S1);
    if ('R'  in a) this.R  = B(a.R);
    this.Q = this.S1 || (this.Q && !this.R);
    return this.Q;
  }
  info() { return `Q=${this.Q ? 1 : 0}`; }
}

class RS extends FBase {
  constructor(n) { super(n, 'RS'); this.S = false; this.R1 = false; this.Q = false; }
  reset() { this.S = false; this.R1 = false; this.Q = false; }
  invoke(a) {
    if ('S'  in a) this.S  = B(a.S);
    if ('R1' in a) this.R1 = B(a.R1);
    this.Q = !this.R1 && (this.Q || this.S);
    return this.Q;
  }
  info() { return `Q=${this.Q ? 1 : 0}`; }
}

class R_TRIG extends FBase {
  constructor(n) { super(n, 'R_TRIG'); this.CLK = false; this.Q = false; this._prev = false; }
  reset() { this.CLK = false; this.Q = false; this._prev = false; }
  invoke(a) {
    if ('CLK' in a) this.CLK = B(a.CLK);
    this.Q = this.CLK && !this._prev;
    this._prev = this.CLK;
    return this.Q;
  }
  info() { return `Q=${this.Q ? 1 : 0}`; }
}

class F_TRIG extends FBase {
  constructor(n) { super(n, 'F_TRIG'); this.CLK = false; this.Q = false; this._prev = false; }
  reset() { this.CLK = false; this.Q = false; this._prev = false; }
  invoke(a) {
    if ('CLK' in a) this.CLK = B(a.CLK);
    this.Q = !this.CLK && this._prev;
    this._prev = this.CLK;
    return this.Q;
  }
  info() { return `Q=${this.Q ? 1 : 0}`; }
}

PLC.FBTypes = { TON, TOF, TP, CTU, CTD, CTUD, SR, RS, R_TRIG, F_TRIG };
PLC.isFBType = t => Object.prototype.hasOwnProperty.call(PLC.FBTypes, PLC.U(t));

PLC.getFB = function (name, type) {
  const key = PLC.U(name), t = PLC.U(type);
  const Cls = PLC.FBTypes[t];
  if (!Cls) throw new Error(`Unknown function block type '${type}'`);
  let fb = PLC.fbs.get(key);
  if (fb && fb.TYPE === t) return fb;
  fb = new Cls(String(name).trim());
  PLC.fbs.set(key, fb);
  PLC.varsDirty = true;
  return fb;
};

/* ---------------- Language modules & scan engine ---------------- */

PLC.modules = {};
PLC.registerModule = m => { PLC.modules[m.id] = m; };

PLC.engine = {
  running: false,
  lang: null,
  program: null,
  scanMs: 50,
  execMs: 0,
  scanCount: 0,
  _timer: null,
  _last: 0,

  start(lang) {
    if (this.running) this.stop();
    const mod = PLC.modules[lang];
    if (!mod) return false;
    let prog;
    try {
      prog = mod.compile();
    } catch (e) {
      UI.status('Compile error: ' + e.message, true);
      return false;
    }
    this.program = prog;
    this.lang = lang;
    this.running = true;
    this.scanCount = 0;
    this._last = performance.now();
    this._timer = setInterval(() => this.tick(), this.scanMs);
    UI.onRunState(true);
    UI.status(`Running ${mod.title} program — scan cycle ${this.scanMs} ms.`);
    return true;
  },

  tick() {
    const now = performance.now();
    const dt = Math.min(500, now - this._last);   // clamp after tab-sleep
    this._last = now;
    const t0 = performance.now();
    try {
      this.program.scan(dt);
    } catch (e) {
      this.stop();
      UI.status('Runtime error: ' + e.message, true);
      return;
    }
    this.execMs = performance.now() - t0;
    this.scanCount++;
    UI.afterScan();
  },

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (!this.running) return;
    this.running = false;
    const mod = PLC.modules[this.lang];
    if (mod && mod.onStop) mod.onStop();
    UI.onRunState(false);
    UI.status('Stopped.');
  },

  reset() {
    this.stop();
    PLC.resetState();
    Object.values(PLC.modules).forEach(m => m.onReset && m.onReset());
    UI.refreshAll();
    UI.status('Reset — variables and function blocks returned to initial values.');
  },
};
