/**
 * CppNotesInteractive — extensión de VS Code.
 *
 * Edita archivos `.cppnotes` (JSON) con una lista ordenada de **paneles** que
 * pueden ser de TEXTO (notas con formato enriquecido) o de CÓDIGO (C o C++).
 *
 * - Cada panel de código se puede compilar/ejecutar de forma INDEPENDIENTE.
 * - Un botón "Ejecutar todos" ejecuta todos los paneles de código EN CONJUNTO.
 * - La ejecución se hace en la Terminal Integrada: std::cin / scanf reciben la
 *   entrada real que teclea el usuario en la terminal.
 *
 * Compilar:  npm run compile   ->  out/extension.js
 * Probar:    F5                -> Extension Development Host
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type PanelType = 'text' | 'code';
type CodeLanguage = 'cpp' | 'c';

/**
 * Un panel del documento.
 * - type === 'text'  -> se usa `text`.
 * - type === 'code'  -> se usan `code` y `language` (compilador a emplear).
 * Se mantiene una forma plana (todos los campos) para simplificar la
 * serialización y el manejo sin tipos en el webview.
 */
interface Panel {
  id: string;
  type: PanelType;
  language: CodeLanguage; // 'cpp' | 'c' (solo relevante en paneles de código)
  code: string;          // solo relevante en paneles de código
  text: string;          // solo relevante en paneles de texto
}

/** Estructura lógica del archivo `.cppnotes`. */
interface CppNotesDoc {
  panels: Panel[];
}

/** Subconjunto mínimo que necesita el compilador/ejecutor. */
interface RunnableBlock {
  id: string;
  language: CodeLanguage;
  code: string;
}

/** Resultado de una compilación satisfactoria (lista para ejecutar). */
interface CompileResult {
  panelId: string;
  exePath: string;
}

// ---------------------------------------------------------------------------
// Constantes / estado global
// ---------------------------------------------------------------------------

const VIEW_TYPE = 'cppnotes.editor';

/** Canal de salida SOLO para diagnósticos (no para ejecutar el programa). */
const outputChannel = vscode.window.createOutputChannel('CppNotesInteractive');

// --- Estado de ejecución (para captura de salida y botón "Detener") ---------
// Los programas se ejecutan como procesos hijo (spawn) para capturar su salida
// y mostrarla debajo del panel. Cada ejecución recibe una "generación"; iniciar
// una nueva o pulsar "Detener" invalida la anterior y mata sus procesos.
let activeGeneration = 0;
const runningChildren = new Set<ChildProcess>();
const runningByPanel = new Map<string, ChildProcess>();
const killedChildren = new Set<ChildProcess>();

/** Mata un proceso y lo marca como detenido. */
function killChild(child: ChildProcess): void {
  killedChildren.add(child);
  try { child.kill(); } catch { /* ignorar */ }
}

/** Inicia una nueva ejecución (mata cualquier ejecución previa). */
function newRun(): number {
  activeGeneration++;
  for (const child of runningChildren) { killChild(child); }
  runningChildren.clear();
  runningByPanel.clear();
  return activeGeneration;
}

/** Cancela la ejecución en curso (botón "Detener"). */
function cancelRun(): void {
  activeGeneration++;
  for (const child of runningChildren) { killChild(child); }
  runningChildren.clear();
  runningByPanel.clear();
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Lee un valor de configuración con valor por defecto. */
function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('cppnotes').get<T>(key, defaultValue);
}

/** Normaliza un id (acepta string o number; si falta, usa el fallback). */
function normalizeId(id: unknown, fallback: string): string {
  return typeof id === 'string' || typeof id === 'number' ? String(id) : fallback;
}

/**
 * Devuelve compilador, flags y extensión según el lenguaje del panel.
 */
function compilerInfo(language: CodeLanguage): { compiler: string; flags: string; ext: string } {
  if (language === 'c') {
    return {
      compiler: getConfig<string>('cCompiler', 'gcc'),
      flags: getConfig<string>('cFlags', '-std=c11 -O2'),
      ext: '.c',
    };
  }
  return {
    compiler: getConfig<string>('cppCompiler', 'g++'),
    flags: getConfig<string>('cppFlags', '-std=c++17 -O2'),
    ext: '.cpp',
  };
}

/**
 * Parsea el texto del documento a la estructura lógica.
 *
 * Acepta:
 *  1. Formato nuevo:   { "panels": [ {type, ...}, ... ] }
 *  2. Formato antiguo: { "notes": "...", "codeBlocks": [{id, code}] }
 *
 * Si el JSON no es válido no se pierde el contenido: se conserva como un panel
 * de texto para que al guardar vuelva a ser JSON válido.
 */
function parseDocumentText(text: string): CppNotesDoc {
  if (!text.trim()) {
    return { panels: [] };
  }

  try {
    const data = JSON.parse(text);

    // --- Formato nuevo (paneles) ---
    if (Array.isArray(data.panels)) {
      const panels: Panel[] = data.panels
        .filter((p: any): boolean => !!p && (p.type === 'text' || p.type === 'code'))
        .map((p: any, i: number): Panel => {
          const id = normalizeId(p.id, `${p.type}_${i + 1}`);
          if (p.type === 'code') {
            const language: CodeLanguage = p.language === 'c' ? 'c' : 'cpp';
            return { id, type: 'code', language, code: typeof p.code === 'string' ? p.code : '', text: '' };
          }
          return { id, type: 'text', language: 'cpp', code: '', text: typeof p.text === 'string' ? p.text : '' };
        });
      return { panels };
    }

    // --- Migración del formato antiguo { notes, codeBlocks } ---
    const panels: Panel[] = [];
    if (typeof data.notes === 'string' && data.notes.length > 0) {
      panels.push({ id: 'text_1', type: 'text', language: 'cpp', code: '', text: data.notes });
    }
    if (Array.isArray(data.codeBlocks)) {
      data.codeBlocks
        .filter((b: any): boolean => !!b && typeof b.code === 'string')
        .forEach((b: any, i: number) => {
          panels.push({
            id: normalizeId(b.id, `code_${i + 1}`),
            type: 'code',
            language: 'cpp',
            code: b.code,
            text: '',
          });
        });
    }
    return { panels };
  } catch {
    outputChannel.appendLine('[CppNotes] JSON inválido; se conserva el contenido como un panel de texto.');
    return { panels: [{ id: 'text_1', type: 'text', language: 'cpp', code: '', text }] };
  }
}

