# Copy Path/Name & Custom Actions System

Add Copy Path/Copy Name to context menus, and build a full Custom Actions system with an autohide right sidebar for managing actions that integrate into context menus.

## User Review Required

> [!IMPORTANT]
> **Custom Action Command Variables** — Instead of Thunar's cryptic `%f/%F/%d/%D/%n/%N` syntax, we propose clickable variable chips (`{file}`, `{files}`, `{dir}`, `{name}`, `{names}`, `{parent}`) with a live preview showing what the command resolves to. Does this approach feel right?

> [!IMPORTANT]
> **Action Execution Output** — Should action output (stdout/stderr) be shown in a toast notification, a popup modal, or silently ignored? Current plan: optional toggle per-action with toast notifications.

## Open Questions

1. **Custom Action Icons** — Should we use emoji pickers, or a fixed set of SVG icons to choose from? Current plan: emoji-based (simple, no asset deps).
2. **Action Ordering** — Should actions in the context menu follow the sidebar order, or be alphabetical? Current plan: sidebar order (drag-reorderable later).

---

## Proposed Changes

### Part 1: Copy Path / Copy Name

Minimal changes — purely frontend, no backend needed.

---

#### [MODIFY] [context-menu.js](file:///media/jang/home/Deve/zen-man/frontend/js/context-menu.js)

**File context menu** — Add "Copy Path" and "Copy Name" items after the existing Cut item (line 63), before the separator leading to Rename/Delete:

```diff
+            <div class="context-menu-separator"></div>
+            <div class="context-menu-item" data-action="copy-path">
+                <span>Copy Path</span>
+            </div>
+            <div class="context-menu-item" data-action="copy-name">
+                <span>Copy Name</span>
+            </div>
```

**Add handler functions:**

```js
// Copy full paths of all selected items, newline-separated
export function triggerCopyPath() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    const text = [...tab.selectedPaths].join('\n') + '\n';
    navigator.clipboard.writeText(text);
}

// Copy basenames of all selected items, newline-separated  
export function triggerCopyName() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    const text = [...tab.selectedPaths].map(p => p.split('/').pop()).join('\n') + '\n';
    navigator.clipboard.writeText(text);
}
```

**Event delegation** — Add `copy-path` and `copy-name` cases to the click handler at line 196.

---

#### [MODIFY] [tabs.js](file:///media/jang/home/Deve/zen-man/frontend/js/tabs.js)

**Tab context menu** (`showTabContextMenu`, line 314) — Add Copy Path / Copy Name items after Duplicate Tab:

```diff
         <div class="context-menu-item" data-action="duplicate-tab" ...>
             <span>Duplicate Tab</span>
         </div>
+        <div class="context-menu-separator"></div>
+        <div class="context-menu-item" data-action="copy-tab-path" data-pane-id="${paneId}" data-tab-id="${tabId}">
+            <span>Copy Path</span>
+        </div>
+        <div class="context-menu-item" data-action="copy-tab-name" data-pane-id="${paneId}" data-tab-id="${tabId}">
+            <span>Copy Name</span>
+        </div>
         <div class="context-menu-separator"></div>
```

#### [MODIFY] [context-menu.js](file:///media/jang/home/Deve/zen-man/frontend/js/context-menu.js) (event delegation)

Add `copy-tab-path` and `copy-tab-name` cases that look up the tab via `getPaneTab(paneId, tabId)` and copy `tab.currentPath` or its basename.

---

### Part 2: Custom Actions — Backend

---

#### [MODIFY] [places.go](file:///media/jang/home/Deve/zen-man/api/places.go)

**Add data model** to Config struct:

```go
type CustomAction struct {
    ID         string `json:"id"`
    Name       string `json:"name"`
    Icon       string `json:"icon"`        // emoji
    Command    string `json:"command"`      // e.g. "code {file}"
    Role       string `json:"role"`         // "files" | "dirs" | "both" | "background"
    Patterns   string `json:"patterns"`     // comma-separated globs, e.g. "*.jpg,*.png"
    ShowOutput bool   `json:"show_output"`
}

// Add to Config struct:
type Config struct {
    Bookmarks     []string                    `json:"bookmarks"`
    Workspaces    map[string]WorkspaceSession `json:"workspaces"`
    CustomActions []CustomAction              `json:"custom_actions"`
}
```

**Role meanings:**
| Role | Appears when... |
|---|---|
| `files` | Right-click on file(s) only |
| `dirs` | Right-click on folder(s) only |
| `both` | Right-click on any file/folder selection |
| `background` | Right-click on empty area (no selection) |

#### [NEW] [actions.go](file:///media/jang/home/Deve/zen-man/api/actions.go)

New file with two handlers:

**`HandleActions`** — CRUD for custom actions:
- `GET` → return all custom actions from config
- `POST` with `action: "create"` → append new action with generated UUID
- `POST` with `action: "update"` → update action by ID
- `POST` with `action: "delete"` → remove action by ID
- `POST` with `action: "reorder"` → accept ordered ID list, reorder

