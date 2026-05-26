// Zen-Man Frontend Bootstrapper

// State Management
const state = {
    currentPath: '',
    history: [],
    historyIndex: -1,
    selectedPaths: new Set(),
    viewMode: 'list', // 'list' or 'grid'
    tabs: [],
    activeTabId: null,
    loadedEntries: [],
    hasMore: false,
    nextCursor: '',
    isLoading: false,
};

// UI Elements
const els = {
    fileList: document.getElementById('file-list'),
    breadcrumbs: document.getElementById('breadcrumbs'),
    navBack: document.getElementById('nav-back'),
    navForward: document.getElementById('nav-forward'),
    navUp: document.getElementById('nav-up'),
    viewList: document.getElementById('view-list'),
    viewGrid: document.getElementById('view-grid'),
    statusSelection: document.getElementById('status-selection'),
    statusInfo: document.getElementById('status-info'),
    sidebarPlaces: document.getElementById('sidebar-places'),
    addressBar: document.getElementById('address-bar'),
    breadcrumbContainer: document.getElementById('breadcrumb-container'),
    contextMenu: document.getElementById('context-menu')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadSidebarPlaces();
    navigateTo(''); // empty path triggers backend CWD listing
});

function setupEventListeners() {
    // View Toggles
    els.viewList.addEventListener('click', () => setViewMode('list'));
    els.viewGrid.addEventListener('click', () => setViewMode('grid'));

    // Navigation Buttons
    els.navBack.addEventListener('click', () => navigateHistory(-1));
    els.navForward.addEventListener('click', () => navigateHistory(1));
    els.navUp.addEventListener('click', navigateUp);

    // Click inside breadcrumb container toggles address bar edit mode
    els.breadcrumbContainer.addEventListener('click', (e) => {
        if (e.target === els.breadcrumbContainer || e.target === els.breadcrumbs) {
            enableAddressBarEdit();
        }
    });

    els.addressBar.addEventListener('blur', disableAddressBarEdit);
    els.addressBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            navigateTo(els.addressBar.value);
            els.addressBar.blur();
        } else if (e.key === 'Escape') {
            els.addressBar.blur();
        }
    });

    // Virtual Scroll Listener
    els.fileList.addEventListener('scroll', () => {
        if (state.viewMode === 'list') {
            renderFilesListVirtual();
        }
    });

    // Handle resize
    window.addEventListener('resize', () => {
        if (state.viewMode === 'list') {
            renderFilesListVirtual();
        }
    });

    // Right click context menu on list container
    els.fileList.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        
        // Find if we clicked on an item or empty space
        const item = e.target.closest('.file-item');
        if (item) {
            const path = item.getAttribute('data-path');
            const isDir = item.getAttribute('data-dir') === 'true';
            
            // If item is not in current selection, select it exclusively
            if (!state.selectedPaths.has(path)) {
                state.selectedPaths.clear();
                state.selectedPaths.add(path);
                updateItemSelectionStyles();
            }
            showContextMenu(e, path, isDir, true);
        } else {
            // Clicked on empty space
            state.selectedPaths.clear();
            updateItemSelectionStyles();
            showContextMenu(e, null, false, false);
        }
    });

    // Hide context menu on left click anywhere
    document.addEventListener('click', () => {
        els.contextMenu.style.display = 'none';
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
}

function loadSidebarPlaces() {
    // Sidebar base locations
    const places = [
        { name: 'Home', path: '~', icon: '🏠' },
        { name: 'Root', path: '/', icon: '💻' },
        { name: 'Downloads', path: '~/Downloads', icon: '📥' },
        { name: 'Documents', path: '~/Documents', icon: '📄' },
        { name: 'Desktop', path: '~/Desktop', icon: '🖥️' }
    ];

    els.sidebarPlaces.innerHTML = places.map(p => `
        <div class="sidebar-item" data-path="${p.path}">
            <span class="icon">${p.icon}</span>
            <span>${p.name}</span>
        </div>
    `).join('');

    // Attach click events
    els.sidebarPlaces.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            const path = item.getAttribute('data-path');
            navigateTo(path);
        });
    });
}

// View switcher
function setViewMode(mode) {
    state.viewMode = mode;
    if (mode === 'list') {
        els.viewList.classList.add('active');
        els.viewGrid.classList.remove('active');
        els.fileList.className = 'file-list list-view';
    } else {
        els.viewList.classList.remove('active');
        els.viewGrid.classList.add('active');
        els.fileList.className = 'file-list grid-view';
    }
    els.fileList.scrollTop = 0;
    renderFiles();
}

// History Navigation
function pushHistory(path) {
    if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
    }
    state.history.push(path);
    state.historyIndex = state.history.length - 1;
    updateNavButtons();
}

