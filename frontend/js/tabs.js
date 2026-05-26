import { state, getPaneDom, getPaneTab, dragTabState } from './state.js';
import { navigateTo, renderBreadcrumbs, updateNavButtons } from './navigation.js';
import { renderFiles } from './file-list.js';
import { setActivePane } from './split-view.js';

// Tabs state operations
export function createTab(paneId, path = '', group = '', color = '') {
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

export function renderTabs(paneId) {
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

export function toggleGroupCollapse(paneId, color) {
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

export function attachTabDragListeners(paneId) {
    const paneEl = getPaneDom(paneId);
    const tabsBar = paneEl.querySelector('.tabs-bar');

    tabsBar.querySelectorAll('.tab, .tab-group-label').forEach(el => {
        el.addEventListener('dragstart', (e) => {
            if (e.target.classList.contains('tab-close')) {
                e.preventDefault();
                return;
            }
            dragTabState.source = {
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
            if (!dragTabState.source) return;
            if (dragTabState.source.paneId !== paneId) return; 
            
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
            if (!dragTabState.source) return;
            if (dragTabState.source.paneId !== paneId) return;

            const isLeft = el.classList.contains('drag-over-left');
            const targetType = el.classList.contains('tab') ? 'tab' : 'group';
            const targetTabIndex = el.getAttribute('data-tab-index') ? parseInt(el.getAttribute('data-tab-index')) : null;
            const targetGroupColor = el.getAttribute('data-group-color');

            const pane = state.panes[paneId];

            if (dragTabState.source.type === 'tab') {
                const srcTabId = dragTabState.source.tabId;
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
            } else if (dragTabState.source.type === 'group') {
                const srcGroupColor = dragTabState.source.groupColor;
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
            dragTabState.source = null;
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            dragTabState.source = null;
        });
    });
}

export function switchTab(paneId, tabId) {
    state.panes[paneId].activeTabId = tabId;
    setActivePane(paneId);
    renderTabs(paneId);
    renderFiles(paneId);
    renderBreadcrumbs(paneId);
    updateNavButtons(paneId);
}

export function closeTab(paneId, tabId) {
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

export function duplicateTab(paneId, tabId) {
    const tab = getPaneTab(paneId, tabId);
    if (tab) {
        createTab(paneId, tab.currentPath, tab.group, tab.color);
    }
}

export function assignTabGroup(paneId, tabId, color) {
    const tab = getPaneTab(paneId, tabId);
    if (tab) {
        tab.group = color ? color : '';
        tab.color = color;
        renderTabs(paneId);
    }
}

export function showTabContextMenu(e, paneId, tabId) {
    const menu = document.getElementById('context-menu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.display = 'block';

    const colors = ['red', 'blue', 'green', 'yellow', 'purple'];
    let groupHtml = colors.map(c => `
        <div class="context-menu-item" data-action="assign-tab-group" data-pane-id="${paneId}" data-tab-id="${tabId}" data-color="${c}">
            <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:${c}; margin-right:8px;"></span>
            <span>${c.charAt(0).toUpperCase() + c.slice(1)} Group</span>
        </div>
    `).join('');

    menu.innerHTML = `
        <div class="context-menu-item" data-action="close-tab" data-pane-id="${paneId}" data-tab-id="${tabId}">
            <span>Close Tab</span>
            <span class="context-menu-shortcut">Ctrl+W</span>
        </div>
        <div class="context-menu-item" data-action="duplicate-tab" data-pane-id="${paneId}" data-tab-id="${tabId}">
            <span>Duplicate Tab</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-header" style="padding: 5px 15px; font-size: 0.75rem; color: var(--text-muted); font-weight: bold;">TAB GROUP COLOR</div>
        ${groupHtml}
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="assign-tab-group" data-pane-id="${paneId}" data-tab-id="${tabId}" data-color="">
            <span>Remove Group</span>
        </div>
    `;
}
