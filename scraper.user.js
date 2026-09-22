// ==UserScript==
// @name         Canvas File Scraper
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Scrape and ZIP Canvas files from course pages
// @author       Lucas Root
// @match        https://*.instructure.com/courses/*
// @match        *://*/courses/*
// @downloadURL  https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js
// @updateURL    https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
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

    // Canvas tab labels that must never end up as the archive name.
    const COURSE_PAGE_LABELS = new Set([
        'home', 'modules', 'course modules', 'files', 'course files', 'assignments',
        'pages', 'syllabus', 'course syllabus', 'grades', 'announcements', 'quizzes',
        'discussions', 'people', 'collaborations', 'conferences', 'outcomes', 'rubrics',
        'settings', 'dashboard', 'canvas', 'modules: course modules'
    ]);

    const isCoursePageLabel = (text) => COURSE_PAGE_LABELS.has(text.trim().toLowerCase());

    const getCourseTitle = () => {
        // The breadcrumb entry pointing at the course root is the course name.
        // Note the nesting: the crumb is <a href="/courses/123"><span class="ellipsible">.
        const crumb = Array.from(document.querySelectorAll('#breadcrumbs a')).find((a) => {
            try {
                return /\/courses\/\d+\/?$/.test(new URL(a.href, window.location.href).pathname);
            } catch (_e) {
                return false;
            }
        });
        const crumbText = crumb ? crumb.textContent.trim() : '';
        if (crumbText && !isCoursePageLabel(crumbText)) return sanitizeName(crumbText);

        // Canvas publishes the course name on its page-global ENV object. Userscripts
        // run sandboxed, so the page's copy is only reachable through unsafeWindow.
        try {
            const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const envTitle = pageWindow && pageWindow.ENV && pageWindow.ENV.COURSE_TITLE;
            if (typeof envTitle === 'string' && envTitle.trim()) return sanitizeName(envTitle.trim());
        } catch (_e) {
            // Sandboxed or unavailable; fall through to the DOM.
        }

        const el = document.querySelector('[data-testid="course-name"]');
        const testIdText = el && el.textContent ? el.textContent.trim() : '';
        if (testIdText && !isCoursePageLabel(testIdText)) return sanitizeName(testIdText);

        // Last resort: the tab title, which Canvas formats as "Modules: Course Name".
        // Take the longest segment that is not the name of a course tab.
        const candidates = (document.title || '')
            .split(':')
            .map((part) => part.trim())
            .filter((part) => part.length > 2 && !isCoursePageLabel(part))
            .sort((a, b) => b.length - a.length);
        return sanitizeName(candidates[0] || 'Canvas_Course');
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
    const API_PAGE_LIMIT = 20;
    const FILE_DOWNLOAD_CONCURRENCY = 4;
    const REQUEST_TIMEOUT_MS = 30000;
    const ZIP_READ_CHUNK_BYTES = 4 * 1024 * 1024;
    const YIELD_INTERVAL_MS = 16;
    const U32_MAX = 0xFFFFFFFF;

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
                const data = response.response;
                resolve(data instanceof Blob ? data : new Blob([data]));
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

    // --- Minimal stored (uncompressed) ZIP writer ---
    // This replaces JSZip, whose generateAsync scheduled its work on microtasks:
    // the renderer never got a turn, so progress text stayed frozen at 0% and a
    // large course blew past any wall-clock timeout. Writing the archive here
    // lets us yield to the event loop, report real progress, and stay cancelable.
    // Slice-by-8 CRC32: eight tables let us fold eight bytes per iteration, which
    // measures ~2.9x faster than the byte-at-a-time loop (274 -> 785 MB/s).
    const CRC32_TABLES = (() => {
        const first = new Uint32Array(256);
        for (let i = 0; i < 256; i += 1) {
            let value = i;
            for (let bit = 0; bit < 8; bit += 1) {
                value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
            }
            first[i] = value >>> 0;
        }
        const tables = [first];
        for (let n = 1; n < 8; n += 1) {
            const previous = tables[n - 1];
            const table = new Uint32Array(256);
            for (let i = 0; i < 256; i += 1) {
                table[i] = (previous[i] >>> 8) ^ first[previous[i] & 0xFF];
            }
            tables.push(table);
        }
        return tables;
    })();

    const [T0, T1, T2, T3, T4, T5, T6, T7] = CRC32_TABLES;

    // Reading four bytes at a time through a Uint32Array assumes little-endian.
    const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

    const crc32Chunk = (crc, bytes) => {
        let value = crc;
        let i = 0;
        const length = bytes.length;

        // The word view needs 4-byte alignment; slices read from a blob always start
        // at offset 0, but guard anyway and let the byte loop handle the rest.
        if (IS_LITTLE_ENDIAN && length >= 8 && bytes.byteOffset % 4 === 0) {
            const wordCount = (length >>> 3) * 2;
            const words = new Uint32Array(bytes.buffer, bytes.byteOffset, wordCount);
            for (let w = 0; w < wordCount; w += 2) {
                const low = words[w] ^ value;
                const high = words[w + 1];
                value = T7[low & 0xFF] ^ T6[(low >>> 8) & 0xFF]
                    ^ T5[(low >>> 16) & 0xFF] ^ T4[(low >>> 24) & 0xFF]
                    ^ T3[high & 0xFF] ^ T2[(high >>> 8) & 0xFF]
                    ^ T1[(high >>> 16) & 0xFF] ^ T0[(high >>> 24) & 0xFF];
            }
            i = wordCount * 4;
        }

        for (; i < length; i += 1) {
            value = T0[(value ^ bytes[i]) & 0xFF] ^ (value >>> 8);
        }
        return value >>> 0;
    };

    const createByteWriter = (size) => {
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        let offset = 0;
        return {
            bytes,
            u16(value) { view.setUint16(offset, value, true); offset += 2; },
            u32(value) { view.setUint32(offset, value >>> 0, true); offset += 4; },
            u64(value) {
                view.setUint32(offset, value % 0x100000000, true);
                view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
                offset += 8;
            },
            raw(source) { bytes.set(source, offset); offset += source.length; }
        };
    };

    const toDosDateTime = (date) => {
        const year = Math.max(date.getFullYear(), 1980);
        return {
            time: ((date.getHours() & 0x1F) << 11)
                | ((date.getMinutes() & 0x3F) << 5)
                | ((date.getSeconds() >> 1) & 0x1F),
            date: (((year - 1980) & 0x7F) << 9)
                | (((date.getMonth() + 1) & 0x0F) << 5)
                | (date.getDate() & 0x1F)
        };
    };

    const buildLocalHeader = (nameBytes, crc, size, stamp) => {
        const needsZip64 = size > U32_MAX;
        const extraLength = needsZip64 ? 20 : 0;
        const writer = createByteWriter(30 + nameBytes.length + extraLength);
        writer.u32(0x04034b50);
        writer.u16(needsZip64 ? 45 : 20);
        writer.u16(0x0800); // UTF-8 file names
        writer.u16(0); // stored, no compression
        writer.u16(stamp.time);
        writer.u16(stamp.date);
        writer.u32(crc);
        writer.u32(needsZip64 ? U32_MAX : size);
        writer.u32(needsZip64 ? U32_MAX : size);
        writer.u16(nameBytes.length);
        writer.u16(extraLength);
        writer.raw(nameBytes);
        if (needsZip64) {
            writer.u16(0x0001);
            writer.u16(16);
            writer.u64(size);
            writer.u64(size);
        }
        return writer.bytes;
    };

    const buildCentralEntry = (entry, stamp) => {
        const includeSizes = entry.size > U32_MAX;
        const includeOffset = entry.offset > U32_MAX;
        const payloadLength = (includeSizes ? 16 : 0) + (includeOffset ? 8 : 0);
        const extraLength = payloadLength > 0 ? payloadLength + 4 : 0;
        const writer = createByteWriter(46 + entry.nameBytes.length + extraLength);
        writer.u32(0x02014b50);
        writer.u16(extraLength > 0 ? 45 : 20); // version made by
        writer.u16(includeSizes ? 45 : 20); // version needed
        writer.u16(0x0800);
        writer.u16(0);
        writer.u16(stamp.time);
        writer.u16(stamp.date);
        writer.u32(entry.crc);
        writer.u32(includeSizes ? U32_MAX : entry.size);
        writer.u32(includeSizes ? U32_MAX : entry.size);
        writer.u16(entry.nameBytes.length);
        writer.u16(extraLength);
        writer.u16(0); // comment length
        writer.u16(0); // disk number
        writer.u16(0); // internal attributes
        writer.u32(0); // external attributes
        writer.u32(includeOffset ? U32_MAX : entry.offset);
        writer.raw(entry.nameBytes);
        if (extraLength > 0) {
            writer.u16(0x0001);
            writer.u16(payloadLength);
            if (includeSizes) {
                writer.u64(entry.size);
                writer.u64(entry.size);
            }
            if (includeOffset) writer.u64(entry.offset);
        }
        return writer.bytes;
    };

    const buildEndOfCentralDirectory = (count, centralSize, centralOffset) => {
        const needsZip64 = count > 0xFFFF || centralSize > U32_MAX || centralOffset > U32_MAX;
        const writer = createByteWriter(needsZip64 ? 98 : 22);
        if (needsZip64) {
            writer.u32(0x06064b50);
            writer.u64(44); // size of this record minus 12
            writer.u16(45);
            writer.u16(45);
            writer.u32(0);
            writer.u32(0);
            writer.u64(count);
            writer.u64(count);
            writer.u64(centralSize);
            writer.u64(centralOffset);
            writer.u32(0x07064b50);
            writer.u32(0);
            writer.u64(centralOffset + centralSize);
            writer.u32(1);
        }
        writer.u32(0x06054b50);
        writer.u16(0);
        writer.u16(0);
        writer.u16(needsZip64 ? 0xFFFF : count);
        writer.u16(needsZip64 ? 0xFFFF : count);
        writer.u32(needsZip64 ? U32_MAX : centralSize);
        writer.u32(needsZip64 ? U32_MAX : centralOffset);
        writer.u16(0); // no archive comment
        return writer.bytes;
    };

    const yieldToRenderer = () => new Promise((resolve) => setTimeout(resolve, 0));

    // Hash one blob, handing the main thread back only once a frame's worth of work
    // has piled up. Yielding after every slice cost more than the hashing did:
    // browsers clamp nested timeouts to ~4ms, and a slice now takes about 5ms.
    const crc32Blob = async (blob, shouldCancel, onBytes) => {
        const size = blob.size;
        let value = 0xFFFFFFFF;
        let lastYield = performance.now();

        for (let start = 0; start < size; start += ZIP_READ_CHUNK_BYTES) {
            if (shouldCancel && shouldCancel()) throw new Error('ZIP build canceled by user.');
            const end = Math.min(start + ZIP_READ_CHUNK_BYTES, size);
            const slice = new Uint8Array(await blob.slice(start, end).arrayBuffer());
            value = crc32Chunk(value, slice);
            if (onBytes) onBytes(slice.length);
            if (performance.now() - lastYield >= YIELD_INTERVAL_MS) {
                await yieldToRenderer();
                lastYield = performance.now();
            }
        }

        return (value ^ 0xFFFFFFFF) >>> 0;
    };

    const writeStoredZip = (files) => {
        const encoder = new TextEncoder();
        const stamp = toDosDateTime(new Date());
        const parts = [];
        const centralEntries = [];
        let offset = 0;

        for (const file of files) {
            const nameBytes = encoder.encode(file.name);
            const size = file.blob.size;
            const header = buildLocalHeader(nameBytes, file.crc, size, stamp);
            parts.push(header);
            // The blob is handed to the archive by reference; the browser keeps it
            // backed by disk, so memory does not grow with the course size.
            if (size > 0) parts.push(file.blob);
            centralEntries.push({ nameBytes, crc: file.crc, size, offset });
            offset += header.length + size;
        }

        const centralOffset = offset;
        let centralSize = 0;
        for (const entry of centralEntries) {
            const bytes = buildCentralEntry(entry, stamp);
            parts.push(bytes);
            centralSize += bytes.length;
        }
        parts.push(buildEndOfCentralDirectory(centralEntries.length, centralSize, centralOffset));

        return new Blob(parts, { type: 'application/zip' });
    };

    const buildZipBlob = async (entries, shouldCancel, onProgress) => {
        const usedNames = new Set();
        const skippedErrors = [];
        const files = [];

        // Each file is hashed the moment it lands rather than in a second pass over
        // everything, so the CRC work overlaps the downloads still in flight. On a
        // network-bound course the archiving cost disappears behind the transfers.
        let completed = 0;
        const results = await mapWithConcurrency(entries, FILE_DOWNLOAD_CONCURRENCY, async (entry) => {
            if (shouldCancel && shouldCancel()) throw new Error('ZIP build canceled by user.');
            try {
                const blob = await getBlobForUrl(entry.url);
                return { entry, blob, crc: await crc32Blob(blob, shouldCancel) };
            } catch (error) {
                return { entry, error };
            } finally {
                completed += 1;
                if (onProgress) onProgress(completed, entries.length);
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
            files.push({ name: fileName, blob: result.blob, crc: result.crc });
        }

        if (files.length === 0) {
            const reason = skippedErrors.length > 0 ? ` ${skippedErrors[0]}` : '';
            throw new Error(`No files could be downloaded.${reason}`);
        }

        // Everything is hashed by now, so laying out the archive is pure bookkeeping.
        if (onProgress) onProgress(entries.length, entries.length, true, 100);
        return writeStoredZip(files);
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
            const blob = await buildZipBlob(entries, () => token !== activePrepareToken, (completed, total, creating, percent) => {
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

    const getCourseId = () => {
        const match = window.location.pathname.match(/\/courses\/(\d+)/);
        return match ? match[1] : '';
    };

    const getModuleItemId = (link) => {
        const match = (link.getAttribute('href') || '').match(/\/modules\/items\/(\d+)/);
        return match ? match[1] : '';
    };

    // Canvas paginates through an RFC 5988 Link header.
    const parseNextLink = (header) => {
        if (!header) return '';
        for (const part of header.split(',')) {
            const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
            if (match) return match[1];
        }
        return '';
    };

    // One request per 100 modules instead of one page fetch per module item.
    // Modules holding more than ~100 items come back without their items, and
    // those simply fall through to the per-item page scan below.
    const fetchModuleItemsFromApi = async (courseId) => {
        const itemsById = new Map();
        if (!courseId) return itemsById;

        let url = `${window.location.origin}/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`;
        for (let page = 0; page < API_PAGE_LIMIT && url; page += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            let res;
            try {
                res = await fetch(url, {
                    credentials: 'include',
                    headers: { Accept: 'application/json' },
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeout);
            }
            if (!res.ok) throw new Error(`Canvas API responded ${res.status}`);

            const modules = await res.json();
            if (!Array.isArray(modules)) throw new Error('Unexpected Canvas API response.');
            for (const module of modules) {
                const items = (module && Array.isArray(module.items)) ? module.items : [];
                for (const item of items) {
                    if (item && item.id !== null && item.id !== undefined) {
                        itemsById.set(String(item.id), item);
                    }
                }
            }

            url = parseNextLink(res.headers.get('Link'));
        }

        return itemsById;
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
        const seenKeys = new Set();
        // /files/123/download and /courses/1/files/123/download?download_frd=1 are
        // the same file, so key on the file id whenever the URL carries one.
        const fileKey = (url) => {
            const match = url.match(/\/files\/(\d+)/);
            return match ? `file:${match[1]}` : `url:${url}`;
        };
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
            const key = fileKey(url);
            if (seenKeys.has(key)) return;
            const safeName = sanitizeName(name);
            seenKeys.add(key);
            found.push({ name: safeName, url });
            addFileRow(safeName, url);
        };

        for (const link of pageFileLinks) {
            addFoundFile(link.innerText.trim() || link.textContent.trim() || 'file', link.href);
        }

        // Ask the API to classify the module items first. Anything it reports as a
        // File resolves to a download URL with no request of its own; everything
        // else (a Page or Assignment may still carry an attachment) is scanned as
        // before. A failure here costs nothing but the old behaviour.
        const courseId = getCourseId();
        let apiItems = new Map();
        try {
            status.innerText = 'Looking up course modules...';
            apiItems = await fetchModuleItemsFromApi(courseId);
        } catch (e) {
            console.error('Canvas API lookup failed; falling back to page scans:', e);
        }

        // Results keep their slot so the list still matches the order on the page.
        const resolved = new Array(moduleItems.length).fill(null);
        const itemsNeedingScan = [];
        const scanSlots = [];
        moduleItems.forEach((item, index) => {
            const apiItem = apiItems.get(getModuleItemId(item));
            const contentId = apiItem && apiItem.content_id;
            if (apiItem && apiItem.type === 'File' && contentId !== null && contentId !== undefined) {
                const title = (apiItem.title || item.innerText || '').trim();
                resolved[index] = {
                    name: sanitizeName(title),
                    url: `${window.location.origin}/courses/${courseId}/files/${contentId}/download?download_frd=1`
                };
            } else {
                itemsNeedingScan.push(item);
                scanSlots.push(index);
            }
        });

        let scannedItems = 0;
        const moduleResults = await mapWithConcurrency(itemsNeedingScan, MODULE_SCAN_CONCURRENCY, async (item) => {
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
                status.innerText = `Scanning item ${scannedItems}/${itemsNeedingScan.length}...`;
            }
        });

        moduleResults.forEach((result, index) => {
            if (result) resolved[scanSlots[index]] = result;
        });
        resolved.forEach((result) => {
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
        // Stop any in-flight background prepare so the two builds do not compete.
        if (prepareTimer) clearTimeout(prepareTimer);
        activePrepareToken += 1;
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