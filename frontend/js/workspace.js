import { state } from './state.js';
import { createTab, switchTab } from './tabs.js';
import { setSplitView, setQuadView } from './split-view.js';

// ─── Internal helpers ────────────────────────────────────────────────────────

function buildSessionPayload() {
    const mapTab = t => ({ id: t.id, path: t.currentPath, name: t.name, group: t.group, color: t.color, flatViewMode: t.flatViewMode });
    return {
        left_tabs: state.panes.left.tabs.map(mapTab),
        left_active: state.panes.left.activeTabId,
        right_tabs: state.panes.right.tabs.map(mapTab),
        right_active: state.panes.right.activeTabId,
        left_bottom_tabs: state.panes['left-bottom'].tabs.map(mapTab),
        left_bottom_active: state.panes['left-bottom'].activeTabId,
        right_bottom_tabs: state.panes['right-bottom'].tabs.map(mapTab),
        right_bottom_active: state.panes['right-bottom'].activeTabId,
        split: state.isSplit,
        quad: state.isQuad
    };
}

async function restoreSession(session) {
    state.panes.left.tabs = [];
    state.panes.right.tabs = [];
    state.panes['left-bottom'].tabs = [];
    state.panes['right-bottom'].tabs = [];

    // Left pane
    if (session.left_tabs && session.left_tabs.length > 0) {
        session.left_tabs.forEach(t => {
            const isLazy = t.id !== session.left_active;
            const newTab = createTab('left', t.path, t.group, t.color, t.name, isLazy, t.id);
            if (newTab) newTab.flatViewMode = t.flatViewMode || null;
        });
        state.panes.left.activeTabId = session.left_active;
    } else {
        createTab('left', '');
    }

    // Right pane
    if (session.right_tabs && session.right_tabs.length > 0) {
        session.right_tabs.forEach(t => {
            const isLazy = t.id !== session.right_active;
            const newTab = createTab('right', t.path, t.group, t.color, t.name, isLazy, t.id);
            if (newTab) newTab.flatViewMode = t.flatViewMode || null;
        });
        state.panes.right.activeTabId = session.right_active;
    }

    // Left bottom pane
    if (session.left_bottom_tabs && session.left_bottom_tabs.length > 0) {
        session.left_bottom_tabs.forEach(t => {
            const isLazy = t.id !== session.left_bottom_active;
            const newTab = createTab('left-bottom', t.path, t.group, t.color, t.name, isLazy, t.id);
            if (newTab) newTab.flatViewMode = t.flatViewMode || null;
        });
        state.panes['left-bottom'].activeTabId = session.left_bottom_active;
    }

    // Right bottom pane
    if (session.right_bottom_tabs && session.right_bottom_tabs.length > 0) {
        session.right_bottom_tabs.forEach(t => {
            const isLazy = t.id !== session.right_bottom_active;
            const newTab = createTab('right-bottom', t.path, t.group, t.color, t.name, isLazy, t.id);
            if (newTab) newTab.flatViewMode = t.flatViewMode || null;
        });
        state.panes['right-bottom'].activeTabId = session.right_bottom_active;
    }

    state.isSplit = session.split;
    state.isQuad = !!session.quad;

    // Apply layout
    if (state.isQuad) {
        setQuadView(true);
    } else {
        setSplitView(state.isSplit);
    }

    // Activate/switch tabs
    switchTab('left', state.panes.left.activeTabId);
    
    if (state.isQuad || state.isSplit) {
        if (state.panes.right.activeTabId) {
            switchTab('right', state.panes.right.activeTabId);
        }
    }
    if (state.isQuad) {
        if (state.panes['left-bottom'].activeTabId) {
            switchTab('left-bottom', state.panes['left-bottom'].activeTabId);
        }
        if (state.panes['right-bottom'].activeTabId) {
            switchTab('right-bottom', state.panes['right-bottom'].activeTabId);
        }
    }
}

// ─── Auto-save (silent, debounced 1.5s) ─────────────────────────────────────

let _autoSaveTimer = null;

async function autoSaveSession(name) {
    if (!name) return;
    try {
        await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save', name, session: buildSessionPayload() })
        });
        _showSaveIndicator();
    } catch (err) {
        console.error('Auto-save failed:', err);
    }
}