function navigateHistory(direction) {
    const nextIndex = state.historyIndex + direction;
    if (nextIndex >= 0 && nextIndex < state.history.length) {
        state.historyIndex = nextIndex;
        const targetPath = state.history[state.historyIndex];
        navigateTo(targetPath, false);
    }
}

function navigateUp() {
    if (!state.currentPath || state.currentPath === '/') return;
    const parts = state.currentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    navigateTo(parentPath);
}

function updateNavButtons() {
    els.navBack.disabled = state.historyIndex <= 0;
    els.navForward.disabled = state.historyIndex >= state.history.length - 1;
    els.navUp.disabled = !state.currentPath || state.currentPath === '/';
}

// Address Bar Interaction
function enableAddressBarEdit() {
    els.breadcrumbs.style.display = 'none';
    els.addressBar.style.display = 'block';
    els.addressBar.value = state.currentPath;
    els.addressBar.focus();
    els.addressBar.select();
}

function disableAddressBarEdit() {
    els.breadcrumbs.style.display = 'flex';
    els.addressBar.style.display = 'none';
}

// Main API call to read directory
async function navigateTo(path, recordHistory = true) {
    if (state.isLoading) return;
    state.isLoading = true;
    els.statusInfo.textContent = 'Loading directory...';
    state.selectedPaths.clear();
    updateSelectionUI();

    try {
        const response = await fetch(`/api/dir?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
            throw new Error(`Failed to load: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        state.currentPath = data.path;
        state.loadedEntries = data.entries || [];
        state.hasMore = data.has_more || false;
        state.nextCursor = data.cursor || '';

        if (recordHistory) {
            pushHistory(state.currentPath);
        } else {
            updateNavButtons();
        }

        renderBreadcrumbs();
        els.fileList.scrollTop = 0;
        renderFiles();

        els.statusInfo.textContent = `${state.loadedEntries.length} items`;
    } catch (err) {
        console.error(err);
        els.statusInfo.textContent = `Error loading directory`;
        alert(`Could not open directory: ${err.message}`);
    } finally {
        state.isLoading = false;
    }
}

function renderBreadcrumbs() {
    const path = state.currentPath;
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
    
    els.breadcrumbs.innerHTML = html;
    
    els.breadcrumbs.querySelectorAll('.breadcrumb-segment').forEach(seg => {
        seg.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetPath = seg.getAttribute('data-path');
            navigateTo(targetPath);
        });
    });
}

function renderFiles() {
    if (state.viewMode === 'list') {
        renderFilesListVirtual();
    } else {
        renderFilesGrid();
    }
}

// Performant Virtual Scroll List View
function renderFilesListVirtual() {
    const rowHeight = 40;
    const totalEntries = state.loadedEntries.length;

    if (totalEntries === 0) {
        els.fileList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Directory is empty</div>`;
        return;
    }

    const containerHeight = els.fileList.clientHeight || 500;
    const scrollTop = els.fileList.scrollTop;

    const warningHeight = 80;
    const showWarning = state.hasMore;

    let totalHeight = totalEntries * rowHeight;
    if (showWarning) {
        totalHeight += warningHeight;
    }

    const buffer = 5;
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
    const endIndex = Math.min(totalEntries - 1, Math.ceil((scrollTop + containerHeight) / rowHeight) + buffer);

    let html = `<div class="scroll-spacer" style="height: ${totalHeight}px; width: 1px; pointer-events: none; position: absolute; top: 0; left: 0;"></div>`;

    for (let i = startIndex; i <= endIndex; i++) {
        const entry = state.loadedEntries[i];
        const fullPath = state.currentPath + (state.currentPath.endsWith('/') ? '' : '/') + entry.name;
        const icon = entry.is_dir ? '📁' : '📄';
        const iconClass = entry.is_dir ? 'icon-folder' : 'icon-file';
        const isSelected = state.selectedPaths.has(fullPath) ? 'selected' : '';
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
                        <button id="btn-load-more" class="btn-warning">Load next 200 items</button>
                        <button id="btn-load-all" class="btn-warning">Load all items (may cause lag)</button>
                    </div>
                </div>
            `;
        }
    }

    els.fileList.innerHTML = html;
    attachItemEventListeners();
}

