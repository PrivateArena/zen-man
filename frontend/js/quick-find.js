import { state, getActiveTab, getPaneDom, getActivePane } from './state.js';
import { formatSize } from './utils.js';
import { openFile, executeFileOp } from './api.js';
import { updateItemSelectionStyles, updateSelectionUI, updateClipboardUI, renderFiles } from './file-list.js';
import { copyPaths, copyNames } from './context-menu.js';

let navigateToCallback = null;
let activeAbortController = null;
let debounceTimeout = null;
let searchResults = [];
let allResults = [];
let selectedIndex = -1;
let isSearchCapped = false;
let totalMatched = 0;
let scopeFilter = 'both';
let useRegex = false;

export function initQuickFind(navigateTo) {
    navigateToCallback = navigateTo;
}

export function openQuickFind() {
    const tab = getActiveTab();
    if (!tab) return;

    const overlay = document.getElementById('quick-find-overlay');
    const input = document.getElementById('quick-find-input');
    const pathLabel = document.getElementById('quick-find-path');
    const recursiveCheck = document.getElementById('quick-find-recursive');

    // Restore recursive toggle state from localStorage
    const savedRecursive = localStorage.getItem('quick-find-recursive') === 'true';
    recursiveCheck.checked = savedRecursive;

    // Restore scope filter from localStorage
    const savedScope = localStorage.getItem('quick-find-scope') || 'both';
    scopeFilter = savedScope;
    document.querySelectorAll('#quick-find-scope-toggle .btn-scope').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scope === savedScope);
    });

    // Restore regex toggle from localStorage
    const savedRegex = localStorage.getItem('quick-find-regex') === 'true';
    useRegex = savedRegex;
    document.getElementById('quick-find-btn-regex').classList.toggle('active', savedRegex);

    // Reset state
    input.value = '';
    searchResults = [];
    allResults = [];
    selectedIndex = -1;
    isSearchCapped = false;
    totalMatched = 0;
    pathLabel.textContent = `Finding in: ${tab.currentPath}`;
    updateActionButtonsState();
    
    // Clear previous results UI
    const resultsContainer = document.getElementById('quick-find-results');
    resultsContainer.innerHTML = '';
    document.getElementById('quick-find-count').textContent = '';

    // Show modal
    overlay.style.display = 'flex';
    input.focus();

    // Bind event listeners for this session
    setupModalListeners();
}

export function closeQuickFind() {
    const overlay = document.getElementById('quick-find-overlay');
    overlay.style.display = 'none';

    // Abort any active search immediately
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
    if (debounceTimeout) {
        clearTimeout(debounceTimeout);
        debounceTimeout = null;
    }

    // Return focus to active pane
    const activePaneId = state.activePane;
    const fileListEl = getPaneDom(activePaneId).querySelector('.file-list');
    if (fileListEl) fileListEl.focus();

    removeModalListeners();
}

function setupModalListeners() {
    const overlay = document.getElementById('quick-find-overlay');
    const input = document.getElementById('quick-find-input');
    const recursiveCheck = document.getElementById('quick-find-recursive');
    const scopeToggle = document.getElementById('quick-find-scope-toggle');
    const btnCopy = document.getElementById('quick-find-btn-copy');
    const btnCut = document.getElementById('quick-find-btn-cut');
    const btnCopyPath = document.getElementById('quick-find-btn-copy-path');
    const btnCopyName = document.getElementById('quick-find-btn-copy-name');
    const btnDelete = document.getElementById('quick-find-btn-delete');
    const btnPasteInside = document.getElementById('quick-find-btn-paste-inside');
    const btnPasteLinkInside = document.getElementById('quick-find-btn-paste-link-inside');

    const btnRegex = document.getElementById('quick-find-btn-regex');

    overlay.addEventListener('click', onOverlayClick);
    input.addEventListener('input', onInputChanged);
    input.addEventListener('keydown', onInputKeyDown);
    recursiveCheck.addEventListener('change', onRecursiveToggle);
    scopeToggle.addEventListener('click', onScopeToggle);
    btnRegex.addEventListener('click', onRegexToggle);
    btnCopy.addEventListener('click', onCopyFoundClick);
    btnCut.addEventListener('click', onCutFoundClick);
    btnCopyPath.addEventListener('click', onCopyPathFoundClick);
    btnCopyName.addEventListener('click', onCopyNameFoundClick);
    btnDelete.addEventListener('click', onDeleteFoundClick);
    btnPasteInside.addEventListener('click', onPasteInsideFoundClick);
    btnPasteLinkInside.addEventListener('click', onPasteLinkInsideFoundClick);
}

