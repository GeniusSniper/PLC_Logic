'use strict';

/* ============================================================
   App glue — tabs, run controls, I/O simulator, variable and
   FB tables, modal dialogs, code editors, persistence.
   ============================================================ */

(function () {

const $ = sel => document.querySelector(sel);
const LS_KEY = 'plcLogicStudio.v1';
const LANGS = ['ld', 'fbd', 'st', 'il', 'sfc'];
const DEFAULT_VARS = new Set([
  ...Array.from({ length: 8 }, (_, i) => 'I' + i),
  ...Array.from({ length: 8 }, (_, i) => 'Q' + i),
  ...Array.from({ length: 8 }, (_, i) => 'M' + i),
  'AI0', 'AI1', 'AQ0', 'AQ1',
]);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => esc(s).replace(/"/g, '&quot;');

let current = 'ld';
let saveTimer = null;
let layoutState = { hiddenLangs: [] };
let saveLayoutFn = null;

/* ================= UI namespace ================= */

const UI = window.UI = {

  currentLang() { return current; },

  status(msg, isErr) {
    const bar = $('#statusbar');
    $('#status-msg').textContent = msg;
    bar.classList.toggle('error', !!isErr);
  },

  /* modal form: fields [{key,label,value,type?('number'|'select'),options?}] -> Promise<obj|null> */
  form(title, fields, note) {
    return new Promise(resolve => {
      const root = $('#modal-root');
      root.hidden = false;
      root.innerHTML = `<div class="modal-back"><div class="modal">
        <h3>${esc(title)}</h3>
        ${note ? `<div class="m-note">${esc(note)}</div>` : ''}
        ${fields.map(f => `<div class="m-field"><label>${esc(f.label)}</label>${
          f.type === 'select'
            ? `<select data-k="${f.key}">${f.options.map(o => `<option${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
            : `<input data-k="${f.key}" type="${f.type === 'number' ? 'number' : 'text'}" value="${escAttr(f.value ?? '')}">`
        }</div>`).join('')}
        <div class="m-btns"><button class="m-cancel">Cancel</button><button class="m-ok">OK</button></div>
      </div></div>`;

      const done = val => { root.hidden = true; root.innerHTML = ''; resolve(val); };
      const collect = () => {
        const o = {};
        root.querySelectorAll('[data-k]').forEach(el => { o[el.dataset.k] = el.value; });
        return o;
      };
      root.querySelector('.m-ok').addEventListener('click', () => done(collect()));
      root.querySelector('.m-cancel').addEventListener('click', () => done(null));
      root.querySelector('.modal-back').addEventListener('pointerdown', e => {
        if (e.target === e.currentTarget) done(null);
      });
      root.querySelector('.modal').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); done(collect()); }
        if (e.key === 'Escape') done(null);
      });
      const first = root.querySelector('input,select,button.m-ok');
      if (first) { first.focus(); first.select && first.select(); }
    });
  },

  confirm(msg) {
    return UI.form('Please confirm', [], msg).then(r => r !== null);
  },

  /* highlighted code editor (textarea + <pre> overlay) */
  codeEditor(host, { value, highlight, onChange }) {
    host.innerHTML = `<div class="code-wrap"><pre class="code-hl"></pre><textarea class="code-ta" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>`;
    const ta = host.querySelector('.code-ta');
    const pre = host.querySelector('.code-hl');
    ta.value = value || '';
    const sync = () => { pre.innerHTML = highlight(ta.value) + '\n'; };
    ta.addEventListener('input', () => { sync(); onChange && onChange(ta.value); });
    ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
        sync();
        onChange && onChange(ta.value);
      }
    });
    sync();
    return {
      get value() { return ta.value; },
      set value(v) { ta.value = v || ''; sync(); },
    };
  },

  docChanged() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProject, 600);
  },

  onRunState(running) {
    $('#btn-run').disabled = running;
    $('#btn-stop').disabled = !running;
    $('#scan-info').classList.toggle('live', running);
    if (!running) $('#scan-info').textContent = '';
    const mod = PLC.modules[current];
    if (!running && mod && mod.renderLive) mod.renderLive();
  },

  afterScan() {
    const mod = PLC.modules[PLC.engine.lang];
    if (mod && mod.renderLive) mod.renderLive();
    updatePanels();
    $('#scan-info').textContent = `scan #${PLC.engine.scanCount} · ${PLC.engine.execMs.toFixed(1)} ms`;
  },

  refreshAll() {
    PLC.varsDirty = true;
    updatePanels();
    const mod = PLC.modules[current];
    if (mod && mod.renderLive) mod.renderLive();
  },
};

