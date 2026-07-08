# ⚡ PLC Logic Studio

**🔗 Live demo: [PLC_Logic](https://geniussniper.github.io/PLC_Logic/)**

A browser-based **PLC programming environment** supporting all five **IEC 61131-3** languages, with a live scan-cycle simulator, an interactive I/O panel, and standard function blocks (timers, counters, bistables, edge detectors).

## Languages

| Language | Editor | Highlights |
|---|---|---|
| **LD** — Ladder Diagram | Graphical grid editor | Contacts (NO/NC), coils (plain/set/reset), inline TON/TOF/TP/CTU/CTD, branch links, live power-flow highlighting |
| **FBD** — Function Block Diagram | Drag-and-drop block canvas | Logic, math, compare, select, bistable, edge, timer and counter blocks; pin-to-pin wiring with live signal colouring |
| **ST** — Structured Text | Syntax-highlighted code editor | `IF/ELSIF`, `CASE`, `FOR`, `WHILE`, `REPEAT`, VAR blocks, FB invocations (`t1(IN := x, PT := T#2s);`), time literals, built-in functions |
| **IL** — Instruction List | Syntax-highlighted code editor | `LD/ST/S/R/AND/OR/XOR/ADD…`, negation modifiers, parenthesised deferred operators, labels + `JMP/JMPC`, `CAL` for function blocks |
| **SFC** — Sequential Function Chart | Graphical step/transition editor | Steps with ST actions, transitions with ST conditions, step timers (`S1.T`), token-flow animation |

## Using it

1. Pick a language tab. Each editor starts with a working example (or press **Example**).
2. Press **▶ Run** — the program is compiled and scanned every 50 ms, exactly like a real PLC scan cycle.
3. Toggle the digital inputs (I0–I7) and set analog values (AI0/AI1) in the **I/O Simulator**; watch outputs, variables and function blocks update live.
4. **Reset** returns all variables and function blocks to their initial state.

Programs autosave to your browser (localStorage). **Export/Import** moves the whole project as a JSON file.

### Shared variable model

All five languages share one variable table: `I0…I7` (digital in), `Q0…Q7` (digital out), `AI0/AI1`, `AQ0/AQ1` (analog), `M0…M7` (memory) — plus any variables you add. Timers/counters are named instances (`T1 : TON;`) shared across the project, so an ST program can read a ladder timer's `T1.ET`.

## Try these examples

- **LD**: motor start/stop with seal-in — press I0 to start, I1 to stop, Q1 lights 2 s later.
- **FBD / ST**: a two-timer oscillator flashing Q0 (ST also counts the flashes).
- **IL**: the same start/stop circuit written as instructions.
- **SFC**: a traffic-light sequence on Q0/Q1/Q2.

## Local development

Just open `index.html` in a browser, or serve the folder:

```sh
python -m http.server 8000
# → http://localhost:8000
```

## Project structure

```
index.html          app shell
css/style.css       theme
js/core.js          variables, IEC function blocks (TON/TOF/TP/CTU/CTD/CTUD/SR/RS/R_TRIG/F_TRIG), scan engine
js/st.js            Structured Text tokenizer / parser / interpreter (also powers SFC conditions & actions)
js/il.js            Instruction List interpreter
js/ladder.js        Ladder editor + power-flow solver
js/fbd.js           Function Block Diagram editor + dataflow evaluator
js/sfc.js           Sequential Function Chart editor + token simulator
js/examples.js      demo programs
js/app.js           tabs, I/O panel, tables, persistence
```
# PLC_Logic
