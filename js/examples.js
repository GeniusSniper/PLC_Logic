'use strict';

/* ============================================================
   Example programs — one per language.
   ============================================================ */

PLC.EXAMPLES = {

  /* Motor start/stop with seal-in branch + delayed lamp */
  ld: {
    rows: 4,
    cells: [
      [{ t: 'NO', name: 'I0' }, { t: 'NC', name: 'I1' }, { t: 'H' }, { t: 'H' }, { t: 'H' }, { t: 'H' }, { t: 'H' }, { t: 'COIL', name: 'Q0' }],
      [{ t: 'NO', name: 'Q0' }, null, null, null, null, null, null, null],
      [{ t: 'NO', name: 'Q0' }, { t: 'TON', name: 'T1', pt: 2000 }, { t: 'H' }, { t: 'H' }, { t: 'H' }, { t: 'H' }, { t: 'H' }, { t: 'COIL', name: 'Q1' }],
      [null, null, null, null, null, null, null, null],
    ],
    vlinks: [[0, 1]],
  },

  /* Two on-delay timers wired as an oscillator flashing Q0 */
  fbd: {
    blocks: [
      { id: 1, type: 'NOT', x: 60, y: 130, name: '', params: {} },
      { id: 2, type: 'TON', x: 250, y: 110, name: 'FLASH_ON', params: { PT: 600 } },
      { id: 3, type: 'TON', x: 450, y: 110, name: 'FLASH_OFF', params: { PT: 600 } },
      { id: 4, type: 'VAR_OUT', x: 650, y: 122, name: 'Q0', params: {} },
    ],
    conns: [
      { id: 10, from: [1, 'OUT'], to: [2, 'IN'] },
      { id: 11, from: [2, 'Q'], to: [3, 'IN'] },
      { id: 12, from: [3, 'Q'], to: [1, 'IN'] },
      { id: 13, from: [2, 'Q'], to: [4, 'IN'] },
    ],
    nextId: 20,
  },

  st: `(* Flashing lamp, pulse counter and a threshold — Structured Text demo *)
VAR
  blink : TON;
  pause : TON;
  cnt   : CTU;
END_VAR

(* two on-delay timers wired as an oscillator *)
blink(IN := NOT pause.Q, PT := T#600ms);
pause(IN := blink.Q,     PT := T#600ms);
Q0 := blink.Q;

(* count the flashes: I0 resets, Q1 latches after 10 pulses *)
cnt(CU := blink.Q, R := I0, PV := 10);
Q1 := cnt.Q;
AQ0 := cnt.CV;

(* analog threshold: set AI0 in the I/O panel *)
IF AI0 >= 500 THEN
  Q2 := TRUE;
ELSE
  Q2 := FALSE;
END_IF;
`,

  il: `(* Motor start/stop with seal-in — Instruction List demo *)
(* I0 = start button, I1 = stop button, Q0 = motor *)
VAR
  T1 : TON;
END_VAR

LD   I0        // start pressed
OR   Q0        // ...or already running (seal-in)
ANDN I1        // and stop not pressed
ST   Q0

(* delayed lamp: Q1 comes on 1.5 s after the motor starts *)
LD   Q0
ST   T1.IN
LD   T#1500ms
ST   T1.PT
CAL  T1
LD   T1.Q
ST   Q1
`,

  /* Traffic light sequence: red -> red+yellow -> green -> yellow -> red */
  sfc: {
    steps: [
      { id: 1, name: 'S_RED',    x: 260, y: 30,  initial: true,  actions: 'Q0 := TRUE;  Q1 := FALSE; Q2 := FALSE;' },
      { id: 2, name: 'S_REDYEL', x: 260, y: 160, initial: false, actions: 'Q0 := TRUE;  Q1 := TRUE;  Q2 := FALSE;' },
      { id: 3, name: 'S_GREEN',  x: 260, y: 290, initial: false, actions: 'Q0 := FALSE; Q1 := FALSE; Q2 := TRUE;' },
      { id: 4, name: 'S_YEL',    x: 260, y: 420, initial: false, actions: 'Q0 := FALSE; Q1 := TRUE;  Q2 := FALSE;' },
    ],
    trans: [
      { id: 5, from: 1, to: 2, condition: 'S_RED.T >= T#3s' },
      { id: 6, from: 2, to: 3, condition: 'S_REDYEL.T >= T#1s' },
      { id: 7, from: 3, to: 4, condition: 'S_GREEN.T >= T#4s' },
      { id: 8, from: 4, to: 1, condition: 'S_YEL.T >= T#1s' },
    ],
    nextId: 9,
  },
};
