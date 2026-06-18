import { state, getPaneDom, getActiveTab } from './state.js';
import { renderFiles, updateSelectionUI, renderFilesListVirtual } from './file-list.js';

let renderTabsCallback = null;
let _autoSaveCallback = null;

export function initNavigation(renderTabs, autoSaveCallback) {
    renderTabsCallback = renderTabs;
    _autoSaveCallback = autoSaveCallback || null;
}

function getSelectedIndex(tab, selectedPath) {
    let virtualRows = [];
    if (tab.flatViewMode === 'grouped') {
        let currentGroup = null;
        const collapsedFileGroups = tab.collapsedFileGroups || new Set();
        
        tab.loadedEntries.forEach(entry => {
            const relPath = entry.rel_path || '';
            const lastSlash = relPath.lastIndexOf('/');
            const parentDir = lastSlash !== -1 ? relPath.substring(0, lastSlash) : '.';
            
            if (parentDir !== currentGroup) {
                currentGroup = parentDir;
                virtualRows.push({ type: 'header', path: currentGroup });
            }
            
            const isCollapsed = collapsedFileGroups.has(currentGroup);
            if (!isCollapsed) {
                virtualRows.push({ type: 'file', entry: entry });
            }
        });
    } else {
        tab.loadedEntries.forEach(entry => {
            virtualRows.push({ type: 'file', entry: entry });
        });
    }
    
    return virtualRows.findIndex(row => {
        if (row.type !== 'file') return false;
        const entry = row.entry;
        const entryPathSuffix = entry.rel_path || entry.name;
        const fullPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + entryPathSuffix;
        return fullPath === selectedPath;
    });
}

// Navigation helpers
export async function navigateTo(path, recordHistory = true, paneId = state.activePane) {
    const pane = state.panes[paneId];
    if (pane.isLoading) return;
    pane.isLoading = true;
    
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) {
        pane.isLoading = false;
        return;
    }

    const oldPath = tab.currentPath;
    if (oldPath && tab.selectedPaths.size > 0) {
        tab.pathSelections = tab.pathSelections || {};
        tab.pathSelections[oldPath] = new Set(tab.selectedPaths);
    }

    // Determine if we are going up or back to an ancestor folder
    let restoredSelection = null;
    if (oldPath && oldPath !== path) {
        const parent = path.endsWith('/') ? path : path + '/';
        if (oldPath.startsWith(parent) || path === '/') {
            const relative = path === '/' ? oldPath.slice(1) : oldPath.slice(parent.length);
            const firstSegment = relative.split('/')[0];
            if (firstSegment) {
                restoredSelection = path === '/' ? '/' + firstSegment : path + (path.endsWith('/') ? '' : '/') + firstSegment;
            }
        }
    }

    const infoEl = getPaneDom(paneId).querySelector('.status-info');
    infoEl.textContent = 'Loading directory...';
    tab.selectedPaths.clear();
    updateSelectionUI(paneId);

    try {
        let url = `/api/dir?path=${encodeURIComponent(path)}`;
        if (tab.flatViewMode === 'mixed') {
            url += '&flat=true';
        } else if (tab.flatViewMode === 'mixed-no-folders') {
            url += '&flat=true&no_folders=true';
        } else if (tab.flatViewMode === 'grouped') {
            url += '&flat=true';
        }
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        tab.currentPath = data.path;
        tab.name = data.path.split('/').pop() || 'Root';
        tab.loadedEntries = data.entries || [];
        tab.hasMore = data.has_more || false;
        tab.nextCursor = data.cursor || '';
        tab.isLoaded = true;

        tab.selectedPaths.clear();
        if (restoredSelection) {
            tab.selectedPaths.add(restoredSelection);
        } else if (tab.pathSelections && tab.pathSelections[data.path]) {
            tab.pathSelections[data.path].forEach(p => tab.selectedPaths.add(p));
        }
        updateSelectionUI(paneId);

        if (recordHistory) {
            pushPaneHistory(paneId, tab.currentPath);
        } else {
            updateNavButtons(paneId);
        }

        renderBreadcrumbs(paneId);
        if (renderTabsCallback) {
            renderTabsCallback(paneId);
        }
        if (_autoSaveCallback) _autoSaveCallback();
        
        const fileListEl = getPaneDom(paneId).querySelector('.file-list');
        fileListEl.scrollTop = 0;

        renderFiles(paneId);

        if (tab.selectedPaths.size > 0) {
            const firstSelectedPath = [...tab.selectedPaths][0];
            if (tab.viewMode === 'list') {
                const selectedIdx = getSelectedIndex(tab, firstSelectedPath);
                if (selectedIdx !== -1) {
                    const topOffset = selectedIdx * 40;
                    const containerHeight = fileListEl.clientHeight || 500;
                    fileListEl.scrollTop = Math.max(0, topOffset - containerHeight / 2 + 20);
                    renderFilesListVirtual(paneId);
                }
            } else {
                const fileItems = fileListEl.querySelectorAll('.file-item');
                for (const item of fileItems) {
                    if (item.getAttribute('data-path') === firstSelectedPath) {
                        item.scrollIntoView({ block: 'center', inline: 'nearest' });
                        break;
                    }
                }
            }
        }

        infoEl.textContent = `${tab.loadedEntries.length} items`;
        if (paneId === state.activePane) {
            updateDiskSpaceDisplay();
        }
    } catch (err) {
        console.error(err);
        infoEl.textContent = `Error loading directory`;
        
        // Ensure path and basic navigation/breadcrumbs are updated so the UI is not stuck
        tab.currentPath = path;
        tab.isLoaded = true; // Still mark as loaded/attempted so it behaves normally
        renderBreadcrumbs(paneId);
        updateNavButtons(paneId);
        renderFiles(paneId);
        
        alert(`Could not open directory: ${err.message}`);
    } finally {
        pane.isLoading = false;
    }
}