function removeModalListeners() {
    const overlay = document.getElementById('quick-find-overlay');
    const input = document.getElementById('quick-find-input');
    const recursiveCheck = document.getElementById('quick-find-recursive');
    const scopeToggle = document.getElementById('quick-find-scope-toggle');
    const btnCopy = document.getElementById('quick-find-btn-copy');
    const btnCut = document.getElementById('quick-find-btn-cut');
    const btnCopyPath = document.getElementById('quick-find-btn-copy-path');
    const btnCopyName = document.getElementById('quick-find-btn-copy-name');
    const btnDelete = document.getElementById('quick-find-btn-delete');
    const btnPasteInside = document.getElementById('quick-find-btn-paste-inside');
    const btnPasteLinkInside = document.getElementById('quick-find-btn-paste-link-inside');

    const btnRegex = document.getElementById('quick-find-btn-regex');

    overlay.removeEventListener('click', onOverlayClick);
    input.removeEventListener('input', onInputChanged);
    input.removeEventListener('keydown', onInputKeyDown);
    recursiveCheck.removeEventListener('change', onRecursiveToggle);
    scopeToggle.removeEventListener('click', onScopeToggle);
    btnRegex.removeEventListener('click', onRegexToggle);
    btnCopy.removeEventListener('click', onCopyFoundClick);
    btnCut.removeEventListener('click', onCutFoundClick);
    btnCopyPath.removeEventListener('click', onCopyPathFoundClick);
    btnCopyName.removeEventListener('click', onCopyNameFoundClick);
    btnDelete.removeEventListener('click', onDeleteFoundClick);
    btnPasteInside.removeEventListener('click', onPasteInsideFoundClick);
    btnPasteLinkInside.removeEventListener('click', onPasteLinkInsideFoundClick);
}

function onOverlayClick(e) {
    if (e.target.id === 'quick-find-overlay') {
        closeQuickFind();
    }
}

function onRecursiveToggle() {
    const recursiveCheck = document.getElementById('quick-find-recursive');
    localStorage.setItem('quick-find-recursive', recursiveCheck.checked);
    // Refire search immediately if input has text
    triggerSearch();
}

function onScopeToggle(e) {
    const btn = e.target.closest('.btn-scope');
    if (!btn) return;

    const scope = btn.dataset.scope;
    if (scope === scopeFilter) return;

    scopeFilter = scope;
    localStorage.setItem('quick-find-scope', scope);

    document.querySelectorAll('#quick-find-scope-toggle .btn-scope').forEach(b => {
        b.classList.toggle('active', b.dataset.scope === scope);
    });

    // Re-filter existing results without re-searching
    if (allResults.length > 0) {
        searchResults = scopeFilter === 'both'
            ? [...allResults]
            : allResults.filter(item => scopeFilter === 'folder' ? item.is_dir : !item.is_dir);
        selectedIndex = searchResults.length > 0 ? 0 : -1;
        renderSearchResults();
        updateScopeCountLabel();
    }

    updateActionButtonsState();
}

function onRegexToggle() {
    useRegex = !useRegex;
    localStorage.setItem('quick-find-regex', useRegex);
    document.getElementById('quick-find-btn-regex').classList.toggle('active', useRegex);
    // Refire search immediately if input has text
    triggerSearch();
}

function onInputChanged() {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
        triggerSearch();
    }, 250); // 250ms debounce to prevent IO spam while typing
}

