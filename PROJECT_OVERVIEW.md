# zen-man — Project Architecture Overview

## Purpose

zen-man is a dual-pane file manager for Linux (with Windows support). It runs a local Go HTTP server that serves a vanilla JavaScript SPA frontend and exposes a REST API for all filesystem operations. The browser is the UI shell; the Go backend is the OS bridge.

---

## Architecture Diagram

```
Browser (SPA)                    Go HTTP Server                    Filesystem
┌─────────────────────┐         ┌─────────────────────────┐
│  js/ (vanilla JS)   │  HTTP   │  main.go                │
│                     │◄───────►│  api/*.go               │◄──────►  ext4, NTFS, ...
│  index.html         │  REST   │                         │
│  style.css          │         │  SQLite (search index,  │
│                     │         │    dir size cache)      │
│                     │         │                         │
│                     │         │  Archive VFS (zip/rar/7z│
│                     │         │    in-memory manifests) │
└─────────────────────┘         └─────────────────────────┘
```

## Component Directory: `api/` (Go Backend, 19 files)

| File | Role | Key Exports |
|------|------|-------------|
| `main.go` | Entry point — HTTP server, route registration, static file serving | `main()`, `openBrowser()`, `handleProperties()` |
| `actions.go` | User-defined shell command actions | `HandleActions`, `HandleActionExec` |
| `ops.go` | Core file operations: open, rename, copy, move, delete, mkdir, chmod, clipboard | `HandleFileOp`, `handlePaste`, `handleDelete`, `handleRename`, `handleMkdir`, `handleChmod`, `copyFile`, `copyDir`, `moveItem` |
| `dir.go` | Directory listing with cursor pagination, sorting, recursive size calc | `HandleReadDirectory`, `HandleDirSize`, `CalculateDirSize`, `FileEntry`, `DirResponse` |
| `search.go` | Real-time filesystem search (live walk) | `HandleSearch`, `SearchEntry`, `SearchResponse` |
| `log.go` | Persistent action log with binary-encoded records, CRC, undo | `GetLog`, `ActionLog.Append`, `ActionLog.QueryPath`, `ActionLog.QueryRecent`, `HandleLog`, `HandleLogRevert`, `ActionRecord` |
| `log_revert.go` | Revert logic for paste-copy, paste-move, rename, mkdir | `RevertRecord` |
| `places.go` | Bookmarks, workspaces, mounted drives, custom action config | `HandlePlaces`, `HandleWorkspaces`, `CustomAction`, `Config`, `WorkspaceSession` |
| `archive_handlers.go` | HTTP handlers for archive virtual filesystem | `HandleListArchiveDir`, `HandleStreamArchiveFile` |
| `archive_extract.go` | Async archive extraction with job tracking, progress polling | `HandleExtractArchive`, `HandleExtractStatus`, `performExtract`, `ExtractJob` |
| `archive_parser.go` | Archive format detection, manifest building, in-memory file extraction | `DetectFormat`, `BuildManifest`, `extractFileToMemory`, `parseZip`, `parseRar`, `parse7z` |
| `archive_vfs.go` | LRU-cached virtual filesystem layer over archives | `ArchiveCache`, `GetCache`, `PutCache`, `BuildCacheKey`, `OpenAndVerify`, `VirtualNode` |
| `diskspace.go` | Disk space query (platform dispatch) | `HandleDiskSpace`, `DiskSpaceInfo` |
| `diskspace_unix.go` | Unix disk space via `syscall.Statfs_t` | `GetDiskSpace` |
| `diskspace_windows.go` | Windows disk space | `GetDiskSpace` |
| `db.go` | SQLite database init, dir size caching | `InitDB`, `GetCachedDirSize`, `SaveCachedDirSize`, `SaveCachedDirSizesBatch` |
| `search_index.go` | Full-text search index manager, query parsing, FTS5 execution | `IndexManager`, `GetIndexManager`, `ParseSearchQuery`, `ExecuteSearch`, `InitSearchTables` |
| `search_index_api.go` | HTTP handlers for index CRUD, rebuild, status | `HandleIndexSearch`, `HandleIndexRebuild`, `HandleIndexStatus`, `HandleIndexConfig`, `HandleIndexCancel` |
| `search_index_walker.go` | Background filesystem walker building the FTS index | `RebuildIndex`, `CancelRebuild`, `runRebuild`, `walkRoot`, `writer`, `compileExcludes` |

