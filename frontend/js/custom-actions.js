import { getActiveTab, state } from './state.js';

let customActions = [];
let editingActionId = null;

// Mock variables for live command preview
const mockPreviewData = {
    dir: '/home/user/projects/zen-man',
    file: '/home/user/projects/zen-man/frontend/index.html',
    files: `"/home/user/projects/zen-man/frontend/index.html" "/home/user/projects/zen-man/README.md"`,
    name: 'index.html',
    names: `"index.html" "README.md"`,
    parent: '/home/user/projects/zen-man/frontend'
};

export function initCustomActions() {
    setupUIEventListeners();
    loadCustomActions();
}

async function loadCustomActions() {
    try {
        const response = await fetch('/api/actions');
        if (!response.ok) throw new Error('Failed to load custom actions');
        customActions = await response.json() || [];
        renderActionList();
    } catch (err) {
        console.error('Error loading custom actions:', err);
    }
}

function setupUIEventListeners() {
    const addBtn = document.getElementById('btn-add-action');
    const cancelBtn = document.getElementById('action-cancel-btn');
    const saveBtn = document.getElementById('action-save-btn');
    const commandInput = document.getElementById('action-command');
    const nameInput = document.getElementById('action-name');
    const iconInput = document.getElementById('action-icon');
    const patternsInput = document.getElementById('action-patterns');
    
    // Add action button clicks
    addBtn.addEventListener('click', () => {
        showActionEditor(null);
    });

    // Cancel edit/create
    cancelBtn.addEventListener('click', () => {
        hideActionEditor();
    });

    // Save action
    saveBtn.addEventListener('click', saveAction);

    // Live preview event listeners
    commandInput.addEventListener('input', updateCommandPreview);

    // Click on variable chips to insert into command
    document.querySelectorAll('.var-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const token = chip.getAttribute('data-var');
            insertVariable(token);
        });
    });

    // Auto default icon when name changes if empty
    nameInput.addEventListener('input', () => {
        if (!iconInput.value) {
            iconInput.value = '⚡';
        }
    });
}

function insertVariable(token) {
    const input = document.getElementById('action-command');
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const text = input.value;
    input.value = text.substring(0, start) + token + text.substring(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + token.length;
    updateCommandPreview();
}

function updateCommandPreview() {
    const command = document.getElementById('action-command').value;
    const previewEl = document.getElementById('action-preview');

    if (!command.trim()) {
        previewEl.textContent = '—';
        return;
    }

    let resolved = command;
    resolved = resolved.replaceAll('{dir}', mockPreviewData.dir);
    resolved = resolved.replaceAll('{file}', mockPreviewData.file);
    resolved = resolved.replaceAll('{files}', mockPreviewData.files);
    resolved = resolved.replaceAll('{name}', mockPreviewData.name);
    resolved = resolved.replaceAll('{names}', mockPreviewData.names);
    resolved = resolved.replaceAll('{parent}', mockPreviewData.parent);

    previewEl.textContent = resolved;
}

function showActionEditor(action = null) {
    const editor = document.getElementById('action-editor');
    const actionList = document.getElementById('action-list');
    
    if (action) {
        editingActionId = action.id;
        document.getElementById('action-name').value = action.name;
        document.getElementById('action-icon').value = action.icon || '⚡';
        document.getElementById('action-command').value = action.command;
        document.getElementById('action-patterns').value = action.patterns || '';
        document.getElementById('action-show-output').checked = action.show_output;
        
        // Select appropriate role radio button
        const radios = document.getElementsByName('action-role');
        radios.forEach(radio => {
            radio.checked = radio.value === action.role;
        });
    } else {
        editingActionId = null;
        document.getElementById('action-name').value = '';
        document.getElementById('action-icon').value = '⚡';
        document.getElementById('action-command').value = '';
        document.getElementById('action-patterns').value = '';
        document.getElementById('action-show-output').checked = false;
        
        // Default role is "both"
        const radios = document.getElementsByName('action-role');
        radios.forEach(radio => {
            radio.checked = radio.value === 'both';
        });
    }

    editor.style.display = 'flex';
    actionList.style.display = 'none';
    updateCommandPreview();
}

function hideActionEditor() {
    document.getElementById('action-editor').style.display = 'none';
    document.getElementById('action-list').style.display = 'flex';
    editingActionId = null;
}

async function saveAction() {
    const name = document.getElementById('action-name').value.trim();
    const icon = document.getElementById('action-icon').value.trim() || '⚡';
    const command = document.getElementById('action-command').value.trim();
    const patterns = document.getElementById('action-patterns').value.trim();
    const show_output = document.getElementById('action-show-output').checked;

    let role = 'both';
    const radios = document.getElementsByName('action-role');
    for (const r of radios) {
        if (r.checked) {
            role = r.value;
            break;
        }
    }

    if (!name || !command) {
        alert('Name and Command fields are required.');
        return;
    }

    const actionData = {
        name,
        icon,
        command,
        role,
        patterns,
        show_output
    };

    if (editingActionId) {
        actionData.id = editingActionId;
    }

    const body = {
        action: editingActionId ? 'update' : 'create',
        action_data: actionData
    };

    try {
        const response = await fetch('/api/actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to save custom action');
        }

        const data = await response.json();
        customActions = data.custom_actions || [];
        renderActionList();
        hideActionEditor();
    } catch (err) {
        alert(`Error saving action: ${err.message}`);
    }
}

