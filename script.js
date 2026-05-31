const DEFAULT_CODE = `MOV R0, 5
MOV R1, 10
ADD R0, R1
MOV R2, R0
MOV R3, 3
SUB R2, R3
STORE R2, 20
LOAD R3, 20`;

const REGS = ['R0', 'R1', 'R2', 'R3'];

function parseInstruction(line) {
  line = line.trim().toUpperCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!line || line.startsWith(';') || line.startsWith('#')) return null;
  const parts = line.split(' ').filter(Boolean);
  if (!parts.length) return null;
  return { opcode: parts[0], op1: parts[1] || null, op2: parts[2] || null, raw: line };
}

function toHex(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(4, '0'); }
function numVal(s) { if (!s) return 0; if (/^-?\d+$/.test(s)) return parseInt(s, 10); return 0; }

let state = {
  code: DEFAULT_CODE,
  instructions: [],
  memory: {},
  registers: { R0: 0, R1: 0, R2: 0, R3: 0 },
  prevRegisters: { R0: 0, R1: 0, R2: 0, R3: 0 },
  pc: 0,
  ir: { opcode: '', op1: '', op2: '' },
  stage: 'idle', 
  cyclePhase: 0, 
  logs: [],
  stepCount: 0,
  running: false,
  loaded: false,
  
  // Animation & Highlight States
  changedRegs: new Set(),
  changedMem: new Set(),
  readRegs: new Set(),
  readMem: new Set(),
  pendingTransfers: [],
  decodeScramblePending: false,
  
  halted: false,
  lastPc: -1
};

let runTimer = null;

function addLog(text, type) {
  const t = state.stepCount;
  state.logs.unshift({ text, type, t });
  if (state.logs.length > 80) state.logs.pop();
}

function loadInstructions() {
  const lines = state.code.split('\n');
  state.instructions = [];
  state.memory = {};
  state.registers = { R0: 0, R1: 0, R2: 0, R3: 0 };
  state.prevRegisters = { R0: 0, R1: 0, R2: 0, R3: 0 };
  state.pc = 0;
  state.ir = { opcode: '', op1: '', op2: '' };
  state.stage = 'idle';
  state.cyclePhase = 0;
  state.logs = [];
  state.stepCount = 0;
  state.changedRegs = new Set();
  state.changedMem = new Set();
  state.readRegs = new Set();
  state.readMem = new Set();
  state.pendingTransfers = [];
  state.halted = false;
  state.lastPc = -1;
  state.loaded = false;

  let addr = 0;
  for (const line of lines) {
    const instr = parseInstruction(line);
    if (instr) {
      state.instructions.push(instr);
      state.memory[addr] = { type: 'instr', value: instr.raw, instr };
      addr++;
    }
  }
  for (let i = addr; i < 32; i++) {
    if (!state.memory[i]) state.memory[i] = { type: 'data', value: 0 };
  }
  state.loaded = true;
  addLog('Program loaded — ' + state.instructions.length + ' instructions configured.', 'success');
  render();
}