// Light Grid View Layout
function renderFilesGrid() {
    if (state.loadedEntries.length === 0) {
        els.fileList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">Directory is empty</div>`;
        return;
    }

    let html = '';
    state.loadedEntries.forEach(entry => {
        const fullPath = state.currentPath + (state.currentPath.endsWith('/') ? '' : '/') + entry.name;
        const icon = entry.is_dir ? '📁' : '📄';
        const iconClass = entry.is_dir ? 'icon-folder' : 'icon-file';
        const isSelected = state.selectedPaths.has(fullPath) ? 'selected' : '';

        html += `
            <div class="file-item ${isSelected}" data-path="${fullPath}" data-dir="${entry.is_dir}" draggable="true">
                <div class="file-name">
                    <span class="${iconClass}" style="font-size: 2.5rem;">${icon}</span>
                    <span>${entry.name}</span>
                </div>
            </div>
        `;
    });

    if (state.hasMore) {
        html += `
            <div class="load-more-container" style="width: 100%; display: flex; flex-direction: column; align-items: center; padding: 20px; box-sizing: border-box;">
                <span class="load-more-warning" style="margin-bottom: 10px;">⚠️ Loading limited to 200 items to prevent interface lag. More files are available.</span>
                <div class="load-more-buttons">
                    <button id="btn-load-more" class="btn-warning">Load next 200 items</button>
                    <button id="btn-load-all" class="btn-warning">Load all items (may cause lag)</button>
                </div>
            </div>
        `;
    }

    els.fileList.innerHTML = html;
    attachItemEventListeners();
}

function attachItemEventListeners() {
    els.fileList.querySelectorAll('.file-item').forEach(item => {
        const path = item.getAttribute('data-path');
        const isDir = item.getAttribute('data-dir') === 'true';

        // Select interaction
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            handleItemClick(path, e.ctrlKey, e.shiftKey);
        });

        // Double click navigation / open
        item.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (isDir) {
                navigateTo(path);
            } else {
                openFile(path);
            }
        });

        // DRAG & DROP IMPLEMENTATION
        item.addEventListener('dragstart', (e) => {
            // Drag current selection
            if (!state.selectedPaths.has(path)) {
                state.selectedPaths.clear();
                state.selectedPaths.add(path);
                updateItemSelectionStyles();
            }
            e.dataTransfer.setData('text/plain', JSON.stringify([...state.selectedPaths]));
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
                        // Move to directory
                        await executeFileOp('paste', sources, path);
                        navigateTo(state.currentPath); // refresh current folder
                    }
                } catch (err) {
                    console.error(err);
                }
            }
        });
    });

    // Pagination loading
    const btnLoadMore = document.getElementById('btn-load-more');
    if (btnLoadMore) {
        btnLoadMore.addEventListener('click', (e) => {
            e.stopPropagation();
            loadMoreFiles(false);
        });
    }

    const btnLoadAll = document.getElementById('btn-load-all');
    if (btnLoadAll) {
        btnLoadAll.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm("Loading all files in a very large directory might slow down the application. Are you sure you want to proceed?")) {
                loadMoreFiles(true);
            }
        });
    }
}