async function deleteCustomAction(id) {
    if (!confirm('Are you sure you want to delete this custom action?')) {
        return;
    }

    try {
        const response = await fetch('/api/actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'delete',
                action_data: { id }
            })
        });

        if (!response.ok) throw new Error('Failed to delete');

        const data = await response.json();
        customActions = data.custom_actions || [];
        renderActionList();
    } catch (err) {
        alert(`Error deleting custom action: ${err.message}`);
    }
}

async function moveAction(id, direction) {
    const index = customActions.findIndex(a => a.id === id);
    if (index === -1) return;
    
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= customActions.length) return;

    // Swap items
    const temp = customActions[index];
    customActions[index] = customActions[newIndex];
    customActions[newIndex] = temp;

    // Save ordering to backend
    const ids = customActions.map(a => a.id);
    try {
        const response = await fetch('/api/actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'reorder',
                ids: ids
            })
        });
        if (!response.ok) throw new Error('Reordering failed');
        renderActionList();
    } catch (err) {
        console.error('Reordering error:', err);
    }
}

function renderActionList() {
    const listContainer = document.getElementById('action-list');
    if (customActions.length === 0) {
        listContainer.innerHTML = `<div style="padding: 15px; font-size: 0.85rem; color: var(--text-muted); text-align: center;">No custom actions. Click + to add.</div>`;
        return;
    }

    listContainer.innerHTML = customActions.map(a => `
        <div class="sidebar-item action-item" data-id="${a.id}" style="display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; align-items:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-grow:1;">
                <span class="icon">${a.icon || '⚡'}</span>
                <span>${a.name}</span>
            </div>
            <div class="action-item-controls" style="display:flex; gap:4px;">
                <span class="btn-sidebar-action btn-move-up" data-id="${a.id}" title="Move Up" style="font-size:0.75rem; padding: 2px 4px;">▲</span>
                <span class="btn-sidebar-action btn-move-down" data-id="${a.id}" title="Move Down" style="font-size:0.75rem; padding: 2px 4px;">▼</span>
                <span class="btn-sidebar-action btn-edit-action" data-id="${a.id}" title="Edit" style="font-size:0.8rem; padding: 2px 4px;">✏️</span>
                <span class="btn-sidebar-action btn-delete-action" data-id="${a.id}" title="Delete" style="font-size:0.8rem; padding: 2px 4px; color: var(--danger-color);">&times;</span>
            </div>
        </div>
    `).join('');

    // Attach listeners
    listContainer.querySelectorAll('.action-item').forEach(item => {
        const id = item.getAttribute('data-id');
        const actObj = customActions.find(a => a.id === id);

        item.querySelector('.btn-edit-action').addEventListener('click', (e) => {
            e.stopPropagation();
            showActionEditor(actObj);
        });

        item.querySelector('.btn-delete-action').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteCustomAction(id);
        });

        item.querySelector('.btn-move-up').addEventListener('click', (e) => {
            e.stopPropagation();
            moveAction(id, -1);
        });

        item.querySelector('.btn-move-down').addEventListener('click', (e) => {
            e.stopPropagation();
            moveAction(id, 1);
        });
    });
}