## Component Directory: `js/` (Frontend SPA, 19 files)

| File | Role | Key Exports |
|------|------|-------------|
| `app.js` | App bootstrap, event delegation, pane listeners, progress indicator | `setupEventListeners`, `setupPaneListeners`, `ProgressIndicator` |
| `state.js` | Global state: active pane, active tab, MRU tab tracking | `getActivePane`, `getActiveTab`, `getPaneDom`, `getPaneTab`, `updateMru`, `getRecentTabs` |
| `api.js` | Thin fetch wrappers for backend API | `executeFileOp`, `openFile` |
| `file-list.js` | Virtual-scrolled file list, grid view, selection, clipboard UI | `renderFiles`, `renderFilesListVirtual`, `renderFilesGrid`, `attachItemEventListeners`, `selectAll`, `updateSelectionUI` |
| `navigation.js` | Path navigation, breadcrumbs, back/forward history, view mode toggling | `navigateTo`, `renderBreadcrumbs`, `pushPaneHistory`, `navigatePaneHistory`, `setPaneViewMode`, `updateDiskSpaceDisplay` |
| `tabs.js` | Tab lifecycle (create, close, switch, duplicate), drag-reorder, groups | `createTab`, `switchTab`, `closeTab`, `duplicateTab`, `assignTabGroup`, `toggleGroupCollapse` |
| `sidebar.js` | Sidebar: bookmarks, mounted drives, add/remove bookmarks | `loadSidebarPlaces`, `renderBookmarks`, `renderMounts`, `addCurrentToBookmarks`, `removeBookmark` |
| `search-manager.js` | Full search modal with virtual scroller, filter chips, pagination, indexer settings | `openSearchManager`, `triggerSearch`, `renderVirtualRows`, `executeItemAction`, `fetchIndexerStatus`, `triggerIndexRebuild` |
| `quick-find.js` | Quick-find modal (Ctrl+P), inline search, bulk actions on results | `openQuickFind`, `triggerSearch`, `renderSearchResults`, `executeItemAction` |
| `context-menu.js` | Context menus for files, folders, search results; all menu action handlers | `showContextMenu`, `showFolderContextMenu`, `showSearchResultContextMenu`, `triggerClipboard`, `triggerPaste`, `triggerRename`, `triggerDelete`, `triggerChmod` |
| `keyboard.js` | Global keyboard shortcuts, tab cycling overlay | `handleKeyboardShortcuts`, `triggerTabCycling`, `cycleTabs` |
| `shortcuts.js` | Shortcut string parsing and matching DSL | `parseShortcut`, `matchesShortcut`, `getShortcutDisplay` |
| `action-log.js` | Action log panel: fetch, render, revert actions, relative timestamps | `openActionLog`, `toggleActionLog`, `fetchLog`, `revertRecord`, `renderRecords` |
| `action-log-init.js` | Action log dependency injection and initialization | (init side effects) |
| `utils.js` | Utility functions: formatting, smart positioning, VFS path parsing | `formatSize`, `formatDate`, `positionElementSmartly`, `parseVfsPath` |
| `workspace.js` | Tab session save/restore, workspace CRUD, auto-save | `restoreSession`, `autoSaveSession`, `loadWorkspaces`, `triggerSaveWorkspace`, `triggerDeleteWorkspace` |
| `split-view.js` | Split/quad pane layout, active pane tracking, responsive resize | `initSplitView`, `setActivePane`, `updateLayout`, `setSplitView`, `setQuadView` |
| `batch-rename.js` | Batch rename modal with preview, regex/numbering patterns | `startBatchRename`, `applyBatchRename`, `calculatePreviews`, `cancelBatchRename` |
| `custom-actions.js` | Custom action editor, pattern matching, execution with output toast | `initCustomActions`, `showActionEditor`, `executeCustomAction`, `getActionsForContext` |