function _showSaveIndicator() {
    const indicator = document.getElementById('workspace-save-indicator');
    if (!indicator) return;
    indicator.classList.add('visible');
    clearTimeout(indicator._fadeTimer);
    indicator._fadeTimer = setTimeout(() => indicator.classList.remove('visible'), 2000);
}

export function scheduleAutoSave() {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
        const select = document.getElementById('workspace-select');
        const name = select ? select.value : 'default';
        autoSaveSession(name);
    }, 1500);
}

// ─── Workspace REST integrations ─────────────────────────────────────────────

export async function loadWorkspaces() {
    try {
        const response = await fetch('/api/workspaces');
        if (!response.ok) throw new Error('Failed to load workspaces');
        const data = await response.json();

        const select = document.getElementById('workspace-select');
        let html = '<option value="default">Default</option>';
        if (data.workspaces) {
            data.workspaces.forEach(w => {
                if (w.toLowerCase() !== 'default') {
                    html += `<option value="${w}">${w}</option>`;
                }
            });
        }
        select.innerHTML = html;
    } catch (err) {
        console.error(err);
    }
}

// Called on app startup — restores the 'default' session, or creates a blank tab
export async function restoreDefaultWorkspace() {
    try {
        const response = await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restore', name: 'default' })
        });
        if (!response.ok) throw new Error('No saved default session');
        const data = await response.json();
        const s = data.session;
        if (s && (s.left_tabs?.length > 0 || s.right_tabs?.length > 0 || s.left_bottom_tabs?.length > 0 || s.right_bottom_tabs?.length > 0)) {
            await restoreSession(s);
            return;
        }
    } catch (_) {
        // No prior session saved — start fresh
    }
    createTab('left', '');
}

export function showWorkspaceCreatePanel() {
    document.getElementById('workspace-select').style.display = 'none';
    document.getElementById('workspace-new-btn').style.display = 'none';
    document.getElementById('workspace-delete').style.display = 'none';

    const panel = document.getElementById('workspace-create-panel');
    panel.style.display = 'flex';
    const input = document.getElementById('workspace-new-name');
    input.value = '';
    input.focus();
}

export function hideWorkspaceCreatePanel() {
    document.getElementById('workspace-create-panel').style.display = 'none';

    document.getElementById('workspace-select').style.display = 'block';
    document.getElementById('workspace-new-btn').style.display = 'block';
    document.getElementById('workspace-delete').style.display = 'block';
}

// Creates a NEW named workspace from the create panel
export async function triggerSaveWorkspace() {
    const nameInput = document.getElementById('workspace-new-name');
    const name = nameInput.value.trim();
    if (!name) {
        alert('Please enter a workspace name.');
        return;
    }
    if (name.toLowerCase() === 'default') {
        alert('Cannot overwrite or create a workspace named "default".');
        return;
    }

    try {
        const response = await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save', name, session: buildSessionPayload() })
        });
        if (response.ok) {
            await loadWorkspaces();
            document.getElementById('workspace-select').value = name;
            hideWorkspaceCreatePanel();
        }
    } catch (err) {
        alert('Failed to save workspace: ' + err.message);
    }
}

export async function triggerDeleteWorkspace() {
    const select = document.getElementById('workspace-select');
    const name = select.value;
    if (name === 'default') {
        alert('Cannot delete the Default workspace.');
        return;
    }

    if (confirm(`Are you sure you want to delete workspace "${name}"?`)) {
        try {
            const response = await fetch('/api/workspaces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', name })
            });
            if (response.ok) {
                await loadWorkspaces();
            }
        } catch (err) {
            console.error(err);
        }
    }
}

export async function handleWorkspaceChange() {
    const select = document.getElementById('workspace-select');
    const name = select.value;

    if (name === 'default') {
        // Restore saved default session (may be empty on first run)
        await restoreDefaultWorkspace();
        return;
    }

    try {
        const response = await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restore', name })
        });
        if (!response.ok) throw new Error('Workspace not found');
        const data = await response.json();
        await restoreSession(data.session);
    } catch (err) {
        alert('Failed to restore workspace: ' + err.message);
    }
}
