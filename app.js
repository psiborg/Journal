/* ============================================================
   JOURNAL — app.js
   Calendar-based Markdown Note-taking PWA
   ============================================================ */

'use strict';

const APP_VERSION   = '1.0.0';
const CACHE_VERSION = 'journal-v1'; // must match CACHE in sw.js

// --- Minimal Markdown Parser ------------------------------------------------

const MD = (() => {
  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function parseInline(s) {
    return s
      // Bold+italic
      .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      // Bold
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.*?)__/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/_((?!_).*?)_/g, '<em>$1</em>')
      // Strikethrough
      .replace(/~~(.*?)~~/g, '<del>$1</del>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Images
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Auto-links
      .replace(/(?<!\])\b(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  function parse(md) {
    const lines = md.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim();
        let code = '';
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code += escapeHtml(lines[i]) + '\n';
          i++;
        }
        html += `<pre><code class="lang-${escapeHtml(lang)}">${code}</code></pre>`;
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        html += '<hr />';
        i++;
        continue;
      }

      // Headings
      const hm = line.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        const level = hm[1].length;
        html += `<h${level}>${parseInline(hm[2])}</h${level}>`;
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        let bq = '';
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          bq += lines[i].replace(/^>\s?/, '') + '\n';
          i++;
        }
        html += `<blockquote>${parse(bq.trim())}</blockquote>`;
        continue;
      }

      // Unordered list
      if (/^(\s*)([-*+])\s/.test(line)) {
        let items = '';
        while (i < lines.length && /^\s*([-*+])\s/.test(lines[i])) {
          const txt = lines[i].replace(/^\s*([-*+])\s/, '');
          // Task list
          const task = txt.match(/^\[([ xX])\]\s+(.*)/);
          if (task) {
            const checked = task[1].toLowerCase() === 'x' ? 'checked' : '';
            items += `<li class="task-item"><input type="checkbox" ${checked} disabled /> ${parseInline(task[2])}</li>`;
          } else {
            items += `<li>${parseInline(txt)}</li>`;
          }
          i++;
        }
        html += `<ul>${items}</ul>`;
        continue;
      }

      // Ordered list
      if (/^\d+\.\s/.test(line)) {
        let items = '';
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
          const txt = lines[i].replace(/^\d+\.\s/, '');
          items += `<li>${parseInline(txt)}</li>`;
          i++;
        }
        html += `<ol>${items}</ol>`;
        continue;
      }

      // Table
      if (/\|/.test(line) && i + 1 < lines.length && /^[\|:\- ]+$/.test(lines[i+1])) {
        const headers = line.split('|').map(h => h.trim()).filter(h => h);
        i += 2; // skip separator
        let rows = '';
        while (i < lines.length && /\|/.test(lines[i])) {
          const cells = lines[i].split('|').map(c => c.trim()).filter(c => c);
          rows += '<tr>' + cells.map(c => `<td>${parseInline(c)}</td>`).join('') + '</tr>';
          i++;
        }
        const thead = '<tr>' + headers.map(h => `<th>${parseInline(h)}</th>`).join('') + '</tr>';
        html += `<table><thead>${thead}</thead><tbody>${rows}</tbody></table>`;
        continue;
      }

      // Empty line → paragraph break
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph — collect consecutive non-special lines
      let para = '';
      while (i < lines.length &&
             lines[i].trim() !== '' &&
             !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s|(-{3,}|\*{3,}|_{3,})$)/.test(lines[i])) {
        para += (para ? ' ' : '') + lines[i];
        i++;
      }
      if (para) html += `<p>${parseInline(para)}</p>`;
    }

    return html;
  }

  return { parse };
})();


// --- State ------------------------------------------------------------------

const state = {
  currentDate:  null,   // 'YYYY-MM-DD'
  currentNoteId: null,  // uuid of open note
  calYear: 0,
  calMonth: 0,
  // notes: { 'YYYY-MM-DD': [ { id, content, updatedAt }, ... ] }
  notes: {},
  splitEnabled: true,
  saveTimer: null,
  isDragging: false,
};

const STORAGE_KEY  = 'journal_notes_v1';
const SETTINGS_KEY = 'journal_settings';

// --- Settings Store -----------------------------------------------------------
// Single JSON object under SETTINGS_KEY:
// { vscodeTheme, font, fontSize }

const Settings = (() => {
  let _cache = null;

  function _load() {
    if (_cache) return _cache;
    try {
      _cache = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch { _cache = {}; }
    return _cache;
  }

  function _save() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_cache));
  }

  function get(key, fallback = null) {
    return _load()[key] ?? fallback;
  }

  function set(key, value) {
    _load()[key] = value;
    _save();
  }

  function remove(key) {
    delete _load()[key];
    _save();
  }

  return { get, set, remove };
})();


// --- DOM Refs ----------------------------------------------------------------

const $ = id => document.getElementById(id);

const els = {
  html:           document.documentElement,
  sidebarToggle:  $('sidebar-toggle'),
  sidebar:        $('sidebar'),
  sidebarOverlay: $('sidebar-overlay'),
  prevMonth:      $('prev-month'),
  nextMonth:      $('next-month'),
  calMonthLabel:  $('cal-month-label'),
  calDays:        $('cal-days'),
  notesList:      $('notes-list'),
  newNoteBtn:     $('new-note-btn'),
  topbarDate:     $('topbar-date'),
  splitToggle:    $('split-toggle'),
  deleteNoteBtn:  $('delete-note-btn'),
  emptyState:     $('empty-state'),
  splitContainer: $('split-container'),
  editorPane:     $('editor-pane'),
  splitHandle:    $('split-handle'),
  previewPane:    $('preview-pane'),
  mdEditor:       $('md-editor'),
  mdPreview:      $('md-preview'),
  statusBar:      $('status-bar'),
  statusDate:     $('status-date'),
  statusWords:    $('status-words'),
  statusSaved:    $('status-saved'),
  noteTabsBar:    $('note-tabs-bar'),
  noteTabs:       $('note-tabs'),
  addNoteTab:     $('add-note-tab'),
};


// --- Storage -----------------------------------------------------------------

function loadNotes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state.notes = raw ? JSON.parse(raw) : {};
  } catch { state.notes = {}; }
}

function saveNotes() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.notes));
  } catch (e) {
    showToast('Storage full — note may not have saved.');
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}


// --- Date Helpers -------------------------------------------------------------

