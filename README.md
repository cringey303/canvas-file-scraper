# Canvas Universal Deep Scraper

Tampermonkey userscript for Canvas LMS that scans a course Modules page, finds linked downloadable files, and exports selected files into a single ZIP.

## What it does

- Adds a floating UI on Canvas Modules pages.
- Scans module item pages for Canvas file download links.
- Lets you choose which discovered files to include.
- Includes `Select All` and `Select None` quick actions.
- Downloads all selected files as `Canvas_Modules_Export.zip`.

## Requirements

- Google Chrome, Microsoft Edge, or Firefox.
- Tampermonkey extension installed in your browser.
- Access to a Canvas course Modules page.

## Install with Tampermonkey

1. Install [Tampermonkey](https://www.tampermonkey.net/):
   - Chrome/Edge: install from the browser extension store.
   - Firefox: install from Firefox Add-ons.
2. Open this raw script URL in your browser:
  - [https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js](https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js)
3. Tampermonkey should open an install prompt.
4. Click `Install` (or `Reinstall` when updating).
5. Confirm the script is enabled in the Tampermonkey dashboard.

### Manual fallback (if raw link does not prompt install)

1. Open Tampermonkey dashboard.
2. Click `Utilities`.
3. Use `Install from URL` and paste:
  - `https://raw.githubusercontent.com/cringey303/canvas-file-scraper/main/scraper.user.js`
4. Install and enable the script.

## How to use

1. Open a Canvas Modules URL that matches:
   - `https://<your-school>.instructure.com/courses/<course-id>/modules`
2. Wait for the page to load.
3. In the scraper panel, click `Start Deep Scan`.
4. Wait for the scan to finish and review the checkbox list.
5. Optional: use `Select All` or `Select None` to quickly toggle file selection.
6. Check or uncheck individual files as needed.
7. Click `Download ZIP`.
8. Your browser downloads `Canvas_Modules_Export.zip`.

## Notes and limitations

- The script only runs on Canvas Modules pages (`/courses/*/modules*`).
- It finds links that look like Canvas file downloads (`/files/.../download`).
- If an item is not accessible with your account permissions, it may be skipped.
- If no files are found, the panel shows `Scan Again`.
- Tampermonkey auto-update checks use the script metadata URL and `@version`; bump `@version` before each release.

## Troubleshooting

- Panel does not appear:
  - Confirm you are on a matching Modules URL.
  - Confirm the script is enabled in Tampermonkey.
  - Refresh the page after enabling.
- ZIP is empty:
  - Check that files were found and selected.
  - Verify you have permission to open those module items/files.
- Download blocked by browser:
  - Allow downloads/popups for your Canvas domain if prompted.

## Disclaimer

Use only for courses and content you are authorized to access and download.