---

## Key Architectural Patterns

### 1. HTTP-as-IPC Architecture

The browser never touches the filesystem. Every operation (list dir, read file, rename, search, archive browse) goes through a REST endpoint. The Go server binds to a random port on `127.0.0.1` and opens the browser to that URL. This means the frontend is stateless with respect to the OS — all state lives in Go or is serialised to SQLite.

### 2. Cursor-Based Pagination for Directory Listing

`api/dir.go` implements server-side pagination using cursor tokens (monotonically increasing file IDs derived from directory position). The frontend issues `GET /api/dir?path=X&cursor=Y&limit=Z` calls. This avoids loading large directories at once. The cursor persists the sort order across pages.

### 3. Dual Search Architecture

| Mode | Handler | Mechanism | Use Case |
|------|---------|-----------|----------|
| Live search | `api/search.go` | On-demand filesystem walk with context cancellation | Ad-hoc Ctrl+P / Ctrl+F |
| Indexed search | `api/search_index.go` + `api/search_index_walker.go` | Background SQLite FTS5 trigram index, periodically rebuilt | Deep search across indexed roots |

The live search is cancellable (context cancellation on subsequent keystroke). The indexed search uses SQLite FTS5 with trigrams for fuzzy matching and supports filters (`ext:pdf`, `type:dir`, path scoping).

### 4. Action Log with Binary Codec

`api/log.go` records every reversible file operation in a binary-encoded append-only log stored at `~/.local/share/zen-man/action-log`. Each record has a CRC32 checksum. Reverts append a "reverted" marker at the original record's offset (the only in-place mutation). Binary encoding (rather than JSON) was chosen for append performance. The codec reads/writes fixed-size headers + variable-length path fields.

### 5. Archive Virtual Filesystem

Archives (zip, rar, 7z) are treated as virtual directories. On first browse, `BuildManifest` parses the archive into a tree of `VirtualNode`s stored in an LRU cache (`api/archive_vfs.go`). Subsequent directory listings read from the cache. File reads stream directly from the archive via `HandleStreamArchiveFile`. Cache entries expire after a TTL and the LRU cap prevents memory exhaustion.

### 6. Background Indexer with Platform-Tuned Concurrency

`api/search_index_walker.go` runs the FTS index builder as a cancellable goroutine. It probes the underlying block device (`isRotationalDev`) to choose between single-worker (HDD, avoid thrashing) and multi-worker (SSD, parallel reads). Exclude patterns are compiled once and shared across walkers.

### 7. Async Extract with Job Tracking

Archive extraction (`api/archive_extract.go`) runs asynchronously in a goroutine. The client polls `HandleExtractStatus` for progress. A periodic cleanup ticker evicts stale completed jobs. Each `ExtractJob` holds its own progress counters.

### 8. Session Persistence with Auto-Save

`js/workspace.js` serialises the full tab layout (paths, pane splits, view modes) to the backend every 30 seconds. On restart, `restoreSession` replays the tabs. The backend stores sessions as JSON in the config directory.

### 9. Dual Pane / Quad View Layout

`js/split-view.js` manages a 1, 2, or 4 pane layout. `js/state.js` tracks which pane is active and maintains a most-recently-used (MRU) tab list for Alt+Tab cycling. Each pane has its own navigation history stack (back/forward).

### 10. Go API Handler Convention

All REST handlers in `api/` follow a consistent pattern: read request body, validate, execute operation, write JSON response. `api/ops.go` centralises file operations behind a single `HandleFileOp` router that dispatches on an `OpRequest.Action` field. This keeps the HTTP surface area small while allowing client-side flexibility.

---

## Data Flow: Typical User Action

```
User clicks file → context-menu.js:triggerOpen()
  → js/api.js:openFile(path)
    → POST /api/op { action: "open", paths: [...] }
      → api/ops.go:HandleFileOp → handleOpen()
        → exec.Command("xdg-open", path)
        → HTTP 200 { success: true }
          → frontend shows toast/notification
```