function todayKey() {
  const d = new Date();
  return fmtKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function fmtKey(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDateLong(dateObj) {
  return dateObj.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

function fmtDateShort(key) {
  return parseKey(key).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];


// --- Note Accessors -----------------------------------------------------------

function notesForDay(dateKey) {
  return state.notes[dateKey] || [];
}

function getNoteById(dateKey, id) {
  return notesForDay(dateKey).find(n => n.id === id) || null;
}

function dayHasContent(dateKey) {
  return notesForDay(dateKey).some(n => n.content.trim());
}

function noteIndex(dateKey, id) {
  return notesForDay(dateKey).findIndex(n => n.id === id);
}


// --- Calendar ----------------------------------------------------------------

function renderCalendar() {
  const { calYear: y, calMonth: m } = state;
  els.calMonthLabel.textContent = `${MONTHS[m]} ${y}`;

  const today = todayKey();
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();

  let html = '';

  for (let p = firstDay - 1; p >= 0; p--) {
    const d = prevDays - p;
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    const key = fmtKey(py, pm + 1, d);
    html += calDayHtml(d, key, 'cal-other-month', today);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = fmtKey(y, m + 1, d);
    html += calDayHtml(d, key, '', today);
  }

  const total = firstDay + daysInMonth;
  const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let d = 1; d <= trailing; d++) {
    const nm = m === 11 ? 0 : m + 1;
    const ny = m === 11 ? y + 1 : y;
    const key = fmtKey(ny, nm + 1, d);
    html += calDayHtml(d, key, 'cal-other-month', today);
  }

  els.calDays.innerHTML = html;

  els.calDays.querySelectorAll('.cal-day:not(.cal-empty)').forEach(el => {
    el.addEventListener('click', () => {
      openDay(el.dataset.key);
      closeSidebar();
    });
  });
}

function calDayHtml(d, key, extra, today) {
  const hasNote = dayHasContent(key);
  const noteCount = notesForDay(key).filter(n => n.content.trim()).length;
  const isToday    = key === today;
  const isSelected = key === state.currentDate;
  const classes = ['cal-day', extra,
    isToday    ? 'cal-today'    : '',
    isSelected ? 'cal-selected' : '',
    hasNote    ? 'has-note'     : '',
  ].filter(Boolean).join(' ');
  const countBadge = noteCount > 1
    ? `<span class="cal-note-count">${noteCount}</span>` : '';
  return `<div class="${classes}" data-key="${key}" role="button" tabindex="0" aria-label="${fmtDateShort(key)}">${d}${countBadge}</div>`;
}


// --- Notes List (sidebar) -----------------------------------------------------

function renderNotesList() {
  // Collect all individual notes sorted newest-first
  const allNotes = [];
  for (const [dateKey, arr] of Object.entries(state.notes)) {
    for (const note of arr) {
      if (note.content.trim()) allNotes.push({ dateKey, note });
    }
  }
  allNotes.sort((a, b) => {
    const dateCmp = b.dateKey.localeCompare(a.dateKey);
    if (dateCmp !== 0) return dateCmp;
    return (b.note.updatedAt || '').localeCompare(a.note.updatedAt || '');
  });

  if (!allNotes.length) {
    els.notesList.innerHTML = '<p class="notes-empty-msg">No notes yet.<br>Click a day to start writing.</p>';
    return;
  }

  els.notesList.innerHTML = allNotes.map(({ dateKey, note }) => {
    const isActive = dateKey === state.currentDate && note.id === state.currentNoteId;
    const title   = extractTitle(note.content);
    const preview = extractPreview(note.content);
    const dayCount = notesForDay(dateKey).filter(n => n.content.trim()).length;
    return `
      <div class="note-item${isActive ? ' active' : ''}" data-date="${dateKey}" data-id="${note.id}" role="listitem" tabindex="0">
        <div class="note-item-date">
          ${fmtDateShort(dateKey)}
          ${dayCount > 1 ? `<span class="note-item-count">${dayCount} notes</span>` : ''}
        </div>
        <div class="note-item-title">${escHtml(title)}</div>
        ${preview ? `<div class="note-item-preview">${escHtml(preview)}</div>` : ''}
      </div>`;
  }).join('');

  els.notesList.querySelectorAll('.note-item').forEach(el => {
    const open = () => { openNote(el.dataset.date, el.dataset.id); closeSidebar(); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function extractTitle(content) {
  const lines = (content || '').split('\n');
  for (const l of lines) {
    const m = l.match(/^#{1,3}\s+(.*)/);
    if (m) return m[1];
    if (l.trim()) return l.trim().slice(0, 60);
  }
  return 'Untitled';
}

function extractPreview(content) {
  const lines = (content || '').split('\n');
  let first = true;
  for (const l of lines) {
    const clean = l.replace(/^#{1,6}\s+/, '').replace(/[*_`~]/g, '').trim();
    if (!clean) continue;
    if (first) { first = false; continue; }
    return clean.slice(0, 80);
  }
  return '';
}


// --- Note Tabs Bar ------------------------------------------------------------

function renderNoteTabs() {
  const dateKey = state.currentDate;
  if (!dateKey) return;

  const notes = notesForDay(dateKey);
  els.noteTabs.innerHTML = notes.map((note, i) => {
    const isActive = note.id === state.currentNoteId;
    const label = extractTitle(note.content) || `Note ${i + 1}`;
    return `
      <div class="note-tab${isActive ? ' active' : ''}" data-id="${note.id}" role="tab" tabindex="0" aria-selected="${isActive}" title="${escHtml(label)}">
        <span class="note-tab-label">${escHtml(label.slice(0, 22))}${label.length > 22 ? '…' : ''}</span>
        ${notes.length > 1
          ? `<button class="note-tab-close" data-id="${note.id}" aria-label="Delete note" tabindex="-1">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
             </button>`
          : ''}
      </div>`;
  }).join('');

  // Tab click → switch note
  els.noteTabs.querySelectorAll('.note-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      if (e.target.closest('.note-tab-close')) return;
      openNote(dateKey, tab.dataset.id);
    });
    tab.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.classList.contains('note-tab-close')) {
        openNote(dateKey, tab.dataset.id);
      }
    });
  });

  // Close-tab (delete) click
  els.noteTabs.querySelectorAll('.note-tab-close').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteNoteById(dateKey, btn.dataset.id);
    });
  });
}


// --- Open Day / Note ----------------------------------------------------------

/** Open a day — picks first existing note or creates one */
function openDay(dateKey) {
  if (!state.notes[dateKey] || state.notes[dateKey].length === 0) {
    state.notes[dateKey] = [{ id: uid(), content: '', updatedAt: null }];
  }
  openNote(dateKey, state.notes[dateKey][0].id);
}

/** Open a specific note by date + id */
function openNote(dateKey, noteId) {
  // Ensure the day array exists
  if (!state.notes[dateKey]) state.notes[dateKey] = [];

  let note = getNoteById(dateKey, noteId);
  if (!note) {
    note = { id: noteId || uid(), content: '', updatedAt: null };
    state.notes[dateKey].push(note);
  }

  state.currentDate   = dateKey;
  state.currentNoteId = note.id;

  // Show editor
  els.emptyState.style.display     = 'none';
  els.splitContainer.style.display = 'flex';
  els.statusBar.style.display      = 'flex';
  els.deleteNoteBtn.style.display  = 'flex';
  els.noteTabsBar.style.display    = 'flex';

  els.mdEditor.value = note.content;
  renderPreview();
  updateStatus();
  updateTopbarDate(dateKey);
  renderNoteTabs();
  renderCalendar();
  renderNotesList();

  els.mdEditor.focus();
}

function updateTopbarDate(key) {
  const d = parseKey(key);
  els.topbarDate.textContent = fmtDateLong(d);
  els.statusDate.textContent = fmtDateShort(key);
}

/** Create a new blank note for today and open it */
function newNoteToday() {
  const key = todayKey();
  addNoteToDay(key);
}

/** Create a new note for a given day */
function addNoteToDay(dateKey) {
  if (!state.notes[dateKey]) state.notes[dateKey] = [];
  const newNote = { id: uid(), content: '', updatedAt: null };
  state.notes[dateKey].push(newNote);
  openNote(dateKey, newNote.id);
}


// --- Editor ------------------------------------------------------------------

els.mdEditor.addEventListener('input', () => {
  renderPreview();
  updateStatus();
  scheduleSave();
  // Refresh tab label live as title changes
  renderNoteTabs();
});

// Tab key + keyboard shortcuts in editor
els.mdEditor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = els.mdEditor.selectionStart;
    const end   = els.mdEditor.selectionEnd;
    els.mdEditor.value = els.mdEditor.value.slice(0, start) + '  ' + els.mdEditor.value.slice(end);
    els.mdEditor.selectionStart = els.mdEditor.selectionEnd = start + 2;
    renderPreview();
    scheduleSave();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentNote(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); applyFormat('bold'); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); applyFormat('italic'); }
  if ((e.ctrlKey || e.metaKey) && e.key === '`') { e.preventDefault(); applyFormat('inlinecode'); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); applyFormat('link'); }
});

// --- Image Store (IndexedDB) --------------------------------------------------

const ImageStore = (() => {
  const DB_NAME    = 'journal_images';
  const STORE_NAME = 'images';
  const DB_VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = () => reject(req.error);
    });
  }

  async function save(id, dataUrl, mimeType, name) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id, dataUrl, mimeType, name });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function get(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  // Resolve all journal-img://ID occurrences in an HTML string to data URLs
  async function resolveInHtml(html) {
    const ids = [...new Set([...html.matchAll(/journal-img:\/\/([a-z0-9]+)/g)].map(m => m[1]))];
    if (!ids.length) return html;
    const records = await Promise.all(ids.map(id => get(id)));
    let resolved = html;
    ids.forEach((id, i) => {
      const rec = records[i];
      const replacement = rec ? rec.dataUrl : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
      resolved = resolved.replaceAll(`journal-img://${id}`, replacement);
    });
    return resolved;
  }

  return { save, get, remove, resolveInHtml, _openDb: open };
})();