function doStep() {
  if (state.halted) return;
  if (!state.loaded || !state.instructions.length) { addLog('Load assembly payload first.', 'error'); render(); return; }
  if (state.pc >= state.instructions.length && state.cyclePhase === 0) { addLog('Processor Pipeline Halted — EOP reached.', 'success'); state.halted = true; state.stage = 'idle'; render(); return; }

  // Clear previous transient states
  state.changedRegs = new Set();
  state.changedMem = new Set();
  state.readRegs = new Set();
  state.readMem = new Set();
  state.pendingTransfers = [];
  state.prevRegisters = { ...state.registers };
  state.stepCount++;

  if (state.cyclePhase === 0) {
    // FETCH
    state.stage = 'fetch';
    state.lastPc = state.pc;
    const instr = state.instructions[state.pc];
    state.ir = { opcode: instr.opcode, op1: instr.op1 || '', op2: instr.op2 || '' };
    addLog('FETCH: Pipeline extraction "' + instr.raw + '" from segment ' + toHex(state.pc) + ' | Incrementing PC.', 'fetch');
    state.pc++;
    state.cyclePhase = 1;
  } else if (state.cyclePhase === 1) {
    // DECODE
    state.stage = 'decode';
    state.decodeScramblePending = true; // Trigger cipher effect
    addLog('DECODE: Parsing Command: OPCODE[' + state.ir.opcode + ']' + (state.ir.op1 ? '  OP1[' + state.ir.op1 + ']' : '') + (state.ir.op2 ? '  OP2[' + state.ir.op2 + ']' : ''), 'decode');
    state.cyclePhase = 2;
  } else {
    // EXECUTE
    state.stage = 'execute';
    const { opcode, op1, op2 } = state.ir;
    let msg = '';
    let err = false;
    const regs = state.registers;
    const isReg = (s) => REGS.includes(s);

    if (opcode === 'MOV') {
      if (!isReg(op1)) { err = true; msg = 'EXECUTE ERROR: Invalid destination constraint'; }
      else {
        const val = isReg(op2) ? regs[op2] : numVal(op2);
        if (isReg(op2)) {
           state.readRegs.add(op2);
           // Queue ghost transfer: Source Register -> Dest Register
           state.pendingTransfers.push({ src: 'reg-'+op2, dest: 'reg-'+op1, val: val });
        }
        regs[op1] = val;
        state.changedRegs.add(op1);
        msg = 'EXECUTE: Assigned ' + op1 + ' ← ' + val;
      }
    } else if (opcode === 'ADD' || opcode === 'SUB') {
      if (!isReg(op1) || !isReg(op2)) { err = true; msg = 'EXECUTE ERROR: Arithmetic requires structural registers'; }
      else {
        const prev = regs[op1];
        const computed = opcode === 'ADD' ? prev + regs[op2] : prev - regs[op2];
        
        // ALU uses both as sources initially
        state.readRegs.add(op1);
        state.readRegs.add(op2);
        
        // Ghost transfer from OP2 to OP1
        state.pendingTransfers.push({ src: 'reg-'+op2, dest: 'reg-'+op1, val: regs[op2] });
        
        regs[op1] = computed;
        state.changedRegs.add(op1);
        msg = `EXECUTE: ALU ${opcode} computation: ${op1} = ${prev} ${opcode==='ADD'?'+':'-'} ${regs[op2]} ➔ ${regs[op1]}`;
      }
    } else if (opcode === 'LOAD') {
      const addr = numVal(op2);
      const memVal = state.memory[addr] ? (state.memory[addr].type === 'data' ? state.memory[addr].value : 0) : 0;
      
      state.readMem.add(addr);
      state.pendingTransfers.push({ src: 'mem-'+addr, dest: 'reg-'+op1, val: memVal });
      
      regs[op1] = memVal;
      state.changedRegs.add(op1);
      msg = 'EXECUTE: Memory bus fetch triggered ' + op1 + ' ← RAM[' + toHex(addr) + ']';
    } else if (opcode === 'STORE') {
      if (!isReg(op1)) { err = true; msg = 'EXECUTE ERROR: Store expects register source'; }
      else {
        const addr = numVal(op2);
        if (!state.memory[addr]) state.memory[addr] = { type: 'data', value: 0 };
        
        state.readRegs.add(op1);
        state.pendingTransfers.push({ src: 'reg-'+op1, dest: 'mem-'+addr, val: regs[op1] });
        
        state.memory[addr] = { type: 'data', value: regs[op1] };
        state.changedMem.add(addr);
        msg = 'EXECUTE: Bus transaction RAM[' + toHex(addr) + '] ← ' + regs[op1];
      }
    } else {
      err = true; msg = 'EXECUTE ERROR: Unknown instruction';
    }
    
    addLog(msg, err ? 'error' : 'execute');
    state.cyclePhase = 0;
    
    if (state.pc >= state.instructions.length) {
      state.halted = true;
      addLog('Instruction pipeline exhausted. Processor isolated.', 'success');
    }
  }
  render();
}

