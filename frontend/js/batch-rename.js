import { state, getPaneDom, getActiveTab } from './state.js';
import { updateLayout } from './split-view.js';
import { navigateTo } from './navigation.js';
import { executeFileOp } from './api.js';
import { renderFiles } from './file-list.js';

let isBatchRenameActive = false;
let batchRenameFiles = []; // items being renamed
let sourcePaneId = '';
let originalIsSplit = false;
let originalIsQuad = false;
let originalLeftBreadcrumbsHtml = '';
let originalRightBreadcrumbsHtml = '';

export function getIsBatchRenameActive() {
    return isBatchRenameActive;
}

export function startBatchRename(paneId) {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size <= 1) return;

    sourcePaneId = paneId;
    originalIsSplit = state.isSplit;
    originalIsQuad = state.isQuad;

    // Get selected file entries
    batchRenameFiles = tab.loadedEntries.filter(entry => {
        const fullPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + entry.name;
        return tab.selectedPaths.has(fullPath);
    }).map(entry => ({
        ...entry,
        path: tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + entry.name
    }));

    if (batchRenameFiles.length === 0) return;

    isBatchRenameActive = true;

    // Force dual split view
    state.isSplit = true;
    state.isQuad = false;
    updateLayout();

    // Show control panel
    const panel = document.getElementById('batch-rename-panel');
    panel.style.display = 'flex';

    // Clear inputs and set defaults
    document.getElementById('batch-rename-find').value = '';
    document.getElementById('batch-rename-replace').value = '';
    document.getElementById('batch-rename-regex').checked = false;
    document.getElementById('batch-rename-case').checked = false;
    document.getElementById('batch-rename-ext').checked = false;
    document.getElementById('batch-rename-counter-start').value = 1;
    document.getElementById('batch-rename-counter-step').value = 1;

    // Set count info
    document.getElementById('batch-rename-count-info').textContent = `${batchRenameFiles.length} items loaded`;

    // Save original breadcrumbs
    const leftBreadcrumbs = getPaneDom('left').querySelector('.breadcrumbs');
    const rightBreadcrumbs = getPaneDom('right').querySelector('.breadcrumbs');
    if (leftBreadcrumbs) originalLeftBreadcrumbsHtml = leftBreadcrumbs.innerHTML;
    if (rightBreadcrumbs) originalRightBreadcrumbsHtml = rightBreadcrumbs.innerHTML;

    // Setup custom breadcrumbs labels
    if (leftBreadcrumbs) leftBreadcrumbs.innerHTML = '<span class="breadcrumb-segment" style="cursor: default; font-weight: 600; color: var(--accent-color);">Original Names</span>';
    if (rightBreadcrumbs) rightBreadcrumbs.innerHTML = '<span class="breadcrumb-segment" style="cursor: default; font-weight: 600; color: #2ecc71;">Preview Names (Dry Run)</span>';

    // Attach listeners
    const inputs = [
        'batch-rename-find',
        'batch-rename-replace',
        'batch-rename-regex',
        'batch-rename-case',
        'batch-rename-ext',
        'batch-rename-counter-start',
        'batch-rename-counter-step'
    ];
    inputs.forEach(id => {
        const el = document.getElementById(id);
        el.oninput = updatePreview;
        el.onchange = updatePreview;
    });

    // Synchronize scrolling between lists
    setTimeout(() => {
        const leftList = getPaneDom('left').querySelector('.file-list');
        const rightList = getPaneDom('right').querySelector('.file-list');
        if (leftList && rightList) {
            leftList.onscroll = () => { rightList.scrollTop = leftList.scrollTop; };
            rightList.onscroll = () => { leftList.scrollTop = rightList.scrollTop; };
        }
    }, 100);

    updatePreview();
    document.getElementById('batch-rename-find').focus();
}

export function cancelBatchRename() {
    if (!isBatchRenameActive) return;
    isBatchRenameActive = false;

    // Hide control panel
    const panel = document.getElementById('batch-rename-panel');
    if (panel) panel.style.display = 'none';

    // Restore breadcrumbs
    const leftBreadcrumbs = getPaneDom('left').querySelector('.breadcrumbs');
    const rightBreadcrumbs = getPaneDom('right').querySelector('.breadcrumbs');
    if (leftBreadcrumbs) leftBreadcrumbs.innerHTML = originalLeftBreadcrumbsHtml;
    if (rightBreadcrumbs) rightBreadcrumbs.innerHTML = originalRightBreadcrumbsHtml;

    // Unbind synchronized scroll
    const leftList = getPaneDom('left').querySelector('.file-list');
    const rightList = getPaneDom('right').querySelector('.file-list');
    if (leftList) leftList.onscroll = null;
    if (rightList) rightList.onscroll = null;

    // Restore layout
    state.isSplit = originalIsSplit;
    state.isQuad = originalIsQuad;
    updateLayout();

    // Trigger normal list renders
    renderFiles('left');
    renderFiles('right');
}