function renderPreview() {
  const md = els.mdEditor.value;
  if (!md.trim()) {
    els.mdPreview.innerHTML = '<p style="color:var(--text-muted);font-style:italic">Preview will appear here…</p>';
    return;
  }
  const rawHtml = MD.parse(md);
  if (rawHtml.includes('journal-img://')) {
    ImageStore.resolveInHtml(rawHtml).then(resolved => {
      els.mdPreview.innerHTML = resolved;
    });
  } else {
    els.mdPreview.innerHTML = rawHtml;
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrentNote, 800);
}

function saveCurrentNote() {
  if (!state.currentDate || !state.currentNoteId) return;
  const idx = noteIndex(state.currentDate, state.currentNoteId);
  if (idx === -1) return;
  state.notes[state.currentDate][idx] = {
    id: state.currentNoteId,
    content: els.mdEditor.value,
    updatedAt: new Date().toISOString(),
  };
  saveNotes();
  renderNotesList();
  renderCalendar();
  flashSaved();
}

function flashSaved() {
  els.statusSaved.textContent = '✓ Saved';
  els.statusSaved.classList.add('visible');
  clearTimeout(els._savedTimer);
  els._savedTimer = setTimeout(() => els.statusSaved.classList.remove('visible'), 2000);
}

function updateStatus() {
  const text = els.mdEditor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  els.statusWords.textContent = `${words} word${words !== 1 ? 's' : ''} · ${chars} char${chars !== 1 ? 's' : ''}`;
}


// --- Split View ---------------------------------------------------------------

function initSplitView() {
  // Default: editor 50%, preview 50%
  els.editorPane.style.flex = '1';
  els.previewPane.style.flex = '1';
}

els.splitToggle.addEventListener('click', () => {
  state.splitEnabled = !state.splitEnabled;
  if (state.splitEnabled) {
    els.splitContainer.classList.remove('no-preview');
    els.splitToggle.title = 'Toggle split view';
  } else {
    els.splitContainer.classList.add('no-preview');
    els.splitToggle.title = 'Show split view';
  }
});

// Drag to resize
let dragStartX = 0, startEditorFlex = 0, startPreviewFlex = 0;

els.splitHandle.addEventListener('mousedown', startDrag);
els.splitHandle.addEventListener('touchstart', startDrag, { passive: true });