**`HandleActionExec`** — Execute a custom action:
- `POST` with `{ id, paths[], dir }` 
- Look up action by ID, substitute variables in command:
  - `{file}` → first selected path
  - `{files}` → space-separated quoted paths
  - `{dir}` → current directory  
  - `{name}` → basename of first selected
  - `{names}` → space-separated basenames
  - `{parent}` → parent directory of first selected
- Execute via `exec.Command("sh", "-c", expandedCommand)` with working dir = `{dir}`
- If `show_output`: capture and return stdout/stderr
- If not: fire-and-forget (detach process)

#### [MODIFY] [main.go](file:///media/jang/home/Deve/zen-man/main.go)

Replace dummy `handleCustomAction` stub with real routing:

```diff
- mux.HandleFunc("/api/action", handleCustomAction)
+ mux.HandleFunc("/api/actions", api.HandleActions)
+ mux.HandleFunc("/api/action/exec", api.HandleActionExec)
```

Remove the dummy `handleCustomAction` function.

---

### Part 3: Custom Actions — Frontend Right Sidebar

---

#### [MODIFY] [index.html](file:///media/jang/home/Deve/zen-man/frontend/index.html)

Add right sidebar trigger zone and sidebar panel **after** `</main>` (line 140), before the context menu div:

```html
<!-- Right Sidebar Trigger Zone -->
<div class="right-sidebar-trigger-zone"></div>

<!-- Right Sidebar: Custom Actions Manager -->
<aside class="right-sidebar" id="right-sidebar">
    <div class="sidebar-header">
        <h2>Custom Actions</h2>
        <button id="btn-add-action" class="btn-sidebar-action" title="Add New Action">+</button>
    </div>
    
    <!-- Action Editor (hidden by default) -->
    <div id="action-editor" class="action-editor" style="display: none;">
        <div class="action-editor-field">
            <label>Name</label>
            <input type="text" id="action-name" placeholder="e.g. Open in Terminal">
        </div>
        <div class="action-editor-field">
            <label>Icon</label>
            <input type="text" id="action-icon" placeholder="🖥️" maxlength="2" class="action-icon-input">
        </div>
        <div class="action-editor-field">
            <label>Command</label>
            <input type="text" id="action-command" placeholder="Click variables below...">
            <div class="action-variables">
                <span class="var-chip" data-var="{file}">{file}</span>
                <span class="var-chip" data-var="{files}">{files}</span>
                <span class="var-chip" data-var="{dir}">{dir}</span>
                <span class="var-chip" data-var="{name}">{name}</span>
                <span class="var-chip" data-var="{names}">{names}</span>
                <span class="var-chip" data-var="{parent}">{parent}</span>
            </div>
        </div>
        <div class="action-editor-field">
            <label>Command Preview</label>
            <div id="action-preview" class="action-preview">—</div>
        </div>
        <div class="action-editor-field">
            <label>Applies to</label>
            <div class="action-roles">
                <label class="role-option"><input type="radio" name="action-role" value="both" checked> 📄📁 Files & Folders</label>
                <label class="role-option"><input type="radio" name="action-role" value="files"> 📄 Files Only</label>
                <label class="role-option"><input type="radio" name="action-role" value="dirs"> 📁 Folders Only</label>
                <label class="role-option"><input type="radio" name="action-role" value="background"> 🖥️ Background (empty area)</label>
            </div>
        </div>
        <div class="action-editor-field">
            <label>File Patterns <span class="text-muted">(optional, e.g. *.jpg, *.png)</span></label>
            <input type="text" id="action-patterns" placeholder="Leave empty for all files">
        </div>
        <div class="action-editor-field">
            <label class="toggle-label">
                <input type="checkbox" id="action-show-output">
                <span>Show command output</span>
            </label>
        </div>
        <div class="action-editor-buttons">
            <button id="action-save-btn" class="btn-accent">Save</button>
            <button id="action-cancel-btn" class="btn-secondary">Cancel</button>
        </div>
    </div>

    <!-- Action List -->
    <div id="action-list" class="action-list"></div>
</aside>
```

**Key UX design decisions:**
- **Variable chips** are clickable — clicking inserts the variable at cursor position in the command input
- **Live preview** updates on every keystroke, showing an example like: `code /home/user/photo.jpg`
- **Role radio buttons** use descriptive labels with emoji icons — no Thunar-style cryptic conditions
- The entire editor is **inline** within the sidebar — no separate dialog/modal

---

#### [NEW] [custom-actions.css](file:///media/jang/home/Deve/zen-man/frontend/css/custom-actions.css)

**Right sidebar** — mirrors the left sidebar autohide pattern:

