// ==UserScript==
// @name         Canvas File Scraper
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Scrape and ZIP Canvas files from course pages
// @author       Lucas Root
// @match        https://*.instructure.com/courses/*
// @match        *://*/courses/*
// @downloadURL  https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js
// @updateURL    https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js
// @grant        GM_xmlhttpRequest
// @connect      *
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

    const getCourseTitle = () => {
        const selectors = [
            '.ic-app-course-menu .menu-item-title',
            '#breadcrumbs .ellipsible a',
            '[data-testid="course-name"]'
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            const text = el && el.textContent ? el.textContent.trim() : '';
            if (text && text.length > 2) {
                return sanitizeName(text);
            }
        }

        // Fallback: derive from browser title (e.g., "Course Name: Modules").
        const rawTitle = (document.title || '').split(':')[0].trim();
        return sanitizeName(rawTitle || 'Canvas_Course');
    };

    const blobPromiseCache = new Map();
    let preparedZipBlob = null;
    let preparedSelectionSignature = '';
    let activePrepareToken = 0;
    let prepareTimer = null;
    let isDownloadInProgress = false;
    let cancelDownloadRequested = false;
    let autoScanTimer = null;
    let autoScanAttempts = 0;
    let isScanning = false;
    const MAX_AUTO_SCAN_ATTEMPTS = 8;
    const AUTO_SCAN_RETRY_MS = 1500;
    const MODULE_SCAN_CONCURRENCY = 6;
    const FILE_DOWNLOAD_CONCURRENCY = 4;
    const REQUEST_TIMEOUT_MS = 30000;
    const ZIP_CREATION_TIMEOUT_MS = 120000;

    const mapWithConcurrency = async (items, concurrency, worker) => {
        const results = new Array(items.length);
        let nextIndex = 0;
        const workerCount = Math.min(concurrency, items.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index], index);
            }
        });
        await Promise.all(workers);
        return results;
    };

    const getSelectedEntries = () => {
        return Array.from(container.querySelectorAll('.sc-cb:checked')).map((cb) => {
            return {
                name: cb.getAttribute('data-name') || 'file',
                url: cb.value
            };
        });
    };

    const getSelectionSignature = (entries) => {
        return entries.map((entry) => `${entry.name}|${entry.url}`).join('\n');
    };

    const requestBlob = (url) => new Promise((resolve, reject) => {
        let request;
        const timeout = setTimeout(() => {
            if (request) request.abort();
            reject(new Error('Canvas request timed out.'));
        }, REQUEST_TIMEOUT_MS);
        request = GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: 'blob',
            onload: (response) => {
                clearTimeout(timeout);
                if (response.status < 200 || response.status >= 300) {
                    reject(new Error(`HTTP ${response.status}`));
                    return;
                }
                resolve(response.response);
            },
            onerror: () => {
                clearTimeout(timeout);
                reject(new Error('Canvas request was blocked or failed.'));
            },
            ontimeout: () => {
                clearTimeout(timeout);
                reject(new Error('Canvas request timed out.'));
            }
        });
    });

    const getBlobForUrl = async (url) => {
        if (blobPromiseCache.has(url)) return blobPromiseCache.get(url);

        const promise = (async () => {
            if (typeof GM_xmlhttpRequest === 'function') {
                return requestBlob(url);
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            let res;
            try {
                res = await fetch(url, {
                    credentials: 'include',
                    redirect: 'follow',
                    signal: controller.signal
                });
            } catch (e) {
                if (e.name === 'AbortError') throw new Error('Canvas request timed out.');
                throw e;
            } finally {
                clearTimeout(timeout);
            }
            if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
            return res.blob();
        })();

        blobPromiseCache.set(url, promise);

        try {
            return await promise;
        } catch (e) {
            blobPromiseCache.delete(url);
            throw e;
        }
    };

    const downloadBlob = (blob, fileName) => {
        const link = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        link.href = objectUrl;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(objectUrl);
    };

    const buildZipBlob = async (entries, shouldCancel, onProgress) => {
        const zip = new JSZip();
        const usedNames = new Set();
        const skippedErrors = [];
        let addedFileCount = 0;

        const results = await mapWithConcurrency(entries, FILE_DOWNLOAD_CONCURRENCY, async (entry, index) => {
            if (shouldCancel && shouldCancel()) throw new Error('ZIP build canceled by user.');
            try {
                return { entry, blob: await getBlobForUrl(entry.url) };
            } catch (error) {
                return { entry, error };
            } finally {
                if (onProgress) onProgress(index + 1, entries.length);
            }
        });

        for (const result of results) {
            if (shouldCancel && shouldCancel()) {
                throw new Error('ZIP build canceled by user.');
            }
            if (result.error) {
                skippedErrors.push(`${result.entry.name}: ${result.error.message}`);
                console.error('File skip:', result.error);
                continue;
            }
            const baseName = sanitizeName(result.entry.name);
            const ext = extensionFromUrl(result.entry.url);
            const fileName = ensureUniqueName(`${baseName}${ext}`, usedNames);
            const data = await result.blob.arrayBuffer();
            zip.file(fileName, data);
            addedFileCount += 1;
        }

        if (addedFileCount === 0) {
            const reason = skippedErrors.length > 0 ? ` ${skippedErrors[0]}` : '';
            throw new Error(`No files could be downloaded.${reason}`);
        }

        if (onProgress) onProgress(entries.length, entries.length, true, 0);
        const generation = zip.generateAsync(
            { type: 'uint8array', compression: 'STORE' },
            (metadata) => {
                if (onProgress) onProgress(entries.length, entries.length, true, metadata.percent);
            }
        );
        let timeoutId;
        const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('ZIP creation timed out after 120 seconds.')), ZIP_CREATION_TIMEOUT_MS);
        });
        try {
            const bytes = await Promise.race([generation, timeout]);
            return new Blob([bytes], { type: 'application/zip' });
        } finally {
            clearTimeout(timeoutId);
        }
    };

    const prepareZipInBackground = async () => {
        const entries = getSelectedEntries();
        const signature = getSelectionSignature(entries);

        if (entries.length === 0) {
            preparedZipBlob = null;
            preparedSelectionSignature = '';
            setZipPreparing(false);
            return;
        }

        if (preparedZipBlob && preparedSelectionSignature === signature) return;

        const token = activePrepareToken;
        try {
            const blob = await buildZipBlob(entries, null, (completed, total, creating, percent) => {
                if (token === activePrepareToken) {
                    status.innerText = creating
                        ? `Creating ZIP... ${Math.round(percent || 0)}%`
                        : `Preparing ZIP... ${completed}/${total} files`;
                }
            });
            if (token !== activePrepareToken) return;
            preparedZipBlob = blob;
            preparedSelectionSignature = signature;
            setZipPreparing(false);
            status.innerText = `Ready. ${entries.length} file${entries.length === 1 ? '' : 's'} prepared.`;
        } catch (e) {
            if (token !== activePrepareToken) return;
            preparedZipBlob = null;
            preparedSelectionSignature = '';
            setZipPreparing(false);
            status.innerText = e.message;
            console.error('Background ZIP prepare failed:', e);
        }
    };

    const queueZipPreparation = () => {
        if (prepareTimer) clearTimeout(prepareTimer);
        activePrepareToken += 1;
        preparedZipBlob = null;
        preparedSelectionSignature = '';
        setZipPreparing(true);
        prepareTimer = setTimeout(() => {
            prepareZipInBackground();
        }, 250);
    };

    const getModuleItems = () => {
        return Array.from(document.querySelectorAll('a.ig-title'))
            .filter(a => a.href.includes('/modules/items/'));
    };

    const getPageFileLinks = () => {
        return Array.from(document.querySelectorAll('a[href*="/files/"][href*="/download"]'));
    };

    // --- UI Construction ---
    const launcherTab = document.createElement('button');
    launcherTab.id = 'canvas-scraper-tab';
    launcherTab.type = 'button';
    launcherTab.textContent = '-';
    launcherTab.title = 'Open Canvas File Scraper';
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
            <span style="font-weight: bold; font-size: 14px;">Canvas File Scraper</span>
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

    const setZipPreparing = (isPreparing) => {
        dlBtn.disabled = isPreparing;
        dlBtn.style.background = isPreparing ? '#6b7280' : '#00558c';
        dlBtn.innerText = isPreparing ? 'Preparing ZIP...' : 'Download ZIP';
    };

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
        queueZipPreparation();
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
        if (prepareTimer) clearTimeout(prepareTimer);
        activePrepareToken += 1;
        if (autoScanTimer) clearTimeout(autoScanTimer);
        launcherTab.remove();
        container.remove();
    });

    list.addEventListener('change', (e) => {
        const target = e.target;
        if (target && target.classList && target.classList.contains('sc-cb')) {
            queueZipPreparation();
        }
    });

    // --- Scraper Logic ---
    const runScan = async (isAutoScan) => {
        if (isScanning) return;
        isScanning = true;

        startBtn.style.display = 'none';
        startBtn.disabled = true;
        list.innerHTML = '';
        selectActions.style.display = 'none';
        dlBtn.style.display = 'none';
        preparedZipBlob = null;
        preparedSelectionSignature = '';
        blobPromiseCache.clear();
        if (prepareTimer) clearTimeout(prepareTimer);

        const moduleItems = getModuleItems();
        const pageFileLinks = getPageFileLinks();
        if (moduleItems.length === 0 && pageFileLinks.length === 0) {
            isScanning = false;
            if (isAutoScan && autoScanAttempts < MAX_AUTO_SCAN_ATTEMPTS) {
                autoScanAttempts += 1;
                status.innerText = 'Waiting for module items to load...';
                autoScanTimer = setTimeout(() => {
                    runScan(true);
                }, AUTO_SCAN_RETRY_MS);
                return;
            }

            status.innerText = 'No downloadable Canvas file links found. Try again after the page loads.';
            startBtn.style.display = 'block';
            startBtn.disabled = false;
            startBtn.innerText = 'Scan Again';
            return;
        }

        autoScanAttempts = 0;

        const found = [];
        const seenUrls = new Set();
        const addFileRow = (name, url) => {
            const div = document.createElement('div');
            div.style = "font-size: 12px; padding: 5px; border-bottom: 1px solid #222; display: flex; align-items: center; gap: 6px;";

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'sc-cb';
            checkbox.dataset.name = name;
            checkbox.value = url;
            checkbox.checked = true;

            const label = document.createElement('span');
            label.style = 'margin-left:2px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
            label.textContent = name;

            const singleDownloadBtn = document.createElement('button');
            singleDownloadBtn.type = 'button';
            singleDownloadBtn.textContent = 'Download';
            singleDownloadBtn.title = `Download ${name}`;
            singleDownloadBtn.style = 'flex: 0 0 auto; padding: 3px 6px; background: #00558c; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;';
            singleDownloadBtn.addEventListener('click', async () => {
                singleDownloadBtn.disabled = true;
                singleDownloadBtn.textContent = '...';
                try {
                    const blob = await getBlobForUrl(url);
                    const extension = extensionFromUrl(url);
                    downloadBlob(blob, `${name}${extension}`);
                } catch (e) {
                    console.error('Single file download failed:', e);
                    status.innerText = `Download failed: ${e.message}`;
                } finally {
                    singleDownloadBtn.disabled = false;
                    singleDownloadBtn.textContent = 'Download';
                }
            });

            div.appendChild(checkbox);
            div.appendChild(label);
            div.appendChild(singleDownloadBtn);
            list.appendChild(div);
        };
        const addFoundFile = (name, url) => {
            if (seenUrls.has(url)) return;
            const safeName = sanitizeName(name);
            seenUrls.add(url);
            found.push({ name: safeName, url });
            addFileRow(safeName, url);
        };

        for (const link of pageFileLinks) {
            addFoundFile(link.innerText.trim() || link.textContent.trim() || 'file', link.href);
        }

        let scannedItems = 0;
        const moduleResults = await mapWithConcurrency(moduleItems, MODULE_SCAN_CONCURRENCY, async (item) => {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
                let res;
                try {
                    res = await fetch(item.href, { credentials: 'include', signal: controller.signal });
                } finally {
                    clearTimeout(timeout);
                }
                if (!res.ok) return null;
                const text = await res.text();
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const dl = doc.querySelector('a[href*="/files/"][href*="/download"]');
                if (!dl) return null;
                return {
                    name: sanitizeName(item.innerText.trim()),
                    url: new URL(dl.getAttribute('href'), item.href).href
                };
            } catch (e) {
                console.error('Item skip:', e);
                return null;
            } finally {
                scannedItems += 1;
                status.innerText = `Scanning item ${scannedItems}/${moduleItems.length}...`;
            }
        });

        moduleResults.forEach((result) => {
            if (result) addFoundFile(result.name, result.url);
        });

        isScanning = false;
        status.innerText = `Scan complete. Found ${found.length} files.`;
        dlBtn.style.display = found.length > 0 ? 'block' : 'none';
        selectActions.style.display = found.length > 0 ? 'flex' : 'none';
        if (found.length > 0) {
            status.innerText = `Scan complete. Found ${found.length} files. Preparing ZIP...`;
            queueZipPreparation();
        }
        if (found.length === 0) {
            startBtn.style.display = 'block';
            startBtn.disabled = false;
            startBtn.innerText = 'Scan Again';
        }
    };

    startBtn.onclick = async () => {
        runScan(false);
    };

    // Trigger an automatic scan on page load so results are ready faster.
    autoScanTimer = setTimeout(() => {
        runScan(true);
    }, 600);

    // --- ZIP Logic ---
    dlBtn.onclick = async () => {
        if (isDownloadInProgress) {
            cancelDownloadRequested = true;
            dlBtn.innerText = 'Cancelling...';
            return;
        }

        const selectedEntries = getSelectedEntries();
        if (selectedEntries.length === 0) return alert("Select files.");

        isDownloadInProgress = true;
        cancelDownloadRequested = false;
        dlBtn.disabled = false;
        dlBtn.innerText = "Cancel";

        const signature = getSelectionSignature(selectedEntries);
        let content = preparedZipBlob;

        try {
            if (!content || preparedSelectionSignature !== signature) {
                content = await buildZipBlob(
                    selectedEntries,
                    () => cancelDownloadRequested,
                    (completed, total, creating, percent) => {
                        dlBtn.innerText = creating
                            ? `Creating ZIP... ${Math.round(percent || 0)}%`
                            : `Preparing ZIP... ${completed}/${total}`;
                    }
                );
                preparedZipBlob = content;
                preparedSelectionSignature = signature;
            }

            if (cancelDownloadRequested) {
                status.innerText = 'Download canceled.';
                return;
            }

            const a = document.createElement('a');
            const objectUrl = URL.createObjectURL(content);
            a.href = objectUrl;
            const zipName = `${getCourseTitle()}.zip`;
            a.download = zipName;
            a.click();
            URL.revokeObjectURL(objectUrl);
        } catch (e) {
            if (cancelDownloadRequested) {
                status.innerText = 'Download canceled.';
            } else {
                console.error('Download failed:', e);
                status.innerText = e.message;
            }
        } finally {
            isDownloadInProgress = false;
            cancelDownloadRequested = false;
            setZipPreparing(false);
        }
    };
})();