export async function applyBatchRename() {
    if (!isBatchRenameActive) return;

    const previews = calculatePreviews();
    const conflicts = previews.filter(p => p.status === 'conflict');
    if (conflicts.length > 0) {
        alert('Cannot apply rename: there are unresolved filename conflicts or errors.');
        return;
    }

    const applyBtn = document.getElementById('batch-rename-apply-btn');
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';

    const changedIndexes = [];
    previews.forEach((p, idx) => {
        if (p.status !== 'unchanged') {
            changedIndexes.push(idx);
        }
    });

    if (changedIndexes.length === 0) {
        cancelBatchRename();
        return;
    }

    const sources = changedIndexes.map(idx => batchRenameFiles[idx].path);
    const newNames = changedIndexes.map(idx => previews[idx].preview);


    try {
        await executeFileOp('rename', sources, null, JSON.stringify(newNames));
        
        // Hide panel & reset layout
        isBatchRenameActive = false;
        document.getElementById('batch-rename-panel').style.display = 'none';

        // Restore breadcrumbs
        const leftBreadcrumbs = getPaneDom('left').querySelector('.breadcrumbs');
        const rightBreadcrumbs = getPaneDom('right').querySelector('.breadcrumbs');
        if (leftBreadcrumbs) leftBreadcrumbs.innerHTML = originalLeftBreadcrumbsHtml;
        if (rightBreadcrumbs) rightBreadcrumbs.innerHTML = originalRightBreadcrumbsHtml;

        state.isSplit = originalIsSplit;
        state.isQuad = originalIsQuad;
        updateLayout();

        // Refresh all panes that display this directory
        const tab = state.panes[sourcePaneId].tabs.find(t => t.id === state.panes[sourcePaneId].activeTabId);
        const currentPath = tab ? tab.currentPath : '/';

        for (const pId of Object.keys(state.panes)) {
            const pane = state.panes[pId];
            const pTab = pane.tabs.find(t => t.id === pane.activeTabId);
            if (pTab && pTab.currentPath === currentPath) {
                navigateTo(pTab.currentPath, false, pId);
            }
        }
    } catch (err) {
        alert(`Batch rename failed: ${err.message}`);
    } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply Rename';
    }
}

function calculatePreviews() {
    const findText = document.getElementById('batch-rename-find').value;
    const replaceText = document.getElementById('batch-rename-replace').value;
    const isRegex = document.getElementById('batch-rename-regex').checked;
    const isCase = document.getElementById('batch-rename-case').checked;
    const renameExt = document.getElementById('batch-rename-ext').checked;
    const startVal = parseInt(document.getElementById('batch-rename-counter-start').value, 10) || 1;
    const stepVal = parseInt(document.getElementById('batch-rename-counter-step').value, 10) || 1;

    // Prepare regex compiler if active
    let regex = null;
    let regexError = null;

    if (findText) {
        try {
            if (isRegex) {
                regex = new RegExp(findText, isCase ? 'gi' : 'g');
            } else {
                // Escape literal text for regex replacement
                const escaped = findText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                regex = new RegExp(escaped, isCase ? 'gi' : 'g');
            }
        } catch (err) {
            regexError = err.message;
        }
    }

    const tab = state.panes[sourcePaneId].tabs.find(t => t.id === state.panes[sourcePaneId].activeTabId);
    const existingNames = new Set(tab ? tab.loadedEntries.map(e => e.name) : []);
    const sourceNames = new Set(batchRenameFiles.map(f => f.name));
    
    // Names that exist in the directory but are NOT in the selected list being renamed
    const otherExistingNames = new Set([...existingNames].filter(n => !sourceNames.has(n)));

    const previews = [];
    const usedTargetNames = new Set();

    batchRenameFiles.forEach((file, index) => {
        const name = file.name;
        let namePart = name;
        let extPart = '';

        if (!file.is_dir) {
            const lastDot = name.lastIndexOf('.');
            if (lastDot > 0) {
                namePart = name.substring(0, lastDot);
                extPart = name.substring(lastDot);
            }
        }

        let targetNamePart = namePart;
        let targetExtPart = extPart;

        // Perform replacement
        if (findText && regex) {
            if (renameExt) {
                // Apply to full filename
                const fullTarget = name.replace(regex, replaceText);
                const lastDot = fullTarget.lastIndexOf('.');
                if (lastDot > 0 && !file.is_dir) {
                    targetNamePart = fullTarget.substring(0, lastDot);
                    targetExtPart = fullTarget.substring(lastDot);
                } else {
                    targetNamePart = fullTarget;
                    targetExtPart = '';
                }
            } else {
                // Apply to name portion only
                targetNamePart = namePart.replace(regex, replaceText);
            }
        } else if (findText && regexError) {
            // Error compiled regex, target remains unmodified
        }

        // Apply sequential counters placeholder replacement [n] or [n:digits]
        const counterVal = startVal + index * stepVal;
        
        let finalNamePart = targetNamePart;
        let finalExtPart = targetExtPart;

        const counterReplacer = (match, digits) => {
            const numStr = String(counterVal);
            if (digits) {
                const width = parseInt(digits, 10);
                return numStr.padStart(width, '0');
            }
            return numStr;
        };

        // Replace both in name and extension if they exist
        finalNamePart = finalNamePart.replace(/\[n\]/g, String(counterVal));
        finalNamePart = finalNamePart.replace(/\[n:(\d+)\]/g, counterReplacer);
        finalExtPart = finalExtPart.replace(/\[n\]/g, String(counterVal));
        finalExtPart = finalExtPart.replace(/\[n:(\d+)\]/g, counterReplacer);

        const previewName = renameExt ? finalNamePart : (finalNamePart + finalExtPart);

        // Validation / Collision checking
        let status = 'success';
        let reason = '';

        if (previewName === '') {
            status = 'conflict';
            reason = 'Filename cannot be empty';
        } else if (previewName === name) {
            status = 'unchanged';
        } else if (otherExistingNames.has(previewName)) {
            status = 'conflict';
            reason = 'File already exists in folder';
        } else if (usedTargetNames.has(previewName)) {
            status = 'conflict';
            reason = 'Duplicate target name collision';
        }

        usedTargetNames.add(previewName);

        previews.push({
            original: name,
            preview: previewName,
            isDir: file.is_dir,
            status,
            reason,
            regexError
        });
    });

    return previews;
}