async function triggerSearch() {
    const input = document.getElementById('quick-find-input');
    const query = input.value.trim();
    const tab = getActiveTab();
    if (!tab) return;

    // Clear active controllers if any
    if (activeAbortController) {
        activeAbortController.abort();
    }

    const resultsContainer = document.getElementById('quick-find-results');
    const countLabel = document.getElementById('quick-find-count');

    if (query === '') {
        searchResults = [];
        allResults = [];
        selectedIndex = -1;
        isSearchCapped = false;
        totalMatched = 0;
        resultsContainer.innerHTML = '';
        countLabel.textContent = '';
        updateActionButtonsState();
        return;
    }

    activeAbortController = new AbortController();
    const signal = activeAbortController.signal;

    const recursive = document.getElementById('quick-find-recursive').checked;
    countLabel.textContent = 'Searching...';

    try {
        const url = `/api/search?path=${encodeURIComponent(tab.currentPath)}&q=${encodeURIComponent(query)}&recursive=${recursive}&regex=${useRegex}`;
        const response = await fetch(url, { signal });
        
        if (!response.ok) {
            throw new Error(`Search failed: ${response.statusText}`);
        }

        const data = await response.json();
        
        allResults = data.entries || [];
        isSearchCapped = data.capped || false;
        totalMatched = data.total_matched || allResults.length;

        // Apply scope filter client-side
        searchResults = scopeFilter === 'both'
            ? [...allResults]
            : allResults.filter(item => scopeFilter === 'folder' ? item.is_dir : !item.is_dir);
        selectedIndex = searchResults.length > 0 ? 0 : -1;
        renderSearchResults();
        updateScopeCountLabel();
        updateActionButtonsState();
    } catch (err) {
        if (err.name === 'AbortError') {
            // Silence aborted fetch requests
            return;
        }
        console.error(err);
        searchResults = [];
        allResults = [];
        isSearchCapped = false;
        totalMatched = 0;
        updateActionButtonsState();
        countLabel.textContent = 'Search failed';
        resultsContainer.innerHTML = `<div class="quick-find-empty">Error running search: ${err.message}</div>`;
    }
}

function renderSearchResults() {
    const resultsContainer = document.getElementById('quick-find-results');
    if (searchResults.length === 0) {
        resultsContainer.innerHTML = `<div class="quick-find-empty">No matching files or folders found</div>`;
        return;
    }

    let html = '';
    searchResults.forEach((item, index) => {
        const icon = item.is_dir ? '📁' : '📄';
        const sizeStr = item.is_dir ? '' : formatSize(item.size);
        const isSelected = index === selectedIndex ? 'selected' : '';
        
        html += `
            <div class="quick-find-item ${isSelected}" data-index="${index}">
                <span class="quick-find-item-icon">${icon}</span>
                <div class="quick-find-item-details">
                    <span class="quick-find-item-name">${item.name}</span>
                    <span class="quick-find-item-relpath">${item.rel_path}</span>
                </div>
                ${sizeStr ? `<span class="quick-find-item-size">${sizeStr}</span>` : ''}
            </div>
        `;
    });

    resultsContainer.innerHTML = html;

    // Attach click event handlers
    resultsContainer.querySelectorAll('.quick-find-item').forEach(el => {
        const index = parseInt(el.getAttribute('data-index'), 10);
        
        // Double left-click to open/navigate (User Option C)
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            executeItemAction(index, 'open');
        });

        // Click to select
        el.addEventListener('click', () => {
            selectedIndex = index;
            highlightSelectedRow();
        });

        // Right click to reveal in directory (User Option C)
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            executeItemAction(index, 'reveal');
        });
    });

    // Auto-scroll selected row into view
    scrollToSelected();
}

function highlightSelectedRow() {
    const resultsContainer = document.getElementById('quick-find-results');
    resultsContainer.querySelectorAll('.quick-find-item').forEach((el, index) => {
        if (index === selectedIndex) {
            el.classList.add('selected');
        } else {
            el.classList.remove('selected');
        }
    });
    scrollToSelected();
}

function scrollToSelected() {
    const resultsContainer = document.getElementById('quick-find-results');
    const selectedRow = resultsContainer.querySelector('.quick-find-item.selected');
    if (selectedRow) {
        selectedRow.scrollIntoView({ block: 'nearest' });
    }
}

function onInputKeyDown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        closeQuickFind();
    } 
    else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (searchResults.length === 0) return;
        selectedIndex = (selectedIndex + 1) % searchResults.length;
        highlightSelectedRow();
    } 
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (searchResults.length === 0) return;
        selectedIndex = (selectedIndex - 1 + searchResults.length) % searchResults.length;
        highlightSelectedRow();
    } 
    else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIndex !== -1 && searchResults[selectedIndex]) {
            executeItemAction(selectedIndex, 'open');
        }
    }
}

