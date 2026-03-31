// ==UserScript==
// @name         Canvas Universal Deep Scraper
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Deep scrape and ZIP files from any Canvas Modules page
// @author       Lucas Root
// @match        https://*.instructure.com/courses/*/modules*
// @match        *://*/courses/*/modules*
// @downloadURL  https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js
// @updateURL    https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function() {
    'use strict';

    if (document.getElementById('canvas-scraper-root')) return;

    const sanitizeName = (name) => {
        return (name || 'file')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180) || 'file';
    };

    const extensionFromUrl = (url) => {
        try {
            const path = new URL(url, window.location.href).pathname;
            const last = path.split('/').pop() || '';
            const dot = last.lastIndexOf('.');
            if (dot > 0 && dot < last.length - 1) return last.slice(dot);
        } catch (_e) {
            // Ignore URL parsing failures and return an empty extension.
        }
        return '';
    };

    const ensureUniqueName = (name, usedNames) => {
        if (!usedNames.has(name)) {
            usedNames.add(name);
            return name;
        }

        const dot = name.lastIndexOf('.');
        const hasExt = dot > 0;
        const base = hasExt ? name.slice(0, dot) : name;
        const ext = hasExt ? name.slice(dot) : '';
        let index = 2;
        let candidate = `${base} (${index})${ext}`;
        while (usedNames.has(candidate)) {
            index += 1;
            candidate = `${base} (${index})${ext}`;
        }
        usedNames.add(candidate);
        return candidate;
    };

    const getModuleItems = () => {
        return Array.from(document.querySelectorAll('a.ig-title'))
            .filter(a => a.href.includes('/modules/items/'));
    };

    // --- UI Construction ---
    const launcherTab = document.createElement('button');
    launcherTab.id = 'canvas-scraper-tab';
    launcherTab.type = 'button';
    launcherTab.textContent = '-';
    launcherTab.title = 'Open Canvas Deep Scraper';
    launcherTab.style = `
        position: fixed; top: 140px; right: 0; width: 34px; height: 88px;
        background: #2d2d2d; color: #fff; z-index: 99999; border: 1px solid #444;
        border-right: none; border-radius: 8px 0 0 8px; cursor: pointer;
        font-size: 24px; line-height: 1; font-weight: bold; box-shadow: 0 8px 20px rgba(0,0,0,0.5);
    `;

    const container = document.createElement('div');
    container.id = "canvas-scraper-root";
    container.style = `
        position: fixed; top: 50px; right: 50px; width: 350px; height: 500px;
        background: #1d1d1d; color: #fff; z-index: 99999; padding: 0;
        border-radius: 8px; display: none; flex-direction: column;
        box-shadow: 0 10px 30px rgba(0,0,0,0.7); font-family: sans-serif;
        border: 1px solid #444; resize: both; overflow: hidden; min-width: 250px; min-height: 300px;
    `;

    container.innerHTML = `
        <div id="scraper-header" style="padding: 15px; background: #2d2d2d; cursor: move; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #444;">
            <span style="font-weight: bold; font-size: 14px;">Canvas Deep Scraper</span>
            <div style="display: flex; gap: 6px; align-items: center;">
                <button id="minimize-scraper" title="Minimize" style="background: none; border: none; color: #d1d5db; font-size: 22px; cursor: pointer; line-height: 1;">-</button>
                <button id="close-scraper" title="Close" style="background: none; border: none; color: #ff4d4d; font-size: 20px; cursor: pointer; line-height: 1;">&times;</button>
            </div>
        </div>
        <div style="flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column;">
            <p id="scrape-status" style="font-size: 11px; color: #aaa; margin-bottom: 10px;">Ready to scan...</p>
            <div id="scrape-select-actions" style="display: none; gap: 8px; margin-bottom: 10px;">
                <button id="scrape-select-all" style="flex: 1; padding: 8px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Select All</button>
                <button id="scrape-select-none" style="flex: 1; padding: 8px; background: #6b7280; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Select None</button>
            </div>
            <div id="scrape-file-list" style="flex: 1; background: #111; border-radius: 4px; padding: 5px; overflow-y: auto; margin-bottom: 10px; border: 1px solid #333;"></div>
            <button id="scrape-dl-btn" style="width: 100%; padding: 12px; background: #00558c; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; display: none;">Download ZIP</button>
            <button id="scrape-start-btn" style="width: 100%; padding: 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Start Deep Scan</button>
        </div>
        <div style="height: 15px; width: 15px; position: absolute; bottom: 0; right: 0; cursor: nwse-resize;"></div>
    `;

    document.body.appendChild(launcherTab);
    document.body.appendChild(container);

    const status = container.querySelector('#scrape-status');
    const list = container.querySelector('#scrape-file-list');
    const dlBtn = container.querySelector('#scrape-dl-btn');
    const startBtn = container.querySelector('#scrape-start-btn');
    const selectActions = container.querySelector('#scrape-select-actions');
    const selectAllBtn = container.querySelector('#scrape-select-all');
    const selectNoneBtn = container.querySelector('#scrape-select-none');
    const minimizeBtn = container.querySelector('#minimize-scraper');
    const closeBtn = container.querySelector('#close-scraper');

    const openPanel = () => {
        container.style.display = 'flex';
        launcherTab.style.display = 'none';
    };

    const minimizePanel = () => {
        container.style.display = 'none';
        launcherTab.style.display = 'block';
    };

    const setAllCheckboxes = (checked) => {
        const checkboxes = container.querySelectorAll('.sc-cb');
        checkboxes.forEach((cb) => {
            cb.checked = checked;
        });
    };

    launcherTab.addEventListener('click', openPanel);
    selectAllBtn.addEventListener('click', () => setAllCheckboxes(true));
    selectNoneBtn.addEventListener('click', () => setAllCheckboxes(false));
    minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        minimizePanel();
    });

    // --- Draggable Logic ---
    let isDragging = false;
    let offset = [0,0];
    const header = container.querySelector('#scraper-header');

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        offset = [container.offsetLeft - e.clientX, container.offsetTop - e.clientY];
    });

    const onMouseMove = (e) => {
        if (!isDragging) return;
        container.style.left = (e.clientX + offset[0]) + 'px';
        container.style.top = (e.clientY + offset[1]) + 'px';
        container.style.right = 'auto'; // Disable 'right' to allow moving
    };
    const onMouseUp = () => {
        isDragging = false;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        launcherTab.remove();
        container.remove();
    });

    // --- Scraper Logic ---
    startBtn.onclick = async () => {
        startBtn.style.display = 'none';
        list.innerHTML = '';
        selectActions.style.display = 'none';

        const moduleItems = getModuleItems();
        if (moduleItems.length === 0) {
            status.innerText = 'No module item links found yet. Scroll/load modules, then try again.';
            startBtn.style.display = 'block';
            startBtn.innerText = 'Scan Again';
            return;
        }

        const found = [];
        for (let i = 0; i < moduleItems.length; i++) {
            status.innerText = `Scanning item ${i+1}/${moduleItems.length}...`;
            try {
                const res = await fetch(moduleItems[i].href);
                if (!res.ok) continue;
                const text = await res.text();
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const dl = doc.querySelector('a[href*="/files/"][href*="/download"]');
                if (dl) {
                    const name = sanitizeName(moduleItems[i].innerText.trim());
                    const url = new URL(dl.getAttribute('href'), moduleItems[i].href).href;
                    found.push({ name, url });
                    const div = document.createElement('div');
                    div.style = "font-size: 12px; padding: 5px; border-bottom: 1px solid #222; display: flex; align-items: center;";

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.className = 'sc-cb';
                    checkbox.dataset.name = name;
                    checkbox.value = url;
                    checkbox.checked = true;

                    const label = document.createElement('span');
                    label.style = 'margin-left:8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
                    label.textContent = name;

                    div.appendChild(checkbox);
                    div.appendChild(label);
                    list.appendChild(div);
                }
            } catch (e) { console.error("Item skip:", e); }
        }
        status.innerText = `Scan complete. Found ${found.length} files.`;
        dlBtn.style.display = found.length > 0 ? 'block' : 'none';
        selectActions.style.display = found.length > 0 ? 'flex' : 'none';
        if (found.length === 0) {
            startBtn.style.display = 'block';
            startBtn.innerText = 'Scan Again';
        }
    };

    // --- ZIP Logic ---
    dlBtn.onclick = async () => {
        const zip = new JSZip();
        const selected = Array.from(container.querySelectorAll('.sc-cb:checked'));
        if (selected.length === 0) return alert("Select files.");
        
        dlBtn.disabled = true;
        dlBtn.innerText = "Processing...";

        const usedNames = new Set();
        
        for (const cb of selected) {
            try {
                const res = await fetch(cb.value);
                if (!res.ok) continue;
                const blob = await res.blob();
                const baseName = sanitizeName(cb.getAttribute('data-name'));
                const ext = extensionFromUrl(cb.value);
                const fileName = ensureUniqueName(`${baseName}${ext}`, usedNames);
                zip.file(fileName, blob);
            } catch (e) { console.error("File skip:", e); }
        }

        const content = await zip.generateAsync({type:"blob"});
        const a = document.createElement('a');
        const objectUrl = URL.createObjectURL(content);
        a.href = objectUrl;
        a.download = "Canvas_Modules_Export.zip";
        a.click();
        URL.revokeObjectURL(objectUrl);
        dlBtn.disabled = false;
        dlBtn.innerText = "Download ZIP";
    };
})();