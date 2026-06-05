import { state, getActiveTab } from './state.js';

let navigateToCallback = null;

export function initSidebar(navigateTo) {
    navigateToCallback = navigateTo;
}

export function loadSidebarPlaces() {
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
            if (navigateToCallback) {
                navigateToCallback(path);
            }
        });
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const path = item.getAttribute('data-path');
            import('./context-menu.js').then(m => m.showFolderContextMenu(e, path, state.activePane, 'sidebar'));
        });
    });

    loadPlacesAndMounts();
}

export async function loadPlacesAndMounts() {
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

export function renderBookmarks() {
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
            } else if (navigateToCallback) {
                navigateToCallback(item.getAttribute('data-path'));
            }
        });
        
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const path = item.getAttribute('data-path');
            import('./context-menu.js').then(m => m.showFolderContextMenu(e, path, state.activePane, 'sidebar'));
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

export function renderMounts() {
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
            if (navigateToCallback) {
                navigateToCallback(item.getAttribute('data-path'));
            }
        });
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const path = item.getAttribute('data-path');
            import('./context-menu.js').then(m => m.showFolderContextMenu(e, path, state.activePane, 'sidebar'));
        });
    });
}

export async function addCurrentToBookmarks() {
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

export async function removeBookmark(path) {
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
