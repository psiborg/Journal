# Journal

A calm, offline-first Progressive Web App for daily Markdown note-taking. All data stays on your device — no accounts, no cloud, no tracking.

---

## Features

### 📅 Calendar navigation
Click any day in the sidebar calendar to open or create notes for that date. Days with notes are marked with a dot; days with multiple notes show a count badge. Use the arrow buttons to navigate between months.

### 📝 Multiple notes per day
Each day supports any number of notes. Notes are organised in a tab bar above the editor — click a tab to switch, press **+** to add a new note to the current day, or click **×** on a tab to delete it.

### ✦ Markdown editor with live preview
Write in Markdown on the left; see the rendered result on the right in real time. The split pane is resizable by dragging the divider. Toggle the preview off to go full-width editor.

**Supported Markdown:**
- Headings (H1–H4), bold, italic, strikethrough, inline code
- Fenced code blocks, blockquotes
- Ordered lists, unordered lists, task lists (`- [ ]` / `- [x]`)
- Tables, links, images, horizontal rules

### 🛠 Formatting toolbar
One-click buttons for every common format above the editor. Wraps selected text or inserts a placeholder. Active state highlights which formatting applies at the cursor position.

**Keyboard shortcuts:**

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + B` | Bold |
| `Ctrl/Cmd + I` | Italic |
| `Ctrl/Cmd + K` | Insert link |
| `` Ctrl/Cmd + ` `` | Inline code |
| `Ctrl/Cmd + S` | Force save |
| `Tab` | Insert two spaces |

### 🖼 Image embedding
Click the image button in the toolbar to pick an image file from your system. Images are stored in **IndexedDB** and referenced in Markdown as `journal-img://ID` — they render correctly in the preview without needing the original file path, and are bundled into exports.

### 🔍 Full-text search
Press `/`, `Ctrl/Cmd + F`, or click the search icon to open the search modal. Searches across all notes with:
- Multi-word queries
- Filter by **All fields**, **Title only**, or **Content only**
- Sort by **Relevance**, **Newest**, or **Oldest**
- Highlighted match excerpts with hit counts
- Keyboard navigation (`↑ ↓` to move, `↵` to open, `Esc` to close)

### 🎨 Themes
Eight VSCode-inspired colour themes, accessible from **☰ → Editor theme**:

| Theme | Style |
|---|---|
| One Dark Pro | Dark |
| Dracula | Dark |
| Tokyo Night | Dark |
| Monokai Pro | Dark |
| GitHub Dark | Dark |
| Solarized Dark | Dark |
| GitHub Light | Light |
| Solarized Light | Light |

### 🔤 Font settings
Accessible from **☰ → Font settings**. Choose from six typefaces and a font size from 8 pt to 28 pt in 2 pt increments. A live preview shows how the combination looks in both the editor and prose view.

| Typeface | Style |
|---|---|
| Default | Source Serif 4 |
| Serif | Lora |
| Sans-serif | Inter |
| Monospace | Fira Code |
| Handwriting | Caveat |
| Slab serif | Merriweather |

### 📦 Export & Import
**Export** (☰ → Export notes) downloads a `journal-notes-YYYY-MM-DD.json` file containing all notes and their embedded images.

**Import** (☰ → Import notes) merges a `.json` export file into the current journal. Notes are added alongside existing ones; duplicate IDs are reassigned automatically. Embedded images are restored to IndexedDB.

### 📱 Progressive Web App
Install Journal to your home screen or desktop from your browser's install prompt. Works fully offline after the first load via a service worker cache.

---

## Keyboard shortcuts (global)

| Key | Action |
|---|---|
| `N` | New note for today (or current day) |
| `/` | Open search |
| `Ctrl/Cmd + F` | Open search |
| `Esc` | Close sidebar / modal |

---

## Storage

Journal uses two browser storage mechanisms:

| Store | Key | Contents |
|---|---|---|
| `localStorage` | `journal_notes_v1` | All note text, organised by date |
| `localStorage` | `journal_settings` | Theme, font, and font size preferences |
| `IndexedDB` | `journal_images` | Base64-encoded embedded images |

All data is local to the browser. Clearing site data or browser storage will permanently erase notes and images. Use **Export notes** regularly to back up your data.

---

## File structure

```
index.html   — App shell and HTML structure
app.css      — All styles and theme variables
app.js       — Application logic
manifest.json — PWA manifest
sw.js        — Service worker for offline support
```

---

## Running locally

No build step required. Serve the folder over HTTP:

```bash
# Node.js
npx serve .

# Python
python3 -m http.server 8080
```

Then open `http://localhost:3000` (or whichever port) in your browser. Opening `index.html` directly as a `file://` URL will work for basic use but the service worker will not register.

---

## Browser support

Requires a modern browser with support for:
- `IndexedDB` (image storage)
- `CSS custom properties`
- `Service Worker` (offline / PWA install)

Tested in Chrome, Firefox, and Safari (desktop and mobile).