// Check pattern match for file glob pattern
function matchPattern(fileName, patternStr) {
    if (!patternStr || patternStr.trim() === '') return true;
    const patterns = patternStr.split(',').map(p => p.trim().toLowerCase());
    const fileLower = fileName.toLowerCase();
    
    return patterns.some(pat => {
        // Simple escape except for wildcard *
        const regexStr = '^' + pat.replace(/[-\/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*') + '$';
        const regex = new RegExp(regexStr);
        return regex.test(fileLower);
    });
}

// Generate context menu items HTML string based on filters
export function getActionsForContext(isDir, isItem, targetPath) {
    const fileName = targetPath ? targetPath.split('/').pop() : '';
    
    const matched = customActions.filter(a => {
        // 1. Role filter
        if (!isItem) {
            // Background context (empty pane area)
            return a.role === 'background';
        }
        
        if (isDir) {
            if (a.role !== 'dirs' && a.role !== 'both') return false;
        } else {
            if (a.role !== 'files' && a.role !== 'both') return false;
        }

        // 2. Pattern filter (only applies if we clicked an item)
        return matchPattern(fileName, a.patterns);
    });

    if (matched.length === 0) return '';

    return matched.map(a => `
        <div class="context-menu-item" data-action="custom-action" data-action-id="${a.id}">
            <span>${a.icon || '⚡'} ${a.name}</span>
        </div>
    `).join('');
}

// Trigger custom action execution from menu clicks
export function handleActionMenuClick(actionId) {
    const action = customActions.find(a => a.id === actionId);
    if (!action) return;

    const tab = getActiveTab();
    if (!tab) return;

    // Get selected paths and directory
    const paths = [...tab.selectedPaths];
    const dir = tab.currentPath;

    executeCustomAction(action, paths, dir);
}

async function executeCustomAction(action, paths, dir) {
    try {
        const response = await fetch('/api/action/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: action.id,
                paths,
                dir
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to execute custom action');
        }

        const data = await response.json();
        
        if (action.show_output) {
            showOutputToast(action.name, data.status, data.output, data.error);
        }
    } catch (err) {
        showOutputToast(action.name, 'error', '', err.message);
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showOutputToast(actionName, status, output, errorMsg) {
    // Remove old toast
    const old = document.getElementById('action-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.id = 'action-toast';
    toast.className = 'action-toast';
    
    let title = `${actionName} Output`;
    let bodyContent = output || '(Command completed with no output)';
    
    if (status === 'error') {
        title = `${actionName} Error`;
        toast.style.borderLeftColor = 'var(--danger-color)';
        bodyContent = errorMsg + (output ? '\n\n' + output : '');
    }

    toast.innerHTML = `
        <div class="action-toast-header">
            <span style="font-weight:600; color:var(--text-active);">${title}</span>
            <span class="action-toast-close" style="font-size:1.2rem; cursor:pointer;">&times;</span>
        </div>
        <div class="action-toast-body">${escapeHtml(bodyContent)}</div>
    `;

    document.body.appendChild(toast);
    
    // Animate in
    setTimeout(() => {
        toast.classList.add('visible');
    }, 50);

    toast.querySelector('.action-toast-close').addEventListener('click', () => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    });

    // Auto close short successful output
    if (status !== 'error' && bodyContent.length < 300) {
        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.remove('visible');
                setTimeout(() => toast.remove(), 300);
            }
        }, 6000);
    }
}
