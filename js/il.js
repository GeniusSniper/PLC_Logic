'use strict';

/* ============================================================
   Instruction List (IL) — accumulator-based interpreter.
   LD/LDN ST/STN S R AND/OR/XOR(+N) NOT ADD SUB MUL DIV MOD
   GT GE EQ NE LE LT JMP/JMPC/JMPCN CAL/CALC/CALCN RET/RETC
   Parenthesised deferred operators:  AND( ... )
   ============================================================ */

(function () {

const B = PLC.bool, N = PLC.num, OPS = PLC.ops;

const BIN = { AND: 1, OR: 1, XOR: 1, ADD: 1, SUB: 1, MUL: 1, DIV: 1, MOD: 1, GT: 1, GE: 1, EQ: 1, NE: 1, LE: 1, LT: 1 };

/* operand -> {load(), store(v)} */
function makeOperand(str, lineNo) {
  const s = str.trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (up === 'TRUE') return { load: () => true };
  if (up === 'FALSE') return { load: () => false };
  if (/^(T|TIME)#/i.test(s)) {
    const v = PLC.ST.parseTimeLiteral(s.replace(/^(T|TIME)#/i, ''));
    return { load: () => v };
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const v = parseFloat(s);
    return { load: () => v };
  }
  if (/^\d+#[0-9A-Fa-f_]+$/.test(s)) {
    const [base, digits] = s.split('#');
    const v = parseInt(digits.replace(/_/g, ''), parseInt(base, 10));
    return { load: () => v };
  }
  const m = s.match(/^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/);
  if (!m) throw new Error(`Line ${lineNo}: invalid operand '${s}'`);
  const name = m[1], member = m[2];
  if (member) return {
    load: () => PLC.readMember(name, member),
    store: v => PLC.writeMember(name, member, v),
    name,
  };
  return {
    load: () => PLC.readVar(name),
    store: v => PLC.writeVar(name, v),
    name,
  };
}

function parseVarDecls(lines) {
  // returns instructions-only lines; applies declarations directly
  const out = [];
  let inVar = false;
  for (const { text, no } of lines) {
    const up = text.toUpperCase();
    if (/^VAR(_INPUT|_OUTPUT|_GLOBAL)?$/.test(up)) { inVar = true; continue; }
    if (up === 'END_VAR') { inVar = false; continue; }
    if (!inVar) { out.push({ text, no }); continue; }
    const m = text.match(/^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([A-Za-z_]\w*)\s*(?::=\s*(.+?))?\s*;?$/);
    if (!m) throw new Error(`Line ${no}: invalid declaration '${text}'`);
    const names = m[1].split(',').map(x => x.trim());
    const type = m[2];
    for (const name of names) {
      if (PLC.isFBType(type)) PLC.getFB(name, type);
      else {
        let init = type.toUpperCase() === 'BOOL' ? false : 0;
        if (m[3]) {
          const op = makeOperand(m[3], no);
          init = op.load();
        }
        PLC.defineVar(name, undefined, init);
      }
    }
  }
  return out;
}

function compile(src) {
  // strip block comments, then split lines and strip line comments
  const noBlocks = src.replace(/\(\*[\s\S]*?\*\)/g, m => m.replace(/[^\n]/g, ' '));
  const rawLines = noBlocks.split('\n').map((l, i) => ({
    text: l.replace(/\/\/.*$/, '').trim(),
    no: i + 1,
  })).filter(l => l.text);

  const body = parseVarDecls(rawLines);

  const instrs = [];
  const labels = {};
  for (const { text, no } of body) {
    let rest = text;
    const lm = rest.match(/^([A-Za-z_]\w*)\s*:\s*(.*)$/);
    if (lm && !/^(T|TIME)#/i.test(rest)) {
      labels[lm[1].toUpperCase()] = instrs.length;
      rest = lm[2].trim();
      if (!rest) continue;
    }
    if (rest === ')') { instrs.push({ op: ')', no }); continue; }
    const m = rest.match(/^([A-Za-z_]+)(\()?\s*(.*)$/);
    if (!m) throw new Error(`Line ${no}: cannot parse '${rest}'`);
    const op = m[1].toUpperCase();
    const paren = !!m[2];
    const operand = m[3] ? makeOperand(m[3].replace(/;$/, ''), no) : null;
    instrs.push({ op, paren, operand, raw: m[3] || '', no });
  }

  function applyBin(op, neg, saved, cur) {
    const v = neg ? OPS.NOT(cur) : cur;
    return OPS[op](saved, v);
  }

  return {
    scan(dt) {
      let pc = 0, CR, count = 0;
      const stack = [];
      const end = instrs.length;
      while (pc < end) {
        if (++count > 100000) throw new Error('Instruction limit exceeded — possible jump loop');
        const ins = instrs[pc++];
        const { op, operand } = ins;
        try {
          if (op === ')') {
            const e = stack.pop();
            if (!e) throw new Error("')' without matching open");
            CR = applyBin(e.op, e.neg, e.CR, CR);
            continue;
          }
          // negated binary / load / store variants
          let base = op, neg = false;
          if (op.length > 1 && op.endsWith('N') && (BIN[op.slice(0, -1)] || ['LD', 'ST'].includes(op.slice(0, -1)))) {
            base = op.slice(0, -1); neg = true;
          }
          if (ins.paren) {
            if (!BIN[base]) throw new Error(`'${op}(' is not a valid deferred operator`);
            stack.push({ op: base, neg, CR });
            CR = operand ? operand.load() : undefined;
            continue;
          }
          switch (base) {
            case 'LD':
              if (!operand) throw new Error('LD requires an operand');
              CR = neg ? OPS.NOT(operand.load()) : operand.load();
              break;
            case 'ST':
              if (!operand || !operand.store) throw new Error('ST requires a writable operand');
              operand.store(neg ? OPS.NOT(CR) : CR);
              break;
            case 'S':
              if (!operand || !operand.store) throw new Error('S requires a writable operand');
              if (B(CR)) operand.store(true);
              break;
            case 'R':
              if (!operand || !operand.store) throw new Error('R requires a writable operand');
              if (B(CR)) operand.store(false);
              break;
            case 'NOT':
              CR = OPS.NOT(CR);
              break;
            case 'AND': case 'OR': case 'XOR':
            case 'ADD': case 'SUB': case 'MUL': case 'DIV': case 'MOD':
            case 'GT': case 'GE': case 'EQ': case 'NE': case 'LE': case 'LT': {
              if (!operand) throw new Error(`${op} requires an operand`);
              CR = applyBin(base, neg, CR, operand.load());
              break;
            }
            case 'JMP': case 'JMPC': case 'JMPCN': {
              const lbl = (ins.raw || '').replace(/;$/, '').trim().toUpperCase();
              if (!(lbl in labels)) throw new Error(`Unknown label '${ins.raw}'`);
              if (base === 'JMP' || (base === 'JMPC' && B(CR)) || (base === 'JMPCN' && !B(CR))) pc = labels[lbl];
              break;
            }
            case 'CAL': case 'CALC': case 'CALCN': {
              if (base === 'CALC' && !B(CR)) break;
              if (base === 'CALCN' && B(CR)) break;
              const name = (ins.raw || '').replace(/;$/, '').trim();
              const inst = PLC.fbs.get(PLC.U(name));
              if (!inst) throw new Error(`'${name}' is not a declared function block instance — declare it in a VAR block`);
              inst.invoke({}, dt);   // uses parameters stored via ST inst.IN / inst.PT
              break;
            }
            case 'RET':
              pc = end; break;
            case 'RETC':
              if (B(CR)) pc = end; break;
            case 'RETCN':
              if (!B(CR)) pc = end; break;
            default:
              throw new Error(`Unknown instruction '${op}'`);
          }
        } catch (e) {
          throw new Error(`Line ${ins.no}: ${e.message.replace(/^Line \d+: /, '')}`);
        }
      }
    },
  };
}

PLC.IL = { compile };

/* ---------------- highlighting ---------------- */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const IL_KW = 'LDN|LD|STN|ST|S|R|ANDN|AND|ORN|OR|XORN|XOR|NOT|ADD|SUB|MUL|DIV|MOD|GT|GE|EQ|NE|LE|LT|JMPC|JMPCN|JMP|CALCN|CALC|CAL|RETC|RETCN|RET|VAR_INPUT|VAR_OUTPUT|VAR_GLOBAL|VAR|END_VAR|TON|TOF|TP|CTU|CTD|CTUD|SR_|RS|R_TRIG|F_TRIG|BOOL|INT|REAL|TIME';

PLC.IL.highlight = function (src) {
  const re = new RegExp(
    '(\\(\\*[\\s\\S]*?(?:\\*\\)|$)|//[^\\n]*)' +
    '|((?:T|TIME)#[\\w.]+|\\b\\d+#[0-9A-Fa-f_]+|\\b\\d+(?:\\.\\d+)?\\b|\\bTRUE\\b|\\bFALSE\\b)' +
    `|^(\\s*)(${IL_KW})\\b` +
    `|\\b(${IL_KW})\\b`,
    'gim');
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    if (m[1]) out += `<span class="tok-com">${esc(m[0])}</span>`;
    else if (m[2]) out += `<span class="tok-num">${esc(m[0])}</span>`;
    else if (m[4] !== undefined) out += esc(m[3]) + `<span class="tok-kw">${esc(m[4])}</span>`;
    else out += `<span class="tok-kw">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
};

/* ---------------- IL editor module ---------------- */

const IL_MOD = {
  id: 'il',
  title: 'Instruction List',
  editor: null,

  init(pane) {
    pane.innerHTML = `
      <div class="ed-toolbar">
        <span style="font-weight:700">Instruction List</span>
        <span class="ed-hint">LD / ST / AND / OR / S / R / JMP / CAL · set FB params with ST t1.IN then CAL t1</span>
      </div>
      <div class="code-host" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
    this.editor = UI.codeEditor(pane.querySelector('.code-host'), {
      value: '',
      highlight: PLC.IL.highlight,
      onChange: () => UI.docChanged(),
    });
  },

  compile() { return PLC.IL.compile(this.editor.value); },
  renderLive() {},
  save() { return this.editor.value; },
  load(v) { this.editor.value = typeof v === 'string' ? v : ''; },
  example() { this.editor.value = PLC.EXAMPLES.il; UI.docChanged(); },
};

PLC.registerModule(IL_MOD);

})();