function startDrag(e) {
  state.isDragging = true;
  els.splitHandle.classList.add('dragging');
  dragStartX = e.clientX ?? e.touches[0].clientX;
  startEditorFlex  = parseFloat(getComputedStyle(els.editorPane).flexGrow)  || 1;
  startPreviewFlex = parseFloat(getComputedStyle(els.previewPane).flexGrow) || 1;

  document.addEventListener('mousemove', onDrag);
  document.addEventListener('touchmove', onDrag, { passive: true });
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchend', stopDrag);
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

function onDrag(e) {
  if (!state.isDragging) return;
  const x = e.clientX ?? e.touches[0].clientX;
  const dx = x - dragStartX;
  const containerW = els.splitContainer.getBoundingClientRect().width;
  const totalFlex = startEditorFlex + startPreviewFlex;
  const flexPerPx = totalFlex / containerW;
  const newEditor = Math.max(0.2, Math.min(totalFlex - 0.2, startEditorFlex + dx * flexPerPx));
  els.editorPane.style.flex = newEditor;
  els.previewPane.style.flex = totalFlex - newEditor;
}

function stopDrag() {
  state.isDragging = false;
  els.splitHandle.classList.remove('dragging');
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('touchmove', onDrag);
  document.removeEventListener('mouseup', stopDrag);
  document.removeEventListener('touchend', stopDrag);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
}

// Keyboard resize
els.splitHandle.addEventListener('keydown', e => {
  const step = 0.05;
  let ef = parseFloat(getComputedStyle(els.editorPane).flexGrow) || 1;
  let pf = parseFloat(getComputedStyle(els.previewPane).flexGrow) || 1;
  const total = ef + pf;
  if (e.key === 'ArrowLeft') { ef = Math.max(.2, ef - step * total); pf = total - ef; }
  if (e.key === 'ArrowRight') { ef = Math.min(total - .2, ef + step * total); pf = total - ef; }
  els.editorPane.style.flex = ef;
  els.previewPane.style.flex = pf;
});


// --- Delete Note -------------------------------------------------------------

async function deleteNoteById(dateKey, noteId) {
  const note  = getNoteById(dateKey, noteId);
  const title = extractTitle(note?.content || '');

  // Find image IDs referenced in this note
  const content   = note?.content || '';
  const imageIds  = [...new Set([...content.matchAll(/journal-img:\/\/([a-z0-9]+)/g)].map(m => m[1]))];
  const hasImages = imageIds.length > 0;

  // Build confirm message
  const baseMsg = `"${title}" will be permanently deleted.`;
  const imgNote = hasImages
    ? ` This note contains ${imageIds.length} embedded image${imageIds.length !== 1 ? 's' : ''}.`
    : '';

  showConfirm(
    'Delete this note?',
    baseMsg + imgNote,
    () => {
      // Perform the deletion
      const notes = notesForDay(dateKey);
      state.notes[dateKey] = notes.filter(n => n.id !== noteId);
      if (state.notes[dateKey].length === 0) delete state.notes[dateKey];
      saveNotes();

      // Reset UI if the deleted note was open
      if (state.currentDate === dateKey && state.currentNoteId === noteId) {
        const remaining = notesForDay(dateKey);
        if (remaining.length > 0) {
          openNote(dateKey, remaining[0].id);
        } else {
          state.currentDate    = null;
          state.currentNoteId  = null;
          els.emptyState.style.display     = 'flex';
          els.splitContainer.style.display = 'none';
          els.statusBar.style.display      = 'none';
          els.deleteNoteBtn.style.display  = 'none';
          els.noteTabsBar.style.display    = 'none';
          els.topbarDate.textContent       = '';
          renderCalendar();
          renderNotesList();
        }
      } else {
        renderCalendar();
        renderNotesList();
        renderNoteTabs();
      }

      // If the note had images, ask whether to remove them from IndexedDB too
      if (hasImages) {
        showConfirm(
          'Remove embedded images?',
          `This note referenced ${imageIds.length} image${imageIds.length !== 1 ? 's' : ''} stored on this device. Remove ${imageIds.length !== 1 ? 'them' : 'it'} too?`,
          async () => {
            await Promise.all(imageIds.map(id => ImageStore.remove(id)));
            showToast(`Removed ${imageIds.length} image${imageIds.length !== 1 ? 's' : ''}.`);
          },
          { confirmLabel: 'Remove images', confirmClass: 'btn-danger' }
        );
      }
    }
  );
}

els.deleteNoteBtn.addEventListener('click', () => {
  if (state.currentDate && state.currentNoteId) {
    deleteNoteById(state.currentDate, state.currentNoteId);
  }
});


// --- Confirm Dialog -----------------------------------------------------------

function showConfirm(title, msg, onConfirm, { confirmLabel = 'Delete', confirmClass = 'btn-danger' } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay show';
  overlay.innerHTML = `
    <div class="confirm-box" role="dialog" aria-modal="true" aria-labelledby="cdlg-title">
      <div class="confirm-title" id="cdlg-title">${escHtml(title)}</div>
      <div class="confirm-msg">${escHtml(msg)}</div>
      <div class="confirm-actions">
        <button class="btn btn-ghost" id="cdlg-cancel">Cancel</button>
        <button class="btn ${confirmClass}" id="cdlg-confirm">${escHtml(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 250); };
  overlay.querySelector('#cdlg-cancel').addEventListener('click', close);
  overlay.querySelector('#cdlg-confirm').addEventListener('click', () => { close(); onConfirm(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#cdlg-confirm').focus();
}


// --- Toast --------------------------------------------------------------------

let _toast;
function showToast(msg, duration = 2500) {
  if (!_toast) {
    _toast = document.createElement('div');
    _toast.className = 'toast';
    document.body.appendChild(_toast);
  }
  _toast.textContent = msg;
  _toast.classList.add('show');
  clearTimeout(_toast._t);
  _toast._t = setTimeout(() => _toast.classList.remove('show'), duration);
}

function showToastWithAction(msg, actionLabel, onAction) {
  // Dismiss any existing passive toast first
  if (_toast) _toast.classList.remove('show');

  const t = document.createElement('div');
  t.className = 'toast toast--action show';
  t.innerHTML = `<span class="toast-msg">${escHtml(msg)}</span><button class="toast-action-btn">${escHtml(actionLabel)}</button>`;
  document.body.appendChild(t);

  t.querySelector('.toast-action-btn').addEventListener('click', () => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
    onAction();
  });
}


// --- Sidebar (mobile) ---------------------------------------------------------

els.sidebarToggle.addEventListener('click', toggleSidebar);
els.sidebarOverlay.addEventListener('click', closeSidebar);

function toggleSidebar() {
  if (els.sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
}

function openSidebar() {
  els.sidebar.classList.add('open');
  els.sidebarOverlay.classList.add('visible');
}

function closeSidebar() {
  els.sidebar.classList.remove('open');
  els.sidebarOverlay.classList.remove('visible');
}


// --- Calendar Navigation ------------------------------------------------------

els.prevMonth.addEventListener('click', () => {
  state.calMonth--;
  if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
  renderCalendar();
});

els.nextMonth.addEventListener('click', () => {
  state.calMonth++;
  if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
  renderCalendar();
});

// Keyboard navigation in calendar
els.calDays.addEventListener('keydown', e => {
  if (!['Enter',' '].includes(e.key)) return;
  const el = e.target;
  if (el.classList.contains('cal-day') && el.dataset.key) {
    openNote(el.dataset.key);
    closeSidebar();
  }
});


// --- Global Keyboard Shortcuts ------------------------------------------------

document.addEventListener('keydown', e => {
  // Ignore when typing in editor
  if (document.activeElement === els.mdEditor) return;

  switch (e.key) {
    case 'n': case 'N':
      newNoteToday();
      break;
    case 'Escape':
      closeSidebar();
      break;
  }
});


// --- Buttons -----------------------------------------------------------------

els.newNoteBtn.addEventListener('click', () => {
  // If a day is open, add a note to that day; otherwise add to today
  const target = state.currentDate || todayKey();
  addNoteToDay(target);
  closeSidebar();
});


els.addNoteTab.addEventListener('click', () => {
  if (state.currentDate) addNoteToDay(state.currentDate);
});


// --- PWA Service Worker -------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}


// --- Init ---------------------------------------------------------------------

function init() {
  loadNotes();

  const now = new Date();
  state.calYear  = now.getFullYear();
  state.calMonth = now.getMonth();

  renderCalendar();
  renderNotesList();
  initSplitView();

  // Open today's first note if it exists
  const tk = todayKey();
  if (dayHasContent(tk)) {
    openDay(tk);
  }
}

init();


// --- Markdown Toolbar ---------------------------------------------------------

// -- Core formatting engine ----------------------------------------------------
function applyFormat(action) {
  const ta = els.mdEditor;
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const sel   = ta.value.slice(start, end);
  const before = ta.value.slice(0, start);
  const after  = ta.value.slice(end);

  // Helper: wrap selection or insert placeholder
  function wrap(prefix, suffix, placeholder) {
    const text = sel || placeholder;
    const newVal = before + prefix + text + suffix + after;
    ta.value = newVal;
    const cursor = start + prefix.length;
    ta.selectionStart = cursor;
    ta.selectionEnd   = cursor + text.length;
  }

  // Helper: prefix current line(s)
  function prefixLines(prefix) {
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd   = after.indexOf('\n');
    const fullBefore = ta.value.slice(0, lineStart);
    const line       = ta.value.slice(lineStart, lineEnd === -1 ? undefined : lineStart + (end - lineStart) + lineEnd);
    const lineContent = ta.value.slice(lineStart, end === start ? (lineEnd === -1 ? ta.value.length : ta.value.indexOf('\n', lineStart)) : end);

    // Handle selection spanning lines
    const selectedLines = ta.value.slice(
      ta.value.lastIndexOf('\n', start) + 1,
      end
    ).split('\n');

    const preStart = ta.value.lastIndexOf('\n', start) + 1;
    const preText  = ta.value.slice(0, preStart);
    const postText = ta.value.slice(end);
    const newLines = selectedLines.map(l => {
      if (l.startsWith(prefix)) return l.slice(prefix.length); // toggle off
      return prefix + l;
    }).join('\n');

    ta.value = preText + newLines + postText;
    ta.selectionStart = preStart;
    ta.selectionEnd   = preStart + newLines.length;
  }

  // Helper: insert block (on its own line)
  function insertBlock(text, cursorOffset) {
    const needsNewlineBefore = before.length > 0 && !before.endsWith('\n');
    const needsNewlineAfter  = after.length > 0 && !after.startsWith('\n');
    const insertText = (needsNewlineBefore ? '\n' : '') + text + (needsNewlineAfter ? '\n' : '');
    ta.value = before + insertText + after;
    const pos = start + (needsNewlineBefore ? 1 : 0) + (cursorOffset !== undefined ? cursorOffset : text.length);
    ta.selectionStart = ta.selectionEnd = pos;
  }

  switch (action) {
    case 'bold':          wrap('**', '**', 'bold text'); break;
    case 'italic':        wrap('*', '*', 'italic text'); break;
    case 'strikethrough': wrap('~~', '~~', 'strikethrough'); break;
    case 'inlinecode':    wrap('`', '`', 'code'); break;
    case 'h1':            prefixLines('# '); break;
    case 'h2':            prefixLines('## '); break;
    case 'h3':            prefixLines('### '); break;
    case 'h4':            prefixLines('#### '); break;
    case 'blockquote':    prefixLines('> '); break;
    case 'ul':            prefixLines('- '); break;
    case 'ol':            prefixLines('1. '); break;
    case 'tasklist':      prefixLines('- [ ] '); break;

    case 'codeblock': {
      const lang = '';
      insertBlock('```' + lang + '\n' + (sel || 'code here') + '\n```');
      break;
    }

    case 'link': {
      const url = sel.startsWith('http') ? sel : 'https://';
      const text2 = sel.startsWith('http') ? 'Link text' : (sel || 'Link text');
      if (sel.startsWith('http')) {
        ta.value = before + `[${text2}](${url})` + after;
        ta.selectionStart = start + 1;
        ta.selectionEnd   = start + 1 + text2.length;
      } else {
        ta.value = before + `[${text2}](https://)` + after;
        ta.selectionStart = start + 1;
        ta.selectionEnd   = start + 1 + text2.length;
      }
      break;
    }

    case 'image': {
      // Handled by the image file picker — nothing to do here
      break;
    }

    case 'table': {
      const tbl = '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |';
      insertBlock(tbl, 2); // put cursor after first |
      break;
    }

    case 'hr': {
      insertBlock('\n---\n');
      break;
    }
  }

  // Trigger update
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}

// -- Wire up toolbar buttons ----------------------------------------------------

// Image button — opens file picker instead of calling applyFormat
const imageFileInput = document.getElementById('image-file-input');
let _pendingImageCursorStart = 0;
let _pendingImageCursorEnd   = 0;

document.querySelector('.toolbar-btn[data-action="image"]').addEventListener('mousedown', e => {
  e.preventDefault();
  // Capture cursor position before focus is lost
  _pendingImageCursorStart = els.mdEditor.selectionStart;
  _pendingImageCursorEnd   = els.mdEditor.selectionEnd;
  imageFileInput.value = '';
  imageFileInput.click();
});