/* ================= I/O simulator & tables ================= */

let lastVarSig = '', lastFBSig = '';

function fmtVal(v) {
  if (typeof v === 'boolean') return `<span class="${v ? 'bool-t' : 'bool-f'}">${v ? 'TRUE' : 'FALSE'}</span>`;
  if (typeof v === 'number') return esc(String(Math.round(v * 1000) / 1000));
  return esc(String(v));
}

function buildIO() {
  const di = $('#io-di'), dout = $('#io-do'), an = $('#io-an');
  let diH = '', doH = '', anH = '';
  PLC.vars.forEach(v => {
    if (typeof v.value === 'boolean') {
      if (v.kind === 'input') diH += `<div class="io-sw" data-name="${escAttr(v.name)}" title="Click to toggle"><div class="led"></div><span>${esc(v.name)}</span></div>`;
      else if (v.kind === 'output') doH += `<div class="io-sw out" data-name="${escAttr(v.name)}"><div class="led"></div><span>${esc(v.name)}</span></div>`;
    } else if (v.kind === 'input') {
      anH += `<div class="io-an-item"><span>${esc(v.name)}</span><input type="number" data-name="${escAttr(v.name)}" value="${v.value}"></div>`;
    } else if (v.kind === 'output') {
      anH += `<div class="io-an-item"><span>${esc(v.name)}</span><span class="an-val" data-name="${escAttr(v.name)}">${v.value}</span></div>`;
    }
  });
  di.innerHTML = diH;
  dout.innerHTML = doH;
  an.innerHTML = anH;
}

function updateIO() {
  document.querySelectorAll('#io-di .io-sw, #io-do .io-sw').forEach(el => {
    el.classList.toggle('on', PLC.bool(safeRead(el.dataset.name)));
  });
  document.querySelectorAll('#io-an .an-val').forEach(el => {
    el.textContent = String(Math.round(PLC.num(safeRead(el.dataset.name)) * 1000) / 1000);
  });
  document.querySelectorAll('#io-an input[data-name]').forEach(el => {
    if (document.activeElement !== el) el.value = PLC.num(safeRead(el.dataset.name));
  });
}

function safeRead(name) { try { return PLC.readVar(name); } catch { return false; } }

function buildVarTable() {
  const tbody = $('#var-table tbody');
  let h = '';
  PLC.vars.forEach(v => {
    const kind = { input: 'IN', output: 'OUT', memory: 'MEM' }[v.kind] || v.kind;
    const del = DEFAULT_VARS.has(PLC.U(v.name)) ? '' :
      `<button class="row-del" data-del="${escAttr(v.name)}" title="Delete variable">&times;</button>`;
    h += `<tr><td class="v-name">${esc(v.name)}</td><td class="v-kind">${kind}</td>` +
         `<td class="v-val" data-name="${escAttr(v.name)}" title="Click to change">${fmtVal(v.value)}</td><td>${del}</td></tr>`;
  });
  tbody.innerHTML = h;
}

function buildFBTable() {
  const tbody = $('#fb-table tbody');
  let h = '';
  PLC.fbs.forEach(fb => {
    h += `<tr><td class="v-name">${esc(fb.name)}</td><td class="v-kind">${esc(fb.TYPE)}</td>` +
         `<td class="fb-state" data-fb="${escAttr(fb.name)}">${esc(fb.info ? fb.info() : '')}</td></tr>`;
  });
  tbody.innerHTML = h || '<tr><td class="v-kind" colspan="3">none yet — timers/counters appear here</td></tr>';
}

function updatePanels() {
  if (PLC.varsDirty) {
    buildIO();
    buildVarTable();
    buildFBTable();
    PLC.varsDirty = false;
    lastVarSig = varSig();
    lastFBSig = fbSig();
    updateIO();
    return;
  }
  updateIO();
  const vs = varSig();
  if (vs !== lastVarSig) {
    lastVarSig = vs;
    document.querySelectorAll('#var-table .v-val').forEach(el => {
      el.innerHTML = fmtVal(safeRead(el.dataset.name));
    });
  }
  const fs = fbSig();
  if (fs !== lastFBSig) {
    lastFBSig = fs;
    document.querySelectorAll('#fb-table [data-fb]').forEach(el => {
      const fb = PLC.fbs.get(PLC.U(el.dataset.fb));
      if (fb && fb.info) el.textContent = fb.info();
    });
  }
}

