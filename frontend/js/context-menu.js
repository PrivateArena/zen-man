import { state, getActiveTab, getPaneDom, getPaneTab } from './state.js';
import { setActivePane } from './split-view.js';
import { navigateTo } from './navigation.js';
import { executeFileOp, openFile } from './api.js';
import { updateItemSelectionStyles, updateSelectionUI, renderFiles, updateClipboardUI } from './file-list.js';
import { createTab, closeTab, duplicateTab, assignTabGroup } from './tabs.js';
import { getActionsForContext, handleActionMenuClick, handleActionMenuClickForPath } from './custom-actions.js';
import { positionElementSmartly } from './utils.js';
import { getShortcutDisplay } from './shortcuts.js';

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

// --- Shared position helper ---
function _positionAndShow(e, html, context = 'file-list') {
    const menu = document.getElementById('context-menu');
    menu.setAttribute('data-menu-context', context);
    menu.innerHTML = html;
    menu.style.display = 'block';
    positionElementSmartly(menu, e.clientX, e.clientY);
}

export function showContextMenu(e, targetPath, isDir, isItem) {
    let html = '';
    if (isItem) {
        if (isDir) {
            html += `
                <div class="context-menu-item" data-action="open-in-new-tab">
                    <span>Open in New Tab</span>
                    <span class="context-menu-shortcut">${getShortcutDisplay('open-in-new-tab')}</span>
                </div>
                <div class="context-menu-item" data-action="copy-inside" data-target-path="${targetPath}">
                    <span>Copy Inside</span>
                    <span class="context-menu-shortcut">${getShortcutDisplay('copy-inside')}</span>
                </div>
                <div class="context-menu-item" data-action="cut-inside" data-target-path="${targetPath}">
                    <span>Cut Inside</span>
                    <span class="context-menu-shortcut">${getShortcutDisplay('cut-inside')}</span>
                </div>
            `;
            const hasClipboard = state.clipboard && state.clipboard.op;
            if (hasClipboard) {
                html += `
                    <div class="context-menu-item" data-action="paste-inside" data-target-path="${targetPath}">
                        <span>Paste Inside</span>
                        <span class="context-menu-shortcut">${getShortcutDisplay('paste-inside')}</span>
                    </div>
                `;
            }
            html += `<div class="context-menu-separator"></div>`;
        }
        html += `
            <div class="context-menu-item" data-action="open">
                <span>Open</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('open')}</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-action="cut">
                <span>Cut</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('cut')}</span>
            </div>
            <div class="context-menu-item" data-action="copy">
                <span>Copy</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('copy')}</span>
            </div>
            <div class="context-menu-item" data-action="copy-path">
                <span>Copy Path</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('copy-path')}</span>
            </div>
            <div class="context-menu-item" data-action="copy-name">
                <span>Copy Name</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('copy-name')}</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-action="rename">
                <span>Rename</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('rename')}</span>
            </div>
            <div class="context-menu-item" data-action="delete" style="color: var(--danger-color);">
                <span>Delete</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('delete')}</span>
            </div>
        `;
    } else {
        html += `
            <div class="context-menu-item" data-action="paste">
                <span>Paste</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('paste')}</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" data-action="create-folder">
                <span>New Folder</span>
                <span class="context-menu-shortcut">${getShortcutDisplay('create-folder')}</span>
            </div>
        `;
    }

    const customHtml = getActionsForContext(isDir, isItem, targetPath);
    if (customHtml) {
        html += '<div class="context-menu-separator"></div>' + customHtml;
    }

    _positionAndShow(e, html, 'file-list');
}

