import { state, getPaneDom, getActiveTab } from './state.js';
import { formatSize, formatDate } from './utils.js';
import { executeFileOp, openFile } from './api.js';

let navigateToCallback = null;

export function initFileList(navigateTo) {
    navigateToCallback = navigateTo;
}

export function renderFiles(paneId = state.activePane) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    if (tab.viewMode === 'list') {
        renderFilesListVirtual(paneId);
    } else {
        renderFilesGrid(paneId);
    }
}

export function renderFilesListVirtual(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    const fileListEl = getPaneDom(paneId).querySelector('.file-list');
    
    const rowHeight = 40;
    const totalEntries = tab.loadedEntries.length;

    if (totalEntries === 0) {
        fileListEl.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Directory is empty</div>`;
        return;
    }

    const containerHeight = fileListEl.clientHeight || 500;
    const scrollTop = fileListEl.scrollTop;

    const warningHeight = 80;
    const showWarning = tab.hasMore;

    let totalHeight = totalEntries * rowHeight;
    if (showWarning) {
        totalHeight += warningHeight;
    }

    const buffer = 5;
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
    const endIndex = Math.min(totalEntries - 1, Math.ceil((scrollTop + containerHeight) / rowHeight) + buffer);

    let html = `<div class="scroll-spacer" style="height: ${totalHeight}px; width: 1px; pointer-events: none; position: absolute; top: 0; left: 0;"></div>`;

    for (let i = startIndex; i <= endIndex; i++) {
        const entry = tab.loadedEntries[i];
        const fullPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + entry.name;
        const icon = entry.is_dir ? '📁' : '📄';
        const iconClass = entry.is_dir ? 'icon-folder' : 'icon-file';
        const isSelected = tab.selectedPaths.has(fullPath) ? 'selected' : '';
        const sizeStr = entry.is_dir ? '--' : formatSize(entry.size);
        const dateStr = formatDate(entry.mod_time);
        
        const topOffset = i * rowHeight;

        html += `
            <div class="file-item ${isSelected}" data-path="${fullPath}" data-dir="${entry.is_dir}" draggable="true" style="position: absolute; top: ${topOffset}px; left: 0; right: 0; height: ${rowHeight}px; display: flex; align-items: center;">
                <div class="file-name">
                    <span class="${iconClass}">${icon}</span>
                    <span>${entry.name}</span>
                </div>
                <div class="file-size">${sizeStr}</div>
                <div class="file-date">${dateStr}</div>
            </div>
        `;
    }

    if (showWarning) {
        const warningTop = totalEntries * rowHeight;
        const isWarningVisible = (warningTop + warningHeight >= scrollTop) && (warningTop <= scrollTop + containerHeight);
        
        if (isWarningVisible) {
            html += `
                <div class="load-more-container" style="position: absolute; top: ${warningTop}px; left: 0; right: 0; height: ${warningHeight}px; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box;">
                    <span class="load-more-warning">⚠️ Loading limited to 200 items to prevent interface lag. More files are available.</span>
                    <div class="load-more-buttons">
                        <button class="btn-warning btn-load-more">Load next 200 items</button>
                        <button class="btn-warning btn-load-all">Load all items (may cause lag)</button>
                    </div>
                </div>
            `;
        }
    }

    fileListEl.innerHTML = html;
    attachItemEventListeners(paneId);
}

export function renderFilesGrid(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    const fileListEl = getPaneDom(paneId).querySelector('.file-list');

    const totalEntries = tab.loadedEntries.length;
    if (totalEntries === 0) {
        fileListEl.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Directory is empty</div>`;
        return;
    }

    let html = '';
    tab.loadedEntries.forEach(entry => {
        const fullPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + entry.name;
        const icon = entry.is_dir ? '📁' : '📄';
        const iconClass = entry.is_dir ? 'icon-folder' : 'icon-file';
        const isSelected = tab.selectedPaths.has(fullPath) ? 'selected' : '';

        html += `
            <div class="file-item ${isSelected}" data-path="${fullPath}" data-dir="${entry.is_dir}" draggable="true">
                <div class="file-name">
                    <span class="${iconClass}" style="font-size: 2.5rem;">${icon}</span>
                    <span>${entry.name}</span>
                </div>
            </div>
        `;
    });

    if (tab.hasMore) {
        html += `
            <div class="load-more-container" style="width: 100%; display: flex; flex-direction: column; align-items: center; padding: 20px; box-sizing: border-box;">
                <span class="load-more-warning" style="margin-bottom: 10px;">⚠️ Loading limited to 200 items to prevent interface lag. More files are available.</span>
                <div class="load-more-buttons">
                    <button class="btn-warning btn-load-more">Load next 200 items</button>
                    <button class="btn-warning btn-load-all">Load all items (may cause lag)</button>
                </div>
            </div>
        `;
    }

    fileListEl.innerHTML = html;
    attachItemEventListeners(paneId);
}

