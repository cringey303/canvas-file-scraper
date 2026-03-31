// ==UserScript==
// @name         Canvas Universal Deep Scraper
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Deep scrape and ZIP files from any Canvas Modules page
// @author       Lucas Root
// @match        https://*.instructure.com/courses/*/modules*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

(function() {
    'use strict';

    // Find all module items that link to a page (which might contain a file)
    const moduleItems = Array.from(document.querySelectorAll('a.ig-title'))
        .filter(a => a.href.includes('/modules/items/'));

    if (moduleItems.length === 0) return;

    // --- UI Construction ---
    const container = document.createElement('div');
    container.id = "canvas-scraper-root";
    container.style = `
        position: fixed; top: 50px; right: 50px; width: 350px; height: 500px;
        background: #1d1d1d; color: #fff; z-index: 99999; padding: 0;
        border-radius: 8px; display: flex; flex-direction: column;
        box-shadow: 0 10px 30px rgba(0,0,0,0.7); font-family: sans-serif;
        border: 1px solid #444; resize: both; overflow: hidden; min-width: 250px; min-height: 300px;
    `;

    container.innerHTML = `
        <div id="scraper-header" style="padding: 15px; background: #2d2d2d; cursor: move; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #444;">
            <span style="font-weight: bold; font-size: 14px;">Canvas Deep Scraper</span>
            <button id="close-scraper" style="background: none; border: none; color: #ff4d4d; font-size: 20px; cursor: pointer;">&times;</button>
        </div>
        <div style="flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column;">
            <p id="scrape-status" style="font-size: 11px; color: #aaa; margin-bottom: 10px;">Ready to scan...</p>
            <div id="scrape-file-list" style="flex: 1; background: #111; border-radius: 4px; padding: 5px; overflow-y: auto; margin-bottom: 10px; border: 1px solid #333;"></div>
            <button id="scrape-dl-btn" style="width: 100%; padding: 12px; background: #00558c; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; display: none;">Download ZIP</button>
            <button id="scrape-start-btn" style="width: 100%; padding: 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Start Deep Scan</button>
        </div>
        <div style="height: 15px; width: 15px; position: absolute; bottom: 0; right: 0; cursor: nwse-resize;"></div>
    `;

    document.body.appendChild(container);

    const status = container.querySelector('#scrape-status');
    const list = container.querySelector('#scrape-file-list');
    const dlBtn = container.querySelector('#scrape-dl-btn');
    const startBtn = container.querySelector('#scrape-start-btn');

    // --- Draggable Logic ---
    let isDragging = false;
    let offset = [0,0];
    const header = container.querySelector('#scraper-header');

    header.onmousedown = (e) => {
        isDragging = true;
        offset = [container.offsetLeft - e.clientX, container.offsetTop - e.clientY];
    };
    document.onmousemove = (e) => {
        if (!isDragging) return;
        container.style.left = (e.clientX + offset[0]) + 'px';
        container.style.top = (e.clientY + offset[1]) + 'px';
        container.style.right = 'auto'; // Disable 'right' to allow moving
    };
    document.onmouseup = () => isDragging = false;
    container.querySelector('#close-scraper').onclick = () => container.remove();

    // --- Scraper Logic ---
    startBtn.onclick = async () => {
        startBtn.style.display = 'none';
        const found = [];
        for (let i = 0; i < moduleItems.length; i++) {
            status.innerText = `Scanning item ${i+1}/${moduleItems.length}...`;
            try {
                const res = await fetch(moduleItems[i].href);
                const text = await res.text();
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const dl = doc.querySelector('a[href*="/files/"][href*="/download"]');
                if (dl) {
                    const name = moduleItems[i].innerText.trim();
                    found.push({ name, url: dl.href });
                    const div = document.createElement('div');
                    div.style = "font-size: 12px; padding: 5px; border-bottom: 1px solid #222; display: flex; align-items: center;";
                    div.innerHTML = `<input type="checkbox" class="sc-cb" data-name="${name}" value="${dl.href}" checked> <span style="margin-left:8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</span>`;
                    list.appendChild(div);
                }
            } catch (e) { console.error("Item skip:", e); }
        }
        status.innerText = `Scan complete. Found ${found.length} files.`;
        dlBtn.style.display = 'block';
    };

    // --- ZIP Logic ---
    dlBtn.onclick = async () => {
        const zip = new JSZip();
        const selected = Array.from(container.querySelectorAll('.sc-cb:checked'));
        if (selected.length === 0) return alert("Select files.");
        
        dlBtn.disabled = true;
        dlBtn.innerText = "Processing...";
        
        for (const cb of selected) {
            try {
                const res = await fetch(cb.value);
                const blob = await res.blob();
                const name = cb.getAttribute('data-name');
                const ext = blob.type.includes('pdf') ? '.pdf' : (blob.type.includes('sql') ? '.sql' : '');
                zip.file(name + ext, blob);
            } catch (e) { console.error("File skip:", e); }
        }

        const content = await zip.generateAsync({type:"blob"});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = "Canvas_Modules_Export.zip";
        a.click();
        dlBtn.disabled = false;
        dlBtn.innerText = "Download ZIP";
    };
})();