/**
 * Serializa el estado a JSON limpio (solo los campos relevantes de cada tipo).
 */
function serializeDoc(doc: CppNotesDoc): string {
  const panels = doc.panels.map((p) => {
    if (p.type === 'code') {
      return { id: p.id, type: 'code', language: p.language, code: p.code || '' };
    }
    return { id: p.id, type: 'text', text: p.text || '' };
  });
  return JSON.stringify({ panels }, null, 2);
}

// ---------------------------------------------------------------------------
// Compilación + ejecución
// ---------------------------------------------------------------------------

/**
 * Compila un bloque en un archivo temporal. Devuelve la ruta del binario si
 * compila, o `null` si hubo error (el error se muestra en la webview).
 */
function compileBlock(webviewPanel: vscode.WebviewPanel, block: RunnableBlock): Promise<CompileResult | null> {
  const webview = webviewPanel.webview;

  return new Promise((resolve) => {
    if (!block.code || !block.code.trim()) {
      webview.postMessage({ type: 'runStatus', id: block.id, status: 'error', message: 'The block is empty.' });
      resolve(null);
      return;
    }

    const info = compilerInfo(block.language);
    const tmp = os.tmpdir();
    const safeId = String(block.id).replace(/[^A-Za-z0-9_-]/g, '_');
    const stamp = `${Date.now()}_${safeId}`;
    const srcPath = path.join(tmp, `cppnotes_${stamp}${info.ext}`);
    const exePath = path.join(tmp, `cppnotes_${stamp}${process.platform === 'win32' ? '.exe' : ''}`);

    // (a) Archivo temporal.
    fs.writeFileSync(srcPath, block.code, 'utf8');

    webview.postMessage({
      type: 'runStatus',
      id: block.id,
      status: 'compiling',
      message: `Compiling (${info.compiler})…`,
    });

    // (b) Compilación. Comillas dobles para tolerar rutas con espacios.
    //     `exec` usa una shell (cmd.exe en Windows), que busca el compilador
    //     en el PATH. Si no está en el PATH, configura cCompiler/cppCompiler.
    //     Se fuerza UTF-8 para que los acentos (ñ, ú, etc.) se conserven bien.
    const cmd = `"${info.compiler}" ${info.flags} -finput-charset=UTF-8 -fexec-charset=UTF-8 -o "${exePath}" "${srcPath}"`;
    outputChannel.appendLine(`[${block.id}] ${cmd}`);

    exec(cmd, { cwd: tmp, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr?.trim() || stdout?.trim() || String(error)).slice(0, 4000);
        outputChannel.appendLine(`[${block.id}] ERROR:\n${message}`);
        webview.postMessage({ type: 'runStatus', id: block.id, status: 'error', message });
        resolve(null);
        return;
      }
      resolve({ panelId: block.id, exePath });
    });
  });
}

/**
 * Ejecuta el binario como proceso hijo y captura su salida (stdout/stderr),
 * enviándola al webview en tiempo real para mostrarla debajo del panel, en la
 * misma consola donde el usuario escribe la entrada. La entrada estándar queda
 * ABIERTA: el webview (consola del panel) envía cada línea tecleada (mensaje
 * `stdin`) y aquí se escribe al proceso.
 */