function runAll() {
  if (state.halted) return;
  state.running = true;
  render();
  function tick() {
    if (state.halted || !state.running) { state.running = false; render(); return; }
    doStep();
    // Slightly slower clock to let the ghost data bus animations finish travelling
    if (!state.halted) runTimer = setTimeout(tick, 850); 
    else { state.running = false; render(); }
  }
  tick();
}

function pauseRun() { state.running = false; clearTimeout(runTimer); render(); }

function resetAll() {
  clearTimeout(runTimer);
  loadInstructions();
  addLog('Processor registers initialized to default state.', 'info');
  render();
}

function renderStageBar() {
  const s = state.stage;
  const cp = state.cyclePhase;
  const fetchActive = (s === 'fetch') || (s === 'execute' && cp === 1);
  const decodeActive = (s === 'decode') || (s === 'fetch' && cp === 2);
  const execActive = (s === 'execute' && cp === 0 && state.stepCount > 0 && !state.halted);

  return `<div class="stage-bar">
    <div class="stage-item ${fetchActive ? 'active-fetch' : ''}"><span class="stage-dot"></span>1. FETCH</div>
    <span class="stage-arrow ${fetchActive ? 'active' : ''}">▶</span>
    <div class="stage-item ${decodeActive ? 'active-decode' : ''}"><span class="stage-dot"></span>2. DECODE</div>
    <span class="stage-arrow ${decodeActive ? 'active' : ''}">▶</span>
    <div class="stage-item ${execActive ? 'active-execute' : ''}"><span class="stage-dot"></span>3. EXECUTE</div>
    <span style="margin-left:auto; display:flex; gap:16px; align-items:center;">
      <span style="font-size:10px; color:var(--muted);">CYCLE <span style="color:var(--text); font-weight:bold;">${state.stepCount}</span></span>
      <span style="font-size:10px; color:var(--muted);">PC <span id="pc-badge" style="color:var(--accent); font-weight:700; transition: color 0.2s;">${toHex(state.pc)}</span></span>
      ${state.halted ? '<span style="font-size:10px; background:rgba(248,81,73,0.15); color:var(--red); padding:2px 8px; border-radius:10px; font-weight:bold;">HALTED</span>' : ''}
      ${state.running ? '<span style="font-size:10px; background:rgba(63,185,80,0.15); color:var(--teal); padding:2px 8px; border-radius:10px; font-weight:bold;">RUNNING</span>' : ''}
    </span>
  </div>`;
}