// --- Folder context menu (used by breadcrumbs and sidebar) ---
export function showFolderContextMenu(e, folderPath, paneId, context = 'folder') {
    let html = `
        <div class="context-menu-item" data-action="open-path-in-new-tab"
             data-target-path="${folderPath}" data-pane-id="${paneId}">
            <span>Open in New Tab</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="copy-path" data-target-path="${folderPath}">
            <span>Copy Path</span>
        </div>
        <div class="context-menu-item" data-action="copy-name" data-target-path="${folderPath}">
            <span>Copy Name</span>
        </div>
    `;

    // Custom actions scoped to dirs (folders are always directories)
    const customHtml = getActionsForContext(true, true, folderPath)
        .replace(/data-action="custom-action"/g,
                 `data-action="custom-action-for-path" data-target-path="${folderPath}"`);
    if (customHtml) {
        html += '<div class="context-menu-separator"></div>' + customHtml;
    }

    _positionAndShow(e, html, context);
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

export async function triggerClipboard(op, inside = false) {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    try {
        const actionOp = inside ? `${op}_inside` : op;
        const data = await executeFileOp(actionOp, [...tab.selectedPaths]);
        
        let clipboardItems = [];
        if (data.status === 'success' && data.items) {
            clipboardItems = data.items;
        } else {
            // fallback (original behavior)
            tab.loadedEntries.forEach(entry => {
                const fullPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + entry.name;
                if (tab.selectedPaths.has(fullPath)) {
                    clipboardItems.push({
                        name: entry.name,
                        path: fullPath,
                        isDir: entry.is_dir,
                        size: entry.size
                    });
                }
            });
            
            if (clipboardItems.length < tab.selectedPaths.size) {
                tab.selectedPaths.forEach(path => {
                    const name = path.split('/').pop() || path;
                    if (!clipboardItems.some(item => item.path === path)) {
                        clipboardItems.push({
                            name: name,
                            path: path,
                            isDir: path.endsWith('/') || !name.includes('.'),
                            size: null
                        });
                    }
                });
            }
        }
        
        state.clipboard = {
            op: op,
            items: clipboardItems
        };
        updateClipboardUI();
        
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        if (inside) {
            infoEl.textContent = `${op === 'copy' ? 'Copied' : 'Cut'} contents of ${tab.selectedPaths.size} folder(s)`;
        } else {
            infoEl.textContent = `${op === 'copy' ? 'Copied' : 'Cut'} ${tab.selectedPaths.size} item(s)`;
        }
    } catch (err) {
        alert(`Error executing operation: ${err.message}`);
    }
}

export async function triggerClearClipboard() {
    try {
        await executeFileOp('clear');
        state.clipboard = {
            op: null,
            items: []
        };
        updateClipboardUI();
        
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        if (infoEl) {
            infoEl.textContent = 'Action aborted';
        }
    } catch (err) {
        alert(`Error aborting action: ${err.message}`);
    }
}

export async function triggerPaste(destPath = null) {
    const tab = getActiveTab();
    if (!tab) return;
    try {
        const targetDest = destPath || tab.currentPath;
        let data = await executeFileOp('paste', [], targetDest);
        
        if (data.status === 'conflict') {
            const confirmMerge = confirm(`Folder(s) "${data.conflicts.join(', ')}" already exist at the destination. Do you want to merge them?`);
            if (!confirmMerge) {
                return;
            }
            data = await executeFileOp('paste', [], targetDest, null, true);
        }
        
        const { operation, sources, entries } = data;
        
        if (operation === 'cut' && sources && sources.length > 0) {
            const sourcePaths = new Set(sources);
            Object.keys(state.panes).forEach(paneId => {
                const pane = state.panes[paneId];
                pane.tabs.forEach(t => {
                    t.loadedEntries = t.loadedEntries.filter(entry => {
                        const fullPath = t.currentPath + (t.currentPath.endsWith('/') ? '' : '/') + entry.name;
                        return !sourcePaths.has(fullPath);
                    });
                    sources.forEach(src => t.selectedPaths.delete(src));
                });
            });
            
            // Clear clipboard state on successful move
            state.clipboard = {
                op: null,
                items: []
            };
            updateClipboardUI();
        }
        
        if (entries && entries.length > 0) {
            Object.keys(state.panes).forEach(paneId => {
                const pane = state.panes[paneId];
                pane.tabs.forEach(t => {
                    if (t.currentPath === targetDest) {
                        const newNames = new Set(entries.map(e => e.name));
                        t.loadedEntries = t.loadedEntries.filter(e => !newNames.has(e.name));
                        t.loadedEntries.push(...entries);
                        t.loadedEntries.sort((a, b) => {
                            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                        });
                    }
                });
            });
        }
        
        Object.keys(state.panes).forEach(paneId => {
            const pane = state.panes[paneId];
            const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
            if (activeTab) {
                renderFiles(paneId);
                updateSelectionUI(paneId);
                
                const infoEl = getPaneDom(paneId).querySelector('.status-info');
                if (infoEl) {
                    infoEl.textContent = `${activeTab.loadedEntries.length} items`;
                }
            }
        });
    } catch (err) {
        alert(`Paste failed: ${err.message}`);
    }
}

export async function triggerRename() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    
    if (tab.selectedPaths.size > 1) {
        import('./batch-rename.js').then(m => m.startBatchRename(state.activePane));
        return;
    }
    const oldPath = [...tab.selectedPaths][0];
    const oldName = oldPath.split('/').pop();
    const newName = prompt('Enter new name:', oldName);
    if (newName && newName !== oldName) {
        try {
            const data = await executeFileOp('rename', [oldPath], null, newName);
            const newEntry = data.entry;
            const newPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1) + newName;
            
            Object.keys(state.panes).forEach(paneId => {
                const pane = state.panes[paneId];
                pane.tabs.forEach(t => {
                    if (t.currentPath === tab.currentPath) {
                        t.loadedEntries = t.loadedEntries.map(entry => {
                            if (entry.name === oldName && newEntry) {
                                return newEntry;
                            }
                            return entry;
                        });
                        
                        if (t.selectedPaths.has(oldPath)) {
                            t.selectedPaths.delete(oldPath);
                            t.selectedPaths.add(newPath);
                        }
                    }
                });
                
                const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
                if (activeTab && activeTab.currentPath === tab.currentPath) {
                    renderFiles(paneId);
                    updateSelectionUI(paneId);
                }
            });
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
            const pathsToDelete = [...tab.selectedPaths];
            await executeFileOp('delete', pathsToDelete);
            
            const deletedSet = new Set(pathsToDelete);
            const targetPath = tab.currentPath;
            
            Object.keys(state.panes).forEach(paneId => {
                const pane = state.panes[paneId];
                pane.tabs.forEach(t => {
                    if (t.currentPath === targetPath) {
                        t.loadedEntries = t.loadedEntries.filter(entry => {
                            const fullPath = t.currentPath + (t.currentPath.endsWith('/') ? '' : '/') + entry.name;
                            return !deletedSet.has(fullPath);
                        });
                        pathsToDelete.forEach(path => t.selectedPaths.delete(path));
                    }
                });
                
                const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
                if (activeTab && activeTab.currentPath === targetPath) {
                    renderFiles(paneId);
                    updateSelectionUI(paneId);
                    
                    const infoEl = getPaneDom(paneId).querySelector('.status-info');
                    if (infoEl) {
                        infoEl.textContent = `${activeTab.loadedEntries.length} items`;
                    }
                }
            });
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
            const data = await executeFileOp('mkdir', [], tab.currentPath, folderName);
            const newEntry = data.entry;
            
            Object.keys(state.panes).forEach(paneId => {
                const pane = state.panes[paneId];
                pane.tabs.forEach(t => {
                    if (t.currentPath === tab.currentPath && newEntry) {
                        t.loadedEntries.push(newEntry);
                        t.loadedEntries.sort((a, b) => {
                            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                        });
                    }
                });
                
                const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
                if (activeTab && activeTab.currentPath === tab.currentPath) {
                    renderFiles(paneId);
                    
                    const infoEl = getPaneDom(paneId).querySelector('.status-info');
                    if (infoEl) {
                        infoEl.textContent = `${activeTab.loadedEntries.length} items`;
                    }
                }
            });
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
            const targetPath = item.getAttribute('data-target-path');
            
            if (action === 'open-in-new-tab') {
                triggerOpenInNewTab();
            } else if (action === 'open-path-in-new-tab') {
                // Breadcrumb: open an explicit path in a new tab
                if (targetPath && paneId) createTab(paneId, targetPath);
            } else if (action === 'open') {
                triggerOpen();
            } else if (action === 'copy') {
                triggerClipboard('copy');
            } else if (action === 'cut') {
                triggerClipboard('cut');
            } else if (action === 'copy-inside') {
                triggerClipboard('copy', true);
            } else if (action === 'cut-inside') {
                triggerClipboard('cut', true);
            } else if (action === 'copy-path') {
                // data-target-path overrides selectedPaths (used by breadcrumb menu)
                if (targetPath) navigator.clipboard.writeText(targetPath + '\n');
                else triggerCopyPath();
            } else if (action === 'copy-name') {
                if (targetPath) navigator.clipboard.writeText((targetPath.split('/').pop() || targetPath) + '\n');
                else triggerCopyName();
            } else if (action === 'rename') {
                triggerRename();
            } else if (action === 'delete') {
                triggerDelete();
            } else if (action === 'paste') {
                triggerPaste();
            } else if (action === 'paste-inside') {
                triggerPaste(targetPath);
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
            } else if (action === 'custom-action-for-path') {
                // Folder custom actions: explicit path rather than selectedPaths
                const actionId = item.getAttribute('data-action-id');
                handleActionMenuClickForPath(actionId, targetPath, targetPath);
            }
        });
    }
});