async function executeItemAction(index, mode) {
    const item = searchResults[index];
    if (!item) return;

    const tab = getActiveTab();
    if (!tab) return;

    // Resolve full absolute path of matched item
    const rootPath = tab.currentPath.endsWith('/') ? tab.currentPath : (tab.currentPath + '/');
    const itemPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + item.rel_path;

    closeQuickFind();

    if (mode === 'open') {
        if (item.is_dir) {
            // Navigate to folder
            if (navigateToCallback) {
                navigateToCallback(itemPath, true, state.activePane);
            }
        } else {
            // Open file using default action helper
            openFile(itemPath);
        }
    } 
    else if (mode === 'reveal') {
        // Find parent directory of file/folder
        let parentDir;
        if (item.is_dir) {
            // Reveal a folder inside its parent
            parentDir = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';
        } else {
            // Reveal a file inside its parent
            parentDir = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';
        }

        if (navigateToCallback) {
            // Navigate to parent directory
            await navigateToCallback(parentDir, true, state.activePane);

            // Once navigated, highlight/select the item
            const activeTab = getActiveTab();
            if (activeTab) {
                activeTab.selectedPaths.clear();
                activeTab.selectedPaths.add(itemPath);
                updateItemSelectionStyles(state.activePane);
                updateSelectionUI();

                // Scroll the selected item into view
                setTimeout(() => {
                    const fileListEl = getPaneDom(state.activePane).querySelector('.file-list');
                    const fileItem = fileListEl.querySelector(`[data-path="${CSS.escape(itemPath)}"]`);
                    if (fileItem) {
                        fileItem.scrollIntoView({ block: 'nearest' });
                    }
                }, 150);
            }
        }
    }
}

function updateActionButtonsState() {
    const hasResults = searchResults && searchResults.length > 0;
    const btnCopy = document.getElementById('quick-find-btn-copy');
    const btnCut = document.getElementById('quick-find-btn-cut');
    const btnCopyPath = document.getElementById('quick-find-btn-copy-path');
    const btnCopyName = document.getElementById('quick-find-btn-copy-name');
    const btnDelete = document.getElementById('quick-find-btn-delete');
    const btnPasteInside = document.getElementById('quick-find-btn-paste-inside');
    const btnPasteLinkInside = document.getElementById('quick-find-btn-paste-link-inside');
    
    if (btnCopy) btnCopy.disabled = !hasResults;
    if (btnCut) btnCut.disabled = !hasResults;
    if (btnCopyPath) btnCopyPath.disabled = !hasResults;
    if (btnCopyName) btnCopyName.disabled = !hasResults;
    if (btnDelete) btnDelete.disabled = !hasResults;

    // Paste Inside: only visible when scope is 'folder', enabled when folders exist + clipboard has items
    if (btnPasteInside) {
        const showPasteInside = scopeFilter === 'folder';
        btnPasteInside.style.display = showPasteInside ? '' : 'none';
        if (showPasteInside) {
            const hasFolders = searchResults.some(item => item.is_dir);
            const hasClipboard = state.clipboard && state.clipboard.op && state.clipboard.items && state.clipboard.items.length > 0;
            btnPasteInside.disabled = !(hasResults && hasFolders && hasClipboard);
        }
    }

    // Paste Link Inside: same visibility logic as Paste Inside
    if (btnPasteLinkInside) {
        const showPasteLinkInside = scopeFilter === 'folder';
        btnPasteLinkInside.style.display = showPasteLinkInside ? '' : 'none';
        if (showPasteLinkInside) {
            const hasFolders = searchResults.some(item => item.is_dir);
            const hasClipboard = state.clipboard && state.clipboard.op && state.clipboard.items && state.clipboard.items.length > 0;
            btnPasteLinkInside.disabled = !(hasResults && hasFolders && hasClipboard);
        }
    }
}

function updateScopeCountLabel() {
    const countLabel = document.getElementById('quick-find-count');
    const displayCount = searchResults.length;

    if (totalMatched === 0) {
        if (isSearchCapped) {
            countLabel.textContent = `${totalMatched}+ matches (capped)`;
        } else {
            countLabel.textContent = `${totalMatched} match${totalMatched === 1 ? '' : 'es'}`;
        }
        return;
    }

    const totalLabel = isSearchCapped ? `${totalMatched}+` : `${totalMatched}`;
    if (scopeFilter !== 'both') {
        countLabel.textContent = `${displayCount} ${scopeFilter}${displayCount === 1 ? '' : 's'} (of ${totalLabel} total)`;
    } else {
        countLabel.textContent = isSearchCapped
            ? `${totalMatched}+ matches (capped)`
            : `${totalMatched} match${totalMatched === 1 ? '' : 'es'}`;
    }
}

