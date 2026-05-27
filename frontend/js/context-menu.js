import { state, getActiveTab, getPaneDom, getPaneTab } from './state.js';
import { setActivePane } from './split-view.js';
import { navigateTo } from './navigation.js';
import { executeFileOp, openFile } from './api.js';
import { updateItemSelectionStyles, updateSelectionUI } from './file-list.js';
import { createTab, closeTab, duplicateTab, assignTabGroup } from './tabs.js';
import { getActionsForContext, handleActionMenuClick } from './custom-actions.js';

// Right Click Context Menu Handler
export function handlePaneContextMenu(e, paneId) {
    e.preventDefault();
    setActivePane(paneId);
    
    const tab = getActiveTab();
    if (!tab) return;

    const item = e.target.closest('.file-item');
    if (item) {
        const path = item.getAttribute('data-path');
        const isDir = item.getAttribute('data-dir') === 'true';
        
        if (!tab.selectedPaths.has(path)) {
            tab.selectedPaths.clear();
            tab.selectedPaths.add(path);
            updateItemSelectionStyles(paneId);
        }
        showContextMenu(e, path, isDir, true);
    } else {
        tab.selectedPaths.clear();
        updateItemSelectionStyles(paneId);
        showContextMenu(e, null, false, false);
    }
}

export function showContextMenu(e, targetPath, isDir, isItem) {
    const menu = document.getElementById('context-menu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.display = 'block';

    let html = '';
    if (isItem) {
        if (isDir) {
            html += `
                <div class="context-menu-item" data-action="open-in-new-tab">
                    <span>Open in New Tab</span>
                </div>
                <div class="context-menu-separator"></div>
            `;
        }
        html += `
            <div class="context-menu-item" data-action="open">
                <span>Open</span>
                <span class="context-menu-shortcut">Enter</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-action="copy">
                <span>Copy</span>
                <span class="context-menu-shortcut">Ctrl+C</span>
            </div>
            <div class="context-menu-item" data-action="cut">
                <span>Cut</span>
                <span class="context-menu-shortcut">Ctrl+X</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-action="copy-path">
                <span>Copy Path</span>
            </div>
            <div class="context-menu-item" data-action="copy-name">
                <span>Copy Name</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-action="rename">
                <span>Rename</span>
                <span class="context-menu-shortcut">F2</span>
            </div>
            <div class="context-menu-item" data-action="delete" style="color: var(--danger-color);">
                <span>Delete</span>
                <span class="context-menu-shortcut">Del</span>
            </div>
        `;
    } else {
        html += `
            <div class="context-menu-item" data-action="paste">
                <span>Paste</span>
                <span class="context-menu-shortcut">Ctrl+V</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-action="create-folder">
                <span>New Folder</span>
                <span class="context-menu-shortcut">Ctrl+Shift+N</span>
            </div>
        `;
    }

    const customHtml = getActionsForContext(isDir, isItem, targetPath);
    if (customHtml) {
        html += '<div class="context-menu-separator"></div>' + customHtml;
    }

    menu.innerHTML = html;
}

export function triggerOpenInNewTab() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size !== 1) return;
    const path = [...tab.selectedPaths][0];
    createTab(state.activePane, path);
}

export function triggerOpen() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    
    tab.selectedPaths.forEach(p => {
        const fileListEl = getPaneDom(state.activePane).querySelector('.file-list');
        const item = Array.from(fileListEl.querySelectorAll('.file-item')).find(el => el.getAttribute('data-path') === p);
        if (item) {
            const isDir = item.getAttribute('data-dir') === 'true';
            if (isDir) {
                navigateTo(p, true, state.activePane);
            } else {
                openFile(p);
            }
        }
    });
}

export async function triggerClipboard(op) {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    try {
        await executeFileOp(op, [...tab.selectedPaths]);
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        infoEl.textContent = `${op === 'copy' ? 'Copied' : 'Cut'} ${tab.selectedPaths.size} item(s)`;
    } catch (err) {
        alert(`Error executing operation: ${err.message}`);
    }
}