function renderInputPanel() {
  const s = state.stage;
  const cp = state.cyclePhase;
  let panelClass = "panel p-input";
  if (s === 'fetch' || (s === 'execute' && cp === 1)) panelClass += " pulse-fetch";

  let irPopClass = "ir-box";
  if (s === 'fetch') irPopClass += " pop-ir";

  return `<div class="${panelClass}" style="grid-row:1/3; grid-column:1/2; border-right:1px solid var(--border);">
    <div class="panel-header">
      <span class="panel-label">Assembly Compiler</span>
    </div>
    <div class="panel-body">
      <textarea id="code" spellcheck="false" autocomplete="off">${state.code}</textarea>
      <div class="btn-row">
        <button class="btn btn-load" onclick="loadInstructions()">⬆ Load</button>
        <button class="btn btn-run" ${!state.loaded || state.halted || state.running ? 'disabled' : ''} onclick="runAll()">▶ Run</button>
        <button class="btn btn-step" ${!state.loaded || state.halted || state.running ? 'disabled' : ''} onclick="doStep()">→ Step</button>
        ${state.running ? `<button class="btn btn-reset" onclick="pauseRun()">⏸ Pause</button>` : ''}
        <button class="btn btn-reset" onclick="resetAll()">↺ Reset</button>
      </div>

      <div class="${irPopClass}" style="margin-top:14px;">
        <div class="ir-label">INSTRUCTION REGISTER (IR)</div>
        <div class="ir-fields">
          <div class="ir-field ${s==='decode'?'highlight-decode':''}">
            <div class="ir-field-label">OPCODE</div>
            <div class="ir-field-val" id="ir-op" data-val="${state.ir.opcode || '—'}" style="color:var(--purple);">${state.ir.opcode || '—'}</div>
          </div>
          <div class="ir-field ${s==='decode'?'highlight-decode':''}">
            <div class="ir-field-label">OP 1</div>
            <div class="ir-field-val" id="ir-op1" data-val="${state.ir.op1 || '—'}">${state.ir.op1 || '—'}</div>
          </div>
          <div class="ir-field ${s==='decode'?'highlight-decode':''}">
            <div class="ir-field-label">OP 2</div>
            <div class="ir-field-val" id="ir-op2" data-val="${state.ir.op2 || '—'}" style="color:var(--yellow);">${state.ir.op2 || '—'}</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderRegisters() {
  const s = state.stage;
  let panelClass = "panel";
  if (s === 'decode') panelClass += " pulse-decode";
  if (s === 'execute' && state.changedRegs.size > 0) panelClass += " pulse-execute";

  return `<div class="${panelClass}" style="grid-row:1/2; grid-column:2/3;">
    <div class="panel-header"><span class="panel-label">Register File</span></div>
    <div class="panel-body">
      <div class="reg-grid">
        ${REGS.map(r => {
          const val = state.registers[r];
          const oldVal = state.prevRegisters[r];
          const changed = state.changedRegs.has(r);
          const isRead = state.readRegs.has(r);
          const delta = val - oldVal;

          return `<div class="reg-card ${changed ? 'changed' : ''} ${isRead ? 'read-source' : ''}" id="reg-${r}">
            <div class="reg-name">${r}</div>
            <div class="val-container">
              <div class="reg-val ${changed ? 'changed' : ''} ${isRead ? 'read-source' : ''}">${val}</div>
              ${changed && delta !== 0 ? `<span class="delta-pop">${delta > 0 ? '+' + delta : delta}</span>` : ''}
            </div>
            <div class="reg-hex">${toHex(val)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function renderMemory() {
  const s = state.stage;
  let panelClass = "panel";
  if (s === 'fetch') panelClass += " pulse-fetch";
  if (s === 'execute' && (state.ir.opcode === 'STORE' || state.ir.opcode === 'LOAD')) panelClass += " pulse-execute";

  const keys = Object.keys(state.memory).map(Number).sort((a, b) => a - b);
  
  const rows = keys.map(addr => {
    const cell = state.memory[addr];
    const isCurrentPc = addr === state.lastPc && state.stage !== 'idle';
    const isChanged = state.changedMem.has(addr);
    const isRead = state.readMem.has(addr);
    const isInstr = cell.type === 'instr';
    
    return `<div class="mem-row ${isCurrentPc ? 'active' : ''} ${isChanged ? 'changed' : ''} ${isRead ? 'read-source' : ''}" id="mem-${addr}">
      <span class="mem-addr">${isCurrentPc ? '<span class="mem-pointer"></span>' : ''}${toHex(addr)}</span>
      <span class="${isInstr ? 'mem-instr' : 'mem-data'}" style="font-size:10px;">${isInstr ? cell.value : '—'}</span>
      <span class="mem-data" style="font-weight:bold;">${isInstr ? '' : cell.value}</span>
    </div>`;
  }).join('');

  return `<div class="${panelClass}" style="grid-row:1/2; grid-column:3/4;">
    <div class="panel-header"><span class="panel-label">System RAM</span></div>
    <div class="panel-body">
      <div style="display:grid; grid-template-columns:56px 1fr 80px; gap:4px; padding:0 4px 6px; border-bottom:1px solid var(--border); margin-bottom:6px;">
        <span style="font-size:9px;color:var(--muted);">ADDRESS</span>
        <span style="font-size:9px;color:var(--muted);">INSTRUCTION</span>
        <span style="font-size:9px;color:var(--muted);text-align:right;">DATA</span>
      </div>
      <div class="mem-grid">${rows}</div>
    </div>
  </div>`;
}

function renderLog() {
  const entries = state.logs.length
    ? state.logs.map(l => `<div class="log-entry"><span class="log-time">CYC.${l.t.toString().padStart(3,'0')}</span><span class="log-text log-${l.type}">${l.text}</span></div>`).join('')
    : `<p class="empty-state">Microcode processing events stream here.</p>`;
  return `<div class="panel" style="grid-row:2/3; grid-column:2/4; border-right:none;">
    <div class="panel-header"><span class="panel-label">Event Log</span></div>
    <div class="panel-body" id="logbox" style="background:#090d13;">${entries}</div>
  </div>`;
}

// ---------------------------------------------------------
// POST-RENDER ANIMATION CONTROLLERS
// ---------------------------------------------------------

function runCipherScramble() {
  const els = [document.getElementById('ir-op'), document.getElementById('ir-op1'), document.getElementById('ir-op2')];
  const chars = '0123456789ABCDEF@#$%&?*';
  let iterations = 0;
  const maxIterations = 8;
  
  const interval = setInterval(() => {
    els.forEach(el => {
      if(el && el.dataset.val && el.dataset.val !== '—') {
        let scramble = '';
        for(let i=0; i<el.dataset.val.length; i++) scramble += chars[Math.floor(Math.random() * chars.length)];
        el.innerText = scramble;
      }
    });
    iterations++;
    if (iterations >= maxIterations) {
      clearInterval(interval);
      els.forEach(el => { if(el && el.dataset.val) el.innerText = el.dataset.val; });
    }
  }, 35);
}

function runGhostTransfers() {
  if (!state.pendingTransfers || state.pendingTransfers.length === 0) return;
  
  state.pendingTransfers.forEach(transfer => {
    const srcEl = document.getElementById(transfer.src);
    const destEl = document.getElementById(transfer.dest);
    if (!srcEl || !destEl) return;

    const srcRect = srcEl.getBoundingClientRect();
    const destRect = destEl.getBoundingClientRect();

    const ghost = document.createElement('div');
    ghost.className = 'ghost-transfer';
    ghost.innerText = transfer.val;
    
    // Spawn at center of source
    ghost.style.left = (srcRect.left + srcRect.width/2) + 'px';
    ghost.style.top = (srcRect.top + srcRect.height/2) + 'px';
    document.body.appendChild(ghost);

    // Force browser reflow to register start position
    void ghost.offsetWidth;

    // Fly to center of destination
    ghost.style.left = (destRect.left + destRect.width/2) + 'px';
    ghost.style.top = (destRect.top + destRect.height/2) + 'px';
    ghost.style.opacity = '0';

    // Cleanup after transition
    setTimeout(() => { if (document.body.contains(ghost)) document.body.removeChild(ghost); }, 400);
  });
  
  state.pendingTransfers = [];
}

function render() {
  const ta = document.getElementById('code');
  if (ta) state.code = ta.value;

  document.getElementById('app').innerHTML = `
    <div class="header">
      <div style="display:flex;gap:5px"><div class="dot dot-r"></div><div class="dot dot-y"></div><div class="dot dot-g"></div></div>
      <span class="header-title">ISA Simulator</span>
      <span class="header-sub">Instruction cycle execution tracker</span>
    </div>
    ${renderStageBar()}
    <div class="main">
      ${renderInputPanel()}
      ${renderRegisters()}
      ${renderMemory()}
      ${renderLog()}
    </div>
  `;

  const newTa = document.getElementById('code');
  if (newTa) {
    newTa.value = state.code;
    newTa.addEventListener('input', () => { state.code = newTa.value; });
  }

  // Trigger post-render lifecycle animations
  if (state.decodeScramblePending) {
    state.decodeScramblePending = false;
    runCipherScramble();
  }
  runGhostTransfers();
}

// Initialize Application
loadInstructions();