import { state } from './state.js';
import { createTab, switchTab } from './tabs.js';
import { setSplitView } from './split-view.js';

// Workspaces REST integrations
export async function loadWorkspaces() {
    try {
        const response = await fetch('/api/workspaces');
        if (!response.ok) throw new Error('Failed to load workspaces');
        const data = await response.json();
        
        const select = document.getElementById('workspace-select');
        let html = '<option value="default">Default</option>';
        if (data.workspaces) {
            data.workspaces.forEach(w => {
                html += `<option value="${w}">${w}</option>`;
            });
        }
        select.innerHTML = html;
    } catch (err) {
        console.error(err);
    }
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

export async function triggerSaveWorkspace() {
    const nameInput = document.getElementById('workspace-new-name');
    const name = nameInput.value.trim();
    if (!name) {
        alert('Please enter a workspace name.');
        return;
    }

    const leftSessionTabs = state.panes.left.tabs.map(t => ({
        id: t.id,
        path: t.currentPath,
        name: t.name,
        group: t.group,
        color: t.color
    }));
    
    const rightSessionTabs = state.panes.right.tabs.map(t => ({
        id: t.id,
        path: t.currentPath,
        name: t.name,
        group: t.group,
        color: t.color
    }));

    const session = {
        left_tabs: leftSessionTabs,
        left_active: state.panes.left.activeTabId,
        right_tabs: rightSessionTabs,
        right_active: state.panes.right.activeTabId,
        split: state.isSplit
    };

    try {
        const response = await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'save', name, session })
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
        state.panes.left.tabs = [];
        state.panes.right.tabs = [];
        state.isSplit = false;
        setSplitView(false);
        createTab('left', '');
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
        const session = data.session;

        state.panes.left.tabs = [];
        state.panes.right.tabs = [];

        if (session.left_tabs && session.left_tabs.length > 0) {
            session.left_tabs.forEach(t => {
                createTab('left', t.path, t.group, t.color);
            });
            state.panes.left.activeTabId = session.left_active;
        } else {
            createTab('left', '');
        }

        if (session.right_tabs && session.right_tabs.length > 0) {
            session.right_tabs.forEach(t => {
                createTab('right', t.path, t.group, t.color);
            });
            state.panes.right.activeTabId = session.right_active;
        }

        state.isSplit = session.split;
        setSplitView(state.isSplit);

        switchTab('left', state.panes.left.activeTabId);
        if (state.isSplit && state.panes.right.activeTabId) {
            switchTab('right', state.panes.right.activeTabId);
        }
    } catch (err) {
        alert('Failed to restore workspace: ' + err.message);
    }
}