imageFileInput.addEventListener('change', () => {
  const file = imageFileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async ev => {
    const dataUrl  = ev.target.result;
    const id       = uid();
    const alt      = file.name.replace(/\.[^.]+$/, '') || 'image';
    const markdown = `![${alt}](journal-img://${id})`;

    await ImageStore.save(id, dataUrl, file.type, file.name);

    const ta    = els.mdEditor;
    const start = _pendingImageCursorStart;
    const end   = _pendingImageCursorEnd;
    const before = ta.value.slice(0, start);
    const after  = ta.value.slice(end);
    const needsNewlineBefore = before.length > 0 && !before.endsWith('\n');
    const needsNewlineAfter  = after.length  > 0 && !after.startsWith('\n');

    const insert = (needsNewlineBefore ? '\n' : '') + markdown + (needsNewlineAfter ? '\n' : '');
    ta.value = before + insert + after;
    const pos = start + (needsNewlineBefore ? 1 : 0) + markdown.length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  };
  reader.readAsDataURL(file);
});

document.querySelectorAll('.toolbar-btn[data-action]').forEach(btn => {
  if (btn.dataset.action === 'image') return; // already handled above
  btn.addEventListener('mousedown', e => {
    e.preventDefault(); // prevent textarea losing focus
    applyFormat(btn.dataset.action);
  });
});

document.querySelectorAll('.dropdown-item[data-action]').forEach(btn => {
  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    applyFormat(btn.dataset.action);
    closeHeadingDropdown();
  });
});

// -- Heading dropdown ----------------------------------------------------------
const headingTrigger = document.getElementById('heading-trigger');
const headingMenu    = document.getElementById('heading-menu');

function openHeadingDropdown() {
  headingMenu.classList.add('open');
  headingTrigger.setAttribute('aria-expanded', 'true');
}
function closeHeadingDropdown() {
  headingMenu.classList.remove('open');
  headingTrigger.setAttribute('aria-expanded', 'false');
}

headingTrigger.addEventListener('mousedown', e => {
  e.preventDefault();
  headingMenu.classList.contains('open') ? closeHeadingDropdown() : openHeadingDropdown();
});

// Close on outside click
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#heading-dropdown')) closeHeadingDropdown();
});

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeHeadingDropdown();
});

// -- Active state: reflect cursor context --------------------------------------
els.mdEditor.addEventListener('keyup', updateToolbarState);
els.mdEditor.addEventListener('click', updateToolbarState);
els.mdEditor.addEventListener('select', updateToolbarState);