export async function triggerPaste() {
    const tab = getActiveTab();
    if (!tab) return;
    try {
        await executeFileOp('paste', [], tab.currentPath);
        navigateTo(tab.currentPath, false, state.activePane);
        
        // Refresh opposite pane if displaying same path
        const oppositePaneId = state.activePane === 'left' ? 'right' : 'left';
        if (state.isSplit) {
            const oppTab = state.panes[oppositePaneId].tabs.find(t => t.id === state.panes[oppositePaneId].activeTabId);
            if (oppTab && oppTab.currentPath === tab.currentPath) {
                navigateTo(oppTab.currentPath, false, oppositePaneId);
            }
        }
    } catch (err) {
        alert(`Paste failed: ${err.message}`);
    }
}

export async function triggerRename() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size !== 1) return;
    const oldPath = [...tab.selectedPaths][0];
    const oldName = oldPath.split('/').pop();
    const newName = prompt('Enter new name:', oldName);
    if (newName && newName !== oldName) {
        try {
            await executeFileOp('rename', [oldPath], null, newName);
            navigateTo(tab.currentPath, false, state.activePane);
        } catch (err) {
            alert(`Rename failed: ${err.message}`);
        }
    }
}

export async function triggerDelete() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    const confirmMsg = `Are you sure you want to permanently delete these ${tab.selectedPaths.size} item(s)?`;
    if (confirm(confirmMsg)) {
        try {
            await executeFileOp('delete', [...tab.selectedPaths]);
            navigateTo(tab.currentPath, false, state.activePane);
        } catch (err) {
            alert(`Delete failed: ${err.message}`);
        }
    }
}

export async function triggerCreateFolder() {
    const tab = getActiveTab();
    if (!tab) return;
    const folderName = prompt('Enter new folder name:', 'New Folder');
    if (folderName) {
        try {
            await executeFileOp('mkdir', [], tab.currentPath, folderName);
            navigateTo(tab.currentPath, false, state.activePane);
        } catch (err) {
            alert(`Failed to create directory: ${err.message}`);
        }
    }
}

// Copy Path / Name helpers
export function triggerCopyPath() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    const text = [...tab.selectedPaths].join('\n') + '\n';
    navigator.clipboard.writeText(text);
}

export function triggerCopyName() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    const text = [...tab.selectedPaths].map(p => p.split('/').pop()).join('\n') + '\n';
    navigator.clipboard.writeText(text);
}

export function triggerCopyTabPath(paneId, tabId) {
    const tab = getPaneTab(paneId, tabId);
    if (!tab || !tab.currentPath) return;
    navigator.clipboard.writeText(tab.currentPath + '\n');
}

export function triggerCopyTabName(paneId, tabId) {
    const tab = getPaneTab(paneId, tabId);
    if (!tab || !tab.currentPath) return;
    const name = tab.currentPath.split('/').pop() || tab.currentPath;
    navigator.clipboard.writeText(name + '\n');
}

// Attach Event Delegation Listener
document.addEventListener('DOMContentLoaded', () => {
    const contextMenu = document.getElementById('context-menu');
    if (contextMenu) {
        contextMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;
            
            const action = item.getAttribute('data-action');
            const paneId = item.getAttribute('data-pane-id');
            const tabId = item.getAttribute('data-tab-id');
            const color = item.getAttribute('data-color');
            
            if (action === 'open-in-new-tab') {
                triggerOpenInNewTab();
            } else if (action === 'open') {
                triggerOpen();
            } else if (action === 'copy') {
                triggerClipboard('copy');
            } else if (action === 'cut') {
                triggerClipboard('cut');
            } else if (action === 'copy-path') {
                triggerCopyPath();
            } else if (action === 'copy-name') {
                triggerCopyName();
            } else if (action === 'rename') {
                triggerRename();
            } else if (action === 'delete') {
                triggerDelete();
            } else if (action === 'paste') {
                triggerPaste();
            } else if (action === 'create-folder') {
                triggerCreateFolder();
            } else if (action === 'close-tab') {
                closeTab(paneId, tabId);
            } else if (action === 'duplicate-tab') {
                duplicateTab(paneId, tabId);
            } else if (action === 'assign-tab-group') {
                assignTabGroup(paneId, tabId, color);
            } else if (action === 'copy-tab-path') {
                triggerCopyTabPath(paneId, tabId);
            } else if (action === 'copy-tab-name') {
                triggerCopyTabName(paneId, tabId);
            } else if (action === 'custom-action') {
                const actionId = item.getAttribute('data-action-id');
                handleActionMenuClick(actionId);
            }
        });
    }
});