function varSig() {
  let s = '';
  PLC.vars.forEach(v => { s += v.value + '|'; });
  return s;
}
function fbSig() {
  let s = '';
  PLC.fbs.forEach(fb => { s += (fb.info ? fb.info() : '') + '|'; });
  return s;
}

/* ================= persistence ================= */

function projectData() {
  const data = { v: 1, vars: [] };
  LANGS.forEach(l => { data[l] = PLC.modules[l].save(); });
  PLC.vars.forEach(v => data.vars.push({ name: v.name, kind: v.kind, init: v.init }));
  return data;
}

function saveProject() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(projectData()));
  } catch { /* storage full / blocked — non-fatal */ }
}

function applyProject(data) {
  if (data.vars) {
    data.vars.forEach(v => { try { PLC.defineVar(v.name, v.kind, v.init); } catch { } });
  }
  LANGS.forEach(l => { if (data[l] !== undefined) PLC.modules[l].load(data[l]); });
  PLC.varsDirty = true;
}

/* ================= tabs & controls ================= */

function applyLangVisibility() {
  LANGS.forEach(l => {
    const sec = document.getElementById('sec-' + l);
    if (sec) sec.hidden = layoutState.hiddenLangs.includes(l);
  });
  document.querySelectorAll('#tabs .tab').forEach(b => {
    b.classList.toggle('off', layoutState.hiddenLangs.includes(b.dataset.lang));
  });
}

/* hide/show a language section; the remaining visible sections share the space */
function setLangHidden(lang, hide) {
  if (hide) {
    if (LANGS.length - layoutState.hiddenLangs.length <= 1) {
      UI.status('At least one editor must stay visible.', true);
      return false;
    }
    if (!layoutState.hiddenLangs.includes(lang)) layoutState.hiddenLangs.push(lang);
    applyLangVisibility();
    if (current === lang) activate(LANGS.find(l => !layoutState.hiddenLangs.includes(l)));
    UI.status(`${PLC.modules[lang].title} hidden — its program is kept. Bring it back with its tab or the ⚙ menu.`);
  } else {
    layoutState.hiddenLangs = layoutState.hiddenLangs.filter(l => l !== lang);
    applyLangVisibility();
    const mod = PLC.modules[lang];
    if (mod && mod.renderLive) mod.renderLive();
  }
  if (saveLayoutFn) saveLayoutFn();
  return true;
}

function activate(lang) {
  if (PLC.engine.running && PLC.engine.lang !== lang) PLC.engine.stop();
  if (layoutState.hiddenLangs.includes(lang)) setLangHidden(lang, false);
  current = lang;
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
  LANGS.forEach(l => {
    const sec = document.getElementById('sec-' + l);
    if (sec) sec.classList.toggle('active', l === lang);
  });
  const mod = PLC.modules[lang];
  if (mod && mod.renderLive) mod.renderLive();
  UI.status(`${mod.title} is the active section — Run compiles and simulates it.`);
}

async function addVariable() {
  const res = await UI.form('Add variable', [
    { key: 'name', label: 'Name', value: '' },
    { key: 'kind', label: 'Kind', value: 'memory', type: 'select', options: ['memory', 'input', 'output'] },
    { key: 'type', label: 'Type', value: 'BOOL', type: 'select', options: ['BOOL', 'INT', 'REAL', 'TIME'] },
    { key: 'init', label: 'Initial value', value: '0' },
  ]);
  if (!res || !res.name.trim()) return;
  let init;
  if (res.type === 'BOOL') init = /^(true|1)$/i.test(res.init.trim());
  else init = parseFloat(res.init) || 0;
  try {
    PLC.defineVar(res.name.trim(), res.kind, init);
    const v = PLC.vars.get(PLC.U(res.name));
    v.value = init;
    PLC.varsDirty = true;
    updatePanels();
    UI.docChanged();
    UI.status(`Variable ${res.name.trim()} added.`);
  } catch (e) {
    UI.status(e.message, true);
  }
}