```css
/* Right Sidebar Trigger Zone */
.right-sidebar-trigger-zone {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 12px;
    z-index: 999;
}

/* Right Sidebar */
.right-sidebar {
    position: absolute;
    right: -300px;
    top: 0;
    bottom: 0;
    width: 300px;
    background-color: var(--bg-sidebar);
    border-left: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    z-index: 1000;
    transition: right 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.4);
    overflow-y: auto;
}

.right-sidebar-trigger-zone:hover ~ .right-sidebar,
.right-sidebar:hover,
.right-sidebar.visible {
    right: 0;
}
```

**Variable chips styling:**
```css
.var-chip {
    display: inline-block;
    padding: 2px 8px;
    background: var(--accent-color);
    color: white;
    border-radius: 12px;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
}
.var-chip:hover {
    background: var(--accent-hover);
    transform: scale(1.05);
}
```

**Action list items** with hover-reveal edit/delete buttons (same pattern as bookmark items).

**Action editor** — compact vertical form within sidebar width, with proper spacing, themed inputs matching existing design tokens.

---

#### [NEW] [custom-actions.js](file:///media/jang/home/Deve/zen-man/frontend/js/custom-actions.js)

New ES module with:

```
State:
  - customActions[] — loaded from backend on init

API functions:
  - loadCustomActions()       → GET /api/actions
  - saveCustomAction(action)  → POST /api/actions {action: "create"/"update"}
  - deleteCustomAction(id)    → POST /api/actions {action: "delete"}
  - executeCustomAction(id, paths, dir) → POST /api/action/exec

UI functions:
  - initCustomActions()       → attach button/chip listeners, load actions
  - renderActionList()        → render sidebar action list with edit/delete
  - showActionEditor(action?) → show editor form (blank for create, populated for edit)
  - hideActionEditor()        → collapse editor, show list
  - updateCommandPreview()    → live-update preview with example paths
  - insertVariable(varName)   → insert at cursor position in command input

Context Menu Integration:
  - getActionsForContext(isDir, isItem, fileName)
      → filter customActions by role + pattern match
      → returns HTML string of menu items to inject

  - handleActionMenuClick(actionId)
      → get selected paths + current dir from active tab
      → call executeCustomAction()
      → show toast if show_output enabled
```

---

#### [MODIFY] [context-menu.js](file:///media/jang/home/Deve/zen-man/frontend/js/context-menu.js)

**Inject custom actions into file context menus:**

In `showContextMenu()`, after building the standard menu HTML, append custom actions:

```js
import { getActionsForContext, handleActionMenuClick } from './custom-actions.js';

// At end of showContextMenu():
const actionsHtml = getActionsForContext(isDir, isItem, targetPath);
if (actionsHtml) {
    html += `<div class="context-menu-separator"></div>`;
    html += actionsHtml;
}
```

**Event delegation** — add a catch-all for `data-action="custom-action"` with `data-action-id`:

```js
} else if (action === 'custom-action') {
    const actionId = item.getAttribute('data-action-id');
    handleActionMenuClick(actionId);
}
```

---

#### [MODIFY] [style.css](file:///media/jang/home/Deve/zen-man/frontend/css/style.css)

Add import:

```diff
 @import 'context-menu.css';
+@import 'custom-actions.css';
```

#### [MODIFY] [app.js](file:///media/jang/home/Deve/zen-man/frontend/js/app.js)

Add init call:

```diff
+import { initCustomActions } from './custom-actions.js';
 
 // In DOMContentLoaded:
+    initCustomActions();
```

---

## Verification Plan

### Automated Tests

```bash
# Backend compiles
cd /media/jang/home/Deve/zen-man && go build ./...

# Existing tests pass
go test ./api/...
```

### Manual Verification

1. **Copy Path/Name (File View)**:
   - Select single file → right-click → "Copy Path" → paste in terminal → verify full path with trailing newline
   - Select multiple files → right-click → "Copy Name" → paste → verify newline-separated basenames
   
2. **Copy Path/Name (Tab)**:
   - Right-click tab → "Copy Path" → verify tab's current directory path
   - Right-click tab → "Copy Name" → verify directory basename

3. **Right Sidebar**:
   - Hover right edge → sidebar slides in
   - Move mouse away → sidebar slides out
   - Click "+" → editor form appears inline

4. **Custom Action CRUD**:
   - Create action "Open in VS Code" with command `code {file}`, role "files"
   - Verify it appears in sidebar list
   - Edit action → change name → verify update
   - Delete action → confirm removal

5. **Variable Chips**:
   - Click `{file}` chip → verify inserted at cursor in command input
   - Type command → verify live preview updates with example path

6. **Context Menu Integration**:
   - Create "files" role action → right-click file → verify action appears
   - Create "dirs" role action → right-click folder → verify action appears
   - Create "background" role action → right-click empty area → verify action appears
   - Verify pattern filtering (e.g., `*.jpg` action only shows for .jpg files)

7. **Action Execution**:
   - Create action `echo {file}` with "show output" on → execute → verify toast shows output
   - Create action `ls {dir}` → execute → verify it runs without errors