export function attachItemEventListeners(paneId) {
    const paneEl = getPaneDom(paneId);
    const tab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);
    if (!tab) return;

    paneEl.querySelectorAll('.file-item').forEach(item => {
        const path = item.getAttribute('data-path');
        const isDir = item.getAttribute('data-dir') === 'true';

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            handleItemClick(paneId, path, e.ctrlKey, e.shiftKey);
        });

        item.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (isDir) {
                if (navigateToCallback) navigateToCallback(path, true, paneId);
            } else {
                openFile(path);
            }
        });

        // HTML5 DRAG & DROP
        item.addEventListener('dragstart', (e) => {
            if (!tab.selectedPaths.has(path)) {
                tab.selectedPaths.clear();
                tab.selectedPaths.add(path);
                updateItemSelectionStyles(paneId);
            }
            e.dataTransfer.setData('text/plain', JSON.stringify([...tab.selectedPaths]));
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragover', (e) => {
            if (isDir) {
                e.preventDefault();
                item.classList.add('drag-over');
            }
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });

        item.addEventListener('drop', async (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            if (isDir) {
                const dataStr = e.dataTransfer.getData('text/plain');
                try {
                    const sources = JSON.parse(dataStr);
                    if (sources && sources.length > 0) {
                        await executeFileOp('paste', sources, path);
                        if (navigateToCallback) navigateToCallback(tab.currentPath, false, paneId);
                        
                        // If split, reload the other pane too in case it was displaying the destination directory
                        const otherPaneId = paneId === 'left' ? 'right' : 'left';
                        if (state.isSplit) {
                            const otherTab = state.panes[otherPaneId].tabs.find(t => t.id === state.panes[otherPaneId].activeTabId);
                            if (otherTab && (otherTab.currentPath === path || otherTab.currentPath === tab.currentPath)) {
                                if (navigateToCallback) navigateToCallback(otherTab.currentPath, false, otherPaneId);
                            }
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
            }
        });
    });

    const btnLoadMore = paneEl.querySelector('.btn-load-more');
    if (btnLoadMore) {
        btnLoadMore.addEventListener('click', (e) => {
            e.stopPropagation();
            loadMoreFiles(paneId, false);
        });
    }

    const btnLoadAll = paneEl.querySelector('.btn-load-all');
    if (btnLoadAll) {
        btnLoadAll.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm("Loading all files in a very large directory might slow down the application. Are you sure you want to proceed?")) {
                loadMoreFiles(paneId, true);
            }
        });
    }
}

export async function loadMoreFiles(paneId, loadAll) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab || state.isLoading) return;

    state.isLoading = true;
    const infoEl = getPaneDom(paneId).querySelector('.status-info');
    infoEl.textContent = 'Loading more items...';

    const limit = loadAll ? 1000000 : 200;
    const url = `/api/dir?path=${encodeURIComponent(tab.currentPath)}&cursor=${tab.nextCursor}&limit=${limit}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        tab.loadedEntries = tab.loadedEntries.concat(data.entries || []);
        tab.hasMore = data.has_more || false;
        tab.nextCursor = data.cursor || '';

        renderFiles(paneId);
        infoEl.textContent = `${tab.loadedEntries.length} items`;
    } catch (err) {
        console.error(err);
        infoEl.textContent = `Error loading more items`;
        alert(`Could not load more items: ${err.message}`);
    } finally {
        state.isLoading = false;
    }
}

export function handleItemClick(paneId, path, ctrlKey, shiftKey) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    if (ctrlKey) {
        if (tab.selectedPaths.has(path)) {
            tab.selectedPaths.delete(path);
        } else {
            tab.selectedPaths.add(path);
        }
    } else {
        tab.selectedPaths.clear();
        tab.selectedPaths.add(path);
    }
    
    updateItemSelectionStyles(paneId);
    updateSelectionUI();
}

export function updateItemSelectionStyles(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    const fileListEl = getPaneDom(paneId).querySelector('.file-list');
    fileListEl.querySelectorAll('.file-item').forEach(item => {
        const itemPath = item.getAttribute('data-path');
        if (tab.selectedPaths.has(itemPath)) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

export function updateSelectionUI() {
    const tab = getActiveTab();
    if (!tab) return;
    const count = tab.selectedPaths.size;
    const selectEl = getPaneDom(state.activePane).querySelector('.status-selection');
    selectEl.textContent = `${count} item${count === 1 ? '' : 's'} selected`;
}