function wireControls() {
  document.querySelectorAll('#tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => activate(btn.dataset.lang));
  });

  // language sections: click to make active, ✕ to hide (others grow)
  LANGS.forEach(l => {
    const sec = document.getElementById('sec-' + l);
    if (!sec) return;
    sec.addEventListener('pointerdown', e => {
      if (e.target.closest('.sec-hide')) return;
      if (current !== l) activate(l);
    });
    sec.querySelector('.sec-hide').addEventListener('click', () => setLangHidden(l, true));
  });

  $('#btn-run').addEventListener('click', () => PLC.engine.start(current));
  $('#btn-stop').addEventListener('click', () => PLC.engine.stop());
  $('#btn-reset').addEventListener('click', () => PLC.engine.reset());

  $('#btn-example').addEventListener('click', async () => {
    const mod = PLC.modules[current];
    const ok = await UI.confirm(`Replace the current ${mod.title} program with the example?`);
    if (ok) {
      if (PLC.engine.running) PLC.engine.stop();
      mod.example();
      UI.status(`${mod.title} example loaded — press Run.`);
    }
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'plc-logic-project.json';
    a.click();
    URL.revokeObjectURL(a.href);
    UI.status('Project exported.');
  });

  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (PLC.engine.running) PLC.engine.stop();
        applyProject(JSON.parse(reader.result));
        updatePanels();
        saveProject();
        UI.status(`Project '${file.name}' imported.`);
      } catch (err) {
        UI.status('Import failed: ' + err.message, true);
      }
    };
    reader.readAsText(file);
  });

  $('#btn-add-var').addEventListener('click', addVariable);

  // I/O panel interactions
  $('#io-di').addEventListener('click', e => {
    const sw = e.target.closest('.io-sw');
    if (!sw) return;
    const name = sw.dataset.name;
    PLC.writeVar(name, !PLC.bool(safeRead(name)));
    updateIO();
    if (!PLC.engine.running) updatePanels();
  });
  $('#io-an').addEventListener('change', e => {
    const el = e.target.closest('input[data-name]');
    if (!el) return;
    PLC.writeVar(el.dataset.name, parseFloat(el.value) || 0);
    updatePanels();
  });

  // variable table interactions
  $('#var-table').addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const ok = await UI.confirm(`Delete variable ${del.dataset.del}?`);
      if (ok) {
        PLC.deleteVar(del.dataset.del);
        updatePanels();
        UI.docChanged();
      }
      return;
    }
    const cell = e.target.closest('.v-val');
    if (!cell) return;
    const name = cell.dataset.name;
    const v = PLC.vars.get(PLC.U(name));
    if (!v) return;
    if (typeof v.value === 'boolean') {
      v.value = !v.value;
      PLC.varsDirty = true;
      updatePanels();
    } else {
      const res = await UI.form(`Set ${v.name}`, [{ key: 'val', label: 'Value', value: String(v.value), type: 'number' }]);
      if (res) {
        v.value = parseFloat(res.val) || 0;
        PLC.varsDirty = true;
        updatePanels();
      }
    }
  });
}

/* ================= adjustable layout ================= */

const LS_LAYOUT = 'plcLogicStudio.layout';