async function loadMoreFiles(loadAll) {
    if (state.isLoading) return;
    state.isLoading = true;
    els.statusInfo.textContent = 'Loading more items...';

    const limit = loadAll ? 1000000 : 200;
    const url = `/api/dir?path=${encodeURIComponent(state.currentPath)}&cursor=${state.nextCursor}&limit=${limit}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        state.loadedEntries = state.loadedEntries.concat(data.entries || []);
        state.hasMore = data.has_more || false;
        state.nextCursor = data.cursor || '';

        renderFiles();
        els.statusInfo.textContent = `${state.loadedEntries.length} items`;
    } catch (err) {
        console.error(err);
        els.statusInfo.textContent = `Error loading more items`;
        alert(`Could not load more items: ${err.message}`);
    } finally {
        state.isLoading = false;
    }
}

function handleItemClick(path, ctrlKey, shiftKey) {
    if (ctrlKey) {
        if (state.selectedPaths.has(path)) {
            state.selectedPaths.delete(path);
        } else {
            state.selectedPaths.add(path);
        }
    } else {
        state.selectedPaths.clear();
        state.selectedPaths.add(path);
    }
    
    updateItemSelectionStyles();
    updateSelectionUI();
}

function updateItemSelectionStyles() {
    els.fileList.querySelectorAll('.file-item').forEach(item => {
        const itemPath = item.getAttribute('data-path');
        if (state.selectedPaths.has(itemPath)) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

function updateSelectionUI() {
    const count = state.selectedPaths.size;
    els.statusSelection.textContent = `${count} item${count === 1 ? '' : 's'} selected`;
}

// OS integration helper functions
async function openFile(path) {
    try {
        await executeFileOp('open', [path]);
    } catch (err) {
        alert(`Error opening file: ${err.message}`);
    }
}

// Right Click Context Menu Handler
function showContextMenu(e, targetPath, isDir, isItem) {
    els.contextMenu.style.left = `${e.clientX}px`;
    els.contextMenu.style.top = `${e.clientY}px`;
    els.contextMenu.style.display = 'block';

    let html = '';
    if (isItem) {
        // Options when clicking a file/folder selection
        html += `
            <div class="context-menu-item" onclick="triggerOpen()">
                <span>Open</span>
                <span class="context-menu-shortcut">Enter</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" onclick="triggerClipboard('copy')">
                <span>Copy</span>
                <span class="context-menu-shortcut">Ctrl+C</span>
            </div>
            <div class="context-menu-item" onclick="triggerClipboard('cut')">
                <span>Cut</span>
                <span class="context-menu-shortcut">Ctrl+X</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" onclick="triggerRename()">
                <span>Rename</span>
                <span class="context-menu-shortcut">F2</span>
            </div>
            <div class="context-menu-item" onclick="triggerDelete()" style="color: var(--danger-color);">
                <span>Delete</span>
                <span class="context-menu-shortcut">Del</span>
            </div>
        `;
    } else {
        // Options when clicking empty area
        html += `
            <div class="context-menu-item" onclick="triggerPaste()">
                <span>Paste</span>
                <span class="context-menu-shortcut">Ctrl+V</span>
            </div>
            <div class="context-menu-separator"></div>
            <div class="context-menu-item" onclick="triggerCreateFolder()">
                <span>New Folder</span>
                <span class="context-menu-shortcut">Ctrl+Shift+N</span>
            </div>
        `;
    }

    els.contextMenu.innerHTML = html;
}

// Bind Context Menu Actions to Window context
window.triggerOpen = () => {
    state.selectedPaths.forEach(p => {
        const item = Array.from(els.fileList.querySelectorAll('.file-item')).find(el => el.getAttribute('data-path') === p);
        if (item) {
            const isDir = item.getAttribute('data-dir') === 'true';
            if (isDir) {
                navigateTo(p);
            } else {
                openFile(p);
            }
        }
    });
};

window.triggerClipboard = async (op) => {
    if (state.selectedPaths.size === 0) return;
    try {
        await executeFileOp(op, [...state.selectedPaths]);
        els.statusInfo.textContent = `${op === 'copy' ? 'Copied' : 'Cut'} ${state.selectedPaths.size} item(s)`;
    } catch (err) {
        alert(`Error executing operation: ${err.message}`);
    }
};

window.triggerPaste = async () => {
    try {
        await executeFileOp('paste', [], state.currentPath);
        navigateTo(state.currentPath);
    } catch (err) {
        alert(`Paste failed: ${err.message}`);
    }
};

window.triggerRename = async () => {
    if (state.selectedPaths.size !== 1) return;
    const oldPath = [...state.selectedPaths][0];
    const oldName = oldPath.split('/').pop();
    const newName = prompt('Enter new name:', oldName);
    if (newName && newName !== oldName) {
        try {
            await executeFileOp('rename', [oldPath], null, newName);
            navigateTo(state.currentPath);
        } catch (err) {
            alert(`Rename failed: ${err.message}`);
        }
    }
};

window.triggerDelete = async () => {
    if (state.selectedPaths.size === 0) return;
    const confirmMsg = `Are you sure you want to permanently delete these ${state.selectedPaths.size} item(s)?`;
    if (confirm(confirmMsg)) {
        try {
            await executeFileOp('delete', [...state.selectedPaths]);
            navigateTo(state.currentPath);
        } catch (err) {
            alert(`Delete failed: ${err.message}`);
        }
    }
};

window.triggerCreateFolder = async () => {
    const folderName = prompt('Enter new folder name:', 'New Folder');
    if (folderName) {
        try {
            await executeFileOp('mkdir', [], state.currentPath, folderName);
            navigateTo(state.currentPath);
        } catch (err) {
            alert(`Failed to create directory: ${err.message}`);
        }
    }
};

// Global Keyboard Shortcut router
function handleKeyboardShortcuts(e) {
    if (document.activeElement.tagName === 'INPUT') return; // ignore when typing in inputs

    // Ctrl+C
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        window.triggerClipboard('copy');
    }
    // Ctrl+X
    else if (e.ctrlKey && e.key.toLowerCase() === 'x') {
        window.triggerClipboard('cut');
    }
    // Ctrl+V
    else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        window.triggerPaste();
    }
    // F2 rename
    else if (e.key === 'F2') {
        window.triggerRename();
    }
    // Delete
    else if (e.key === 'Delete') {
        window.triggerDelete();
    }
    // Backspace to navigate up
    else if (e.key === 'Backspace') {
        navigateUp();
    }
    // Enter to open
    else if (e.key === 'Enter') {
        window.triggerOpen();
    }
}

// Low-level HTTP Executor
async function executeFileOp(op, sources = [], dest = null, name = null) {
    const response = await fetch('/api/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, sources, dest, name })
    });
    
    if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || response.statusText);
    }
    return response.json();
}

// Helpers
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
    if (!timestamp) return '--';
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}
