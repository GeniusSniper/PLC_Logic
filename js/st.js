'use strict';

/* ============================================================
   Structured Text (ST) — tokenizer, parser, interpreter.
   Also provides expression / statement compilation for SFC.
   ============================================================ */

(function () {

const B = PLC.bool, N = PLC.num, OPS = PLC.ops;

const KEYWORDS = new Set(('IF THEN ELSIF ELSE END_IF CASE OF END_CASE FOR TO BY DO END_FOR ' +
  'WHILE END_WHILE REPEAT UNTIL END_REPEAT VAR VAR_INPUT VAR_OUTPUT VAR_GLOBAL END_VAR ' +
  'AND OR XOR NOT MOD TRUE FALSE EXIT RETURN').split(' '));

const EXIT_SIG = { sig: 'EXIT' };
const RET_SIG  = { sig: 'RETURN' };

/* ---------------- time literals: T#1m30s, T#500ms, T#2.5s ---------------- */
function parseTimeLiteral(s) {
  const clean = s.replace(/_/g, '');
  if (/^\d+(\.\d+)?$/.test(clean)) return parseFloat(clean);   // bare number = ms
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;
  let ms = 0, consumed = 0, m;
  while ((m = re.exec(clean))) {
    const v = parseFloat(m[1]);
    ms += v * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 })[m[2].toLowerCase()];
    consumed += m[0].length;
  }
  if (consumed !== clean.length) throw new Error(`Invalid time literal 'T#${s}'`);
  return ms;
}

/* ---------------- tokenizer ---------------- */
const SYMS2 = [':=', '<=', '>=', '<>', '..', '**'];
const SYMS1 = '+-*/()=<>;,:.&[]';

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const lineOf = pos => src.slice(0, pos).split('\n').length;

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '(' && src[i + 1] === '*') {
      const e = src.indexOf('*)', i + 2);
      if (e < 0) throw new Error(`Unterminated comment (* ... near line ${lineOf(i)}`);
      i = e + 2; continue;
    }
    // numbers (incl. based literals 16#FF, 2#1010)
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '#') {
        const base = parseInt(src.slice(i, j), 10);
        j++;
        let k = j;
        while (k < n && /[0-9A-Fa-f_]/.test(src[k])) k++;
        const digits = src.slice(j, k).replace(/_/g, '');
        const v = parseInt(digits, base);
        if (!digits || isNaN(v)) throw new Error(`Invalid based literal near line ${lineOf(i)}`);
        toks.push({ t: 'num', v, line: lineOf(i) });
        i = k; continue;
      }
      if (src[j] === '.' && /[0-9]/.test(src[j + 1])) {   // not '..' range
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k])) { k++; while (k < n && /[0-9]/.test(src[k])) k++; j = k; }
      }
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)), line: lineOf(i) });
      i = j; continue;
    }
    // identifiers / keywords / typed literals
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const up = word.toUpperCase();
      if (src[j] === '#') {
        if (up === 'T' || up === 'TIME') {
          j++;
          let k = j;
          while (k < n && /[A-Za-z0-9_.]/.test(src[k])) k++;
          toks.push({ t: 'time', v: parseTimeLiteral(src.slice(j, k)), line: lineOf(i) });
          i = k; continue;
        }
        throw new Error(`Unsupported typed literal '${word}#' near line ${lineOf(i)}`);
      }
      toks.push(KEYWORDS.has(up) ? { t: up, v: word, line: lineOf(i) }
                                 : { t: 'id', v: word, line: lineOf(i) });
      i = j; continue;
    }
    // symbols
    const two = src.substr(i, 2);
    if (SYMS2.includes(two)) { toks.push({ t: two, v: two, line: lineOf(i) }); i += 2; continue; }
    if (SYMS1.includes(c)) { toks.push({ t: c, v: c, line: lineOf(i) }); i++; continue; }
    throw new Error(`Unexpected character '${c}' at line ${lineOf(i)}`);
  }
  return toks;
}

/* ---------------- parser ---------------- */