async function resolvePathsForAction() {
    const tab = getActiveTab();
    if (!tab || !searchResults || searchResults.length === 0) return [];

    if (!isSearchCapped) {
        return searchResults.map(item => {
            return tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + item.rel_path;
        });
    }

    const input = document.getElementById('quick-find-input');
    const query = input.value.trim();
    const recursive = document.getElementById('quick-find-recursive').checked;
    const countLabel = document.getElementById('quick-find-count');
    const prevText = countLabel.textContent;
    countLabel.textContent = 'Fetching all matches...';

    try {
        const url = `/api/search?path=${encodeURIComponent(tab.currentPath)}&q=${encodeURIComponent(query)}&recursive=${recursive}&regex=${useRegex}&limit=0`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch all matching files: ${response.statusText}`);
        }
        const data = await response.json();
        let fullEntries = data.entries || [];
        // Apply scope filter to capped results too
        if (scopeFilter !== 'both') {
            fullEntries = fullEntries.filter(item => scopeFilter === 'folder' ? item.is_dir : !item.is_dir);
        }
        return fullEntries.map(item => {
            return tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + item.rel_path;
        });
    } finally {
        countLabel.textContent = prevText;
    }
}

async function onPasteInsideFoundClick() {
    const tab = getActiveTab();
    if (!tab || !searchResults || searchResults.length === 0) return;

    const hasClipboard = state.clipboard && state.clipboard.op && state.clipboard.items && state.clipboard.items.length > 0;
    if (!hasClipboard) {
        alert('Nothing to paste - clipboard is empty.');
        return;
    }

    // Collect only folder paths from the filtered results
    const folderPaths = searchResults
        .filter(item => item.is_dir)
        .map(item => tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + item.rel_path);

    if (folderPaths.length === 0) {
        alert('No folders found in results to paste into.');
        return;
    }

    const itemCount = state.clipboard.items.length;
    const folderCount = folderPaths.length;
    const opLabel = state.clipboard.op === 'cut' ? 'move' : 'copy';
    const confirmMsg = `Are you sure you want to ${opLabel} ${itemCount} clipboard item(s) into ${folderCount} folder(s)?`;
    if (!confirm(confirmMsg)) return;

    const countLabel = document.getElementById('quick-find-count');
    const prevText = countLabel.textContent;

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < folderPaths.length; i++) {
        const folderPath = folderPaths[i];
        countLabel.textContent = `Pasting into folder ${i + 1} of ${folderCount}...`;
        try {
            let data = await executeFileOp('paste', [], folderPath);
            if (data.status === 'conflict') {
                const conflictNames = (data.conflicts || []).join(', ');
                const mergeConfirm = confirm(`Folder(s) "${conflictNames}" already exist at "${folderPath}". Merge?`);
                if (!mergeConfirm) {
                    failCount++;
                    continue;
                }
                data = await executeFileOp('paste', [], folderPath, null, true);
            }
            successCount++;
        } catch (err) {
            failCount++;
            console.error(`Paste into ${folderPath} failed:`, err);
        }
    }

    // If at least one paste succeeded with 'cut' op, clear clipboard and clean up UI
    if (successCount > 0 && state.clipboard.op === 'cut') {
        state.clipboard = { op: null, items: [] };
        updateClipboardUI();
    }

    // Refresh UI for all panes
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

    countLabel.textContent = prevText;
    const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
    if (infoEl) {
        infoEl.textContent = `Pasted into ${successCount} folder(s) (${failCount} failed)`;
    }

    closeQuickFind();
}

async function onPasteLinkInsideFoundClick() {
    const tab = getActiveTab();
    if (!tab || !searchResults || searchResults.length === 0) return;

    const hasClipboard = state.clipboard && state.clipboard.op && state.clipboard.items && state.clipboard.items.length > 0;
    if (!hasClipboard) {
        alert('Nothing to paste - clipboard is empty.');
        return;
    }

    // Collect only folder paths from the filtered results
    const folderPaths = searchResults
        .filter(item => item.is_dir)
        .map(item => tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + item.rel_path);

    if (folderPaths.length === 0) {
        alert('No folders found in results to paste into.');
        return;
    }

    const itemCount = state.clipboard.items.length;
    const folderCount = folderPaths.length;
    const confirmMsg = `Are you sure you want to create symlinks for ${itemCount} clipboard item(s) inside ${folderCount} folder(s)?`;
    if (!confirm(confirmMsg)) return;

    const countLabel = document.getElementById('quick-find-count');
    const prevText = countLabel.textContent;

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < folderPaths.length; i++) {
        const folderPath = folderPaths[i];
        countLabel.textContent = `Linking into folder ${i + 1} of ${folderCount}...`;
        try {
            let data = await executeFileOp('paste_link', [], folderPath);
            if (data.status === 'conflict') {
                const conflictNames = (data.conflicts || []).join(', ');
                const overwriteConfirm = confirm(`Entry(s) "${conflictNames}" already exist at "${folderPath}". Overwrite with symlinks?`);
                if (!overwriteConfirm) {
                    failCount++;
                    continue;
                }
                data = await executeFileOp('paste_link', [], folderPath, null, true);
            }
            successCount++;
        } catch (err) {
            failCount++;
            console.error(`Paste link into ${folderPath} failed:`, err);
        }
    }

    // NEVER clear clipboard - paste-link is non-destructive

    // Refresh UI for all panes
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

    countLabel.textContent = prevText;
    const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
    if (infoEl) {
        infoEl.textContent = `Linked into ${successCount} folder(s) (${failCount} failed)`;
    }

    closeQuickFind();
}

async function onCopyFoundClick() {
    await performClipboardFound('copy');
}

async function onCutFoundClick() {
    await performClipboardFound('cut');
}

async function onCopyPathFoundClick() {
    const tab = getActiveTab();
    if (!tab || !searchResults || searchResults.length === 0) return;

    try {
        const paths = await resolvePathsForAction();
        if (paths.length === 0) return;

        copyPaths(paths);

        // Update active pane status bar info
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        if (infoEl) {
            infoEl.textContent = `Copied paths of ${paths.length} found item(s) to system clipboard`;
        }

        closeQuickFind();
    } catch (err) {
        alert(`Failed to copy found paths: ${err.message}`);
    }
}

async function onCopyNameFoundClick() {
    const tab = getActiveTab();
    if (!tab || !searchResults || searchResults.length === 0) return;

    try {
        const paths = await resolvePathsForAction();
        if (paths.length === 0) return;

        copyNames(paths);

        // Update active pane status bar info
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        if (infoEl) {
            infoEl.textContent = `Copied names of ${paths.length} found item(s) to system clipboard`;
        }

        closeQuickFind();
    } catch (err) {
        alert(`Failed to copy found names: ${err.message}`);
    }
}

async function performClipboardFound(op) {
    const tab = getActiveTab();
    if (!tab || !searchResults || searchResults.length === 0) return;

    try {
        const paths = await resolvePathsForAction();
        if (paths.length === 0) return;

        const data = await executeFileOp(op, paths);
        let clipboardItems = [];
        if (data.status === 'success' && data.items) {
            clipboardItems = data.items;
        } else {
            // fallback structure
            paths.forEach(path => {
                const name = path.split('/').pop() || path;
                clipboardItems.push({
                    name: name,
                    path: path,
                    isDir: path.endsWith('/') || !name.includes('.'),
                    size: null
                });
            });
        }

        state.clipboard = {
            op: op,
            items: clipboardItems
        };
        
        updateClipboardUI();

        // Update status bar info
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        if (infoEl) {
            infoEl.textContent = `${op === 'copy' ? 'Copied' : 'Cut'} ${paths.length} found item(s) to clipboard`;
        }

        closeQuickFind();
    } catch (err) {
        alert(`Failed to ${op} found items: ${err.message}`);
    }
}

async function onDeleteFoundClick() {
    const tab = getActiveTab();
    if (!tab || !searchResults || searchResults.length === 0) return;

    try {
        const pathsToDelete = await resolvePathsForAction();
        if (pathsToDelete.length === 0) return;

        const confirmMsg = `Are you sure you want to permanently delete these ${pathsToDelete.length} matched item(s)?`;
        if (!confirm(confirmMsg)) return;

        await executeFileOp('delete', pathsToDelete);

        const deletedSet = new Set(pathsToDelete);
        
        // Remove deleted items from tabs loadedEntries & selectedPaths
        Object.keys(state.panes).forEach(paneId => {
            const pane = state.panes[paneId];
            pane.tabs.forEach(t => {
                // Remove entries that match deleted paths
                t.loadedEntries = t.loadedEntries.filter(entry => {
                    const entryPathSuffix = entry.rel_path || entry.name;
                    const fullPath = t.currentPath + (t.currentPath.endsWith('/') ? '' : '/') + entryPathSuffix;
                    return !deletedSet.has(fullPath);
                });
                pathsToDelete.forEach(path => t.selectedPaths.delete(path));
            });
            
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

        // Update active pane status bar info
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        if (infoEl) {
            infoEl.textContent = `Deleted ${pathsToDelete.length} item(s)`;
        }

        closeQuickFind();
    } catch (err) {
        alert(`Delete failed: ${err.message}`);
    }
}
