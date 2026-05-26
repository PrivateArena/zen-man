// Zen-Man Frontend Bootstrapper

// State Management
const state = {
    activePane: 'left', // 'left' or 'right'
    isSplit: false,
    bookmarks: [],
    mounts: [],
    panes: {
        left: {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set()
        },
        right: {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set()
        }
    },
    isLoading: false,
};

let dragTabSource = null;

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadSidebarPlaces();
    loadWorkspaces();
    
    // Create initial tab for Left Pane
    createTab('left', ''); 
});

function getActivePane() {
    return state.panes[state.activePane];
}

function getActiveTab() {
    const pane = getActivePane();
    return pane.tabs.find(t => t.id === pane.activeTabId);
}

function getPaneDom(paneId) {
    return document.getElementById(`pane-${paneId}`);
}

function getPaneTab(paneId, tabId) {
    return state.panes[paneId].tabs.find(t => t.id === tabId);
}

function setupEventListeners() {
    setupPaneListeners('left');
    setupPaneListeners('right');

    // Global toggle split view
    document.getElementById('split-toggle-btn').addEventListener('click', () => {
        setSplitView(!state.isSplit);
    });

    // Bookmark actions
    document.getElementById('btn-add-bookmark').addEventListener('click', addCurrentToBookmarks);

    // Workspace actions
    document.getElementById('workspace-new-btn').addEventListener('click', showWorkspaceCreatePanel);
    document.getElementById('workspace-confirm-save').addEventListener('click', triggerSaveWorkspace);
    document.getElementById('workspace-cancel-save').addEventListener('click', hideWorkspaceCreatePanel);
    document.getElementById('workspace-delete').addEventListener('click', triggerDeleteWorkspace);
    document.getElementById('workspace-select').addEventListener('change', handleWorkspaceChange);

    // Right click context menu routing
    document.getElementById('pane-left').addEventListener('contextmenu', (e) => handlePaneContextMenu(e, 'left'));
    document.getElementById('pane-right').addEventListener('contextmenu', (e) => handlePaneContextMenu(e, 'right'));

    // Hide context menu on left click anywhere
    document.addEventListener('click', () => {
        document.getElementById('context-menu').style.display = 'none';
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
}

function setupPaneListeners(paneId) {
    const paneEl = getPaneDom(paneId);
    
    // View Toggles
    paneEl.querySelector('.view-list').addEventListener('click', () => setPaneViewMode(paneId, 'list'));
    paneEl.querySelector('.view-grid').addEventListener('click', () => setPaneViewMode(paneId, 'grid'));
    
    // Navigation Buttons
    paneEl.querySelector('.nav-back').addEventListener('click', () => navigatePaneHistory(paneId, -1));
    paneEl.querySelector('.nav-forward').addEventListener('click', () => navigatePaneHistory(paneId, 1));
    paneEl.querySelector('.nav-up').addEventListener('click', () => navigatePaneUp(paneId));
    
    // Breadcrumbs address bar toggle
    const breadcrumbContainer = paneEl.querySelector('.breadcrumb-container');
    const addressBar = paneEl.querySelector('.address-bar');
    const breadcrumbs = paneEl.querySelector('.breadcrumbs');
    
    breadcrumbContainer.addEventListener('click', (e) => {
        if (e.target === breadcrumbContainer || e.target === breadcrumbs) {
            enablePaneAddressBarEdit(paneId);
        }
    });
    
    addressBar.addEventListener('blur', () => disablePaneAddressBarEdit(paneId));
    addressBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            navigateTo(addressBar.value, true, paneId);
            addressBar.blur();
        } else if (e.key === 'Escape') {
            addressBar.blur();
        }
    });

    // New Tab button
    paneEl.querySelector('.btn-new-tab').addEventListener('click', () => {
        const tab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);
        const path = tab ? tab.currentPath : '/';
        createTab(paneId, path);
    });

    // Switch pane focus on click or focus in
    paneEl.addEventListener('click', () => {
        if (state.activePane !== paneId) {
            setActivePane(paneId);
        }
    });

    paneEl.addEventListener('focusin', () => {
        if (state.activePane !== paneId) {
            setActivePane(paneId);
        }
    });

    // Scroll listener for virtual list
    const fileListEl = paneEl.querySelector('.file-list');
    fileListEl.addEventListener('scroll', () => {
        const tab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);
        if (tab && tab.viewMode === 'list') {
            renderFilesListVirtual(paneId);
        }
    });

    // Window resize recalculations
    window.addEventListener('resize', () => {
        const activeTab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);
        if (activeTab && activeTab.viewMode === 'list') {
            renderFilesListVirtual(paneId);
        }
    });
}