function updateToolbarState() {
  const ta    = els.mdEditor;
  const start = ta.selectionStart;
  const val   = ta.value;
  const sel   = val.slice(start, ta.selectionEnd);

  // Get text around cursor for context
  const lineStart = val.lastIndexOf('\n', start - 1) + 1;
  const lineEnd   = val.indexOf('\n', start);
  const line      = val.slice(lineStart, lineEnd === -1 ? val.length : lineEnd);

  const context = val.slice(Math.max(0, start - 20), ta.selectionEnd + 20);

  const checks = {
    bold:          /\*\*[^*]+\*\*/.test(context) || (sel && `**${sel}**` === `**${sel}**`),
    italic:        /(?<!\*)\*(?!\*)[^*]+\*(?!\*)/.test(context),
    strikethrough: /~~[^~]+~~/.test(context),
    inlinecode:    /`[^`]+`/.test(context),
    blockquote:    line.startsWith('> '),
    ul:            /^\s*[-*+] /.test(line),
    ol:            /^\s*\d+\. /.test(line),
    tasklist:      /^\s*- \[[ x]\] /.test(line),
    h1:            line.startsWith('# '),
    h2:            line.startsWith('## '),
    h3:            line.startsWith('### '),
    h4:            line.startsWith('#### '),
  };

  document.querySelectorAll('.toolbar-btn[data-action]').forEach(btn => {
    btn.classList.toggle('active', !!checks[btn.dataset.action]);
  });

  // Heading trigger active if any heading
  const anyHeading = checks.h1 || checks.h2 || checks.h3 || checks.h4;
  headingTrigger.classList.toggle('active', anyHeading);
}


// --- Search -------------------------------------------------------------------

const searchState = {
  open: false,
  query: '',
  filter: 'all',   // 'all' | 'title' | 'content'
  sort: 'relevance',
  focusedIndex: -1,
  results: [],
};

// DOM refs
const searchOverlay  = document.getElementById('search-overlay');
const searchInput    = document.getElementById('search-input');
const searchMeta     = document.getElementById('search-meta');
const searchResults  = document.getElementById('search-results');
const searchClose    = document.getElementById('search-close');
const searchBtn      = document.getElementById('search-btn');
const sortSelect     = document.getElementById('search-sort-select');

// -- Open / close --------------------------------------------------------------

function openSearch() {
  searchState.open = true;
  searchOverlay.style.display = 'flex';
  searchInput.value = searchState.query;
  renderSearchResults();
  requestAnimationFrame(() => searchInput.focus());
}

function closeSearch() {
  searchState.open = false;
  searchOverlay.style.display = 'none';
  searchState.focusedIndex = -1;
}

searchBtn.addEventListener('click', openSearch);
searchClose.addEventListener('click', closeSearch);

searchOverlay.addEventListener('mousedown', e => {
  if (e.target === searchOverlay) closeSearch();
});

// -- Filter chips --------------------------------------------------------------

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    searchState.filter = chip.dataset.filter;
    runSearch();
  });
});

sortSelect.addEventListener('change', () => {
  searchState.sort = sortSelect.value;
  runSearch();
});

// -- Input handler -------------------------------------------------------------

searchInput.addEventListener('input', () => {
  searchState.query = searchInput.value;
  searchState.focusedIndex = -1;
  runSearch();
});

// -- Keyboard navigation -------------------------------------------------------

searchInput.addEventListener('keydown', e => {
  const count = searchState.results.length;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchState.focusedIndex = Math.min(searchState.focusedIndex + 1, count - 1);
    updateFocus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchState.focusedIndex = Math.max(searchState.focusedIndex - 1, 0);
    updateFocus();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const idx = searchState.focusedIndex >= 0 ? searchState.focusedIndex : 0;
    const r = searchState.results[idx];
    if (r) selectResult(r.dateKey, r.noteId);
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

function updateFocus() {
  const items = searchResults.querySelectorAll('.search-result-item');
  items.forEach((el, i) => {
    el.classList.toggle('focused', i === searchState.focusedIndex);
    if (i === searchState.focusedIndex) el.scrollIntoView({ block: 'nearest' });
  });
}

// -- Search engine -------------------------------------------------------------

function runSearch() {
  const q = searchState.query.trim().toLowerCase();
  searchState.query = searchInput.value;

  if (!q) {
    searchState.results = [];
    renderSearchResults();
    return;
  }

  const terms = q.split(/\s+/).filter(Boolean);

  // Flatten all notes into individual entries
  const entries = [];
  for (const [dateKey, arr] of Object.entries(state.notes)) {
    for (const note of arr) {
      if (note.content) entries.push({ key: dateKey + '::' + note.id, dateKey, noteId: note.id, note });
    }
  }

  const scored = entries.map(({ key, dateKey, noteId, note }) => {
    const rawTitle   = extractTitle(note.content).toLowerCase();
    const rawContent = note.content.toLowerCase();

    let score = 0;
    let titleMatchCount   = 0;
    let contentMatchCount = 0;
    const snippets = [];

    for (const term of terms) {
      let ti = 0, tCount = 0;
      while ((ti = rawTitle.indexOf(term, ti)) !== -1) { tCount++; ti += term.length; }
      titleMatchCount += tCount;
      score += tCount * 10;

      let ci = 0, cCount = 0;
      const positions = [];
      while ((ci = rawContent.indexOf(term, ci)) !== -1) { positions.push(ci); cCount++; ci += term.length; }
      contentMatchCount += cCount;
      score += cCount * 2;

      for (const pos of positions.slice(0, 2)) {
        const start = Math.max(0, pos - 45);
        const end   = Math.min(rawContent.length, pos + 60);
        snippets.push((start > 0 ? '…' : '') + note.content.slice(start, end).replace(/\n/g, ' ') + (end < rawContent.length ? '…' : ''));
      }
    }

    if (searchState.filter === 'title'   && titleMatchCount   === 0) return null;
    if (searchState.filter === 'content' && contentMatchCount === 0) return null;
    if (score === 0) return null;

    return { key, dateKey, noteId, note, score, snippets: snippets.slice(0,2), matchCount: titleMatchCount + contentMatchCount };
  }).filter(Boolean);

  if (searchState.sort === 'relevance') scored.sort((a, b) => b.score - a.score);
  else if (searchState.sort === 'newest') scored.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  else scored.sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  searchState.results = scored;
  renderSearchResults();
}

// -- Highlighting --------------------------------------------------------------

function highlight(text, query) {
  if (!query) return escHtml(text);
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  return escHtml(text).replace(re, '<mark class="search-hl">$1</mark>');
}

// -- Render results ------------------------------------------------------------

function renderSearchResults() {
  const q = searchState.query.trim();

  if (!q) {
    // Recent notes quick-access — flatten all notes sorted newest first
    const recent = [];
    for (const [dateKey, arr] of Object.entries(state.notes)) {
      for (const note of arr) {
        if (note.content.trim()) recent.push({ dateKey, note });
      }
    }
    recent.sort((a, b) => b.dateKey.localeCompare(a.dateKey) || (b.note.updatedAt||'').localeCompare(a.note.updatedAt||''));

    searchMeta.textContent = '';
    searchResults.innerHTML = `
      <div class="no-query-state">
        <span class="nq-label">Recent notes</span>
        <div>
          ${recent.slice(0, 8).map(({ dateKey, note }) => `
            <button class="recent-note-chip" data-date="${dateKey}" data-id="${note.id}">
              <span class="rn-date">${fmtDateShort(dateKey)}</span>
              <span>${escHtml(extractTitle(note.content).slice(0, 30))}</span>
            </button>`).join('')}
          ${!recent.length ? '<span style="color:var(--text-muted);font-style:italic">No notes yet</span>' : ''}
        </div>
      </div>`;

    searchResults.querySelectorAll('.recent-note-chip').forEach(btn => {
      btn.addEventListener('click', () => selectResult(btn.dataset.date, btn.dataset.id));
    });
    return;
  }

  const results = searchState.results;
  const total = results.length;

  if (total === 0) {
    searchMeta.textContent = 'No results';
    searchResults.innerHTML = `
      <div class="search-empty">
        <svg class="search-empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          <line x1="8" y1="11" x2="14" y2="11" stroke-dasharray="2 1"/>
        </svg>
        No notes match <strong>"${escHtml(q)}"</strong>
      </div>`;
    return;
  }

  searchMeta.textContent = `${total} result${total !== 1 ? 's' : ''}`;

  searchResults.innerHTML = results.map((r, i) => {
    const focused = i === searchState.focusedIndex ? ' focused' : '';
    const snippetHtml = r.snippets.map(s => `<div class="sri-match">${highlight(s, q)}</div>`).join('');
    return `
      <div class="search-result-item${focused}" data-date="${r.dateKey}" data-id="${r.noteId}" data-index="${i}" role="option" tabindex="-1">
        <div class="sri-header">
          <span class="sri-date">${fmtDateShort(r.dateKey)}</span>
          <span class="sri-title">${highlight(extractTitle(r.note.content), q)}</span>
          <span class="sri-count">${r.matchCount} hit${r.matchCount !== 1 ? 's' : ''}</span>
        </div>
        ${snippetHtml ? `<div class="sri-matches">${snippetHtml}</div>` : ''}
      </div>`;
  }).join('');

  searchResults.querySelectorAll('.search-result-item').forEach((el, i) => {
    el.addEventListener('click', () => selectResult(el.dataset.date, el.dataset.id));
    el.addEventListener('mousemove', () => { searchState.focusedIndex = i; updateFocus(); });
  });
}

function selectResult(dateKey, noteId) {
  closeSearch();
  openNote(dateKey, noteId);
  const d = parseKey(dateKey);
  state.calYear  = d.getFullYear();
  state.calMonth = d.getMonth();
  renderCalendar();
}

// -- Global shortcut: Ctrl/Cmd+F or / -----------------------------------------

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    // Don't hijack if inside the editor — let browser handle it unless search is already open
    if (document.activeElement !== els.mdEditor || searchState.open) {
      e.preventDefault();
      searchState.open ? closeSearch() : openSearch();
    }
  }
  // Press / to open search (when not typing in editor)
  if (e.key === '/' && document.activeElement !== els.mdEditor && document.activeElement !== searchInput) {
    e.preventDefault();
    openSearch();
  }
});


// --- VSCode Theme System ------------------------------------------------------

const VSCODE_THEME_KEY = 'vscodeTheme'; // key inside journal_settings

const VSCODE_THEMES = [
  // Dark themes
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    variant: 'dark',
    colors: { sidebar: '#21252b', editor: '#282c34', accent: '#61afef', line1: '#61afef', line2: '#98c379', line3: '#e06c75' },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    variant: 'dark',
    colors: { sidebar: '#21222c', editor: '#282a36', accent: '#bd93f9', line1: '#ff79c6', line2: '#50fa7b', line3: '#bd93f9' },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    variant: 'dark',
    colors: { sidebar: '#16161e', editor: '#1a1b26', accent: '#7aa2f7', line1: '#7aa2f7', line2: '#9ece6a', line3: '#f7768e' },
  },
  {
    id: 'monokai-pro',
    name: 'Monokai Pro',
    variant: 'dark',
    colors: { sidebar: '#221f22', editor: '#2d2a2e', accent: '#a9dc76', line1: '#ff6188', line2: '#a9dc76', line3: '#ffd866' },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    variant: 'dark',
    colors: { sidebar: '#010409', editor: '#0d1117', accent: '#58a6ff', line1: '#58a6ff', line2: '#3fb950', line3: '#e3b341' },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    variant: 'dark',
    colors: { sidebar: '#00212b', editor: '#002b36', accent: '#268bd2', line1: '#268bd2', line2: '#859900', line3: '#cb4b16' },
  },
  // Light themes
  {
    id: 'github-light',
    name: 'GitHub Light',
    variant: 'light',
    colors: { sidebar: '#f6f8fa', editor: '#ffffff', accent: '#0969da', line1: '#0969da', line2: '#1a7f37', line3: '#9a6700' },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    variant: 'light',
    colors: { sidebar: '#eee8d5', editor: '#fdf6e3', accent: '#268bd2', line1: '#268bd2', line2: '#859900', line3: '#cb4b16' },
  },
];

const DEFAULT_THEME = { id: 'default', name: 'Journal Default', variant: 'both' };

let activeVscodeTheme = null; // null = Journal default

// -- Apply / remove VSCode theme -----------------------------------------------

function applyVscodeTheme(themeId) {
  // Remove all existing vscode theme attributes
  els.html.removeAttribute('data-vscode-theme');

  if (!themeId || themeId === 'default') {
    activeVscodeTheme = null;
    Settings.remove(VSCODE_THEME_KEY);
    // Restore normal light/dark toggle behaviour
    updateThemePickerUI();
    return;
  }

  const theme = VSCODE_THEMES.find(t => t.id === themeId);
  if (!theme) return;

  activeVscodeTheme = themeId;
  els.html.setAttribute('data-vscode-theme', themeId);
  // Force data-theme to match so light/dark icon states stay sensible
  els.html.setAttribute('data-theme', theme.variant === 'light' ? 'light' : 'dark');
  Settings.set(VSCODE_THEME_KEY, themeId);
  updateThemePickerUI();
}

function loadVscodeTheme() {
  const saved = Settings.get(VSCODE_THEME_KEY);
  if (saved) applyVscodeTheme(saved);
}

// -- Build theme picker UI -----------------------------------------------------

function buildThemePicker() {
  const darkGrid  = document.getElementById('dark-theme-grid');
  const lightGrid = document.getElementById('light-theme-grid');

  VSCODE_THEMES.forEach(theme => {
    const card = document.createElement('div');
    card.className = 'theme-card';
    card.dataset.themeId = theme.id;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${theme.name} theme`);

    const { sidebar, editor, accent, line1, line2, line3 } = theme.colors;

    card.innerHTML = `
      <div class="theme-swatch" aria-hidden="true">
        <div class="swatch-sidebar" style="background:${sidebar}"></div>
        <div class="swatch-main" style="background:${editor}">
          <div class="swatch-line" style="background:${line1};width:80%"></div>
          <div class="swatch-line" style="background:${line2};width:60%"></div>
          <div class="swatch-line" style="background:${line3};width:70%"></div>
        </div>
      </div>
      <div class="theme-info">
        <div class="theme-name">${theme.name}</div>
        <div class="theme-variant">${theme.variant === 'light' ? '☀ Light' : '● Dark'}</div>
      </div>
      <div class="theme-check">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      </div>`;

    card.addEventListener('click', () => applyVscodeTheme(theme.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyVscodeTheme(theme.id); } });

    if (theme.variant === 'light') lightGrid.appendChild(card);
    else darkGrid.appendChild(card);
  });
}