function initLayout() {
  const splitter = $('#splitter');
  const sidebar = $('#sidebar');

  let layout = {};
  try { layout = JSON.parse(localStorage.getItem(LS_LAYOUT)) || {}; } catch { }
  layoutState = layout;

  if (layout.sidebarW) sidebar.style.width = layout.sidebarW + 'px';
  document.querySelectorAll('#sidebar .panel').forEach(p => {
    if (layout.collapsed && layout.collapsed[p.id]) p.classList.add('collapsed');
    if (layout.heights && layout.heights[p.id]) {
      const body = p.querySelector('.panel-body');
      if (body) body.style.height = layout.heights[p.id] + 'px';
    }
  });

  const saveLayout = () => {
    layout.sidebarW = Math.round(sidebar.getBoundingClientRect().width);
    layout.collapsed = {};
    layout.heights = {};
    document.querySelectorAll('#sidebar .panel').forEach(p => {
      layout.collapsed[p.id] = p.classList.contains('collapsed');
      const body = p.querySelector('.panel-body');
      if (body && body.style.height) layout.heights[p.id] = Math.round(parseFloat(body.style.height));
    });
    try { localStorage.setItem(LS_LAYOUT, JSON.stringify(layout)); } catch { }
  };
  saveLayoutFn = saveLayout;

  // draggable editor/sidebar splitter
  let dragging = false;
  splitter.addEventListener('pointerdown', e => {
    dragging = true;
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  splitter.addEventListener('pointermove', e => {
    if (!dragging) return;
    const w = Math.min(Math.max(window.innerWidth - e.clientX, 150), window.innerWidth * 0.6);
    sidebar.style.width = Math.round(w) + 'px';
  });
  splitter.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    saveLayout();
  });
  splitter.addEventListener('dblclick', () => {   // double-click to restore default
    sidebar.style.width = '';
    saveLayout();
  });

  // collapsible panels
  document.querySelectorAll('#sidebar .panel-head').forEach(head => {
    head.addEventListener('click', e => {
      if (e.target.closest('button')) return;   // don't collapse via "+ Add"
      head.parentElement.classList.toggle('collapsed');
      saveLayout();
    });
  });

  // remember manual panel-body resizes (native CSS resize handle)
  document.querySelectorAll('#sidebar .panel-body').forEach(body => {
    body.addEventListener('pointerup', saveLayout);
  });

  /* ----- show/hide language editors (gear menu in the tab bar) ----- */
  layout.hiddenLangs = Array.isArray(layout.hiddenLangs) ? layout.hiddenLangs.filter(l => LANGS.includes(l)) : [];
  if (layout.hiddenLangs.length >= LANGS.length) layout.hiddenLangs = [];
  applyLangVisibility();

  const langBtn = $('#btn-langs');
  const menu = document.createElement('div');
  menu.className = 'lang-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  const closeMenu = () => { menu.hidden = true; };

  const rebuildMenu = () => {
    menu.innerHTML = '<div class="lang-menu-title">Visible editors</div>' + LANGS.map(l => {
      const hidden = layoutState.hiddenLangs.includes(l);
      return `<div class="lang-item${current === l ? ' active' : ''}" data-lang="${l}">` +
        `<span class="chk${hidden ? '' : ' on'}" title="Show / hide this editor">&#10003;</span>` +
        `<span class="lang-name">${esc(PLC.modules[l].title)}</span></div>`;
    }).join('') +
    '<div class="lang-menu-hint">click an editor to show or hide it</div>';
  };

  langBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.hidden) {
      rebuildMenu();
      const r = langBtn.getBoundingClientRect();
      menu.style.left = Math.round(r.left) + 'px';
      menu.style.top = Math.round(r.bottom + 6) + 'px';
      menu.hidden = false;
    } else {
      closeMenu();
    }
  });

  menu.addEventListener('click', e => {
    const item = e.target.closest('.lang-item');
    if (!item) return;
    // clicking anywhere on the row (name or checkmark) inverts visibility
    const lang = item.dataset.lang;
    setLangHidden(lang, !layoutState.hiddenLangs.includes(lang));
    rebuildMenu();
  });

  // close when clicking anywhere outside the menu / gear (capture phase on
  // both pointerdown and click, so nothing can swallow the event first)
  const outsideClose = e => {
    if (!menu.hidden && !menu.contains(e.target) && !langBtn.contains(e.target)) closeMenu();
  };
  document.addEventListener('pointerdown', outsideClose, true);
  document.addEventListener('click', outsideClose, true);
  window.addEventListener('blur', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
}

/* ================= boot ================= */

function boot() {
  PLC.initDefaults();

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch { }

  if (saved && saved.vars) {
    saved.vars.forEach(v => { try { PLC.defineVar(v.name, v.kind, v.init); } catch { } });
  }

  LANGS.forEach(l => PLC.modules[l].init(document.getElementById('pane-' + l)));

  if (saved) {
    LANGS.forEach(l => { if (saved[l] !== undefined) PLC.modules[l].load(saved[l]); });
  } else {
    LANGS.forEach(l => PLC.modules[l].example && PLC.modules[l].example());
  }

  wireControls();
  initLayout();
  PLC.varsDirty = true;
  updatePanels();
  activate(LANGS.find(l => !layoutState.hiddenLangs.includes(l)) || 'ld');
  UI.status('Ready — toggle inputs in the I/O panel, press Run to simulate. Programs autosave to your browser.');
}

boot();

})();