function setActivePane(paneId) {
    state.activePane = paneId;
    
    document.getElementById('pane-left').classList.toggle('active-pane', paneId === 'left');
    document.getElementById('pane-right').classList.toggle('active-pane', paneId === 'right');
    
    updateSelectionUI();
}

function setSplitView(split) {
    state.isSplit = split;
    const container = document.getElementById('panes-container');
    const rightPane = document.getElementById('pane-right');
    const btn = document.getElementById('split-toggle-btn');

    if (split) {
        container.className = 'panes-container split-pane';
        rightPane.style.display = 'flex';
        btn.textContent = 'Single Pane (F3)';
        
        // If right pane doesn't have any tab, duplicate left active path
        if (state.panes.right.tabs.length === 0) {
            const leftTab = state.panes.left.tabs.find(t => t.id === state.panes.left.activeTabId);
            const path = leftTab ? leftTab.currentPath : '/';
            createTab('right', path);
        }
    } else {
        container.className = 'panes-container single-pane';
        rightPane.style.display = 'none';
        btn.textContent = 'Split View (F3)';
        setActivePane('left');
    }
}

async function loadSidebarPlaces() {
    const places = [
        { name: 'Home', path: '~', icon: '🏠' },
        { name: 'Root', path: '/', icon: '💻' },
        { name: 'Downloads', path: '~/Downloads', icon: '📥' },
        { name: 'Documents', path: '~/Documents', icon: '📄' },
        { name: 'Desktop', path: '~/Desktop', icon: '🖥️' }
    ];

    document.getElementById('sidebar-places').innerHTML = places.map(p => `
        <div class="sidebar-item" data-path="${p.path}">
            <span class="icon">${p.icon}</span>
            <span>${p.name}</span>
        </div>
    `).join('');

    document.getElementById('sidebar-places').querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            const path = item.getAttribute('data-path');
            navigateTo(path);
        });
    });

    await loadPlacesAndMounts();
}

async function loadPlacesAndMounts() {
    try {
        const response = await fetch('/api/places');
        if (!response.ok) throw new Error('Failed to load places');
        const data = await response.json();
        
        state.bookmarks = data.bookmarks || [];
        state.mounts = data.mounts || [];
        
        renderBookmarks();
        renderMounts();
    } catch (err) {
        console.error(err);
    }
}

