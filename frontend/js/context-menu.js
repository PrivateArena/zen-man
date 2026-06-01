import { state, getActiveTab, getPaneDom, getPaneTab } from './state.js';
import { setActivePane } from './split-view.js';
import { navigateTo } from './navigation.js';
import { executeFileOp, openFile } from './api.js';
import { updateItemSelectionStyles, updateSelectionUI, renderFiles } from './file-list.js';
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
                <span class="context-menu-shortcut">Alt+C</span>
            </div>
            <div class="context-menu-item" data-action="copy-name">
                <span>Copy Name</span>
                <span class="context-menu-shortcut">Alt+Shift+C</span>
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
        const data = await executeFileOp('paste', [], tab.currentPath);
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
        }
        
        if (entries && entries.length > 0) {
            Object.keys(state.panes).forEach(paneId => {
                const pane = state.panes[paneId];
                pane.tabs.forEach(t => {
                    if (t.currentPath === tab.currentPath) {
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
    if (!tab || tab.selectedPaths.size !== 1) return;
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