function updateThemePickerUI() {
  // Update active card
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('active', card.dataset.themeId === activeVscodeTheme);
  });

  // Update label
  const nameEl = document.getElementById('theme-current-name');
  if (nameEl) {
    const found = VSCODE_THEMES.find(t => t.id === activeVscodeTheme);
    nameEl.textContent = found ? found.name : 'Journal Default';
  }
}

// -- Open / close picker -------------------------------------------------------

const themePickerPanel = document.getElementById('theme-picker-panel');
const themePickerClose = document.getElementById('theme-picker-close');
const themeResetBtn    = document.getElementById('theme-reset-btn');

function openThemePicker() {
  themePickerPanel.style.display = 'flex';
  updateThemePickerUI();
}

function closeThemePicker() {
  themePickerPanel.style.display = 'none';
}

document.getElementById('menu-theme').addEventListener('click', () => {
  closeSidebarMenu();
  openThemePicker();
});
themePickerClose.addEventListener('click', closeThemePicker);
themePickerPanel.addEventListener('mousedown', e => {
  if (e.target === themePickerPanel) closeThemePicker();
});
themeResetBtn.addEventListener('click', () => {
  applyVscodeTheme('default');
  showToast('Reset to Journal default');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && themePickerPanel.style.display !== 'none') closeThemePicker();
});

// -- Init ----------------------------------------------------------------------
buildThemePicker();
loadVscodeTheme();


// --- Sidebar Menu -------------------------------------------------------------

const sidebarMenuBtn  = document.getElementById('sidebar-menu-btn');
const sidebarMenu     = document.getElementById('sidebar-menu');
const sidebarMenuWrap = document.getElementById('sidebar-menu-wrap');

function openSidebarMenu() {
  sidebarMenu.classList.add('open');
  sidebarMenuBtn.setAttribute('aria-expanded', 'true');
}
function closeSidebarMenu() {
  sidebarMenu.classList.remove('open');
  sidebarMenuBtn.setAttribute('aria-expanded', 'false');
}
function toggleSidebarMenu() {
  sidebarMenu.classList.contains('open') ? closeSidebarMenu() : openSidebarMenu();
}

sidebarMenuBtn.addEventListener('click', e => { e.stopPropagation(); toggleSidebarMenu(); });
document.addEventListener('click', e => {
  if (!sidebarMenuWrap.contains(e.target)) closeSidebarMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSidebarMenu();
});


// --- Export -------------------------------------------------------------------

