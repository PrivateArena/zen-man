import { state, getPaneDom, getActiveTab } from './state.js';
import { formatSize, formatDate } from './utils.js';
import { executeFileOp, openFile } from './api.js';
import { getIsBatchRenameActive } from './batch-rename.js';

let navigateToCallback = null;

export function initFileList(navigateTo) {
    navigateToCallback = navigateTo;
}

export function renderFiles(paneId = state.activePane) {
    if (getIsBatchRenameActive()) return;
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
    if (getIsBatchRenameActive()) return;
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
    if (getIsBatchRenameActive()) return;
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
                        const data = await executeFileOp('paste', sources, path);
                        const { operation, sources: returnedSources, entries } = data;
                        
                        if (operation === 'cut' && sources && sources.length > 0) {
                            const sourcePaths = new Set(sources);
                            Object.keys(state.panes).forEach(pId => {
                                const p = state.panes[pId];
                                p.tabs.forEach(t => {
                                    t.loadedEntries = t.loadedEntries.filter(entry => {
                                        const fullPath = t.currentPath + (t.currentPath.endsWith('/') ? '' : '/') + entry.name;
                                        return !sourcePaths.has(fullPath);
                                    });
                                    sources.forEach(src => t.selectedPaths.delete(src));
                                });
                            });
                        }
                        
                        if (entries && entries.length > 0) {
                            Object.keys(state.panes).forEach(pId => {
                                const p = state.panes[pId];
                                p.tabs.forEach(t => {
                                    if (t.currentPath === path) {
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
                        
                        Object.keys(state.panes).forEach(pId => {
                            const p = state.panes[pId];
                            const activeTab = p.tabs.find(t => t.id === p.activeTabId);
                            if (activeTab) {
                                renderFiles(pId);
                                updateSelectionUI(pId);
                                
                                const infoEl = getPaneDom(pId).querySelector('.status-info');
                                if (infoEl) {
                                    infoEl.textContent = `${activeTab.loadedEntries.length} items`;
                                }
                            }
                        });
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
    if (!tab || pane.isLoading) return;

    pane.isLoading = true;
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
        pane.isLoading = false;
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
    updateSelectionUI(paneId);
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

export function updateSelectionUI(paneId = state.activePane) {
    const pane = state.panes[paneId];
    const tab = pane ? pane.tabs.find(t => t.id === pane.activeTabId) : null;
    if (!tab) return;
    const count = tab.selectedPaths.size;
    const selectEl = getPaneDom(paneId).querySelector('.status-selection');
    
    if (count > 0) {
        const selectedList = [];
        tab.loadedEntries.forEach(entry => {
            const fullPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + entry.name;
            if (tab.selectedPaths.has(fullPath)) {
                selectedList.push({
                    name: entry.name,
                    isDir: entry.is_dir,
                    size: entry.size
                });
            }
        });
        
        if (selectedList.length < count) {
            tab.selectedPaths.forEach(path => {
                const name = path.split('/').pop() || path;
                const alreadyAdded = selectedList.some(item => item.name === name);
                if (!alreadyAdded) {
                    selectedList.push({
                        name: name,
                        isDir: path.endsWith('/') || !name.includes('.'),
                        size: null
                    });
                }
            });
        }
        
        const maxDisplay = 10;
        const displayed = selectedList.slice(0, maxDisplay);
        const remaining = selectedList.length - maxDisplay;
        
        let tooltipItemsHtml = displayed.map(item => {
            const icon = item.isDir ? '📁' : '📄';
            const iconClass = item.isDir ? 'icon-folder' : 'icon-file';
            const sizeStr = (item.isDir || item.size === null) ? '' : `<span class="tooltip-item-size">${formatSize(item.size)}</span>`;
            return `
                <div class="tooltip-item">
                    <span class="${iconClass} tooltip-item-icon">${icon}</span>
                    <span class="tooltip-item-name" title="${item.name}">${item.name}</span>
                    ${sizeStr}
                </div>
            `;
        }).join('');
        
        if (remaining > 0) {
            tooltipItemsHtml += `
                <div class="tooltip-more">and ${remaining} more item${remaining > 1 ? 's' : ''}...</div>
            `;
        }

        selectEl.innerHTML = `
            <span class="status-selection-text">${count} item${count === 1 ? '' : 's'} selected</span>
            <button class="btn-status-delete" title="Delete Selected Items">Delete</button>
            <div class="status-selection-tooltip">
                <div class="tooltip-header">Selected Items (${count})</div>
                <div class="tooltip-body">
                    ${tooltipItemsHtml}
                </div>
            </div>
        `;
        
        selectEl.querySelector('.btn-status-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            import('./context-menu.js').then(m => m.triggerDelete());
        });
    } else {
        selectEl.innerHTML = `<span class="status-selection-text">0 items selected</span>`;
    }
}

export function updateClipboardUI() {
    const isClipboardActive = state.clipboard && state.clipboard.items && state.clipboard.items.length > 0;
    const count = isClipboardActive ? state.clipboard.items.length : 0;
    const op = isClipboardActive ? state.clipboard.op : null;
    
    ['left', 'right'].forEach(paneId => {
        const paneEl = getPaneDom(paneId);
        if (!paneEl) return;
        const actionEl = paneEl.querySelector('.status-action');
        if (!actionEl) return;
        
        if (count > 0) {
            const icon = op === 'cut' ? '✂️' : '📋';
            const maxDisplay = 10;
            const displayed = state.clipboard.items.slice(0, maxDisplay);
            const remaining = state.clipboard.items.length - maxDisplay;
            
            let tooltipItemsHtml = displayed.map(item => {
                const itemIcon = item.isDir ? '📁' : '📄';
                const iconClass = item.isDir ? 'icon-folder' : 'icon-file';
                const sizeStr = (item.isDir || item.size === null) ? '' : `<span class="tooltip-item-size">${formatSize(item.size)}</span>`;
                return `
                    <div class="tooltip-item">
                        <span class="${iconClass} tooltip-item-icon">${itemIcon}</span>
                        <span class="tooltip-item-name" title="${item.name}">${item.name}</span>
                        ${sizeStr}
                    </div>
                `;
            }).join('');
            
            if (remaining > 0) {
                tooltipItemsHtml += `
                    <div class="tooltip-more">and ${remaining} more item${remaining > 1 ? 's' : ''}...</div>
                `;
            }

            actionEl.innerHTML = `
                <span class="status-action-text" title="Click to abort action">${icon} ${count} item${count === 1 ? '' : 's'} in action</span>
                <div class="status-action-tooltip">
                    <div class="tooltip-header">In-Action Items (${count})</div>
                    <div class="tooltip-body">
                        ${tooltipItemsHtml}
                    </div>
                </div>
            `;
            actionEl.style.display = 'inline-flex';
            actionEl.querySelector('.status-action-text').addEventListener('click', (e) => {
                e.stopPropagation();
                import('./context-menu.js').then(m => m.triggerClearClipboard());
            });
        } else {
            actionEl.innerHTML = '';
            actionEl.style.display = 'none';
        }
    });
}
