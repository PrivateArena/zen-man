# Zen-Man: System Architecture & Feature Map

Zen-Man is a modern, high-performance, modular web-based file manager designed for advanced users. It leverages a lightweight Go-based backend and a responsive, vanilla ES6 modular frontend. This document outlines Zen-Man's architecture, maps its codebase modules to functional capabilities, and provides a comparative analysis against other file managers.

---

## 1. System Architecture

```mermaid
graph TD
    subgraph Frontend (HTML5 / Vanilla CSS / ES6 Modules)
        App[app.js Entrypoint] --> UI[file-list.js / sidebar.js]
        App --> Nav[navigation.js / tabs.js]
        App --> ActionPanel[custom-actions.js / action-log.js]
        App --> View[split-view.js]
        State[(state.js Central State)] <--> App
    end
    
    subgraph Backend (Go / Loopback REST API)
        GoMux[HTTP ServeMux] --> DirAPI[/api/dir]
        GoMux --> WorkspacesAPI[/api/workspaces]
        GoMux --> ActionsAPI[/api/actions]
        GoMux --> OpsAPI[/api/op & /api/log]
    end

    Frontend <-->|JSON over HTTP| Backend
```

Zen-Man relies on a clear separation of concerns:
- **Backend (Go)**: Binds to a local loopback interface (`127.0.0.1`), handles disk I/O, file system operations, and execution of subprocesses. It is highly optimized for pagination and quick directory reads.
- **Frontend (Vanilla ES6)**: Operates without heavy framework runtimes (React/Vue). Modularity is achieved using ES6 Import/Export modules and custom events, ensuring instant startup times and sub-millisecond UI latency.

---

## 2. Frontend Feature Map

The frontend (`frontend/js/`) is highly modularized. Each file corresponds directly to a domain-level capability:

| Module / File | Size (Bytes) | Primary Responsibility & Capabilities |
| :--- | :--- | :--- |
| **`state.js`** | ~2,382 | **Central State Store**: Manages split/quad layout state, active panes, tab history, selected paths, and global clipboard buffer operations. |
| **`app.js`** | ~6,305 | **Bootstrapper & Event Router**: Binds cross-pane event listeners, triggers DOM initialization, and routes global keyboard shortcuts. |
| **`split-view.js`** | ~3,500 | **Grid Layout Controller**: Manages 1-pane (Single), 2-pane (Split), and 4-pane (Quad Grid) viewport arrangements. Restores layout states and initializes placeholder tabs. |
| **`tabs.js`** | ~14,356 | **Tab Lifecycle Manager**: Supports tab groups, custom coloring, MRU (Most Recently Used) tracking, and Firefox-style lazy on-demand startup loading. |
| **`navigation.js`** | ~6,833 | **File Navigation Engine**: Resolves directory pathways, manages breadcrumb generation, controls address-bar transitions, and handles back/forward/up history. |
| **`file-list.js`** | ~19,475 | **Infinite Scroll File View**: Renders table/grid modes, handles multi-item selections, column sorting (name, size, date), and cursor-based infinite pagination. |
| **`sidebar.js`** | ~5,069 | **System Places & Bookmarks**: Populates system Mounts, Places shortcuts, Bookmarks database, and controls sidebar visibility via a hover-trigger zone. |
| **`action-log.js`** | ~9,867 | **Undo/Redo File Transaction Log**: Tracks copy, cut, move, delete, and rename actions. Provides real-time progress indicators and enables instant operation reversals (Undo). |
| **`custom-actions.js`** | ~15,414 | **User-Defined Action Manager**: Allows users to configure custom terminal commands with variable interpolation chips (e.g. `{file}`, `{dir}`) and live preview outputs. |
| **`quick-find.js`** | ~11,201 | **Search Modal**: Implements Ctrl+F fast search-as-you-type modal, recursive directory tree queries, and keyboard list selection. |
| **`api.js`** | ~683 | **REST Client Core**: Consolidates HTTP API request wrappers for communication with the Go backend. |
| **`utils.js`** | ~580 | **Formatting Utilities**: Contains shared functions for file-size humanization, dates, and name formatting. |
| **`workspace.js`** | ~9,748 | **Named Workspaces Manager**: Handles workspace state configuration (save, delete, change), session restoration and auto-save. |

---

## 3. Backend REST API Feature Map

The Go server (`api/` package and `main.go`) exposes clean JSON endpoints for system interactivity:

- **`/api/dir`**: Reads file systems using cursor-based pagination (default 200 items per chunk) to handle folders with millions of files without blocking the UI thread.
- **`/api/op`**: Orchestrates copy, cut, delete, rename, and property fetches.
- **`/api/workspaces`**: Workspace session management. Saves and loads active layouts (panes, paths, tabs, active selections).
- **`/api/actions` & `/api/action/exec`**: Persists and executes user-defined terminal actions.
- **`/api/log` & `/api/log/revert`**: Feeds the transaction log and executes file system restoration/rollback sequences.
- **`/api/places`**: Dynamically aggregates default system directories based on OS rules.

---

## 4. Competitive Analysis

Zen-Man combines the speed of terminal/command-line file managers with the visual utility of multi-pane desktop file explorers.

| Capability | Zen-Man | Q-Dir | Directory Opus | Nautilus / Finder | Ranger / lf |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Platform** | Web / Local Browser | Windows Desktop | Windows Desktop | macOS / Linux | CLI Terminal |
| **Layouts** | Single, Split, 2x2 Quad | Multi-split configs | Dual Pane | Single / Tabbed | Single |
| **Undo Engine** | Transaction Log (Undo/Revert) | Basic OS Undo | Advanced | Basic OS Undo | Command history |
| **Startup System** | Firefox-style lazy loading | Synchronous | Configuration save | Standard | Instantly lazy |
| **Custom Extensibility**| Emojis + Shell Command Editor | No | VBScript / JS | Python plugins | Shell scripts |
| **Memory footprint** | Low (compiled Go) | Minimal | Heavy | Moderate | Minimal |

### Zen-Man Special Strengths:
1. **Firefox-Style Lazy Tab Restoration**: On startup, only the active pane tab is loaded immediately. Non-active tabs are initialized with cached titles and deferred loading, resolving the issue where unmounted disk paths block UI startup.
2. **Interactive Transaction Log**: Any file operation (Cut, Copy, Rename, Move) is tracked and can be rolled back via the GUI.
3. **Variable-Interpolated Custom Actions**: Dynamic actions (e.g. `code {dir}`) are defined in a browser-native command builder with live execution preview, unlike other explorers that require custom scripts or registry edits.