## Data Flow: Directory Listing

```
navigateTo("/home/user/docs")
  → GET /api/dir?path=/home/user/docs&cursor=0&limit=100&sort=name&order=asc
    → api/dir.go:HandleReadDirectory → ResolvePath → os.ReadDir → sortEntries
    → HTTP 200 { entries: [...], cursor: "MTIz", hasMore: true }
      → file-list.js:renderFiles → renderFilesListVirtual (virtual scroller)
        → user scrolls → loadMoreFiles(cursor)
```

## Data Flow: Archive Browsing

```
user clicks "project.zip"
  → navigateTo detects .zip extension → sends VFS path
    → GET /api/archive?path=/home/user/project.zip&internal=/&cursor=0&limit=100
      → archive_handlers.go:HandleListArchiveDir
        → archive_parser.go:BuildManifest (parses zip, builds virtual tree)
        → archive_vfs.go:PutCache (LRU)
        → returns VirtualNode children as FileEntry list
```

## Data Flow: Search + Revert

```
Action performed → api/log.go:ActionLog.Append (binary-encoded record)
  → later: action-log.js:fetchLog() → GET /api/log?limit=50
    → user clicks revert → POST /api/log/revert { id: "..." }
      → log_revert.go:RevertRecord (reverse the operation)
      → log.go:MarkReverted (write revert marker in log file)
      → frontend refreshes directory listing
```

---

## API Route Map (inferred from handler functions)

| Method | Route | Handler | File |
|--------|-------|---------|------|
| GET | `/api/dir` | `HandleReadDirectory` | `api/dir.go` |
| GET | `/api/dir/size` | `HandleDirSize` | `api/dir.go` |
| POST | `/api/op` | `HandleFileOp` | `api/ops.go` |
| GET | `/api/search` | `HandleSearch` | `api/search.go` |
| GET | `/api/log` | `HandleLog` | `api/log.go` |
| POST | `/api/log/revert` | `HandleLogRevert` | `api/log.go` |
| GET | `/api/places` | `HandlePlaces` | `api/places.go` |
| GET | `/api/workspaces` | `HandleWorkspaces` | `api/places.go` |
| GET | `/api/actions` | `HandleActions` | `api/actions.go` |
| POST | `/api/actions/exec` | `HandleActionExec` | `api/actions.go` |
| GET | `/api/archive` | `HandleListArchiveDir` | `api/archive_handlers.go` |
| GET | `/api/archive/stream` | `HandleStreamArchiveFile` | `api/archive_handlers.go` |
| POST | `/api/archive/extract` | `HandleExtractArchive` | `api/archive_extract.go` |
| GET | `/api/archive/extract/status` | `HandleExtractStatus` | `api/archive_extract.go` |
| GET | `/api/diskspace` | `HandleDiskSpace` | `api/diskspace.go` |
| GET | `/api/search/index` | `HandleIndexSearch` | `api/search_index_api.go` |
| POST | `/api/search/index/rebuild` | `HandleIndexRebuild` | `api/search_index_api.go` |
| GET | `/api/search/index/status` | `HandleIndexStatus` | `api/search_index_api.go` |
| POST | `/api/search/index/config` | `HandleIndexConfig` | `api/search_index_api.go` |
| POST | `/api/search/index/cancel` | `HandleIndexCancel` | `api/search_index_api.go` |
| GET | `/api/properties` | `handleProperties` | `main.go` |

---

## Cross-Cutting Concerns

- **Concurrency**: `sync.RWMutex` on `ActionLog`, `IndexManager`, `ArchiveCache`. Background workers for index rebuild, extract jobs, cache eviction.
- **State**: Frontend state in `js/state.js` (singleton module). Backend state in package-level vars (log singleton, index singleton, cache map).
- **Config**: JSON files under `~/.config/zen-man/` (places, actions, search config).
- **Data Dir**: `~/.local/share/zen-man/` (action log binary, SQLite DB).
- **Platform Abstraction**: `diskspace_unix.go` / `diskspace_windows.go` build-tag dispatch. `xdg-open` vs Windows `os/exec`.