function renderBookmarks() {
    const container = document.getElementById('sidebar-bookmarks');
    if (state.bookmarks.length === 0) {
        container.innerHTML = `<div style="padding: 5px 12px; font-size: 0.85rem; color: var(--text-muted);">No bookmarks</div>`;
        return;
    }
    
    container.innerHTML = state.bookmarks.map(b => {
        const name = b.split('/').pop() || b;
        return `
            <div class="sidebar-item bookmark-item" data-path="${b}" style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    <span class="icon">🔖</span>
                    <span>${name}</span>
                </div>
                <span class="btn-sidebar-action btn-delete-bookmark" data-path="${b}" title="Remove Bookmark" style="opacity:0; transition: opacity 0.2s;">&times;</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.bookmark-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete-bookmark')) {
                e.stopPropagation();
                removeBookmark(item.getAttribute('data-path'));
            } else {
                navigateTo(item.getAttribute('data-path'));
            }
        });
        
        item.addEventListener('mouseenter', () => {
            const delBtn = item.querySelector('.btn-delete-bookmark');
            if (delBtn) delBtn.style.opacity = 1;
        });
        item.addEventListener('mouseleave', () => {
            const delBtn = item.querySelector('.btn-delete-bookmark');
            if (delBtn) delBtn.style.opacity = 0;
        });
    });
}

function renderMounts() {
    const container = document.getElementById('sidebar-mounts');
    if (state.mounts.length === 0) {
        container.innerHTML = `<div style="padding: 5px 12px; font-size: 0.85rem; color: var(--text-muted);">No mounted drives</div>`;
        return;
    }
    
    container.innerHTML = state.mounts.map(m => `
        <div class="sidebar-item" data-path="${m.path}">
            <span class="icon">💾</span>
            <span>${m.name}</span>
        </div>
    `).join('');

    container.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            navigateTo(item.getAttribute('data-path'));
        });
    });
}

async function addCurrentToBookmarks() {
    const tab = getActiveTab();
    if (!tab || !tab.currentPath) return;
    try {
        const response = await fetch('/api/places', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'add', path: tab.currentPath })
        });
        if (response.ok) {
            await loadPlacesAndMounts();
        }
    } catch (err) {
        console.error(err);
    }
}

async function removeBookmark(path) {
    try {
        const response = await fetch('/api/places', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'remove', path })
        });
        if (response.ok) {
            await loadPlacesAndMounts();
        }
    } catch (err) {
        console.error(err);
    }
}

// Tabs state operations
function createTab(paneId, path = '', group = '', color = '') {
    const id = 'tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const tab = {
        id,
        name: 'Loading...',
        currentPath: path,
        history: [],
        historyIndex: -1,
        selectedPaths: new Set(),
        viewMode: 'list',
        loadedEntries: [],
        hasMore: false,
        nextCursor: '',
        group,
        color
    };
    state.panes[paneId].tabs.push(tab);
    state.panes[paneId].activeTabId = id;
    
    renderTabs(paneId);
    navigateTo(path, true, paneId);
}

function renderTabs(paneId) {
    const pane = state.panes[paneId];
    const tabsBar = getPaneDom(paneId).querySelector('.tabs-bar');
    
    if (!pane.collapsedGroups) {
        pane.collapsedGroups = new Set();
    } else if (!(pane.collapsedGroups instanceof Set)) {
        pane.collapsedGroups = new Set(pane.collapsedGroups);
    }
    
    let html = '';
    let renderedGroups = new Set();
    
    pane.tabs.forEach((tab, index) => {
        // Group label header (preceding its tabs)
        if (tab.group && !renderedGroups.has(tab.group)) {
            renderedGroups.add(tab.group);
            const collapsed = pane.collapsedGroups.has(tab.group);
            const collapseIndicator = collapsed ? '▶' : '▼';
            html += `
                <div class="tab-group-label group-${tab.color}" data-group-color="${tab.color}" draggable="true">
                    <span class="tab-group-dot"></span>
                    <span>${tab.group}</span>
                    <span style="font-size: 0.65rem; margin-left: 4px;">${collapseIndicator}</span>
                </div>
            `;
        }
        
        // Hide tabs inside collapsed groups
        const isCollapsed = tab.group && pane.collapsedGroups.has(tab.group);
        if (!isCollapsed) {
            const activeClass = tab.id === pane.activeTabId ? 'active' : '';
            const groupClass = tab.group ? `group-${tab.color}` : '';
            const displayName = tab.name || 'Root';
            
            html += `
                <div class="tab ${activeClass} ${groupClass}" data-tab-id="${tab.id}" data-tab-index="${index}" draggable="true">
                    <span class="tab-title">${displayName}</span>
                    <span class="tab-close" data-tab-id="${tab.id}">&times;</span>
                </div>
            `;
        }
    });
    
    tabsBar.innerHTML = html;
    
    // Click on tab groups labels to collapse/expand
    tabsBar.querySelectorAll('.tab-group-label').forEach(labelEl => {
        const color = labelEl.getAttribute('data-group-color');
        labelEl.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleGroupCollapse(paneId, color);
        });
    });
    
    // Tab actions
    tabsBar.querySelectorAll('.tab').forEach(tabEl => {
        const tabId = tabEl.getAttribute('data-tab-id');
        
        tabEl.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-close')) {
                e.stopPropagation();
                closeTab(paneId, tabId);
            } else {
                switchTab(paneId, tabId);
            }
        });
        
        tabEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showTabContextMenu(e, paneId, tabId);
        });
    });

    // Attach drag & drop reordering
    attachTabDragListeners(paneId);
}

function toggleGroupCollapse(paneId, color) {
    const pane = state.panes[paneId];
    if (!pane.collapsedGroups) {
        pane.collapsedGroups = new Set();
    }
    if (pane.collapsedGroups.has(color)) {
        pane.collapsedGroups.delete(color);
    } else {
        pane.collapsedGroups.add(color);
    }
    renderTabs(paneId);
}

function attachTabDragListeners(paneId) {
    const paneEl = getPaneDom(paneId);
    const tabsBar = paneEl.querySelector('.tabs-bar');

    tabsBar.querySelectorAll('.tab, .tab-group-label').forEach(el => {
        el.addEventListener('dragstart', (e) => {
            if (e.target.classList.contains('tab-close')) {
                e.preventDefault();
                return;
            }
            dragTabSource = {
                paneId: paneId,
                type: el.classList.contains('tab') ? 'tab' : 'group',
                tabId: el.getAttribute('data-tab-id'),
                tabIndex: el.getAttribute('data-tab-index') ? parseInt(el.getAttribute('data-tab-index')) : null,
                groupColor: el.getAttribute('data-group-color')
            };
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        el.addEventListener('dragover', (e) => {
            if (!dragTabSource) return;
            if (dragTabSource.paneId !== paneId) return; 
            
            e.preventDefault();
            
            const rect = el.getBoundingClientRect();
            const relX = e.clientX - rect.left;
            if (relX < rect.width / 2) {
                el.classList.add('drag-over-left');
                el.classList.remove('drag-over-right');
            } else {
                el.classList.add('drag-over-right');
                el.classList.remove('drag-over-left');
            }
        });

        el.addEventListener('dragleave', () => {
            el.classList.remove('drag-over-left', 'drag-over-right');
        });

        el.addEventListener('drop', (e) => {
            el.classList.remove('drag-over-left', 'drag-over-right');
            if (!dragTabSource) return;
            if (dragTabSource.paneId !== paneId) return;

            const isLeft = el.classList.contains('drag-over-left');
            const targetType = el.classList.contains('tab') ? 'tab' : 'group';
            const targetTabIndex = el.getAttribute('data-tab-index') ? parseInt(el.getAttribute('data-tab-index')) : null;
            const targetGroupColor = el.getAttribute('data-group-color');

            const pane = state.panes[paneId];

            if (dragTabSource.type === 'tab') {
                const srcTabId = dragTabSource.tabId;
                const srcIndex = pane.tabs.findIndex(t => t.id === srcTabId);
                if (srcIndex === -1) return;

                const draggedTab = pane.tabs[srcIndex];

                if (targetType === 'tab') {
                    let destIndex = pane.tabs.findIndex(t => t.id === el.getAttribute('data-tab-id'));
                    if (destIndex === -1) return;

                    pane.tabs.splice(srcIndex, 1);
                    if (srcIndex < destIndex) {
                        destIndex--;
                    }
                    
                    const insertAt = isLeft ? destIndex : destIndex + 1;
                    pane.tabs.splice(insertAt, 0, draggedTab);

                    // Join group color if dropped next to group tabs
                    const targetTab = pane.tabs[isLeft ? insertAt + 1 : insertAt - 1];
                    if (targetTab && targetTab.group) {
                        draggedTab.group = targetTab.group;
                        draggedTab.color = targetTab.color;
                    } else {
                        draggedTab.group = '';
                        draggedTab.color = '';
                    }
                } else if (targetType === 'group') {
                    draggedTab.group = targetGroupColor;
                    draggedTab.color = targetGroupColor;
                    
                    pane.tabs.splice(srcIndex, 1);
                    const groupFirstIndex = pane.tabs.findIndex(t => t.group === targetGroupColor);
                    if (groupFirstIndex !== -1) {
                        pane.tabs.splice(groupFirstIndex, 0, draggedTab);
                    } else {
                        pane.tabs.push(draggedTab);
                    }
                }
            } else if (dragTabSource.type === 'group') {
                const srcGroupColor = dragTabSource.groupColor;
                if (!srcGroupColor) return;

                const groupTabs = pane.tabs.filter(t => t.group === srcGroupColor);
                if (groupTabs.length === 0) return;

                pane.tabs = pane.tabs.filter(t => t.group !== srcGroupColor);

                if (targetType === 'tab') {
                    let destIndex = pane.tabs.findIndex(t => t.id === el.getAttribute('data-tab-id'));
                    if (destIndex !== -1) {
                        const insertAt = isLeft ? destIndex : destIndex + 1;
                        pane.tabs.splice(insertAt, 0, ...groupTabs);
                    }
                } else if (targetType === 'group') {
                    let destIndex = pane.tabs.findIndex(t => t.group === targetGroupColor);
                    if (destIndex !== -1) {
                        const insertAt = isLeft ? destIndex : destIndex + groupTabs.length;
                        pane.tabs.splice(insertAt, 0, ...groupTabs);
                    } else {
                        pane.tabs.push(...groupTabs);
                    }
                }
            }

            renderTabs(paneId);
            renderFiles(paneId);
            renderBreadcrumbs(paneId);
            updateNavButtons(paneId);
            dragTabSource = null;
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            dragTabSource = null;
        });
    });
}

function switchTab(paneId, tabId) {
    state.panes[paneId].activeTabId = tabId;
    setActivePane(paneId);
    renderTabs(paneId);
    renderFiles(paneId);
    renderBreadcrumbs(paneId);
    updateNavButtons(paneId);
}

function closeTab(paneId, tabId) {
    const pane = state.panes[paneId];
    const index = pane.tabs.findIndex(t => t.id === tabId);
    if (index === -1) return;
    
    pane.tabs.splice(index, 1);
    
    if (pane.activeTabId === tabId) {
        if (pane.tabs.length > 0) {
            const nextActiveIndex = Math.min(index, pane.tabs.length - 1);
            pane.activeTabId = pane.tabs[nextActiveIndex].id;
        } else {
            pane.activeTabId = null;
            createTab(paneId, '/');
            return;
        }
    }
    
    renderTabs(paneId);
    renderFiles(paneId);
    renderBreadcrumbs(paneId);
    updateNavButtons(paneId);
}

function duplicateTab(paneId, tabId) {
    const tab = getPaneTab(paneId, tabId);
    if (tab) {
        createTab(paneId, tab.currentPath, tab.group, tab.color);
    }
}

function assignTabGroup(paneId, tabId, color) {
    const tab = getPaneTab(paneId, tabId);
    if (tab) {
        tab.group = color ? color : '';
        tab.color = color;
        renderTabs(paneId);
    }
}

function showTabContextMenu(e, paneId, tabId) {
    const menu = document.getElementById('context-menu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.display = 'block';

    const colors = ['red', 'blue', 'green', 'yellow', 'purple'];
    let groupHtml = colors.map(c => `
        <div class="context-menu-item" onclick="assignTabGroup('${paneId}', '${tabId}', '${c}')">
            <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:${c}; margin-right:8px;"></span>
            <span>${c.charAt(0).toUpperCase() + c.slice(1)} Group</span>
        </div>
    `).join('');

    menu.innerHTML = `
        <div class="context-menu-item" onclick="closeTab('${paneId}', '${tabId}')">
            <span>Close Tab</span>
            <span class="context-menu-shortcut">Ctrl+W</span>
        </div>
        <div class="context-menu-item" onclick="duplicateTab('${paneId}', '${tabId}')">
            <span>Duplicate Tab</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-header" style="padding: 5px 15px; font-size: 0.75rem; color: var(--text-muted); font-weight: bold;">TAB GROUP COLOR</div>
        ${groupHtml}
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" onclick="assignTabGroup('${paneId}', '${tabId}', '')">
            <span>Remove Group</span>
        </div>
    `;
}

// Navigation helpers
async function navigateTo(path, recordHistory = true, paneId = state.activePane) {
    if (state.isLoading) return;
    state.isLoading = true;
    
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) {
        state.isLoading = false;
        return;
    }

    const infoEl = getPaneDom(paneId).querySelector('.status-info');
    infoEl.textContent = 'Loading directory...';
    tab.selectedPaths.clear();
    updateSelectionUI();

    try {
        const response = await fetch(`/api/dir?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
            throw new Error(`Failed to load: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        tab.currentPath = data.path;
        tab.name = data.path.split('/').pop() || 'Root';
        tab.loadedEntries = data.entries || [];
        tab.hasMore = data.has_more || false;
        tab.nextCursor = data.cursor || '';

        if (recordHistory) {
            pushPaneHistory(paneId, tab.currentPath);
        } else {
            updateNavButtons(paneId);
        }

        renderBreadcrumbs(paneId);
        renderTabs(paneId);
        
        const fileListEl = getPaneDom(paneId).querySelector('.file-list');
        fileListEl.scrollTop = 0;
        renderFiles(paneId);

        infoEl.textContent = `${tab.loadedEntries.length} items`;
    } catch (err) {
        console.error(err);
        infoEl.textContent = `Error loading directory`;
        alert(`Could not open directory: ${err.message}`);
    } finally {
        state.isLoading = false;
    }
}

function renderBreadcrumbs(paneId) {
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
    });
}

function renderFiles(paneId = state.activePane) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    if (tab.viewMode === 'list') {
        renderFilesListVirtual(paneId);
    } else {
        renderFilesGrid(paneId);
    }
}

function renderFilesListVirtual(paneId) {
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

function renderFilesGrid(paneId) {
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

function attachItemEventListeners(paneId) {
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
                navigateTo(path, true, paneId);
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
                        navigateTo(tab.currentPath, false, paneId);
                        
                        // If split, reload the other pane too in case it was displaying the destination directory
                        const otherPaneId = paneId === 'left' ? 'right' : 'left';
                        if (state.isSplit) {
                            const otherTab = state.panes[otherPaneId].tabs.find(t => t.id === state.panes[otherPaneId].activeTabId);
                            if (otherTab && (otherTab.currentPath === path || otherTab.currentPath === tab.currentPath)) {
                                navigateTo(otherTab.currentPath, false, otherPaneId);
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

async function loadMoreFiles(paneId, loadAll) {
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

function handleItemClick(paneId, path, ctrlKey, shiftKey) {
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

function updateItemSelectionStyles(paneId) {
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

function updateSelectionUI() {
    const tab = getActiveTab();
    if (!tab) return;
    const count = tab.selectedPaths.size;
    const selectEl = getPaneDom(state.activePane).querySelector('.status-selection');
    selectEl.textContent = `${count} item${count === 1 ? '' : 's'} selected`;
}

// Nav stack history actions
function pushPaneHistory(paneId, path) {
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

function navigatePaneHistory(paneId, direction) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    const nextIndex = tab.historyIndex + direction;
    if (nextIndex >= 0 && nextIndex < tab.history.length) {
        tab.historyIndex = nextIndex;
        navigateTo(tab.history[tab.historyIndex], false, paneId);
    }
}

function navigatePaneUp(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab || !tab.currentPath || tab.currentPath === '/') return;

    const parts = tab.currentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    navigateTo(parentPath, true, paneId);
}

function updateNavButtons(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    const paneEl = getPaneDom(paneId);
    if (!tab) return;

    paneEl.querySelector('.nav-back').disabled = tab.historyIndex <= 0;
    paneEl.querySelector('.nav-forward').disabled = tab.historyIndex >= tab.history.length - 1;
    paneEl.querySelector('.nav-up').disabled = !tab.currentPath || tab.currentPath === '/';
}

function setPaneViewMode(paneId, mode) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    tab.viewMode = mode;
    const paneEl = getPaneDom(paneId);
    
    paneEl.querySelector('.view-list').classList.toggle('active', mode === 'list');
    paneEl.querySelector('.view-grid').classList.toggle('active', mode === 'grid');
    
    const fileListEl = paneEl.querySelector('.file-list');
    fileListEl.className = mode === 'list' ? 'file-list list-view' : 'file-list grid-view';
    fileListEl.scrollTop = 0;
    
    renderFiles(paneId);
}

function enablePaneAddressBarEdit(paneId) {
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

function disablePaneAddressBarEdit(paneId) {
    const paneEl = getPaneDom(paneId);
    paneEl.querySelector('.breadcrumbs').style.display = 'flex';
    paneEl.querySelector('.address-bar').style.display = 'none';
}

// Workspaces REST integrations
async function loadWorkspaces() {
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

function showWorkspaceCreatePanel() {
    document.getElementById('workspace-select').style.display = 'none';
    document.getElementById('workspace-new-btn').style.display = 'none';
    document.getElementById('workspace-delete').style.display = 'none';
    
    const panel = document.getElementById('workspace-create-panel');
    panel.style.display = 'flex';
    const input = document.getElementById('workspace-new-name');
    input.value = '';
    input.focus();
}

function hideWorkspaceCreatePanel() {
    document.getElementById('workspace-create-panel').style.display = 'none';
    
    document.getElementById('workspace-select').style.display = 'block';
    document.getElementById('workspace-new-btn').style.display = 'block';
    document.getElementById('workspace-delete').style.display = 'block';
}

async function triggerSaveWorkspace() {
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

async function triggerDeleteWorkspace() {
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

async function handleWorkspaceChange() {
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

// Right Click Context Menu Handler
function handlePaneContextMenu(e, paneId) {
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

function showContextMenu(e, targetPath, isDir, isItem) {
    const menu = document.getElementById('context-menu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.display = 'block';

    let html = '';
    if (isItem) {
        if (isDir) {
            html += `
                <div class="context-menu-item" onclick="triggerOpenInNewTab()">
                    <span>Open in New Tab</span>
                </div>
                <div class="context-menu-separator"></div>
            `;
        }
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

    menu.innerHTML = html;
}

// Bind Context Menu Actions to Window context
window.triggerOpenInNewTab = () => {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size !== 1) return;
    const path = [...tab.selectedPaths][0];
    createTab(state.activePane, path);
};

window.triggerOpen = () => {
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
};

window.triggerClipboard = async (op) => {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size === 0) return;
    try {
        await executeFileOp(op, [...tab.selectedPaths]);
        const infoEl = getPaneDom(state.activePane).querySelector('.status-info');
        infoEl.textContent = `${op === 'copy' ? 'Copied' : 'Cut'} ${tab.selectedPaths.size} item(s)`;
    } catch (err) {
        alert(`Error executing operation: ${err.message}`);
    }
};

window.triggerPaste = async () => {
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
};

window.triggerRename = async () => {
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
};

window.triggerDelete = async () => {
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
};

window.triggerCreateFolder = async () => {
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
};

// Global handlers mapping for inline context calls
window.assignTabGroup = assignTabGroup;
window.closeTab = closeTab;
window.duplicateTab = duplicateTab;

// Keyboard Shortcuts Router
function handleKeyboardShortcuts(e) {
    if (document.activeElement.tagName === 'INPUT') return;

    if (e.key === 'F3') {
        e.preventDefault();
        setSplitView(!state.isSplit);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const sidebar = document.querySelector('.sidebar');
        sidebar.classList.toggle('visible');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const tab = getActiveTab();
        const path = tab ? tab.currentPath : '/';
        createTab(state.activePane, path);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const tab = getActiveTab();
        if (tab) {
            closeTab(state.activePane, tab.id);
        }
    }
    else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycleTabs(e.shiftKey ? -1 : 1);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        window.triggerClipboard('copy');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'x') {
        window.triggerClipboard('cut');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        window.triggerPaste();
    }
    else if (e.key === 'F2') {
        window.triggerRename();
    }
    else if (e.key === 'Delete') {
        window.triggerDelete();
    }
    else if (e.key === 'Backspace') {
        navigatePaneUp(state.activePane);
    }
    else if (e.key === 'Enter') {
        window.triggerOpen();
    }
}

function cycleTabs(dir) {
    const pane = getActivePane();
    if (pane.tabs.length <= 1) return;
    const index = pane.tabs.findIndex(t => t.id === pane.activeTabId);
    const nextIndex = (index + dir + pane.tabs.length) % pane.tabs.length;
    switchTab(state.activePane, pane.tabs[nextIndex].id);
}

// Low-level HTTP payload post executor
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

async function openFile(path) {
    try {
        await executeFileOp('open', [path]);
    } catch (err) {
        alert(`Error opening file: ${err.message}`);
    }
}

// Sidebar loader wrapper
function loadSidebarPlaces() {
    const places = [
        { name: 'Home', path: '~', icon: '🏠' },
        { name: 'Root', path: '/', icon: '💻' },
        { name: 'Downloads', path: '~/Downloads', icon: '📥' },
        { name: 'Documents', path: '~/Documents', icon: '📄' },
        { name: 'Desktop', path: '~/Desktop', icon: '🖥️' }
    ];

    document.getElementById('sidebar-places').innerHTML = places.map(p => `
        <div class="sidebar-item" data-path="${p.path}">
            <span class="icon">${p.icon}</span>
            <span>${p.name}</span>
        </div>
    `).join('');

    document.getElementById('sidebar-places').querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            const path = item.getAttribute('data-path');
            navigateTo(path);
        });
    });

    loadPlacesAndMounts();
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