document.getElementById('menu-export').addEventListener('click', async () => {
  closeSidebarMenu();

  const totalNotes = Object.values(state.notes).reduce((sum, arr) => sum + arr.length, 0);
  if (totalNotes === 0) { showToast('No notes to export.'); return; }

  // Collect all journal-img:// IDs referenced across all notes
  const allContent = Object.values(state.notes).flatMap(a => a.map(n => n.content)).join('\n');
  const imageIds   = [...new Set([...allContent.matchAll(/journal-img:\/\/([a-z0-9]+)/g)].map(m => m[1]))];
  const imageRecords = await Promise.all(imageIds.map(id => ImageStore.get(id)));
  const images = {};
  imageIds.forEach((id, i) => { if (imageRecords[i]) images[id] = imageRecords[i]; });

  const exportData = {
    app: 'Journal',
    exportedAt: new Date().toISOString(),
    version: 2,
    notes: state.notes,
    images,
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href     = url;
  a.download = `journal-notes-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  const imgCount = Object.keys(images).length;
  showToast(`Exported ${totalNotes} note${totalNotes !== 1 ? 's' : ''}${imgCount ? ` and ${imgCount} image${imgCount !== 1 ? 's' : ''}` : ''}.`);
});


// --- Import -------------------------------------------------------------------

const importFileInput = document.getElementById('import-file-input');

document.getElementById('menu-import').addEventListener('click', () => {
  closeSidebarMenu();
  importFileInput.value = '';
  importFileInput.click();
});

importFileInput.addEventListener('change', () => {
  const file = importFileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);

      // Accept v2 format ({ notes: {...} }) or a raw notes object
      let incoming = null;
      if (data && typeof data === 'object' && data.notes && typeof data.notes === 'object') {
        incoming = data.notes;
      } else if (data && typeof data === 'object' && !data.exportedAt) {
        incoming = data;
      }

      if (!incoming) throw new Error('Unrecognised format');

      // Validate: every value must be an array
      const normalised = {};
      for (const [k, v] of Object.entries(incoming)) {
        if (Array.isArray(v)) normalised[k] = v;
      }

      const incomingCount = Object.values(normalised).reduce((s, a) => s + a.length, 0);
      if (incomingCount === 0) { showToast('No notes found in file.'); return; }

      showConfirm(
        'Import notes?',
        `This will merge ${incomingCount} note${incomingCount !== 1 ? 's' : ''} into your journal. Existing notes on the same days will be kept alongside the imported ones.`,
        async () => {
          // Merge notes
          for (const [dateKey, arr] of Object.entries(normalised)) {
            if (!state.notes[dateKey]) state.notes[dateKey] = [];
            const existingIds = new Set(state.notes[dateKey].map(n => n.id));
            for (const note of arr) {
              if (existingIds.has(note.id)) {
                state.notes[dateKey].push({ ...note, id: uid() });
              } else {
                state.notes[dateKey].push(note);
              }
            }
          }

          // Restore images into IndexedDB
          const images = data.images || {};
          const imgEntries = Object.entries(images);
          await Promise.all(imgEntries.map(([id, rec]) =>
            ImageStore.save(id, rec.dataUrl, rec.mimeType, rec.name)
          ));

          saveNotes();
          renderCalendar();
          renderNotesList();
          const imgCount = imgEntries.length;
          showToast(`Imported ${incomingCount} note${incomingCount !== 1 ? 's' : ''}${imgCount ? ` and ${imgCount} image${imgCount !== 1 ? 's' : ''}` : ''} successfully.`);
        }
      );
    } catch {
      showToast('Could not read file — make sure it is a valid Journal export.');
    }
  };
  reader.readAsText(file);
});


// --- About Modal --------------------------------------------------------------

const aboutOverlay = document.getElementById('about-overlay');
const aboutClose   = document.getElementById('about-close');

// --- Clear All Notes ----------------------------------------------------------

document.getElementById('menu-clear').addEventListener('click', () => {
  closeSidebarMenu();

  const totalNotes = Object.values(state.notes).reduce((sum, arr) => sum + arr.length, 0);
  if (totalNotes === 0) { showToast('There are no notes to clear.'); return; }

  showConfirm(
    '⚠ Clear all notes?',
    `This will permanently delete all ${totalNotes} note${totalNotes !== 1 ? 's' : ''} and all stored images. This cannot be undone.`,
    () => {
      // Second confirmation for extra safety
      showConfirm(
        'Are you absolutely sure?',
        'Every note and image will be erased from this device. There is no way to recover them unless you have an export.',
        async () => {
          state.notes        = {};
          state.currentDate  = null;
          state.currentNoteId = null;
          localStorage.removeItem(STORAGE_KEY);

          // Wipe all images from IndexedDB via the open connection
          try {
            const db = await ImageStore._openDb();
            await new Promise((resolve, reject) => {
              const tx = db.transaction('images', 'readwrite');
              tx.objectStore('images').clear();
              tx.oncomplete = resolve;
              tx.onerror    = () => reject(tx.error);
            });
          } catch { /* non-fatal */ }

          els.emptyState.style.display     = 'flex';
          els.splitContainer.style.display = 'none';
          els.statusBar.style.display      = 'none';
          els.deleteNoteBtn.style.display  = 'none';
          els.noteTabsBar.style.display    = 'none';
          els.topbarDate.textContent       = '';
          renderCalendar();
          renderNotesList();
          showToastWithAction('All notes cleared.', 'OK', () => location.reload());
        },
        { confirmLabel: 'Yes, delete everything', confirmClass: 'btn-danger' }
      );
    },
    { confirmLabel: 'Clear all', confirmClass: 'btn-danger' }
  );
});


// --- About Modal --------------------------------------------------------------

function openAbout() {
  // Version info
  const verEl   = document.getElementById('about-version');
  const cacheEl = document.getElementById('about-cache');
  if (verEl)   verEl.textContent   = `v${APP_VERSION}`;
  if (cacheEl) cacheEl.textContent = `cache ${CACHE_VERSION}`;

  // Populate live stats
  const days  = Object.keys(state.notes).length;
  const total = Object.values(state.notes).reduce((s, a) => s + a.length, 0);
  const words = Object.values(state.notes)
    .flatMap(a => a)
    .reduce((s, n) => s + (n.content.trim() ? n.content.trim().split(/\s+/).length : 0), 0);

  document.getElementById('about-stats').innerHTML = [
    { value: days,  label: days  === 1 ? 'Day'   : 'Days'  },
    { value: total, label: total === 1 ? 'Note'  : 'Notes' },
    { value: words > 999 ? (words / 1000).toFixed(1) + 'k' : words, label: 'Words' },
  ].map(s => `
    <div class="about-stat">
      <span class="about-stat-value">${s.value}</span>
      <span class="about-stat-label">${s.label}</span>
    </div>`).join('');

  aboutOverlay.style.display = 'flex';
}

function closeAbout() {
  aboutOverlay.style.display = 'none';
}

document.getElementById('menu-about').addEventListener('click', () => {
  closeSidebarMenu();
  openAbout();
});
aboutClose.addEventListener('click', closeAbout);
aboutOverlay.addEventListener('click', e => { if (e.target === aboutOverlay) closeAbout(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && aboutOverlay.style.display !== 'none') closeAbout(); });


// --- Font Settings ------------------------------------------------------------

const FONT_KEY      = 'font';      // key inside journal_settings
const FONT_SIZE_KEY = 'fontSize';  // key inside journal_settings

const FONT_FACES = [
  { id: 'default',      name: 'Default',      sample: 'Aa', style: "'Source Serif 4', Georgia, serif" },
  { id: 'serif',        name: 'Serif',         sample: 'Aa', style: "'Lora', Georgia, serif" },
  { id: 'sans',         name: 'Sans‑serif',    sample: 'Aa', style: "'Inter', system-ui, sans-serif" },
  { id: 'mono',         name: 'Monospace',     sample: 'Aa', style: "'Fira Code', monospace" },
  { id: 'handwriting',  name: 'Handwriting',   sample: 'Aa', style: "'Caveat', cursive" },
  { id: 'slab',         name: 'Slab serif',    sample: 'Aa', style: "'Merriweather', Georgia, serif" },
];

// Default size in pt
const DEFAULT_FONT_SIZE_PT = 12;

let activeFontId      = 'default';
let activeFontSizePt  = DEFAULT_FONT_SIZE_PT; // numeric pt value

// pt → approximate px (1pt ≈ 1.333px)
function ptToPx(pt) { return (pt * 4 / 3).toFixed(2) + 'px'; }

function applyFontSettings() {
  const html = document.documentElement;

  // Font face
  if (activeFontId === 'default') {
    html.removeAttribute('data-font');
  } else {
    html.setAttribute('data-font', activeFontId);
  }

  // Font size — set CSS variables directly, no attribute needed
  const px = ptToPx(activeFontSizePt);
  // Editor and preview sizes scale together; preview is slightly larger
  const previewPx = ptToPx(activeFontSizePt + 1.5);
  html.style.setProperty('--editor-font-size', px);
  html.style.setProperty('--preview-font-size', previewPx);

  Settings.set(FONT_KEY,      activeFontId);
  Settings.set(FONT_SIZE_KEY, activeFontSizePt);
}

function loadFontSettings() {
  activeFontId     = Settings.get(FONT_KEY, 'default');
  const savedSize  = parseInt(Settings.get(FONT_SIZE_KEY, 12), 10);
  activeFontSizePt = (!isNaN(savedSize) && savedSize >= 8 && savedSize <= 28) ? savedSize : DEFAULT_FONT_SIZE_PT;
  applyFontSettings();
}

// -- Populate size <select> ----------------------------------------------------

function buildFontSizeSelect() {
  const sel = document.getElementById('font-size-select');
  if (!sel) return;
  sel.innerHTML = '';
  for (let pt = 8; pt <= 28; pt += 2) {
    const opt = document.createElement('option');
    opt.value       = pt;
    opt.textContent = `${pt} pt`;
    if (pt === activeFontSizePt) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    activeFontSizePt = parseInt(sel.value, 10);
    applyFontSettings();
    updateFontPreview();
  });
}

// -- Build the font face grid --------------------------------------------------

function buildFontFaceGrid() {
  const grid = document.getElementById('font-face-grid');
  grid.innerHTML = FONT_FACES.map(f => `
    <div class="font-face-card${activeFontId === f.id ? ' active' : ''}" data-font-id="${f.id}" role="button" tabindex="0">
      <span class="font-face-sample" style="font-family:${f.style}">${f.sample}</span>
      <span class="font-face-name">${f.name}</span>
    </div>`).join('');

  grid.querySelectorAll('.font-face-card').forEach(card => {
    const select = () => {
      activeFontId = card.dataset.fontId;
      applyFontSettings();
      updateFontUI();
    };
    card.addEventListener('click', select);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
  });
}

// -- Update active states and live preview -------------------------------------

function updateFontPreview() {
  const cs  = getComputedStyle(document.documentElement);
  const ep  = document.getElementById('font-preview-editor');
  const pp  = document.getElementById('font-preview-prose');
  if (ep) {
    ep.style.fontFamily = cs.getPropertyValue('--editor-font').trim();
    ep.style.fontSize   = cs.getPropertyValue('--editor-font-size').trim();
  }
  if (pp) {
    pp.style.fontFamily = cs.getPropertyValue('--preview-font').trim();
    pp.style.fontSize   = cs.getPropertyValue('--preview-font-size').trim();
  }
}

function updateFontUI() {
  document.querySelectorAll('.font-face-card').forEach(c => {
    c.classList.toggle('active', c.dataset.fontId === activeFontId);
  });
  // Sync select value
  const sel = document.getElementById('font-size-select');
  if (sel) sel.value = String(activeFontSizePt);
  updateFontPreview();
}

// -- Open / close -------------------------------------------------------------

const fontSettingsOverlay = document.getElementById('font-settings-overlay');
const fontSettingsClose   = document.getElementById('font-settings-close');

function openFontSettings() {
  buildFontFaceGrid();
  buildFontSizeSelect();
  updateFontUI();
  fontSettingsOverlay.style.display = 'flex';
}

function closeFontSettings() {
  fontSettingsOverlay.style.display = 'none';
}

document.getElementById('menu-font').addEventListener('click', () => {
  closeSidebarMenu();
  openFontSettings();
});

fontSettingsClose.addEventListener('click', closeFontSettings);
fontSettingsOverlay.addEventListener('click', e => { if (e.target === fontSettingsOverlay) closeFontSettings(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && fontSettingsOverlay.style.display !== 'none') closeFontSettings();
});

// -- Init ----------------------------------------------------------------------
loadFontSettings();