function updatePreview() {
    if (!isBatchRenameActive) return;

    const previews = calculatePreviews();
    
    // Display warnings if regex error or name collisions exist
    const warningEl = document.getElementById('batch-rename-warning');
    const warningTextEl = document.getElementById('batch-rename-warning-text');
    
    const regexError = previews.find(p => p.regexError)?.regexError;
    const firstConflict = previews.find(p => p.status === 'conflict');

    if (regexError) {
        warningTextEl.textContent = `Regex Error: ${regexError}`;
        warningEl.style.display = 'flex';
    } else if (firstConflict) {
        warningTextEl.textContent = `Collision: ${firstConflict.reason} (${firstConflict.preview})`;
        warningEl.style.display = 'flex';
    } else {
        warningEl.style.display = 'none';
    }

    // Render original pane (left)
    const leftList = getPaneDom('left').querySelector('.file-list');
    let leftHtml = '';
    
    batchRenameFiles.forEach((file, index) => {
        const icon = file.is_dir ? '📁' : '📄';
        const iconClass = file.is_dir ? 'icon-folder' : 'icon-file';
        const topOffset = index * 40;
        
        leftHtml += `
            <div class="file-item rename-status-original" style="position: absolute; top: ${topOffset}px; left: 0; right: 0; height: 40px; display: flex; align-items: center;">
                <div class="file-name" style="padding-left: 10px;">
                    <span class="${iconClass}">${icon}</span>
                    <span>${file.name}</span>
                </div>
            </div>
        `;
    });

    const totalHeight = batchRenameFiles.length * 40;
    leftList.innerHTML = `<div class="scroll-spacer" style="height: ${totalHeight}px; width: 1px; pointer-events: none; position: absolute; top: 0; left: 0;"></div>` + leftHtml;

    // Render preview pane (right)
    const rightList = getPaneDom('right').querySelector('.file-list');
    let rightHtml = '';

    previews.forEach((p, index) => {
        const icon = p.isDir ? '📁' : '📄';
        const iconClass = p.isDir ? 'icon-folder' : 'icon-file';
        const topOffset = index * 40;
        
        let statusClass = 'rename-status-success';
        let badgeClass = 'badge-success';
        let badgeText = 'renamed';

        if (p.status === 'unchanged') {
            statusClass = 'rename-status-unchanged';
            badgeClass = 'badge-unchanged';
            badgeText = 'unchanged';
        } else if (p.status === 'conflict') {
            statusClass = 'rename-status-conflict';
            badgeClass = 'badge-conflict';
            badgeText = 'conflict';
        }

        rightHtml += `
            <div class="file-item ${statusClass}" style="position: absolute; top: ${topOffset}px; left: 0; right: 0; height: 40px; display: flex; align-items: center;">
                <div class="file-name" style="padding-left: 10px;">
                    <span class="${iconClass}">${icon}</span>
                    <span>${p.preview}</span>
                </div>
                <span class="rename-preview-badge ${badgeClass}">${badgeText}</span>
            </div>
        `;
    });

    rightList.innerHTML = `<div class="scroll-spacer" style="height: ${totalHeight}px; width: 1px; pointer-events: none; position: absolute; top: 0; left: 0;"></div>` + rightHtml;
}

// Global initialization
function initEvents() {
    const cancelBtn = document.getElementById('batch-rename-cancel-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', cancelBatchRename);
    }

    const applyBtn = document.getElementById('batch-rename-apply-btn');
    if (applyBtn) {
        applyBtn.addEventListener('click', applyBatchRename);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEvents);
} else {
    initEvents();
}