const STARTERS = new Set(['IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'EXIT', 'RETURN', 'id', ';']);

const BUILTINS = {
  ABS:   a => Math.abs(N(a[0])),
  SQRT:  a => Math.sqrt(N(a[0])),
  MIN:   a => Math.min(...a.map(N)),
  MAX:   a => Math.max(...a.map(N)),
  LIMIT: a => Math.min(Math.max(N(a[1]), N(a[0])), N(a[2])),   // LIMIT(MN, IN, MX)
  SEL:   a => B(a[0]) ? a[2] : a[1],                            // SEL(G, IN0, IN1)
  TRUNC: a => Math.trunc(N(a[0])),
  ROUND: a => Math.round(N(a[0])),
};

class Parser {
  constructor(toks) { this.toks = toks; this.p = 0; }
  peek(k) { return this.toks[this.p + (k || 0)] || { t: 'eof', v: 'end of program' }; }
  next() { return this.toks[this.p++] || { t: 'eof', v: 'end of program' }; }
  accept(t) { return this.peek().t === t ? this.next() : null; }
  expect(t, what) {
    const tk = this.next();
    if (tk.t !== t) this.err(`Expected ${what || `'${t}'`} but found '${tk.v}'`, tk);
    return tk;
  }
  err(msg, tk) {
    tk = tk || this.peek();
    throw new Error(msg + (tk.line ? ` (line ${tk.line})` : ''));
  }

  /* ----- declarations ----- */
  parseVarBlocks() {
    const decls = [];
    while (['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_GLOBAL'].includes(this.peek().t)) {
      this.next();
      while (this.peek().t === 'id') {
        const names = [this.next().v];
        while (this.accept(',')) names.push(this.expect('id', 'variable name').v);
        this.expect(':');
        const typeTok = this.next();
        if (typeTok.t !== 'id') this.err(`Expected a type name but found '${typeTok.v}'`, typeTok);
        let init;
        if (this.accept(':=')) {
          const e = this.parseExpr();
          init = e({ dt: 0, ops: 0 });
        }
        this.expect(';');
        decls.push({ names, type: typeTok.v, init });
      }
      this.expect('END_VAR');
      this.accept(';');
    }
    return decls;
  }

  /* ----- statements ----- */
  parseStatements(stops, soft) {
    const list = [];
    for (;;) {
      const t = this.peek().t;
      if (t === 'eof' || (stops && stops.has(t))) break;
      if (!STARTERS.has(t)) {
        if (soft) break;
        this.err(`Unexpected '${this.peek().v}'`);
      }
      const s = this.parseStatement();
      if (s) list.push(s);
    }
    return ctx => { for (const s of list) s(ctx); };
  }

  parseStatement() {
    const tk = this.peek();
    switch (tk.t) {
      case ';': this.next(); return null;
      case 'IF': return this.parseIf();
      case 'CASE': return this.parseCase();
      case 'FOR': return this.parseFor();
      case 'WHILE': return this.parseWhile();
      case 'REPEAT': return this.parseRepeat();
      case 'EXIT': this.next(); this.accept(';'); return () => { throw EXIT_SIG; };
      case 'RETURN': this.next(); this.accept(';'); return () => { throw RET_SIG; };
      case 'id': return this.parseAssignOrCall();
      default: this.err(`Unexpected '${tk.v}'`);
    }
  }

  parseAssignOrCall() {
    const nameTok = this.expect('id');
    const name = nameTok.v;
    // FB invocation: inst(IN := x, PT := T#1s);
    if (this.peek().t === '(') {
      this.next();
      const argExprs = {};
      if (this.peek().t !== ')') {
        do {
          const pn = this.expect('id', 'parameter name').v.toUpperCase();
          this.expect(':=');
          argExprs[pn] = this.parseExpr();
        } while (this.accept(','));
      }
      this.expect(')');
      this.expect(';');
      return ctx => {
        const inst = PLC.fbs.get(PLC.U(name));
        if (!inst) throw new Error(`'${name}' is not a declared function block instance — declare it in a VAR block, e.g.  ${name} : TON;`);
        const a = {};
        for (const k in argExprs) a[k] = argExprs[k](ctx);
        inst.invoke(a, ctx.dt);
      };
    }
    // assignment: var := expr;  or  inst.member := expr;
    let member = null;
    if (this.accept('.')) member = this.expect('id', 'member name').v;
    this.expect(':=', "':='");
    const rhs = this.parseExpr();
    this.expect(';');
    if (member) return ctx => PLC.writeMember(name, member, rhs(ctx));
    return ctx => PLC.writeVar(name, rhs(ctx));
  }

  parseIf() {
    this.expect('IF');
    const branches = [];
    const stops = new Set(['ELSIF', 'ELSE', 'END_IF']);
    let cond = this.parseExpr();
    this.expect('THEN');
    branches.push({ cond, body: this.parseStatements(stops) });
    while (this.accept('ELSIF')) {
      cond = this.parseExpr();
      this.expect('THEN');
      branches.push({ cond, body: this.parseStatements(stops) });
    }
    let elseBody = null;
    if (this.accept('ELSE')) elseBody = this.parseStatements(new Set(['END_IF']));
    this.expect('END_IF');
    this.accept(';');
    return ctx => {
      for (const b of branches) if (B(b.cond(ctx))) { b.body(ctx); return; }
      if (elseBody) elseBody(ctx);
    };
  }

  parseCase() {
    this.expect('CASE');
    const sel = this.parseExpr();
    this.expect('OF');
    const entries = [];
    let elseBody = null;
    const stops = new Set(['ELSE', 'END_CASE']);
    for (;;) {
      const t = this.peek().t;
      if (t === 'ELSE' || t === 'END_CASE' || t === 'eof') break;
      const matchers = [];
      do {
        const lo = this.parseExpr();
        if (this.accept('..')) {
          const hi = this.parseExpr();
          matchers.push({ lo, hi });
        } else {
          matchers.push({ lo });
        }
      } while (this.accept(','));
      this.expect(':');
      const body = this.parseStatements(stops, true);
      entries.push({ matchers, body });
    }
    if (this.accept('ELSE')) elseBody = this.parseStatements(new Set(['END_CASE']));
    this.expect('END_CASE');
    this.accept(';');
    return ctx => {
      const v = N(sel(ctx));
      for (const e of entries) {
        for (const m of e.matchers) {
          const lo = N(m.lo(ctx));
          if (m.hi ? (v >= lo && v <= N(m.hi(ctx))) : v === lo) { e.body(ctx); return; }
        }
      }
      if (elseBody) elseBody(ctx);
    };
  }

  parseFor() {
    this.expect('FOR');
    const name = this.expect('id', 'loop variable').v;
    this.expect(':=');
    const from = this.parseExpr();
    this.expect('TO');
    const to = this.parseExpr();
    let by = null;
    if (this.accept('BY')) by = this.parseExpr();
    this.expect('DO');
    const body = this.parseStatements(new Set(['END_FOR']));
    this.expect('END_FOR');
    this.accept(';');
    return ctx => {
      const step = by ? N(by(ctx)) : 1;
      if (step === 0) throw new Error('FOR loop BY step must not be 0');
      const end = N(to(ctx));
      try {
        for (let i = N(from(ctx)); step > 0 ? i <= end : i >= end; i += step) {
          guard(ctx);
          PLC.writeVar(name, i);
          body(ctx);
        }
      } catch (e) { if (e !== EXIT_SIG) throw e; }
    };
  }

  parseWhile() {
    this.expect('WHILE');
    const cond = this.parseExpr();
    this.expect('DO');
    const body = this.parseStatements(new Set(['END_WHILE']));
    this.expect('END_WHILE');
    this.accept(';');
    return ctx => {
      try {
        while (B(cond(ctx))) { guard(ctx); body(ctx); }
      } catch (e) { if (e !== EXIT_SIG) throw e; }
    };
  }

  parseRepeat() {
    this.expect('REPEAT');
    const body = this.parseStatements(new Set(['UNTIL']));
    this.expect('UNTIL');
    const cond = this.parseExpr();
    this.expect('END_REPEAT');
    this.accept(';');
    return ctx => {
      try {
        do { guard(ctx); body(ctx); } while (!B(cond(ctx)));
      } catch (e) { if (e !== EXIT_SIG) throw e; }
    };
  }

  /* ----- expressions (precedence climbing) ----- */
  parseExpr() { return this.parseOr(); }

  parseOr() {
    let a = this.parseXor();
    while (this.accept('OR')) { const b = this.parseXor(); const l = a; a = ctx => OPS.OR(l(ctx), b(ctx)); }
    return a;
  }
  parseXor() {
    let a = this.parseAnd();
    while (this.accept('XOR')) { const b = this.parseAnd(); const l = a; a = ctx => OPS.XOR(l(ctx), b(ctx)); }
    return a;
  }
  parseAnd() {
    let a = this.parseCmp();
    while (this.peek().t === 'AND' || this.peek().t === '&') {
      this.next();
      const b = this.parseCmp(); const l = a;
      a = ctx => OPS.AND(l(ctx), b(ctx));
    }
    return a;
  }
  parseCmp() {
    let a = this.parseAdd();
    const map = { '=': 'EQ', '<>': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE' };
    for (;;) {
      const t = this.peek().t;
      if (!(t in map)) break;
      this.next();
      const b = this.parseAdd(); const l = a; const op = map[t];
      a = ctx => OPS[op](l(ctx), b(ctx));
    }
    return a;
  }
  parseAdd() {
    let a = this.parseMul();
    for (;;) {
      const t = this.peek().t;
      if (t !== '+' && t !== '-') break;
      this.next();
      const b = this.parseMul(); const l = a; const op = t === '+' ? 'ADD' : 'SUB';
      a = ctx => OPS[op](l(ctx), b(ctx));
    }
    return a;
  }
  parseMul() {
    let a = this.parsePow();
    for (;;) {
      const t = this.peek().t;
      if (t !== '*' && t !== '/' && t !== 'MOD') break;
      this.next();
      const b = this.parsePow(); const l = a;
      const op = t === '*' ? 'MUL' : t === '/' ? 'DIV' : 'MOD';
      a = ctx => OPS[op](l(ctx), b(ctx));
    }
    return a;
  }
  parsePow() {
    const a = this.parseUnary();
    if (this.accept('**')) {
      const b = this.parsePow();
      return ctx => Math.pow(N(a(ctx)), N(b(ctx)));
    }
    return a;
  }
  parseUnary() {
    if (this.accept('NOT')) { const e = this.parseUnary(); return ctx => OPS.NOT(e(ctx)); }
    if (this.accept('-')) { const e = this.parseUnary(); return ctx => -N(e(ctx)); }
    if (this.accept('+')) return this.parseUnary();
    return this.parsePrimary();
  }
  parsePrimary() {
    const tk = this.next();
    switch (tk.t) {
      case 'num': case 'time': { const v = tk.v; return () => v; }
      case 'TRUE': return () => true;
      case 'FALSE': return () => false;
      case '(': {
        const e = this.parseExpr();
        this.expect(')');
        return e;
      }
      case 'id': {
        const name = tk.v;
        if (this.peek().t === '(') {   // built-in function
          const fn = BUILTINS[name.toUpperCase()];
          if (!fn) this.err(`Unknown function '${name}'`, tk);
          this.next();
          const args = [];
          if (this.peek().t !== ')') {
            do { args.push(this.parseExpr()); } while (this.accept(','));
          }
          this.expect(')');
          return ctx => fn(args.map(a => a(ctx)));
        }
        if (this.accept('.')) {
          const member = this.expect('id', 'member name').v;
          return () => PLC.readMember(name, member);
        }
        return () => PLC.readVar(name);
      }
      default:
        this.err(`Unexpected '${tk.v}' in expression`, tk);
    }
  }
}

function guard(ctx) {
  if (++ctx.ops > 200000) throw new Error('Execution limit exceeded — possible infinite loop');
}

function applyDecls(decls) {
  for (const d of decls) {
    for (const name of d.names) {
      if (PLC.isFBType(d.type)) {
        PLC.getFB(name, d.type);
      } else {
        const t = d.type.toUpperCase();
        const def = d.init !== undefined ? d.init : (t === 'BOOL' ? false : 0);
        PLC.defineVar(name, undefined, def);
      }
    }
  }
}

/* ---------------- public API ---------------- */

PLC.ST = {
  compile(src) {
    const p = new Parser(tokenize(src));
    const decls = p.parseVarBlocks();
    const body = p.parseStatements(null);
    if (p.peek().t !== 'eof') p.err(`Unexpected '${p.peek().v}'`);
    applyDecls(decls);
    return {
      scan(dt) {
        const ctx = { dt, ops: 0 };
        try { body(ctx); } catch (e) { if (e !== RET_SIG) throw e; }
      },
    };
  },

  // A bare expression, e.g. an SFC transition condition. Returns fn(ctx) -> value.
  compileExpr(src) {
    const p = new Parser(tokenize(src));
    const e = p.parseExpr();
    if (p.peek().t !== 'eof') p.err(`Unexpected '${p.peek().v}' after expression`);
    return e;
  },

  // A statement list, e.g. SFC step actions. Returns fn(ctx).
  compileStmts(src) {
    const p = new Parser(tokenize(src));
    const decls = p.parseVarBlocks();
    const body = p.parseStatements(null);
    if (p.peek().t !== 'eof') p.err(`Unexpected '${p.peek().v}'`);
    applyDecls(decls);
    return ctx => { try { body(ctx); } catch (e) { if (e !== RET_SIG) throw e; } };
  },

  parseTimeLiteral,
};

/* ---------------- syntax highlighting ---------------- */

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ST_KW_RE = 'IF|THEN|ELSIF|ELSE|END_IF|CASE|OF|END_CASE|FOR|TO|BY|DO|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|VAR_INPUT|VAR_OUTPUT|VAR_GLOBAL|VAR|END_VAR|AND|OR|XOR|NOT|MOD|TRUE|FALSE|EXIT|RETURN|BOOL|INT|DINT|REAL|TIME|TON|TOF|TP|CTU|CTD|CTUD|SR|RS|R_TRIG|F_TRIG';

PLC.ST.highlight = function (src) {
  const re = new RegExp(
    '(\\(\\*[\\s\\S]*?(?:\\*\\)|$)|//[^\\n]*)' +               // 1 comment
    '|((?:T|TIME)#[\\w.]+|\\b\\d+#[0-9A-Fa-f_]+|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)' + // 2 literal
    `|\\b(${ST_KW_RE})\\b` +                                    // 3 keyword
    '|(:=|<=|>=|<>|\\*\\*|[+\\-*/=<>&])',                       // 4 operator
    'gi');
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? 'tok-com' : m[2] ? 'tok-num' : m[3] ? 'tok-kw' : 'tok-op';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
};

/* ---------------- ST editor module ---------------- */

const ST_MOD = {
  id: 'st',
  title: 'Structured Text',
  editor: null,

  init(pane) {
    pane.innerHTML = `
      <div class="ed-toolbar">
        <span style="font-weight:700">Structured Text</span>
        <span class="ed-hint">IF / CASE / FOR / WHILE / REPEAT · timers &amp; counters via VAR blocks · T#1s500ms time literals</span>
      </div>
      <div class="code-host" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
    this.editor = UI.codeEditor(pane.querySelector('.code-host'), {
      value: '',
      highlight: PLC.ST.highlight,
      onChange: () => UI.docChanged(),
    });
  },

  compile() { return PLC.ST.compile(this.editor.value); },
  renderLive() {},
  save() { return this.editor.value; },
  load(v) { this.editor.value = typeof v === 'string' ? v : ''; },
  example() { this.editor.value = PLC.EXAMPLES.st; UI.docChanged(); },
};

PLC.registerModule(ST_MOD);

})();
