import { ZetaHelperMain } from './vendor/zetajs/zetaHelper.js';
import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);
const engineEl = $('engine');
const engineText = $('engine-text');
const dropEl = $('drop');
const pickerEl = $('picker');
const listEl = $('files');
const msgEl = $('msg');
const toolbarEl = $('toolbar');
const zipBtn = $('zip-all');

const CONVERT_TIMEOUT_MS = 4 * 60 * 1000;

const items = []; // { id, file, state: queued|converting|done|failed, pdf, url, error }
let nextId = 1;
let engineReady = false;
let busy = false;
let stuck = false;
let zHM = null;
let watchdog = null;

function setEngine(state, text) {
  engineEl.dataset.state = state;
  engineText.textContent = text;
}

function showMessage(text) {
  msgEl.textContent = text || '';
}

function baseName(name) {
  const n = name.lastIndexOf('.');
  return n > 0 ? name.slice(0, n) : name;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function render() {
  listEl.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'file';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.file.name + '  (' + formatSize(item.file.size) + ')';
    li.appendChild(name);

    const state = document.createElement('div');
    state.className = 'state';
    if (item.state === 'queued') state.textContent = engineReady ? 'Waiting' : 'Waiting for the converter to start';
    if (item.state === 'converting') state.textContent = 'Converting…';
    if (item.state === 'done') { state.textContent = 'Done'; state.classList.add('ok'); }
    if (item.state === 'failed') { state.textContent = item.error || 'Could not convert this file'; state.classList.add('bad'); }
    li.appendChild(state);

    if (item.state === 'done') {
      const actions = document.createElement('div');
      actions.className = 'actions';

      const view = document.createElement('a');
      view.className = 'btn secondary small';
      view.textContent = 'View';
      view.href = item.url;
      view.target = '_blank';
      view.rel = 'noopener';
      actions.appendChild(view);

      const dl = document.createElement('a');
      dl.className = 'btn small';
      dl.textContent = 'Download PDF';
      dl.href = item.url;
      dl.download = baseName(item.file.name) + '.pdf';
      actions.appendChild(dl);

      li.appendChild(actions);
    }
    listEl.appendChild(li);
  }
  const doneCount = items.filter((i) => i.state === 'done').length;
  toolbarEl.hidden = doneCount < 2;
  zipBtn.textContent = 'Download all ' + doneCount + ' PDFs (ZIP)';
}

function addFiles(fileList) {
  showMessage('');
  const rejected = [];
  for (const file of fileList) {
    if (!/\.pub$/i.test(file.name)) { rejected.push(file.name); continue; }
    items.push({ id: nextId++, file, state: 'queued', pdf: null, url: null, error: '' });
  }
  if (rejected.length) {
    showMessage(
      rejected.length === 1
        ? '"' + rejected[0] + '" is not a Publisher (.pub) file, so it was skipped.'
        : rejected.length + ' files were skipped because they are not Publisher (.pub) files.'
    );
  }
  render();
  pump();
}

async function pump() {
  if (!engineReady || busy || stuck) return;
  const item = items.find((i) => i.state === 'queued');
  if (!item) return;
  busy = true;
  item.state = 'converting';
  render();
  try {
    const data = new Uint8Array(await item.file.arrayBuffer());
    window.FS.writeFile('/tmp/input.pub', data);
    watchdog = setTimeout(() => {
      item.state = 'failed';
      item.error = 'This file took too long to convert';
      stuck = true;
      showMessage('The converter stopped responding. Reload this page to keep converting files.');
      render();
    }, CONVERT_TIMEOUT_MS);
    zHM.thrPort.postMessage({ cmd: 'convert', id: item.id, name: item.file.name, from: '/tmp/input.pub', to: '/tmp/output.pdf' });
  } catch (err) {
    finish(item, null, 'Could not read this file');
  }
}

function finish(item, pdf, error) {
  clearTimeout(watchdog);
  if (pdf && pdf.length > 100) {
    item.pdf = pdf;
    item.url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    item.state = 'done';
  } else {
    item.state = 'failed';
    item.error = error || 'Could not convert this file';
  }
  busy = false;
  render();
  pump();
}

function onConverted(data) {
  const item = items.find((i) => i.id === data.id);
  if (!item || item.state !== 'converting') return;
  let pdf = null;
  try {
    pdf = window.FS.readFile(data.to);
  } catch (err) {
    /* handled below */
  }
  try { window.FS.unlink(data.from); } catch (err) { /* ignore */ }
  try { window.FS.unlink(data.to); } catch (err) { /* ignore */ }
  finish(item, pdf, 'Conversion produced no output');
}

function onFailed(data) {
  const item = items.find((i) => i.id === data.id);
  if (!item || item.state !== 'converting') return;
  try { window.FS.unlink(data.from); } catch (err) { /* ignore */ }
  finish(item, null, 'This file could not be opened');
}

function downloadZip() {
  const used = new Set();
  const files = [];
  for (const item of items) {
    if (item.state !== 'done') continue;
    let name = baseName(item.file.name) + '.pdf';
    let n = 2;
    while (used.has(name)) name = baseName(item.file.name) + ' (' + n++ + ').pdf';
    used.add(name);
    files.push({ name, data: item.pdf });
  }
  if (!files.length) return;
  const url = URL.createObjectURL(makeZip(files));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'converted-pdfs.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function startEngine() {
  setEngine('loading', 'Starting the converter. The first visit downloads about 50 MB, so it can take a minute. After that it loads much faster.');
  try {
    zHM = new ZetaHelperMain('office_thread.js', { threadJsType: 'module' });
  } catch (err) {
    setEngine('error', 'The converter could not start: ' + (err && err.message ? err.message : err));
    return;
  }
  setTimeout(() => {
    if (!engineReady && engineEl.dataset.state === 'loading') {
      setEngine('error', 'The converter is taking too long to start. Check your connection, then reload this page.');
    }
  }, 4 * 60 * 1000);
  zHM.start(() => {
    zHM.thrPort.onmessage = (e) => {
      switch (e.data.cmd) {
        case 'start':
          engineReady = true;
          setEngine('ready', 'Converter ready. Your files stay on this device.');
          render();
          pump();
          break;
        case 'converted':
          onConverted(e.data);
          break;
        case 'failed':
          onFailed(e.data);
          break;
        default:
          throw Error('Unknown message command: ' + e.data.cmd);
      }
    };
  });
}

// --- wiring ---
pickerEl.addEventListener('change', () => {
  addFiles(Array.from(pickerEl.files));
  pickerEl.value = '';
});
['dragenter', 'dragover'].forEach((t) =>
  dropEl.addEventListener(t, (e) => { e.preventDefault(); dropEl.classList.add('over'); })
);
['dragleave', 'drop'].forEach((t) =>
  dropEl.addEventListener(t, (e) => { e.preventDefault(); dropEl.classList.remove('over'); })
);
dropEl.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files) addFiles(Array.from(e.dataTransfer.files));
});
zipBtn.addEventListener('click', downloadZip);

if (window.crossOriginIsolated) {
  startEngine();
} else {
  // The helper script reloads the page once after it is set up. If we are still here, the browser is blocking it.
  setEngine('loading', 'Setting things up…');
  setTimeout(() => {
    if (!window.crossOriginIsolated) {
      setEngine(
        'error',
        'This browser is blocking the converter. Try Safari, Chrome, Edge or Firefox in a normal (not private) window, then reload.'
      );
    }
  }, 5000);
}