export function renderBreadcrumbs(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    const path = tab.currentPath;
    const parts = path.split('/').filter(Boolean);
    
    let html = `<span class="breadcrumb-segment" data-path="/">Root</span>`;
    let currentAccumulated = '';
    
    parts.forEach(part => {
        currentAccumulated += '/' + part;
        const target = currentAccumulated;
        html += `
            <span class="breadcrumb-separator">/</span>
            <span class="breadcrumb-segment" data-path="${target}">${part}</span>
        `;
    });
    
    const container = getPaneDom(paneId).querySelector('.breadcrumbs');
    container.innerHTML = html;
    
    container.querySelectorAll('.breadcrumb-segment').forEach(seg => {
        seg.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetPath = seg.getAttribute('data-path');
            navigateTo(targetPath, true, paneId);
        });
        seg.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation(); // prevent pane-level contextmenu from firing
            const crumbPath = seg.getAttribute('data-path');
            import('./context-menu.js').then(m => m.showFolderContextMenu(e, crumbPath, paneId, 'breadcrumb'));
        });
    });
}

// Nav stack history actions
export function pushPaneHistory(paneId, path) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    if (tab.historyIndex < tab.history.length - 1) {
        tab.history = tab.history.slice(0, tab.historyIndex + 1);
    }
    tab.history.push(path);
    tab.historyIndex = tab.history.length - 1;
    updateNavButtons(paneId);
}

export function navigatePaneHistory(paneId, direction) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    const nextIndex = tab.historyIndex + direction;
    if (nextIndex >= 0 && nextIndex < tab.history.length) {
        tab.historyIndex = nextIndex;
        navigateTo(tab.history[tab.historyIndex], false, paneId);
    }
}

export function navigatePaneUp(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab || !tab.currentPath || tab.currentPath === '/') return;

    const parts = tab.currentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    navigateTo(parentPath, true, paneId);
}

export function updateNavButtons(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    const paneEl = getPaneDom(paneId);
    if (!tab) return;

    paneEl.querySelector('.nav-back').disabled = tab.historyIndex <= 0;
    paneEl.querySelector('.nav-forward').disabled = tab.historyIndex >= tab.history.length - 1;
    paneEl.querySelector('.nav-up').disabled = !tab.currentPath || tab.currentPath === '/';
}

export function setPaneViewMode(paneId, mode) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    tab.viewMode = mode;
    const paneEl = getPaneDom(paneId);
    
    const gridChk = paneEl.querySelector('.chk-grid-view');
    if (gridChk) {
        gridChk.checked = (mode === 'grid');
    }
    
    const fileListEl = paneEl.querySelector('.file-list');
    fileListEl.className = mode === 'list' ? 'file-list list-view' : 'file-list grid-view';
    fileListEl.scrollTop = 0;
    
    renderFiles(paneId);
}

export function enablePaneAddressBarEdit(paneId) {
    const paneEl = getPaneDom(paneId);
    const breadcrumbs = paneEl.querySelector('.breadcrumbs');
    const addressBar = paneEl.querySelector('.address-bar');
    const tab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);

    breadcrumbs.style.display = 'none';
    addressBar.style.display = 'block';
    addressBar.value = tab ? tab.currentPath : '/';
    addressBar.focus();
    addressBar.select();
}

export function disablePaneAddressBarEdit(paneId) {
    const paneEl = getPaneDom(paneId);
    paneEl.querySelector('.breadcrumbs').style.display = 'flex';
    paneEl.querySelector('.address-bar').style.display = 'none';
}

let lastDiskSpacePath = null;

function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export async function updateDiskSpaceDisplay() {
    const pane = state.panes[state.activePane];
    if (!pane) return;
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab || !tab.currentPath) {
        const displayEl = document.getElementById('disk-space-display');
        if (displayEl) displayEl.style.display = 'none';
        return;
    }
    
    const path = tab.currentPath;
    if (path === lastDiskSpacePath) return;
    lastDiskSpacePath = path;

    try {
        const response = await fetch(`/api/diskspace?path=${encodeURIComponent(path)}`);
        if (!response.ok) throw new Error('Failed to fetch disk space');
        const data = await response.json();
        
        const free = data.free;
        const total = data.total;
        const used = total - free;
        const usedPercent = total > 0 ? (used / total) * 100 : 0;
        
        const progressBar = document.getElementById('disk-space-progress-bar');
        const textSpan = document.getElementById('disk-space-text');
        const displayEl = document.getElementById('disk-space-display');
        
        if (progressBar && textSpan && displayEl) {
            progressBar.style.width = `${usedPercent}%`;
            
            if (usedPercent >= 90) {
                progressBar.classList.add('low-space');
            } else {
                progressBar.classList.remove('low-space');
            }
            
            textSpan.textContent = `${formatBytes(free)} free of ${formatBytes(total)}`;
            displayEl.style.display = 'flex';
        }
    } catch (err) {
        console.error('Error fetching disk space info:', err);
    }
}