function runBinary(
  webviewPanel: vscode.WebviewPanel,
  panelId: string,
  exePath: string,
  generation: number,
): Promise<void> {
  return new Promise((resolve) => {
    if (generation !== activeGeneration) { resolve(); return; }

    const webview = webviewPanel.webview;
    const child = spawn(exePath, [], { cwd: path.dirname(exePath) });
    runningChildren.add(child);
    runningByPanel.set(panelId, child);

    let settled = false;

    const finish = (ok: boolean, message: string): void => {
      if (settled) { return; }
      settled = true;
      runningChildren.delete(child);
      runningByPanel.delete(panelId);
      killedChildren.delete(child);
      webview.postMessage({ type: 'runDone', id: panelId, ok, message });
      resolve();
    };

    const emit = (text: string, stream: 'out' | 'err'): void => {
      if (!text) { return; }
      webview.postMessage({ type: 'runOutput', id: panelId, text, stream });
    };

    // stdout y stderr se envían por separado; se leen como UTF-8.
    child.stdout?.on('data', (data: Buffer) => emit(data.toString('utf8'), 'out'));
    child.stderr?.on('data', (data: Buffer) => emit(data.toString('utf8'), 'err'));

    child.on('error', (err) => {
      finish(false, `Could not run the program: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      if (signal || killedChildren.has(child)) {
        finish(false, 'Execution stopped.');
      } else {
        finish(code === 0, `Program finished (exit code ${code}).`);
      }
    });

    // NOTA: stdin permanece abierto; el usuario envía datos con el mensaje `stdin`.
  });
}

/** Ejecuta UN panel de código (compila y, si procede, ejecuta). */
async function runOneBlock(
  webviewPanel: vscode.WebviewPanel,
  block: RunnableBlock,
  generation: number,
): Promise<void> {
  const result = await compileBlock(webviewPanel, block);
  if (generation !== activeGeneration) { return; }
  if (!result) { return; }

  // Limpia el estado de compilación y activa la consola del panel.
  webviewPanel.webview.postMessage({
    type: 'runStatus',
    id: block.id,
    status: 'running',
    message: '',
  });

  await runBinary(webviewPanel, result.panelId, result.exePath, generation);
}

/**
 * Ejecuta TODOS los paneles de código en secuencia: cada uno compila y corre,
 * mostrando su salida en la consola de su propio panel.
 */
async function runAllBlocks(
  webviewPanel: vscode.WebviewPanel,
  blocks: RunnableBlock[],
  generation: number,
): Promise<void> {
  if (blocks.length === 0) {
    vscode.window.showInformationMessage('CppNotes: there are no code panels to run.');
    return;
  }

  for (const block of blocks) {
    if (generation !== activeGeneration) { return; }

    const result = await compileBlock(webviewPanel, block);
    if (generation !== activeGeneration) { return; }
    if (!result) { continue; }

    webviewPanel.webview.postMessage({
      type: 'runStatus',
      id: block.id,
      status: 'running',
      message: '',
    });

    await runBinary(webviewPanel, result.panelId, result.exePath, generation);
  }
}

// ---------------------------------------------------------------------------
// HTML del webview
// ---------------------------------------------------------------------------

/**
 * Interfaz: barra con "Añadir texto", "Añadir código", "Ejecutar todos" y
 * "Guardar"; y una lista de paneles reordenables. Se usa `String.raw` para que
 * los `\n` del JavaScript embebido lleguen literalmente al navegador.
 */
function getHtmlForWebview(webview: vscode.Webview): string {
  const nonce = getNonce();

  const csp = [
    `default-src 'none';`,
    `style-src ${webview.cspSource} 'unsafe-inline';`,
    `script-src 'nonce-${nonce}';`,
    `img-src ${webview.cspSource} data:;`,
  ].join(' ');

  return String.raw`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    --bg: #1e1e1e;
    --panel: #252526;
    --border: #3c3c3c;
    --text: #cccccc;
    --btn: #0e639c;
    --btn-hover: #1177bb;
    --danger: #a1260d;
    --danger-hover: #c23a1e;
    --ok: #4ec9b0;
    --mono: 'Consolas', 'Courier New', monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 14px;
    padding: 16px;
    overflow-y: auto;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
  }
  .toolbar h1 { font-size: 18px; margin: 0; flex: 1; font-weight: 600; }
  .btn {
    background: var(--btn);
    color: #fff;
    border: none;
    border-radius: 3px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
  }
  .btn:hover { background: var(--btn-hover); }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn.primary { background: #2a7d2a; }
  .btn.primary:hover { background: #338833; }
  .btn.danger { background: var(--danger); }
  .btn.danger:hover { background: var(--danger-hover); }
  .btn.small { padding: 2px 6px; font-size: 12px; }
  .panel {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    padding: 12px;
    margin-bottom: 14px;
  }
  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .panel-title { font-weight: 600; flex: 1; }
  .drag-handle {
    cursor: grab;
    color: #6a6a6a;
    font-size: 15px;
    letter-spacing: -1px;
    user-select: none;
    -webkit-user-select: none;
    padding: 0 2px;
  }
  .drag-handle:active { cursor: grabbing; }
  .panel.dragging { opacity: 0.45; }
  .panel.drop-target { border-color: var(--btn); box-shadow: 0 0 0 1px var(--btn); }
  .lang {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 4px 6px;
    font-size: 13px;
  }
  .panel textarea {
    width: 100%;
    resize: vertical;
    background: #1b1b1b;
    color: #dcdcdc;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px;
    font-size: 13px;
    line-height: 1.45;
  }
  .panel textarea.code {
    min-height: 140px;
    font-family: var(--mono);
    tab-size: 4;
    white-space: pre;
  }
  .rich-editor { display: block; }
  .rt-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
  }
  .rt-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
  }
  .rt-color {
    width: 22px;
    height: 22px;
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
  }
  .rt-colorpicker {
    width: 28px;
    height: 22px;
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
    background: transparent;
  }
  .rt-size {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 4px;
    font-size: 12px;
    cursor: pointer;
  }
  .rich-text {
    min-height: 80px;
    background: #1b1b1b;
    color: #dcdcdc;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px;
    font-size: 14px;
    line-height: 1.5;
    outline: none;
  }
  .rich-text:focus { outline: 1px solid var(--btn); }
  .rich-text h2 { font-size: 1.5em; margin: 0.3em 0; line-height: 1.2; }
  .rich-text h3 { font-size: 1.25em; margin: 0.3em 0; line-height: 1.2; }
  .rich-text p { margin: 0.3em 0; }
  .rich-text blockquote {
    border-left: 3px solid var(--border);
    margin: 0.4em 0;
    padding-left: 0.8em;
    color: #b3b3b3;
  }
  .rich-text div { margin: 0; }
  .rich-text ul, .rich-text ol { padding-left: 1.6em; margin: 0.3em 0; }
  .rich-text a { color: var(--btn); }
  .rich-text font[size="1"] { font-size: 11px; }
  .rich-text font[size="2"] { font-size: 13px; }
  .rich-text font[size="3"] { font-size: 16px; }
  .rich-text font[size="4"] { font-size: 18px; }
  .rich-text font[size="5"] { font-size: 22px; }
  .rich-text font[size="6"] { font-size: 26px; }
  .rich-text font[size="7"] { font-size: 32px; }
  .panel-footer {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
  }
  .console-input {
    width: 100%;
    margin-top: 6px;
    background: #1b1b1b;
    color: #dcdcdc;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: var(--mono);
    font-size: 13px;
  }
  .console-input:focus { outline: 1px solid var(--btn); }

  /* --- Editor de código con resaltado y altura automática --- */
  .code-editor { position: relative; }
  .panel .code-editor textarea.code {
    position: relative;
    z-index: 1;
    color: transparent !important;
    background: transparent !important;
    -webkit-text-fill-color: transparent;
    caret-color: #ffffff;
    white-space: pre;
    overflow-wrap: normal;
    overflow-y: hidden;
    overflow-x: auto;
    resize: none;
    min-height: 48px;
  }
  .code-editor .code-highlight {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 0;
    margin: 0;
    padding: 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: #1b1b1b;
    color: #d4d4d4;
    font-size: 13px;
    line-height: 1.45;
    font-family: var(--mono);
    tab-size: 4;
    white-space: pre;
    overflow: hidden;
    overflow-wrap: normal;
    pointer-events: none;
    box-sizing: border-box;
  }
  .code-editor .code-highlight code {
    font: inherit;
    color: inherit;
    background: transparent;
  }
  .tok-comment { color: #6a9955; }
  .tok-string { color: #ce9178; }
  .tok-number { color: #b5cea8; }
  .tok-keyword { color: #569cd6; }
  .tok-type { color: #4ec9b0; }
  .tok-func { color: #dcdcaa; }
  .tok-pre { color: #c586c0; }
  .tok-lib { color: #ce9178; }

  /* --- Salida debajo del panel --- */
  .output {
    margin-top: 8px;
    padding: 8px 10px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 12px;
    color: #d4d4d4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 360px;
    overflow-y: auto;
  }
  .output.running { background: #1f2a33; }
  .output.success { background: #1e2f24; }
  .output.error { background: #38201d; }
  .run-err { color: #f48771; }
  .run-input { color: #e6db74; }
  .run-done { color: #9d9d9d; }
</style>
</head>
<body>

  <div class="toolbar">
    <h1>CppNotesInteractive</h1>
    <button id="addText" class="btn">+ Add text</button>
    <button id="addCode" class="btn">+ Add code</button>
    <button id="runAll" class="btn primary">▶ Run all</button>
    <button id="stop" class="btn danger" title="Stop running programs">■ Stop</button>
    <button id="save" class="btn">Save</button>
  </div>

  <section>
    <div id="panels"></div>
  </section>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();

  // Modelo en memoria del webview: lista ordenada de paneles.
  var model = { panels: [] };
  var updateTimer = null;
  var currentDragId = null;
  var consoleEls = {};
  var codeEditors = {};

  var panelsEl = document.getElementById('panels');
  var addTextBtn = document.getElementById('addText');
  var addCodeBtn = document.getElementById('addCode');
  var runAllBtn = document.getElementById('runAll');
  var stopBtn = document.getElementById('stop');
  var saveBtn = document.getElementById('save');

  addTextBtn.addEventListener('click', addText);
  addCodeBtn.addEventListener('click', addCode);
  runAllBtn.addEventListener('click', runAll);
  stopBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });
  saveBtn.addEventListener('click', function () {
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
    vscode.postMessage({ type: 'save', doc: model });
  });

  function postUpdate(immediate) {
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
    if (immediate) {
      vscode.postMessage({ type: 'update', doc: model });
    } else {
      updateTimer = setTimeout(function () {
        updateTimer = null;
        vscode.postMessage({ type: 'update', doc: model });
      }, 300);
    }
  }

  function nextId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function makeBtn(label, onClick, extraClass, small) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (extraClass ? ' ' + extraClass : '') + (small ? ' small' : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function getPanel(id) {
    for (var i = 0; i < model.panels.length; i++) {
      if (model.panels[i].id === id) { return model.panels[i]; }
    }
    return null;
  }

  function getOutputEl(id) {
    var all = panelsEl.querySelectorAll('.output');
    for (var i = 0; i < all.length; i++) {
      if (all[i].dataset.output === id) { return all[i]; }
    }
    return null;
  }

  function setConsoleVisible(id, visible) {
    var el = consoleEls[id];
    if (el) { el.style.display = visible ? '' : 'none'; }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Resaltado de sintaxis C/C++ (colores mientras escribes).
  var HL_KW_SET = {};
  var HL_TYPE_SET = {};
  [
    'auto','break','case','class','const','constexpr','continue','default','delete','do','else',
    'enum','extern','false','for','friend','goto','if','inline','mutable','namespace','new',
    'noexcept','nullptr','operator','override','private','protected','public','register','return',
    'sizeof','static','struct','switch','template','this','throw','true','try','typedef','typename',
    'union','using','virtual','volatile','while'
  ].forEach(function (w) { HL_KW_SET[w] = 1; });
  [
    'char','short','int','long','float','double','void','signed','unsigned','bool','size_t',
    'int8_t','int16_t','int32_t','int64_t','uint8_t','uint16_t','uint32_t','uint64_t'
  ].forEach(function (w) { HL_TYPE_SET[w] = 1; });

  var HL_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(#include)\s*(<[^>\n]*>|"[^"\n]*")|(#\s*[A-Za-z_]\w*)|([A-Za-z_]\w*)(?=\s*\()|(\b(?:char|short|int|long|float|double|void|signed|unsigned|bool|size_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t)\b)|(\b(?:auto|break|case|class|const|constexpr|continue|default|delete|do|else|enum|extern|false|for|friend|goto|if|inline|mutable|namespace|new|noexcept|nullptr|operator|override|private|protected|public|register|return|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|volatile|while)\b)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]*\b)/g;

  function highlightCode(code) {
    return String(code).replace(HL_RE, function (m, comment, str, inc, incLib, pre, fun, type, keyw, num) {
      if (comment !== undefined) { return '<span class="tok-comment">' + escapeHtml(comment) + '</span>'; }
      if (str !== undefined) { return '<span class="tok-string">' + escapeHtml(str) + '</span>'; }
      if (inc !== undefined) {
        return '<span class="tok-pre">' + escapeHtml(inc) + '</span><span class="tok-lib">' + escapeHtml(incLib) + '</span>';
      }
      if (pre !== undefined) { return '<span class="tok-pre">' + escapeHtml(pre) + '</span>'; }
      if (fun !== undefined) {
        if (HL_TYPE_SET[fun]) { return '<span class="tok-type">' + escapeHtml(fun) + '</span>'; }
        if (HL_KW_SET[fun]) { return '<span class="tok-keyword">' + escapeHtml(fun) + '</span>'; }
        return '<span class="tok-func">' + escapeHtml(fun) + '</span>';
      }
      if (type !== undefined) { return '<span class="tok-type">' + escapeHtml(type) + '</span>'; }
      if (keyw !== undefined) { return '<span class="tok-keyword">' + escapeHtml(keyw) + '</span>'; }
      if (num !== undefined) { return '<span class="tok-number">' + escapeHtml(num) + '</span>'; }
      return escapeHtml(m);
    });
  }

  // Editor de código: resaltado de colores + altura automática según las líneas.
  function buildCodeEditor(panel) {
    var wrap = document.createElement('div');
    wrap.className = 'code-editor';

    var pre = document.createElement('pre');
    pre.className = 'code-highlight';
    pre.setAttribute('aria-hidden', 'true');
    var codeEl = document.createElement('code');
    pre.appendChild(codeEl);

    var ta = document.createElement('textarea');
    ta.className = 'code';
    ta.setAttribute('wrap', 'off');
    ta.spellcheck = false;

    function autoGrow() {
      ta.style.height = 'auto';
      ta.style.height = (ta.scrollHeight + 2) + 'px';
    }

    function render() {
      var html = highlightCode(ta.value);
      if (ta.value.charAt(ta.value.length - 1) === '\n') { html += '<br>'; }
      codeEl.innerHTML = html;
      pre.scrollLeft = ta.scrollLeft;
    }

    ta.value = panel.code || '';
    ta.addEventListener('input', function () {
      panel.code = ta.value;
      render();
      autoGrow();
      postUpdate(false);
    });
    ta.addEventListener('scroll', function () { pre.scrollLeft = ta.scrollLeft; });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = ta.selectionStart;
        var d = ta.selectionEnd;
        ta.value = ta.value.substring(0, s) + '\t' + ta.value.substring(d);
        ta.selectionStart = ta.selectionEnd = s + 1;
        panel.code = ta.value;
        render();
        autoGrow();
        postUpdate(false);
      } else if (e.key === 'Enter') {
        // Conservar la indentación de la línea actual (y ajustar un nivel
        // con las llaves { }), en lugar de saltar al inicio de la línea.
        e.preventDefault();
        var val = ta.value;
        var start = ta.selectionStart;
        var end = ta.selectionEnd;

        var lineStart = val.lastIndexOf('\n', start - 1) + 1;
        var currentLine = val.slice(lineStart, start);
        var m = currentLine.match(/^[ \t]*/);
        var indent = m ? m[0] : '';

        if (/\{\s*$/.test(currentLine)) {
          indent += '    ';
        } else if (/\}\s*$/.test(currentLine)) {
          indent = indent.replace(/(\t| {4})$/, '');
        }

        var inserted = '\n' + indent;
        ta.value = val.slice(0, start) + inserted + val.slice(end);
        var caret = start + inserted.length;
        ta.selectionStart = ta.selectionEnd = caret;
        panel.code = ta.value;
        render();
        autoGrow();
        postUpdate(false);
      }
    });

    wrap.appendChild(pre);
    wrap.appendChild(ta);
    render();
    autoGrow();

    codeEditors[panel.id] = {
      ta: ta,
      refresh: function () { ta.value = panel.code || ''; render(); autoGrow(); }
    };
    return wrap;
  }

  // Inserta "using namespace std;" después de los #include (solo C++).
  function addUsingStd(id) {
    var p = getPanel(id);
    if (!p || p.language !== 'cpp') { return; }
    var code = p.code || '';
    if (/using\s+namespace\s+std\s*;/.test(code)) { return; } // ya existe

    var lines = code.split('\n');
    var lastInclude = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*#include/.test(lines[i])) { lastInclude = i; }
    }
    if (lastInclude === -1) {
      code = 'using namespace std;\n' + code;
    } else {
      lines.splice(lastInclude + 1, 0, 'using namespace std;');
      code = lines.join('\n');
    }
    p.code = code;
    var ed = codeEditors[id];
    if (ed) { ed.refresh(); }
    postUpdate(false);
  }

  // ------------------- Editor de texto enriquecido --------------------------
  function textToHtml(s) {
    // Si ya es HTML (contiene etiquetas), se usa tal cual; si no, se escapa.
    if (/<[a-zA-Z/!]/.test(s)) { return s; }
    return escapeHtml(s).replace(/\n/g, '<br>');
  }

  function toolbarBtn(label, cmd, val, titleText) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small rt-btn';
    b.innerHTML = label;
    if (titleText) { b.title = titleText; }
    b.addEventListener('mousedown', function (e) {
      e.preventDefault(); // conserva la selección del texto al pulsar
      document.execCommand(cmd, false, val || null);
    });
    return b;
  }

  // Selector de color personalizado (guarda la selección antes de abrir el
  // diálogo nativo y la restaura al elegir, para aplicar texto o resaltado).
  function makeColorInput(cmd, titleText) {
    var inp = document.createElement('input');
    inp.type = 'color';
    inp.className = 'rt-colorpicker';
    inp.title = titleText;
    var saved = null;
    inp.addEventListener('mousedown', function () {
      var sel = window.getSelection();
      saved = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
    });
    inp.addEventListener('input', function () {
      if (saved) {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(saved);
      }
      document.execCommand(cmd, false, inp.value);
    });
    return inp;
  }

  // Aplica un tamaño de letra en píxeles envolviendo la selección en un <span>.
  function applyFontSize(px) {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.getRangeAt(0).collapsed) { return; }
    var range = sel.getRangeAt(0);
    var span = document.createElement('span');
    span.style.fontSize = px + 'px';
    try {
      span.appendChild(range.extractContents());
      range.insertNode(span);
      sel.removeAllRanges();
      var r = document.createRange();
      r.selectNodeContents(span);
      sel.addRange(r);
    } catch (err) { /* ignorar */ }
  }

  function makeSizeSelect() {
    var el = document.createElement('select');
    el.className = 'rt-size';
    el.title = 'Font size (px)';
    var sizes = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Size';
    el.appendChild(ph);
    for (var i = 0; i < sizes.length; i++) {
      var o = document.createElement('option');
      o.value = String(sizes[i]);
      o.textContent = sizes[i] + ' px';
      el.appendChild(o);
    }
    var saved = null;
    el.addEventListener('mousedown', function () {
      var s = window.getSelection();
      saved = (s && s.rangeCount > 0) ? s.getRangeAt(0).cloneRange() : null;
    });
    el.addEventListener('change', function () {
      var v = el.value;
      if (!v) { return; }
      if (saved) {
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(saved);
      }
      applyFontSize(parseInt(v, 10));
      el.selectedIndex = 0;
    });
    return el;
  }

  var RT_COLORS = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];

  function buildRichTextEditor(panel) {
    var wrap = document.createElement('div');
    wrap.className = 'rich-editor';

    var bar = document.createElement('div');
    bar.className = 'rt-toolbar';

    bar.appendChild(toolbarBtn('Paragraph', 'formatBlock', 'p', 'Normal paragraph (Ctrl+Alt+0)'));
    bar.appendChild(toolbarBtn('Heading', 'formatBlock', 'h2', 'Heading (Ctrl+Alt+1)'));
    bar.appendChild(toolbarBtn('Subheading', 'formatBlock', 'h3', 'Subheading (Ctrl+Alt+2)'));
    bar.appendChild(toolbarBtn('Quote', 'formatBlock', 'blockquote', 'Quote / block (Ctrl+Alt+Q)'));

    bar.appendChild(makeSizeSelect());

    bar.appendChild(toolbarBtn('• List', 'insertUnorderedList', null, 'Bullet list (Ctrl+Shift+8)'));
    bar.appendChild(toolbarBtn('1. List', 'insertOrderedList', null, 'Numbered list (Ctrl+Shift+7)'));

    bar.appendChild(toolbarBtn('<b>B</b>', 'bold', null, 'Bold (Ctrl+B)'));
    bar.appendChild(toolbarBtn('<i>I</i>', 'italic', null, 'Italic (Ctrl+I)'));
    bar.appendChild(toolbarBtn('<u>U</u>', 'underline', null, 'Underline (Ctrl+U)'));

    for (var ci = 0; ci < RT_COLORS.length; ci++) {
      (function (c) {
        var sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'rt-color';
        sw.style.background = c;
        sw.title = 'Color ' + c;
        sw.addEventListener('mousedown', function (e) {
          e.preventDefault();
          document.execCommand('foreColor', false, c);
        });
        bar.appendChild(sw);
      })(RT_COLORS[ci]);
    }

    // Custom text color and custom highlight color.
    bar.appendChild(makeColorInput('foreColor', 'Custom text color'));
    bar.appendChild(makeColorInput('hiliteColor', 'Custom highlight color'));

    bar.appendChild(toolbarBtn('Highlight', 'hiliteColor', '#ffe066', 'Highlight in yellow'));
    bar.appendChild(toolbarBtn('Remove highlight', 'hiliteColor', 'transparent', 'Remove highlight'));

    // Paragraph alignment.
    bar.appendChild(toolbarBtn('Left', 'justifyLeft', null, 'Align left'));
    bar.appendChild(toolbarBtn('Center', 'justifyCenter', null, 'Center'));
    bar.appendChild(toolbarBtn('Right', 'justifyRight', null, 'Align right'));
    bar.appendChild(toolbarBtn('Justify', 'justifyFull', null, 'Justify'));

    // Indentation.
    bar.appendChild(toolbarBtn('⇥', 'indent', null, 'Increase indent'));
    bar.appendChild(toolbarBtn('⇤', 'outdent', null, 'Decrease indent'));

    bar.appendChild(toolbarBtn('Clear formatting', 'removeFormat', null, 'Clear formatting of selection'));

    var ed = document.createElement('div');
    ed.className = 'rich-text';
    ed.setAttribute('contenteditable', 'true');
    ed.innerHTML = textToHtml(panel.text || '');

    ed.addEventListener('input', function () { panel.text = ed.innerHTML; postUpdate(false); });

    // Atajos de teclado para el formato.
    ed.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) { return; }
      var code = e.code || '';
      var handled = true;
      if (!e.altKey && !e.shiftKey && code === 'KeyB') { document.execCommand('bold'); }
      else if (!e.altKey && !e.shiftKey && code === 'KeyI') { document.execCommand('italic'); }
      else if (!e.altKey && !e.shiftKey && code === 'KeyU') { document.execCommand('underline'); }
      else if (e.shiftKey && !e.altKey && code === 'Digit7') { document.execCommand('insertOrderedList'); }
      else if (e.shiftKey && !e.altKey && code === 'Digit8') { document.execCommand('insertUnorderedList'); }
      else if (e.altKey && !e.shiftKey && code === 'Digit0') { document.execCommand('formatBlock', false, 'p'); }
      else if (e.altKey && !e.shiftKey && code === 'Digit1') { document.execCommand('formatBlock', false, 'h2'); }
      else if (e.altKey && !e.shiftKey && code === 'Digit2') { document.execCommand('formatBlock', false, 'h3'); }
      else if (e.altKey && !e.shiftKey && code === 'KeyQ') { document.execCommand('formatBlock', false, 'blockquote'); }
      else { handled = false; }
      if (handled) { e.preventDefault(); }
    });

    wrap.appendChild(bar);
    wrap.appendChild(ed);
    return wrap;
  }

  // Reconstruye la lista de paneles a partir del modelo.
  function renderPanels() {
    panelsEl.innerHTML = '';
    model.panels.forEach(function (panel, index) {
      var card = document.createElement('div');
      card.className = 'panel ' + panel.type;

      var header = document.createElement('div');
      header.className = 'panel-header';

      var title = document.createElement('span');
      title.className = 'panel-title';

      var upBtn = makeBtn('↑', function () { movePanel(index, -1); }, '', true);
      upBtn.disabled = index === 0;
      var downBtn = makeBtn('↓', function () { movePanel(index, 1); }, '', true);
      downBtn.disabled = index === model.panels.length - 1;

      // Asa para arrastrar y soltar (reordena el panel).
      var dragHandle = document.createElement('span');
      dragHandle.className = 'drag-handle';
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Drag to move the panel up/down';
      dragHandle.draggable = true;
      dragHandle.addEventListener('dragstart', function (e) {
        currentDragId = panel.id;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', panel.id); } catch (err) { /* ignorar */ }
        }
        card.classList.add('dragging');
      });
      dragHandle.addEventListener('dragend', function () {
        card.classList.remove('dragging');
        removeDropHighlight();
        currentDragId = null;
      });

      card.addEventListener('dragover', function (e) {
        if (!currentDragId || currentDragId === panel.id) { return; }
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
        removeDropHighlight();
        card.classList.add('drop-target');
      });
      card.addEventListener('drop', function (e) {
        if (!currentDragId || currentDragId === panel.id) { return; }
        e.preventDefault();
        e.stopPropagation();
        var draggedId = currentDragId;
        var rect = card.getBoundingClientRect();
        var before = (e.clientY - rect.top) < (rect.height / 2);
        currentDragId = null;
        removeDropHighlight();
        reorderTo(draggedId, panel.id, before);
      });

      header.appendChild(dragHandle);
      header.appendChild(title);
      header.appendChild(upBtn);
      header.appendChild(downBtn);

      if (panel.type === 'code') {
        var langSel = document.createElement('select');
        langSel.className = 'lang';
        var optCpp = document.createElement('option'); optCpp.value = 'cpp'; optCpp.textContent = 'C++';
        var optC = document.createElement('option'); optC.value = 'c'; optC.textContent = 'C';
        langSel.appendChild(optCpp);
        langSel.appendChild(optC);
        langSel.value = panel.language || 'cpp';
        langSel.addEventListener('change', function () {
          panel.language = langSel.value;
          postUpdate(false);
        });

        var runBtn = makeBtn('▶ Run', function () { runBlock(panel.id); });

        header.appendChild(langSel);
        header.appendChild(runBtn);

        // Para C++: botón que inserta "using namespace std;".
        if (panel.language === 'cpp') {
          var stdBtn = makeBtn('+std', function () { addUsingStd(panel.id); }, '', true);
          stdBtn.title = 'Adds "using namespace std;" so you can write without std::';
          header.insertBefore(stdBtn, langSel);
        }

        var editor = buildCodeEditor(panel);

        var out = document.createElement('div');
        out.className = 'output';
        out.dataset.output = panel.id;
        out.style.display = 'none';

        // Consola de entrada (visible solo mientras el programa se ejecuta).
        var consoleInput = document.createElement('input');
        consoleInput.type = 'text';
        consoleInput.className = 'console-input';
        consoleInput.placeholder = 'Type the input and press Enter…';
        consoleInput.style.display = 'none';
        consoleInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            var val = consoleInput.value;
            if (!val) { return; }
            consoleInput.value = '';
            vscode.postMessage({ type: 'stdin', id: panel.id, text: val });
            var echoOut = getOutputEl(panel.id);
            if (echoOut) {
              echoOut.style.display = 'block';
              // Eco del dato tecleado seguido de salto de línea (como la terminal).
              echoOut.innerHTML += '<span class="run-input">' + escapeHtml(val) + '</span>\n';
              echoOut.scrollTop = echoOut.scrollHeight;
            }
          }
        });
        consoleEls[panel.id] = consoleInput;

        card.appendChild(header);
        card.appendChild(editor);
        card.appendChild(out);
        card.appendChild(consoleInput);
      } else {
        // Panel de texto: editor enriquecido.
        card.appendChild(header);
        card.appendChild(buildRichTextEditor(panel));
      }

      var delBtn = makeBtn('Eliminar', function () { deletePanel(panel.id); }, 'danger');
      header.appendChild(delBtn);

      // Botones para añadir un panel justo debajo de este.
      var footer = document.createElement('div');
      footer.className = 'panel-footer';
      footer.appendChild(makeBtn('+ Text', function () { addTextAfter(panel.id); }, '', true));
      footer.appendChild(makeBtn('+ Code', function () { addCodeAfter(panel.id); }, '', true));
      card.appendChild(footer);

      panelsEl.appendChild(card);

      // Ya en el DOM: reajustar la altura del editor de código a su contenido.
      var ced = codeEditors[panel.id];
      if (ced && ced.refresh) { ced.refresh(); }
    });
  }

  function defaultCodeText() {
    return [
      '// Write your C or C++ code here',
      '#include <iostream>',
      '',
      'using namespace std;',
      '',
      'int main() {',
      '    cout << "Hello, world" << endl;',
      '    return 0;',
      '}'
    ].join('\n');
  }

  function makeTextPanel() {
    return { id: nextId('text'), type: 'text', language: 'cpp', code: '', text: '' };
  }

  function makeCodePanel() {
    return { id: nextId('code'), type: 'code', language: 'cpp', code: defaultCodeText(), text: '' };
  }

  function addText() {
    model.panels.push(makeTextPanel());
    renderPanels();
    postUpdate(false);
  }

  function addCode() {
    model.panels.push(makeCodePanel());
    renderPanels();
    postUpdate(false);
  }

  // Inserta un panel justo después del panel indicado (por su id).
  function insertAfter(id, panel) {
    var idx = -1;
    for (var i = 0; i < model.panels.length; i++) {
      if (model.panels[i].id === id) { idx = i; break; }
    }
    if (idx === -1) {
      model.panels.push(panel);
    } else {
      model.panels.splice(idx + 1, 0, panel);
    }
    renderPanels();
    postUpdate(false);
  }

  function addTextAfter(id) {
    insertAfter(id, makeTextPanel());
  }

  function addCodeAfter(id) {
    insertAfter(id, makeCodePanel());
  }

  function deletePanel(id) {
    model.panels = model.panels.filter(function (p) { return p.id !== id; });
    renderPanels();
    postUpdate(false);
  }

  function movePanel(index, delta) {
    var to = index + delta;
    if (to < 0 || to >= model.panels.length) { return; }
    var arr = model.panels;
    var tmp = arr[index]; arr[index] = arr[to]; arr[to] = tmp;
    renderPanels();
    postUpdate(false);
  }

  function removeDropHighlight() {
    var all = panelsEl.querySelectorAll('.drop-target');
    for (var i = 0; i < all.length; i++) { all[i].classList.remove('drop-target'); }
  }

  // Mueve "draggedId" para dejarlo antes o después de "targetId".
  function reorderTo(draggedId, targetId, before) {
    if (draggedId === targetId) { return; }
    var from = -1;
    for (var i = 0; i < model.panels.length; i++) {
      if (model.panels[i].id === draggedId) { from = i; break; }
    }
    if (from === -1) { return; }

    var arr = model.panels;
    var item = arr.splice(from, 1)[0];

    var t = -1;
    for (var j = 0; j < arr.length; j++) {
      if (arr[j].id === targetId) { t = j; break; }
    }
    if (t === -1) { arr.push(item); }
    else { arr.splice(before ? t : t + 1, 0, item); }

    renderPanels();
    postUpdate(false);
  }

  function clearOutput(id) {
    var out = getOutputEl(id);
    if (out) { out.style.display = 'none'; out.textContent = ''; }
  }

  function runBlock(id) {
    var panel = getPanel(id);
    if (!panel) { return; }
    var out = getOutputEl(id);
    if (out) { out.style.display = 'block'; out.className = 'output running'; out.textContent = 'Compiling…'; }
    setConsoleVisible(id, false);
    vscode.postMessage({ type: 'run', id: id, code: panel.code || '', language: panel.language || 'cpp' });
  }

  function runAll() {
    model.panels.forEach(function (p) { if (p.type === 'code') { clearOutput(p.id); setConsoleVisible(p.id, false); } });
    vscode.postMessage({ type: 'runAll', doc: model });
  }

  // Mensajes que llegan de la extensión.
  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg && msg.type) {
      case 'init':
        model = msg.doc && msg.doc.panels ? msg.doc : { panels: [] };
        renderPanels();
        break;
      case 'runStatus': {
        var out = getOutputEl(msg.id);
        if (!out) { break; }
        out.style.display = 'block';
        var statusText = escapeHtml(msg.message || '');
        out.innerHTML = msg.status === 'error'
          ? '<span class="run-err">' + statusText + '</span>'
          : statusText;
        if (msg.status === 'error') { out.className = 'output error'; setConsoleVisible(msg.id, false); }
        else if (msg.status === 'running') { out.className = 'output running'; setConsoleVisible(msg.id, true); }
        else if (msg.status === 'success') { out.className = 'output success'; }
        else { out.className = 'output running'; }
        break;
      }
      case 'runOutput': {
        var out = getOutputEl(msg.id);
        if (!out) { break; }
        out.style.display = 'block';
        if (out.className !== 'output running') { out.className = 'output running'; }
        var runText = escapeHtml(msg.text);
        if (msg.stream === 'err') {
          out.innerHTML += '<span class="run-err">' + runText + '</span>';
        } else {
          out.innerHTML += runText;
        }
        out.scrollTop = out.scrollHeight;
        break;
      }
      case 'runDone': {
        var out = getOutputEl(msg.id);
        if (!out) { break; }
        out.style.display = 'block';
        if (out.innerHTML) { out.innerHTML += '\n'; }
        out.innerHTML += '<span class="run-done">' + escapeHtml(msg.message) + '</span>';
        out.className = msg.ok ? 'output success' : 'output error';
        out.scrollTop = out.scrollHeight;
        setConsoleVisible(msg.id, false);
        break;
      }
    }
  });

  // Pedir el estado inicial al abrir.
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Proveedor del Custom Editor (CustomTextEditorProvider)
// ---------------------------------------------------------------------------

/**
 * Usamos `CustomTextEditorProvider`: el documento subyacente es un TextDocument
 * real, y VS Code guarda el archivo con su mecanismo normal (Ctrl+S / autoSave).
 * Nosotros reescribimos el buffer mediante `WorkspaceEdit` cuando cambia el
 * estado.
 */
class CppNotesEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CppNotesEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Llamado por VS Code al abrir (o reabrir) el editor de un `.cppnotes`.
   * Firma oficial:
   *   resolveCustomTextEditor(document: TextDocument,
   *                           webviewPanel: WebviewPanel,
   *                           token: CancellationToken): void | Thenable<void>
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewPanel.webview.html = getHtmlForWebview(webview);

    let state: CppNotesDoc = parseDocumentText(document.getText());
    let applyingEdit = false;

    /** Reescribe el buffer del documento con el JSON serializado (marca "dirty"). */
    const writeToDocument = async (doc: CppNotesDoc): Promise<void> => {
      const text = serializeDoc(doc);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, fullRange, text);
      applyingEdit = true;
      try {
        await vscode.workspace.applyEdit(edit);
      } finally {
        applyingEdit = false;
      }
    };

    /**
     * Guarda en disco. La API pública de TextDocument NO expone `save()`; la
     * forma estándar es ejecutar el comando de guardar del editor activo (el
     * webview tiene el foco, de modo que se guarda este documento).
     */
    const saveToDisk = async (): Promise<void> => {
      await vscode.commands.executeCommand('workbench.action.files.save');
    };

    const disposables: vscode.Disposable[] = [];

    // Sincroniza si el documento cambia desde fuera (Git, otro editor, etc.).
    disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) { return; }
        if (applyingEdit) { return; }
        const next = parseDocumentText(e.document.getText());
        state = next;
        webview.postMessage({ type: 'init', doc: next });
      }),
    );

    // Mensajes del webview (postMessage -> onDidReceiveMessage).
    disposables.push(
      webview.onDidReceiveMessage(async (message: any) => {
        switch (message?.type) {
          case 'ready':
            webview.postMessage({ type: 'init', doc: state });
            break;

          case 'update':
            state = message.doc as CppNotesDoc;
            await writeToDocument(state);
            break;

          case 'save':
            state = message.doc as CppNotesDoc;
            await writeToDocument(state);
            await saveToDisk();
            break;

          case 'run': {
            const block: RunnableBlock = {
              id: message.id as string,
              language: (message.language === 'c' ? 'c' : 'cpp') as CodeLanguage,
              code: message.code as string,
            };
            const generation = newRun();
            await runOneBlock(webviewPanel, block, generation);
            break;
          }

          case 'runAll': {
            const doc = message.doc as CppNotesDoc | undefined;
            const blocks: RunnableBlock[] = (doc?.panels || [])
              .filter((p) => p.type === 'code' && p.code && p.code.trim())
              .map((p) => ({ id: p.id, language: p.language, code: p.code }));
            const generation = newRun();
            await runAllBlocks(webviewPanel, blocks, generation);
            break;
          }

          case 'stdin': {
            // El usuario tecleó una línea en la consola del panel.
            const child = runningByPanel.get(message.id as string);
            if (child && child.stdin && !child.killed) {
              child.stdin.write(`${String(message.text ?? '')}\n`);
            }
            break;
          }

          case 'stop':
            cancelRun();
            break;
        }
      }),
    );

    webviewPanel.onDidDispose(() => {
      disposables.forEach((d) => d.dispose());
      cancelRun();
    });
  }
}

// ---------------------------------------------------------------------------
// Activación / desactivación
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  outputChannel.appendLine('CppNotesInteractive activado.');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(CppNotesEditorProvider.register(context));

  // Comandos de la paleta (la interacción principal está en los botones del webview).
  context.subscriptions.push(
    vscode.commands.registerCommand('cppnotes.runAll', () => {
      vscode.window.showInformationMessage('CppNotes: use the "Run all" button inside a .cppnotes editor.');
    }),
    vscode.commands.registerCommand('cppnotes.addTextPanel', () => {
      vscode.window.showInformationMessage('CppNotes: use the "+ Add text" button inside a .cppnotes editor.');
    }),
    vscode.commands.registerCommand('cppnotes.addCodePanel', () => {
      vscode.window.showInformationMessage('CppNotes: use the "+ Add code" button inside a .cppnotes editor.');
    }),
  );
}

export function deactivate(): void {
  // Todo está registrado en context.subscriptions: nada que limpiar.
}
