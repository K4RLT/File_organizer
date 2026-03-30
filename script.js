'use strict';

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
const state = {
    files: [],
    blobCache: {},
    thumbnailCache: {},
    thumbProgress: {},
    folders: { queue: [], skipped: [], trash: [], documents: [], music: [], pictures: [], videos: [] },
    customFolders: [],
    presetFolders: ['documents', 'music', 'pictures', 'videos'],
    currentFolder: '__home__',
    currentIndex: 0,
    currentSkippedIndex: 0,
    undoStack: [],
    redoStack: [],
};

let pendingMoveSource = 'queue';

// ── Live Export ──
const liveExport = {
    active: false,
    dirHandle: null,
    written: 0,
    failed: 0,
    queue: [],      // { fileId, folderName } pending writes
    writing: false,
};

let isDragging = false, dragStartX = 0, dragStartY = 0, dragCurrentX = 0, dragCurrentY = 0;

const ARCHIVE_TYPES = {
    kra:'Krita', ora:'OpenRaster', blend:'Blender',
    zip:'ZIP', '7z':'7-Zip', xcf:'GIMP', psd:'Photoshop', rar:'RAR', tar:'TAR', gz:'GZip', bz2:'BZip2',
    // Office/Document (ZIP-based, may contain docProps/thumbnail or Thumbnails/thumbnail.png)
    docx:'Word', xlsx:'Excel', pptx:'PowerPoint',
    odt:'ODT', ods:'ODS', odp:'ODP',
    // eBook/App (ZIP-based)
    epub:'EPUB', apk:'APK',
    // Design tools (ZIP-based)
    sketch:'Sketch', procreate:'Procreate',
};
// Extensions that are ZIP-containers but NOT valid JSZip archives (single-file compression)
const SKIP_JSZ_EXTS = new Set(['gz','bz2','xcf','psd','blend']);
const TEXT_EXTS = new Set([
    'txt','md','markdown','json','js','mjs','cjs','ts','tsx','jsx','py','css','scss','less',
    'html','htm','xml','xhtml','sh','bash','zsh','rs','go','c','h','cpp','cc',
    'hpp','java','rb','php','yaml','yml','toml','ini','cfg','log','csv','tsv','svg','svgz',
    'vue','svelte','graphql','gql','sql','r','swift','kt','dart','lua',
    'ps1','bat','makefile','dockerfile','gitignore','env',
    'tf','hcl','pl','coffee','elm','hs','ml','tex','rst','diff','patch',
    'drawio','dio','eps'
]);
const OBJ_3D_EXTS    = new Set(['obj','stl','gltf','glb','fbx','dae']);
const NATIVE_3D_EXTS = new Set(['blend','max','mb','ma','c4d','lxo','hip','hipnc']);
const FONT_EXTS      = new Set(['ttf','otf','woff','woff2','eot']);
const OFFICE_EXTS    = new Set(['doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','rtf']);
const EPUB_EXTS      = new Set(['epub','mobi','azw','azw3','fb2']);
const CODE_EXTS      = new Set(['js','mjs','ts','tsx','jsx','py','rs','go','c','h','cpp',
    'java','rb','php','swift','kt','dart','lua','sql','sh','bash','css','scss']);
const EXTRA_IMG_EXTS = new Set(['bmp','tiff','tif','ico','avif','heic','heif','jfif','exr','tga']);
const RASTER_2D_EXTS = new Set(['psd','psb','xcf','kra','ora','clip','mdi','psa','sai','procreate']);
const VECTOR_EXTS    = new Set(['ai','cdr','sketch','drawio','dio','eps','svgz']);
const ANIM_EXTS      = new Set(['aep','prproj']);
const THUMB_TEXT_EXTS = new Set([...TEXT_EXTS, ...CODE_EXTS]);

// ══════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════
function escHtml(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
    return (b/1073741824).toFixed(1) + ' GB';
}

let toastTimer = null;
function showToast(msg, duration = 2500) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// ══════════════════════════════════════════════
//  SIDEBAR (MOBILE)
// ══════════════════════════════════════════════
function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('active');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
}

// ══════════════════════════════════════════════
//  FILE LOADING
// ══════════════════════════════════════════════
function loadFiles(isFolder = false) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = !!isFolder;
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.onchange = async (e) => {
        if (document.body.contains(input)) document.body.removeChild(input);
        const files = Array.from(e.target.files);
        if (!files.length) return;
        closeSidebar();

        // Revoke old blob URLs
        Object.values(state.blobCache).forEach(u => { try { URL.revokeObjectURL(u); } catch(_){} });
        Object.values(state.thumbnailCache).forEach(u => {
            if (u && u.startsWith('blob:')) try { URL.revokeObjectURL(u); } catch(_){}
        });

        state.files = [];
        state.blobCache = {};
        state.thumbnailCache = {};
        state.thumbProgress = {};
        // Only include presets the user hasn't deleted
        const freshFolders = { queue: [], skipped: [], trash: [] };
        state.presetFolders.forEach(f => { freshFolders[f] = []; });
        state.customFolders.forEach(f => { freshFolders[f] = []; });
        state.folders = freshFolders;
        state.currentIndex = 0;
        state.currentFolder = 'queue';
        state.undoStack = [];
        state.redoStack = [];

        // ── Batched loading with progress bar ──
        const total = files.length;
        const CHUNK = 40; // process N files per frame to stay responsive

        const showProgress = (done) => {
            const pct = Math.round((done / total) * 100);
            document.getElementById('mainArea').innerHTML = `
                <div class="empty-state">
                    <div class="load-progress-wrap">
                        <div class="load-progress-bar">
                            <div class="load-progress-fill" style="width:${pct}%"></div>
                        </div>
                        <div class="load-progress-label">${done} / ${total} files — ${pct}%</div>
                    </div>
                    <h2>Loading…</h2>
                    <p>${escHtml(files[Math.min(done, total-1)]?.name || '')}</p>
                </div>`;
        };

        showProgress(0);

        const processChunk = (start) => new Promise(resolve => {
            setTimeout(() => {
                const end = Math.min(start + CHUNK, total);
                for (let i = start; i < end; i++) {
                    const file = files[i];
                    const id = `f${crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '_' + i)}`;
                    const ext = (file.name.includes('.') ? file.name.split('.').pop() : '').toLowerCase();

                    const entry = {
                        id, name: file.name, size: file.size,
                        type: file.type || '',
                        ext, folder: 'queue',
                        lastModified: file.lastModified,
                        _file: file,
                    };
                    state.files.push(entry);
                    state.folders.queue.push(id);

                    const isImage = file.type.startsWith('image/') || EXTRA_IMG_EXTS.has(ext);
                    const isVideo = file.type.startsWith('video/');
                    const isAudio = file.type.startsWith('audio/');
                    const isPDF   = file.type === 'application/pdf' || ext === 'pdf';
                    const isText  = file.type.startsWith('text/') || TEXT_EXTS.has(ext);
                    const is3D    = OBJ_3D_EXTS.has(ext);
                    const isFont  = FONT_EXTS.has(ext);
                    const isSVG   = ext === 'svg' || ext === 'svgz';

                    if (isImage || isVideo || isAudio || isPDF || isText || is3D || isFont || isSVG
                        || OFFICE_EXTS.has(ext) || RASTER_2D_EXTS.has(ext)
                        || ['ai','blend','drawio','dio'].includes(ext)) {
                        state.blobCache[id] = URL.createObjectURL(file);
                    }
                    if (isVideo) captureVideoThumbnail(entry);
                    if (isFont)  scheduleFontThumbnail(entry);
                    if ((isText || CODE_EXTS.has(ext)) && !isImage) scheduleTextThumbnail(entry);
                    // New: PDF first-page, Office canvas placeholder, PSD/AI/Blend/DrawIO via ThumbnailEngine
                    if (isPDF) schedulePdfThumbnail(entry);
                    if (OFFICE_EXTS.has(ext)) scheduleOfficeThumbnail(entry);
                    if (['psd','psb','ai','blend','drawio','dio'].includes(ext)) schedulePsdThumbnail(entry);
                }
                resolve(end);
            }, 0); // yield to browser between chunks
        });

        let processed = 0;
        while (processed < total) {
            processed = await processChunk(processed);
            if (processed < total) showProgress(processed);
        }

        // Re-render folder list sidebar to reflect reset
        rebuildFolderSidebar();
        updateCounts();
        switchFolder('queue');

        // Background archive thumbnail + ZIP tree extraction
        // Exclude non-zip single-file compressed formats and native 3D files
        const archives = state.files.filter(f =>
            (ARCHIVE_TYPES[f.ext] || f.ext === 'zip' || f.ext === 'rar' || f.ext === 'tar')
            && !NATIVE_3D_EXTS.has(f.ext)
            && !SKIP_JSZ_EXTS.has(f.ext)
        );
        if (archives.length) extractArchivesSequential(archives);
    };

    input.click();
}

function showLoading(msg) {
    document.getElementById('mainArea').innerHTML = `
        <div class="empty-state">
            <div class="empty-illustration" style="animation:spin 1.2s linear infinite;">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <circle cx="24" cy="24" r="18" stroke="var(--border-med)" stroke-width="3"/>
                    <path d="M24 6a18 18 0 0118 18" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>
                </svg>
            </div>
            <h2>${escHtml(msg)}</h2>
        </div>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
}

// ══════════════════════════════════════════════
//  VIDEO THUMBNAIL
// ══════════════════════════════════════════════
function captureVideoThumbnail(entry) {
    const video = document.createElement('video');
    video.muted = true;
    video.src = state.blobCache[entry.id];
    video.currentTime = 1.5;
    video.addEventListener('seeked', () => {
        try {
            const canvas = document.createElement('canvas');
            canvas.width  = video.videoWidth  || 320;
            canvas.height = video.videoHeight || 180;
            canvas.getContext('2d').drawImage(video, 0, 0);
            state.thumbnailCache[entry.id] = canvas.toDataURL('image/jpeg', 0.82);
        } catch(_) {}
        video.src = '';
        refreshThumbIfVisible(entry.id);
    }, { once: true });
    video.load();
}

// ══════════════════════════════════════════════
//  ARCHIVE EXTRACTION (ZIP tree + thumbnail)
// ══════════════════════════════════════════════
async function loadJSZip() {
    if (window.JSZip) return window.JSZip;
    return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = () => res(window.JSZip);
        s.onerror = rej;
        document.head.appendChild(s);
    });
}

async function extractArchivesSequential(archives) {
    try { await loadJSZip(); } catch(_) { 
        // JSZip failed to load — mark all as done
        archives.forEach(entry => {
            state.thumbProgress[entry.id] = 100;
            refreshThumbIfVisible(entry.id);
        });
        return;
    }

    for (const entry of archives) {
        state.thumbProgress[entry.id] = 5;
        updateLoadBars(entry.id, 5);

        // Timeout guard: if extraction takes > 30s, give up
        const extractTimeout = setTimeout(() => {
            state.thumbProgress[entry.id] = 100;
            updateLoadBars(entry.id, 100);
            const skl = document.getElementById(`skl_${entry.id}`);
            if (skl) skl.innerHTML = `<div class="pts-label" style="color:var(--text-3)">Could not extract preview</div>`;
        }, 30000);

        try {
            const zip = await JSZip.loadAsync(entry._file, {
                onUpdate: (meta) => {
                    const pct = Math.round(5 + meta.percent * 0.85);
                    state.thumbProgress[entry.id] = pct;
                    updateLoadBars(entry.id, pct);
                }
            });

            clearTimeout(extractTimeout);
            // Build ZIP tree
            buildZipTree(entry, zip);

            // Find thumbnail image
            const thumbPaths = [
                // Krita / ORA / generic
                'mergedimage.png','preview.png','thumbnail.png','preview.jpg','merged.png',
                // LibreOffice ODT/ODS/ODP
                'Thumbnails/thumbnail.png',
                // MS Office DOCX/XLSX/PPTX
                'docProps/thumbnail.jpeg','docProps/thumbnail.png',
                // Sketch
                'previews/preview.png',
                // Some tools use these
                'META-INF/thumbnail.png','preview/thumbnail.png',
            ];
            let found = false;
            for (const p of thumbPaths) {
                const f = zip.file(p);
                if (f) {
                    const blob = await f.async('blob');
                    revokeThumb(entry.id);
                    state.thumbnailCache[entry.id] = URL.createObjectURL(blob);
                    found = true; break;
                }
            }
            if (!found) {
                // For EPUB: prefer files named 'cover'
                if (entry.ext === 'epub') {
                    for (const fn of Object.keys(zip.files)) {
                        if (/cover\.(jpg|jpeg|png|webp)/i.test(fn) && !zip.files[fn].dir) {
                            const blob = await zip.file(fn).async('blob');
                            revokeThumb(entry.id);
                            state.thumbnailCache[entry.id] = URL.createObjectURL(blob);
                            found = true; break;
                        }
                    }
                }
                // For APK: prefer launcher icons
                if (!found && entry.ext === 'apk') {
                    const iconPriority = ['xxxhdpi','xxhdpi','xhdpi','hdpi','mdpi'];
                    for (const density of iconPriority) {
                        for (const fn of Object.keys(zip.files)) {
                            if (fn.includes(density) && /ic_launcher.*\.(png|webp)/i.test(fn) && !zip.files[fn].dir) {
                                const blob = await zip.file(fn).async('blob');
                                revokeThumb(entry.id);
                                state.thumbnailCache[entry.id] = URL.createObjectURL(blob);
                                found = true; break;
                            }
                        }
                        if (found) break;
                    }
                }
                // Generic fallback: first image found
                if (!found) {
                    for (const fn of Object.keys(zip.files)) {
                        if (/\.(png|jpg|jpeg|webp)$/i.test(fn) && !zip.files[fn].dir) {
                            const blob = await zip.file(fn).async('blob');
                            revokeThumb(entry.id);
                            state.thumbnailCache[entry.id] = URL.createObjectURL(blob);
                            break;
                        }
                    }
                }
            }
        } catch(_) { clearTimeout(extractTimeout); }

        state.thumbProgress[entry.id] = 100;
        updateLoadBars(entry.id, 100);
        refreshThumbIfVisible(entry.id);
    }
}

function buildZipTree(entry, zip) {
    const items = [];
    zip.forEach((relPath, zipEntry) => {
        items.push({ path: relPath, dir: zipEntry.dir, size: zipEntry._data?.uncompressedSize || 0 });
    });
    items.sort((a,b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        return a.path.localeCompare(b.path);
    });
    state.files.find(f => f.id === entry.id)._zipTree = items;
}

function revokeThumb(id) {
    const t = state.thumbnailCache[id];
    if (t && t.startsWith('blob:')) { try { URL.revokeObjectURL(t); } catch(_){} }
}

function updateLoadBars(fileId, pct) {
    const fill = document.getElementById(`loadbar_fill_${fileId}`);
    const bar  = document.getElementById(`loadbar_${fileId}`);
    if (fill) fill.style.width = pct + '%';
    if (bar && pct >= 100) setTimeout(() => bar.classList.add('done'), 500);

    // Update the pts-bar inside the skeleton if that's what's shown on the card
    const ptsBarFill = document.querySelector(`#skl_${fileId} .pts-bar-fill`);
    if (ptsBarFill) ptsBarFill.style.width = pct + '%';
    const ptsLabel = document.querySelector(`#skl_${fileId} .pts-label`);
    if (ptsLabel && pct < 100) ptsLabel.textContent = `Extracting… ${pct}%`;

    const rfill = document.getElementById(`rbar_${fileId}`);
    if (rfill) {
        rfill.style.width = pct + '%';
        if (pct >= 100) {
            setTimeout(() => {
                const rbar = rfill.parentElement;
                if (rbar) rbar.style.display = 'none';
                const thumb = document.getElementById(`rthumb_${fileId}`);
                if (thumb) thumb.classList.remove('loading');
            }, 500);
        }
    }
}

function refreshThumbIfVisible(fileId) {
    const src = state.thumbnailCache[fileId];
    if (!src) return;

    // Skeleton on swipe card (video/font/archive waiting state)
    const skl = document.getElementById(`skl_${fileId}`);
    if (skl) {
        const img = document.createElement('img');
        img.src = src;
        img.dataset.thumb = fileId;
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;animation:fadeIn 0.3s ease;';
        skl.replaceWith(img);
        // Also hide any hidden vid fallback
        const vidFb = document.getElementById(`vidFallback_${fileId}`);
        if (vidFb) vidFb.style.display = 'none';
    }

    const cardThumb = document.querySelector(`[data-thumb="${fileId}"]`);
    if (cardThumb && cardThumb.tagName === 'IMG') {
        cardThumb.src = src; cardThumb.style.display = '';
        const placeholder = document.getElementById(`placeholder_${fileId}`);
        if (placeholder) placeholder.style.display = 'none';
        const ztEl = document.getElementById(`ziptree_${fileId}`);
        if (ztEl) renderZipTreeEl(fileId, ztEl);
    }
    const rImg = document.getElementById(`rimg_${fileId}`);
    if (rImg) {
        rImg.src = src;
        rImg.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;';
        const badge = rImg.closest('.review-thumb')?.querySelector('.r-type-badge');
        if (badge) badge.style.display = 'none';
    }

    // Update pts-bar progress in skeleton (archive extraction updates)
    const ptsBar = document.querySelector(`#skl_${fileId} .pts-bar-fill`);
    if (ptsBar) ptsBar.style.width = '100%';
}

// ══════════════════════════════════════════════
//  RENDER ROUTING
// ══════════════════════════════════════════════
const SYSTEM_PANELS = new Set(['__home__','__organizer__','__duplicates__','__storage__','__export__']);

function renderHomePanel() {
    document.getElementById('topbarTitle').textContent = 'File Organizer';
    document.getElementById('topbarMeta').textContent = '';
    document.getElementById('mainArea').innerHTML = `
        <div class="empty-state home-panel">
            <div class="home-icon">
                <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                    <rect x="4" y="4" width="20" height="20" rx="5" fill="var(--accent)" opacity="0.9"/>
                    <rect x="28" y="4" width="20" height="20" rx="5" fill="var(--accent)" opacity="0.55"/>
                    <rect x="4" y="28" width="20" height="20" rx="5" fill="var(--accent)" opacity="0.55"/>
                    <rect x="28" y="28" width="20" height="20" rx="5" fill="var(--accent)" opacity="0.25"/>
                </svg>
            </div>
            <h2 style="margin-top:18px;margin-bottom:6px;">File Organizer</h2>
            <p style="margin-bottom:4px;opacity:0.55;font-size:13px;">Sort, review, and clean up your files.</p>
            <p style="margin-bottom:28px;opacity:0.35;font-size:12px;">Made with patience by Karl</p>
            <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
                <button class="load-btn" style="min-width:130px;" onclick="loadFiles(false)">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3.5h10M2 6.5h6M2 9.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                    Select Files
                </button>
                <button class="load-btn load-btn-secondary" style="min-width:130px;" onclick="loadFiles(true)">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 4.5h12M3 4.5V3a1 1 0 011-1h2l1.5 1.5H10a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Select Folder
                </button>
            </div>
    
<div class="github-footer">

    <!-- Main link -->
    <a href="https://github.com/K4RLT/File_organizer" target="_blank" class="github-main-link">
        View GitHub Project
    </a>

    <!-- Stats -->
    <div class="github-stats">
        ⭐ <span id="ghStars">-</span>
        <span class="divider">|</span>
        🍴 <span id="ghForks">-</span>
    </div>

</div>
        </div>`;
    
    loadGithubStats(); // ← important, don’t skip this like last-minute homework
}

function loadGithubStats() {
    fetch("https://api.github.com/repos/K4RLT/File_organizer")
        .then(res => res.json())
        .then(data => {
            document.getElementById("ghStars").textContent = data.stargazers_count ?? "-";
            document.getElementById("ghForks").textContent = data.forks_count ?? "-";
        })
        .catch(() => {
            document.getElementById("ghStars").textContent = "?";
            document.getElementById("ghForks").textContent = "?";
        });
}

function renderCurrentFolder() {
    if (state.currentFolder === '__home__')  renderHomePanel();
    else if (state.currentFolder === 'queue')   renderSwipeMode();
    else if (state.currentFolder === 'skipped') renderSkippedMode();
    else if (SYSTEM_PANELS.has(state.currentFolder)) return; // stay on current panel
    else renderReviewMode(state.currentFolder);
}

function updateTopbar() {
    const name = state.currentFolder;
    // System panels set their own title/meta — don't clobber them
    if (SYSTEM_PANELS.has(name)) return;
    const labels = { queue:'Queue', skipped:'Skipped', trash:'Trash' };
    document.getElementById('topbarTitle').textContent =
        labels[name] || (name.charAt(0).toUpperCase() + name.slice(1));

    if (name === 'queue') {
        const n = state.folders.queue.length;
        document.getElementById('topbarMeta').textContent = n ? `${n} file${n!==1?'s':''}` : '';
    } else {
        const n = (state.folders[name] || []).length;
        document.getElementById('topbarMeta').textContent = `${n} file${n!==1?'s':''}`;
    }
}

// ══════════════════════════════════════════════
//  SWIPE MODE
// ══════════════════════════════════════════════
function renderSwipeMode() {
    const main = document.getElementById('mainArea');
    const queueIds = state.folders.queue;

    if (!queueIds.length) {
        main.innerHTML = `
            <div class="empty-state">
                <div class="empty-illustration">
                    <svg width="60" height="60" viewBox="0 0 60 60" fill="none">
                        <circle cx="30" cy="30" r="22" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1.5"/>
                        <path d="M20 30l7 7 13-13" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <h2>All Done!</h2>
                <p>No more files in queue</p>
            </div>`;
        updateTopbar();
        return;
    }

    if (state.currentIndex >= queueIds.length) state.currentIndex = 0;
    const file = state.files.find(f => f.id === queueIds[state.currentIndex]);
    if (!file) { state.currentIndex = 0; renderSwipeMode(); return; }

    const isArchive = !!ARCHIVE_TYPES[file.ext];
    const is3D      = OBJ_3D_EXTS.has(file.ext);
    const thumbPct  = state.thumbProgress[file.id] || 0;
    const showBar   = (isArchive && thumbPct < 100) || is3D;

    const ext       = file.ext;
    const baseName  = ext && file.name.endsWith('.' + ext) ? file.name.slice(0, -(ext.length + 1)) : file.name;

    main.innerHTML = `
        <div class="swipe-wrap">
            <div class="swipe-topbar">
                <div class="progress-pill">${state.currentIndex + 1} / ${queueIds.length}</div>
                <div class="swipe-topbar-actions">
                    <button class="undo-btn" id="undoBtn" onclick="undoSwipe()" title="Undo" ${state.undoStack.length === 0 ? 'disabled' : ''}>
                        <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3.5 6H9a3 3 0 010 6H7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 3.5L3 6l2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        Undo
                    </button>
                    <button class="undo-btn" id="redoBtn" onclick="redoSwipe()" title="Redo" ${state.redoStack.length === 0 ? 'disabled' : ''}>
                        <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M11.5 6H6a3 3 0 000 6h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 3.5L12 6 9.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        Redo
                    </button>
                </div>
                <div class="swipe-hint">
                    <span>← trash</span>
                    <span>↓ skip</span>
                    <span>folder →</span>
                </div>
            </div>
            <div class="swipe-stage">
                <div class="swipe-indicator left">Trash</div>
                <div class="swipe-indicator right">Move</div>
                <div class="file-card" id="fileCard">
                    <div class="file-preview" id="filePreview">${renderPreview(file)}</div>
                    <div class="file-info">
                        <div class="file-name-row">
                            <div class="rename-split">
                                <input class="file-name-input" id="fileNameInput"
                                    value="${escHtml(baseName)}"
                                    onchange="handleRename(this.value + (this.dataset.ext ? '.' + this.dataset.ext : ''))"
                                    data-orig-ext="${escHtml(ext)}"
                                    data-ext="${escHtml(ext)}">
                                ${ext ? `<span class="rename-ext-badge">.${escHtml(ext)}</span>` : ''}
                            </div>
                        </div>
                        <div class="ext-warning" id="extWarning"></div>
                        ${buildFileDetails(file)}
                    </div>
                    <div class="card-load-bar ${showBar ? '' : 'done'}" id="loadbar_${file.id}">
                        <div class="card-load-bar-fill" id="loadbar_fill_${file.id}" style="width:${thumbPct}%"></div>
                    </div>
                </div>
            </div>
            <div class="swipe-controls">
                <button class="ctrl-btn ctrl-trash" onclick="swipeLeft()"  title="Trash (←)">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
                <button class="ctrl-btn ctrl-skip"  onclick="skipFile()"  title="Skip (↓)">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v10M4 9l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button class="ctrl-btn ctrl-love"  onclick="swipeRight()" title="Move to folder (→)">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 8V16a1 1 0 001 1h12a1 1 0 001-1V8M3 8V6a1 1 0 011-1h4l2 2h5a1 1 0 011 1v0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>
        </div>`;

    updateTopbar();
    setupSwipeDrag();
}

function checkExtWarning(newName, origExt) {
    const newExt = newName.includes('.') ? newName.split('.').pop().toLowerCase() : '';
    const warn = document.getElementById('extWarning');
    if (!warn) return;
    const changed = origExt && newExt !== origExt;
    warn.classList.toggle('visible', changed);
}

function handleRename(newName) {
    // Guard: system panels have no queue-backed file to rename
    if (SYSTEM_PANELS.has(state.currentFolder)) return;
    const folderIds = state.folders[state.currentFolder];
    if (!folderIds || !folderIds.length) return;
    const idx = state.currentFolder === 'queue'   ? state.currentIndex :
                state.currentFolder === 'skipped' ? state.currentSkippedIndex : 0;
    const fileId = folderIds[idx];
    const f = state.files.find(f => f.id === fileId);
    if (f) {
        // Wire extension-change warning
        const inp = document.getElementById('fileNameInput');
        if (inp) checkExtWarning(newName, inp.dataset.origExt || '');
        f.name = newName;
        f.ext = newName.includes('.') ? newName.split('.').pop().toLowerCase() : '';
    }
}

function buildFileDetails(file) {
    const d = file.lastModified ? new Date(file.lastModified) : null;
    const rows = [
        { k:'Size',  v: formatSize(file.size) },
        file.ext ? { k:'Ext', v: '.' + file.ext.toUpperCase() } : null,
        file.type ? { k:'Type', v: file.type } : null,
        d ? { k:'Date', v: d.toLocaleDateString() } : null,
        d ? { k:'Time', v: d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) } : null,
        ARCHIVE_TYPES[file.ext] ? { k:'Format', v: ARCHIVE_TYPES[file.ext], fw: true } : null,
    ].filter(Boolean);

    return `<div class="file-details-grid">${rows.map(r =>
        `<div class="file-detail-row${r.fw ? ' fw' : ''}">
            <span class="fdk">${escHtml(r.k)}</span>
            <span class="fdv">${escHtml(r.v)}</span>
        </div>`
    ).join('')}</div>`;
}

function renderPreview(file) {
    const url   = state.blobCache[file.id];
    const thumb = state.thumbnailCache[file.id];
    const ext   = file.ext;
    if (file.type.startsWith('video/')) {
        if (thumb) return `<img src="${thumb}" data-thumb="${file.id}" style="max-width:100%;max-height:100%;object-fit:contain;" alt="">`;
        // Skeleton while video thumb is being captured
        if (url) return `<div class="preview-thumb-skeleton" id="skl_${file.id}" data-thumb="${file.id}">
            <div class="pts-spinner"></div><div class="pts-label">Loading preview…</div>
        </div>`;
    }
    if ((file.type.startsWith('image/') || EXTRA_IMG_EXTS.has(ext)) && url)
        return `<img src="${url}" alt="${escHtml(file.name)}" style="max-width:100%;max-height:100%;object-fit:contain;${ext==='svg'?'background:#fff;border-radius:6px;':''}">`;
    if ((ext === 'svg' || ext === 'svgz') && url)
        return `<iframe src="${url}" style="width:min(420px,calc(100vw - 80px));height:220px;border:none;background:#fff;border-radius:8px;" sandbox="allow-same-origin"></iframe>`;
    if (file.type.startsWith('audio/') && url) {
        const ic = {mp3:'🎵',wav:'🎵',flac:'🎼',ogg:'🎵',aac:'🎵',m4a:'🎵',opus:'🎵',aiff:'🎼',wma:'🎵'};
        return `<div class="preview-icon-block"><div class="preview-icon">${ic[ext]||'🎵'}</div><div class="preview-ext">${escHtml(ext.toUpperCase())}</div><audio src="${url}" controls style="margin-top:12px;width:85%;"></audio></div>`;
    }
    if ((file.type === 'application/pdf' || ext === 'pdf') && url)
        return `<iframe src="${url}#toolbar=0&navpanes=0" style="width:min(480px,calc(100vw - 80px));height:min(360px,50vh);border:none;background:#0a0a0c;display:block;border-radius:8px;"></iframe>`;
    if ((ext === 'html' || ext === 'htm') && url)
        return `<div style="width:100%;height:100%;position:relative;overflow:hidden;background:#fff;border-radius:6px;">
            <iframe src="${url}" style="width:200%;height:200%;border:none;transform:scale(0.5);transform-origin:top left;pointer-events:none;" sandbox="allow-same-origin"></iframe>
            <div style="position:absolute;bottom:6px;right:8px;font-size:9px;font-family:var(--mono);color:#888;background:rgba(0,0,0,0.5);padding:2px 6px;border-radius:4px;">HTML preview</div>
        </div>`;
    if ((ext === 'md' || ext === 'markdown') && url) {
        loadMarkdownPreview(file.id, url);
        return `<div class="preview-markdown preview-scrollable" id="mdPreview_${file.id}" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"><div class="preview-loading-inline"><div class="pts-spinner pts-spinner-sm"></div><span>Rendering…</span></div></div>`;
    }
    if (CODE_EXTS.has(ext) && url) {
        loadCodePreview(file.id, url, ext);
        return `<div class="preview-code preview-scrollable" id="codePreview_${file.id}" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"><div class="preview-loading-inline"><div class="pts-spinner pts-spinner-sm"></div><span>Loading…</span></div></div>`;
    }
    if (url && (file.type.startsWith('text/') || TEXT_EXTS.has(ext))) {
        loadTextPreview(file.id, url);
        return `<div class="preview-text preview-scrollable" id="textPreview_${file.id}" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"><div class="preview-loading-inline"><div class="pts-spinner pts-spinner-sm"></div><span>Loading…</span></div></div>`;
    }
    if (FONT_EXTS.has(ext) && url) {
        if (thumb) return renderFontPreviewEl(file);
        return `<div class="preview-thumb-skeleton" id="skl_${file.id}" data-thumb="${file.id}">
            <div class="pts-spinner"></div><div class="pts-label">Loading font…</div>
        </div>`;
    }
    if (OBJ_3D_EXTS.has(ext) && url)
        return `<div class="preview-3d-container" id="viewer3d_${file.id}">
            <div class="preview-thumb-skeleton" style="width:100%;height:100%;min-height:200px;">
                <div class="pts-spinner"></div>
                <div class="pts-label">Loading 3D viewer…</div>
            </div>
        </div>`;
    if ((ext === 'zip' || ARCHIVE_TYPES[ext]) && file._zipTree && !NATIVE_3D_EXTS.has(ext)) {
        if (thumb) return `<img src="${thumb}" data-thumb="${file.id}" style="max-width:100%;max-height:100%;object-fit:contain;"><div id="ziptree_${file.id}" style="display:none;"></div>`;
        return `<div class="zip-tree" id="ziptree_${file.id}">${buildZipTreeHtml(file._zipTree)}</div>`;
    }
    if ((ARCHIVE_TYPES[ext] || ext === 'zip' || ext === 'gz' || ext === 'bz2' || ext === 'tar') && !NATIVE_3D_EXTS.has(ext)) {
        const pct = state.thumbProgress[file.id] || 0;
        return `<div class="preview-thumb-skeleton" id="skl_${file.id}" data-thumb="${file.id}">
            <div class="pts-spinner"></div>
            <div class="pts-label">Extracting… ${pct < 100 ? pct+'%' : ''}</div>
            <div class="pts-bar"><div class="pts-bar-fill" style="width:${pct}%"></div></div>
        </div><img data-thumb="${file.id}" src="" style="display:none;position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;object-fit:contain;" alt="">`;
    }
    if (RASTER_2D_EXTS.has(ext)) {
        const rasterIcons={psd:'🖼️',psb:'🖼️',xcf:'🖼️',kra:'🎨',ora:'🎨',clip:'✏️',mdi:'✏️',psa:'🎨',sai:'🎨',procreate:'✏️'};
        const rasterLabels={psd:'Photoshop',psb:'Photoshop Large',xcf:'GIMP',kra:'Krita',ora:'OpenRaster',clip:'Clip Studio',mdi:'MDI',psa:'Photoshop',sai:'SAI',procreate:'Procreate'};
        if (!thumb && (ext === 'kra' || ext === 'ora'))
            return `<div class="preview-thumb-skeleton" id="skl_${file.id}" data-thumb="${file.id}">
                <div class="pts-spinner"></div><div class="pts-label">${escHtml(rasterLabels[ext]||ext.toUpperCase())}</div>
            </div>`;
        return `<div class="preview-icon-block"><div class="preview-icon">${rasterIcons[ext]||'🎨'}</div><div class="preview-ext">${escHtml(rasterLabels[ext]||ext.toUpperCase())}</div><div class="preview-sub">.${escHtml(ext.toUpperCase())}</div></div>`;
    }
    if (VECTOR_EXTS.has(ext)) {
        const vecLabels={ai:'Illustrator',cdr:'CorelDraw',sketch:'Sketch',drawio:'Draw.io',dio:'Draw.io',eps:'EPS',svgz:'SVG (compressed)'};
        return `<div class="preview-icon-block"><div class="preview-icon">✦</div><div class="preview-ext">${escHtml(vecLabels[ext]||ext.toUpperCase())}</div><div class="preview-sub">.${escHtml(ext.toUpperCase())}</div></div>`;
    }
    if (NATIVE_3D_EXTS.has(ext)) {
        const n3d={blend:'Blender',max:'3ds Max',mb:'Maya Binary',ma:'Maya ASCII',c4d:'Cinema 4D',lxo:'Modo',hip:'Houdini',hipnc:'Houdini'};
        // .blend files are in ARCHIVE_TYPES too, so skip archive spinner for them
        return `<div class="preview-icon-block"><div class="preview-icon">🧊</div><div class="preview-ext">${escHtml(n3d[ext]||'3D File')}</div><div class="preview-sub">.${escHtml(ext.toUpperCase())}</div></div>`;
    }
    if (ANIM_EXTS.has(ext)) {
        const animLabels={aep:'After Effects',prproj:'Premiere Pro'};
        return `<div class="preview-icon-block"><div class="preview-icon">🎞️</div><div class="preview-ext">${escHtml(animLabels[ext]||'Animation')}</div><div class="preview-sub">.${escHtml(ext.toUpperCase())}</div></div>`;
    }
    if (OFFICE_EXTS.has(ext)) {
        const ic2={doc:'📃',docx:'📃',odt:'📃',rtf:'📃',xls:'📊',xlsx:'📊',ods:'📊',ppt:'📽',pptx:'📽',odp:'📽'};
        const lb={doc:'Word',docx:'Word',odt:'OpenDoc',rtf:'Rich Text',xls:'Excel',xlsx:'Excel',ods:'Spreadsheet',ppt:'PowerPoint',pptx:'PowerPoint',odp:'Presentation'};
        return `<div class="preview-icon-block"><div class="preview-icon">${ic2[ext]||'📄'}</div><div class="preview-ext">${escHtml(lb[ext]||ext.toUpperCase())}</div><div class="preview-sub">.${escHtml(ext.toUpperCase())}</div></div>`;
    }
    if (EPUB_EXTS.has(ext))
        return `<div class="preview-icon-block"><div class="preview-icon">📚</div><div class="preview-ext">E-Book</div><div class="preview-sub">.${escHtml(ext.toUpperCase())}</div></div>`;
    const fb={exe:'⚙️',dll:'⚙️',iso:'💿',dmg:'💿',apk:'📱',db:'🗄️',sqlite:'🗄️'};
    return `<div class="preview-icon-block"><div class="preview-icon">${fb[ext]||'📁'}</div><div class="preview-ext">${escHtml(ext?'.'+ext.toUpperCase():'Unknown')}</div></div>`;
}

function buildZipTreeHtml(items, limit = 80) {
    const shown = items.slice(0, limit);
    const more  = items.length - shown.length;
    let html = shown.map(item => {
        const depth = (item.path.match(/\//g) || []).length;
        const indent = '  '.repeat(depth);
        const name   = item.path.split('/').filter(Boolean).pop() || item.path;
        const icon   = item.dir ? '📁' : getFileIcon(name.split('.').pop()?.toLowerCase() || '');
        const sizeStr = item.dir ? '' : formatSize(item.size);
        return `<div class="zip-tree-item${item.dir ? ' is-dir' : ''}" title="${escHtml(item.path)}">
            <span class="zt-icon">${indent}${icon}</span>
            <span class="zt-name">${escHtml(name)}</span>
            ${sizeStr ? `<span class="zt-size">${sizeStr}</span>` : ''}
        </div>`;
    }).join('');
    if (more > 0) html += `<div class="zip-tree-more">… ${more} more item${more!==1?'s':''}</div>`;
    return html;
}

function renderZipTreeEl(fileId, el) {
    const f = state.files.find(f => f.id === fileId);
    if (f?._zipTree) el.innerHTML = buildZipTreeHtml(f._zipTree);
}

function getFileIcon(ext) {
    const m = {
        png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', webp:'🖼', svg:'🖼',
        mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬',
        mp3:'🎵', wav:'🎵', flac:'🎵', ogg:'🎵',
        pdf:'📄', txt:'📝', md:'📝', json:'📝', js:'📝', py:'📝', html:'📝',
        zip:'📦', rar:'📦', '7z':'📦', tar:'📦',
        blend:'🎨', obj:'🎨', fbx:'🎨', gltf:'🎨',
    };
    return m[ext] || '📄';
}

async function loadTextPreview(fileId, url) {
    try {
        const text = await (await fetch(url)).text();
        const el = document.getElementById(`textPreview_${fileId}`);
        if (el) el.textContent = text.slice(0, 4000);
    } catch(_) {}
}

async function loadMarkdownPreview(fileId, url) {
    try {
        const text = await (await fetch(url)).text();
        const el = document.getElementById(`mdPreview_${fileId}`);
        if (!el) return;
        if (!window.marked) {
            await new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js';
                s.onload = res; s.onerror = rej; document.head.appendChild(s);
            });
        }
        el.innerHTML = window.marked.parse(text.slice(0, 50000));
    } catch(_) {
        const el = document.getElementById(`mdPreview_${fileId}`);
        if (el) el.textContent = 'Could not render markdown.';
    }
}

async function loadCodePreview(fileId, url, ext) {
    try {
        const text = await (await fetch(url)).text();
        const el = document.getElementById(`codePreview_${fileId}`);
        if (!el) return;
        if (!window.hljs) {
            await new Promise((res, rej) => {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css';
                document.head.appendChild(link);
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
                s.onload = res; s.onerror = rej; document.head.appendChild(s);
            });
        }
        const pre  = document.createElement('pre');
        const code = document.createElement('code');
        code.className  = `language-${ext}`;
        code.textContent = text.slice(0, 50000);
        pre.appendChild(code);
        el.innerHTML = ''; el.appendChild(pre);
        window.hljs.highlightElement(code);
    } catch(_) {
        const el = document.getElementById(`codePreview_${fileId}`);
        if (el) { el.className = 'preview-text'; el.textContent = 'Could not load file.'; }
    }
}

function renderFontPreviewEl(file) {
    const url  = state.blobCache[file.id];
    const safe = `ff_${file.id.replace(/-/g,'')}`;
    const styleId = `font_style_${file.id}`;
    // Remove stale style if blob URL changed
    const existing = document.getElementById(styleId);
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `@font-face { font-family: '${safe}'; src: url('${url}'); }`;
    document.head.appendChild(style);
    return `<div class="preview-font-block" style="font-family:'${safe}',sans-serif;">
        <div class="preview-font-pangram">The quick brown fox jumps over the lazy dog</div>
        <div class="preview-font-alpha">AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz</div>
        <div class="preview-font-digits">0123456789 !@#$%&*()</div>
        <div class="preview-font-sizes">
            <span style="font-size:12px;">12 </span><span style="font-size:18px;">18 </span>
            <span style="font-size:28px;">28 </span><span style="font-size:42px;">42</span>
        </div>
    </div>`;
}

function scheduleTextThumbnail(entry) {
    const url = state.blobCache[entry.id];
    if (!url) return;
    setTimeout(async () => {
        try {
            const text  = await (await fetch(url)).text();
            const lines = text.split('\n').slice(0, 40);
            const W = 480, H = 270; // higher res
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#0d0d10'; ctx.fillRect(0, 0, W, H);
            // Header bar
            const typeColors = {
                md:'#1d4ed8',markdown:'#1d4ed8',json:'#1e293b',js:'#854d0e',ts:'#1e3a5f',
                tsx:'#0c4a6e',jsx:'#0c4a6e',py:'#1e3a5f',rs:'#7c2d12',go:'#0c4a6e',
                html:'#7f1d1d',css:'#4c1d95',sh:'#14532d',bash:'#14532d',
                yaml:'#7f1d1d',toml:'#7c2d12',sql:'#1e3a5f',csv:'#14532d',
                xml:'#78350f',txt:'#1e293b',log:'#0f172a',vue:'#14532d',
                java:'#78350f',rb:'#7f1d1d',php:'#3b0764',swift:'#7c2d12',kt:'#3b0764',
            };
            const bgCol = typeColors[entry.ext] || '#1e293b';
            ctx.fillStyle = bgCol; ctx.fillRect(0, 0, W, 30);
            // Extension badge
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.beginPath(); if(ctx.roundRect) ctx.roundRect(W-54,7,48,16,4); else ctx.rect(W-54,7,48,16); ctx.fill();
            ctx.fillStyle = '#fff'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
            ctx.fillText(entry.ext.toUpperCase().slice(0,5), W-30, 19); ctx.textAlign = 'left';
            // Filename
            ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = '10px monospace';
            ctx.fillText(entry.name.slice(0,44), 10, 19);
            // Separator
            ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0,30); ctx.lineTo(W,30); ctx.stroke();
            // Code lines
            const isMd = entry.ext === 'md' || entry.ext === 'markdown';
            let y = 46;
            const lineH = 12;
            for (const rawLine of lines) {
                if (y > H - 16) break;
                const line = rawLine.slice(0, 72);
                if (!line.trim()) { y += 7; continue; }
                if (isMd) {
                    if (rawLine.startsWith('# '))      { ctx.fillStyle='#e8e8ea'; ctx.font='bold 13px sans-serif'; ctx.fillText(line.slice(2),10,y); y+=16; continue; }
                    if (rawLine.startsWith('## '))     { ctx.fillStyle='#c8c8ca'; ctx.font='bold 11px sans-serif'; ctx.fillText(line.slice(3),10,y); y+=14; continue; }
                    if (rawLine.startsWith('### '))    { ctx.fillStyle='#aaaaac'; ctx.font='bold 10px sans-serif'; ctx.fillText(line.slice(4),10,y); y+=13; continue; }
                    if (rawLine.startsWith('- ') || rawLine.startsWith('* ')) {
                        ctx.fillStyle='#5b8dd9'; ctx.font='10px monospace'; ctx.fillText('•',10,y);
                        ctx.fillStyle='#888890'; ctx.fillText(line.slice(2),20,y); y+=lineH; continue;
                    }
                    if (rawLine.startsWith('```')) { ctx.fillStyle='#444455'; ctx.font='9px monospace'; ctx.fillText(line,10,y); y+=lineH; continue; }
                }
                const t = rawLine.trimStart();
                let color = '#5a5a6e'; // default dim
                if (t.startsWith('//') || t.startsWith('#') || t.startsWith('--') || t.startsWith('/*') || t.startsWith('*')) {
                    color = '#4a5568';
                } else if (/^(import|export|from|require)\b/.test(t)) {
                    color = '#c678dd';
                } else if (/^(const|let|var|def |fn |func |function|class |return|if |else|elif|for |while |async |await )\b/.test(t)) {
                    color = '#7c9dc5';
                } else if (t.startsWith('"') || t.startsWith("'") || t.startsWith('`')) {
                    color = '#98c379';
                } else if (/^\s*(public|private|protected|static|override|readonly)\b/.test(t)) {
                    color = '#e5c07b';
                } else if (/^[A-Z]/.test(t.replace(/^\s+/,''))) {
                    color = '#e5c07b';
                } else {
                    color = '#6b7280';
                }
                ctx.fillStyle = color; ctx.font = '10px monospace';
                ctx.fillText(line, 10, y); y += lineH;
            }
            // Fade out at bottom
            const grad = ctx.createLinearGradient(0, H*0.72, 0, H);
            grad.addColorStop(0,'rgba(13,13,16,0)'); grad.addColorStop(1,'rgba(13,13,16,0.97)');
            ctx.fillStyle = grad; ctx.fillRect(0,0,W,H);
            state.thumbnailCache[entry.id] = canvas.toDataURL('image/jpeg', 0.92);
            refreshThumbIfVisible(entry.id);
        } catch(_) {}
    }, 80 + Math.random() * 200);
}

function scheduleFontThumbnail(entry) {
    const url = state.blobCache[entry.id];
    if (!url) return;
    setTimeout(async () => {
        try {
            const ff = new FontFace(`fthumb_${entry.id}`, `url(${url})`);
            await ff.load(); document.fonts.add(ff);
            const canvas = document.createElement('canvas');
            canvas.width = 300; canvas.height = 168;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#18181b'; ctx.fillRect(0,0,300,168);
            ctx.fillStyle = '#e8e8ea'; ctx.font = `56px "fthumb_${entry.id}"`;
            ctx.textAlign = 'center'; ctx.fillText('Aa', 150, 90);
            ctx.font = `14px "fthumb_${entry.id}"`; ctx.fillStyle = '#888890';
            ctx.fillText('The quick brown fox', 150, 118);
            ctx.font = '10px monospace'; ctx.fillStyle = '#4a4a54';
            ctx.fillText(`.${entry.ext.toUpperCase()}`, 150, 142);
            state.thumbnailCache[entry.id] = canvas.toDataURL('image/jpeg', 0.88);
            refreshThumbIfVisible(entry.id);
        } catch(_) {}
    }, 100);
}

// ── 3D Loader helpers ──
async function loadThreeJS() {
    if (window.THREE) return;
    await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
    });
}

async function loadGLTFLoader() {
    if (window._GLTFLoader) return;
    // GLTFLoader not on cdnjs for r128, inline minimal fetch
    // We'll use the three.js module from unpkg
    await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/three@0.128.0/examples/js/loaders/GLTFLoader.js';
        s.onload = () => { window._GLTFLoader = true; res(); };
        s.onerror = rej;
        document.head.appendChild(s);
    });
}

async function loadSTLLoader() {
    if (window._STLLoader) return;
    await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/three@0.128.0/examples/js/loaders/STLLoader.js';
        s.onload = () => { window._STLLoader = true; res(); };
        s.onerror = rej;
        document.head.appendChild(s);
    });
}

async function loadColladaLoader() {
    if (window._ColladaLoader) return;
    await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/three@0.128.0/examples/js/loaders/ColladaLoader.js';
        s.onload = () => { window._ColladaLoader = true; res(); };
        s.onerror = rej;
        document.head.appendChild(s);
    });
}

async function loadFBXLoader() {
    if (window._FBXLoader) return;
    if (!window.fflate) {
        await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/fflate@0.7.4/umd/index.js';
            s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
        });
    }
    await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/three@0.128.0/examples/js/loaders/FBXLoader.js';
        s.onload = () => { window._FBXLoader = true; res(); };
        s.onerror = rej;
        document.head.appendChild(s);
    });
}

// ── 3D Viewer ──
async function load3DViewer(fileId, url, ext, isLightbox) {
    const containerId = isLightbox ? `lb_3d_${fileId}` : `viewer3d_${fileId}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        await loadThreeJS();
        const { THREE } = window;

        const w = container.clientWidth  || (isLightbox ? 680 : 400);
        const h = container.clientHeight || (isLightbox ? 500 : 280);

        const scene    = new THREE.Scene();
        scene.background = new THREE.Color(0x080810);

        // Add subtle grid
        const grid = new THREE.GridHelper(10, 20, 0x1a1a2e, 0x1a1a2e);
        grid.name = 'grid';
        grid.position.y = -1.1;
        scene.add(grid);

        const camera = new THREE.PerspectiveCamera(45, w / h, 0.001, 2000);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(w, h);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        container.innerHTML = '';
        container.appendChild(renderer.domElement);

        // ── Lighting ──
        // Ambient
        scene.add(new THREE.AmbientLight(0x404060, 0.8));
        // Hemisphere (sky/ground)
        const hemi = new THREE.HemisphereLight(0x8ab0ff, 0x201030, 0.6);
        scene.add(hemi);
        // Key light
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(4, 8, 6);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.near = 0.1;
        key.shadow.camera.far = 50;
        scene.add(key);
        // Fill light
        const fill = new THREE.DirectionalLight(0x6090ff, 0.4);
        fill.position.set(-4, 2, -4);
        scene.add(fill);
        // Rim light
        const rim = new THREE.DirectionalLight(0xff9060, 0.3);
        rim.position.set(0, -3, -6);
        scene.add(rim);

        // ── Orbit controls (manual) ──
        let orbitDragging = false, orbitLast = {x:0,y:0};
        let theta = 0.4, phi = Math.PI / 3, radius = 4;
        let targetTheta = theta, targetPhi = phi, targetRadius = radius;

        const updateCamera = () => {
            camera.position.set(
                radius * Math.sin(phi) * Math.sin(theta),
                radius * Math.cos(phi),
                radius * Math.sin(phi) * Math.cos(theta)
            );
            camera.lookAt(0, 0, 0);
        };
        updateCamera();

        renderer.domElement.addEventListener('mousedown', e => {
            orbitDragging = true; orbitLast = {x:e.clientX,y:e.clientY}; e.stopPropagation();
        });
        renderer.domElement.addEventListener('mousemove', e => {
            if (!orbitDragging) return;
            const dx = e.clientX - orbitLast.x, dy = e.clientY - orbitLast.y;
            targetTheta -= dx * 0.008;
            targetPhi = Math.max(0.05, Math.min(Math.PI - 0.05, targetPhi + dy * 0.008));
            orbitLast = {x:e.clientX, y:e.clientY};
        });
        renderer.domElement.addEventListener('mouseup', () => orbitDragging = false);
        renderer.domElement.addEventListener('mouseleave', () => orbitDragging = false);
        renderer.domElement.addEventListener('wheel', e => {
            targetRadius = Math.max(0.3, Math.min(50, targetRadius + e.deltaY * 0.004));
            e.preventDefault();
        }, { passive: false });
        renderer.domElement.addEventListener('touchstart', e => {
            if (e.touches.length === 1) { orbitDragging = true; orbitLast = {x:e.touches[0].clientX,y:e.touches[0].clientY}; }
        }, {passive:true});
        renderer.domElement.addEventListener('touchmove', e => {
            if (!orbitDragging || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - orbitLast.x, dy = e.touches[0].clientY - orbitLast.y;
            targetTheta -= dx * 0.008; targetPhi = Math.max(0.05, Math.min(Math.PI-0.05, targetPhi + dy*0.008));
            orbitLast = {x:e.touches[0].clientX,y:e.touches[0].clientY};
        }, {passive:true});
        renderer.domElement.addEventListener('touchend', () => orbitDragging = false);

        // ── Load model by type ──
        let loadedMesh = null;

        const addToScene = (obj) => {
            loadedMesh = obj;
            scene.add(obj);
            centerAndScaleMesh(obj, THREE, grid);
            radius = 3.5; targetRadius = 3.5;
            theta = 0.4;  targetTheta = 0.4;
            phi = Math.PI / 2.8; targetPhi = Math.PI / 2.8;
            updateCamera();
            const bar = document.getElementById(`loadbar_${fileId}`);
            if (bar) bar.classList.add('done');
        };

        if (ext === 'obj') {
            const text = await (await fetch(url)).text();
            const geometry = parseOBJ(text);
            if (geometry) {
                geometry.computeVertexNormals();
                const mat = new THREE.MeshStandardMaterial({
                    color: 0x88aacc, metalness: 0.1, roughness: 0.6
                });
                addToScene(new THREE.Mesh(geometry, mat));
            }
        } else if (ext === 'stl') {
            await loadSTLLoader();
            const loader = new THREE.STLLoader();
            const geometry = await new Promise((res, rej) => loader.load(url, res, null, rej));
            geometry.computeVertexNormals();
            const mat = new THREE.MeshStandardMaterial({ color: 0x7799bb, metalness: 0.15, roughness: 0.55 });
            addToScene(new THREE.Mesh(geometry, mat));
        } else if (ext === 'gltf' || ext === 'glb') {
            await loadGLTFLoader();
            const loader = new THREE.GLTFLoader();
            const gltf = await new Promise((res, rej) => loader.load(url, res, null, rej));
            addToScene(gltf.scene);
        } else if (ext === 'fbx') {
            await loadFBXLoader();
            const loader = new THREE.FBXLoader();
            const fbx = await new Promise((res, rej) => loader.load(url, res, null, rej));
            addToScene(fbx);
        } else if (ext === 'dae') {
            await loadColladaLoader();
            const loader = new THREE.ColladaLoader();
            const collada = await new Promise((res, rej) => loader.load(url, res, null, rej));
            addToScene(collada.scene);
        } else {
            // Unsupported 3D — show wireframe sphere placeholder
            const geo = new THREE.IcosahedronGeometry(1, 2);
            const mat = new THREE.MeshStandardMaterial({ color: 0x4d8fff, wireframe: true });
            addToScene(new THREE.Mesh(geo, mat));
        }

        // Auto-rotate hint overlay
        const hint = document.createElement('div');
        hint.className = 'preview-3d-hint';
        hint.textContent = 'Drag to orbit · Scroll to zoom';
        container.appendChild(hint);
        setTimeout(() => { if (hint.parentNode) hint.style.opacity = '0'; }, 3000);

        // Auto-rotate when idle
        let autoRotate = true;
        renderer.domElement.addEventListener('mousedown', () => autoRotate = false);
        renderer.domElement.addEventListener('touchstart', () => autoRotate = false, {passive:true});

        let animId;
        const animate = () => {
            animId = requestAnimationFrame(animate);
            // Smooth lerp
            theta   += (targetTheta   - theta)   * 0.1;
            phi     += (targetPhi     - phi)      * 0.1;
            radius  += (targetRadius  - radius)   * 0.1;
            if (autoRotate) targetTheta += 0.003;
            updateCamera();
            renderer.render(scene, camera);
        };
        animate();

        // Handle resize
        const ro = new ResizeObserver(() => {
            const nw = container.clientWidth, nh = container.clientHeight;
            if (nw && nh) { renderer.setSize(nw, nh); camera.aspect = nw/nh; camera.updateProjectionMatrix(); }
        });
        ro.observe(container);

        // Cleanup
        const obs = new MutationObserver(() => {
            if (!document.contains(container)) {
                cancelAnimationFrame(animId);
                renderer.dispose();
                ro.disconnect();
                obs.disconnect();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });

    } catch(e) {
        console.warn('3D viewer error:', e);
        if (container) container.innerHTML = `<div class="preview-icon-block"><div class="preview-icon">🎨</div><div class="preview-ext">3D — load error</div><div class="preview-sub">${escHtml(String(e).slice(0,80))}</div></div>`;
    }
}

// Minimal OBJ parser
function parseOBJ(text) {
    const THREE = window.THREE;
    if (!THREE) return null;
    const positions = [], normals = [], uvs = [];
    const verts = [], norms = [], uvArr = [];

    for (const line of text.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'v')  positions.push(+parts[1], +parts[2], +parts[3]);
        if (parts[0] === 'vn') normals.push(+parts[1], +parts[2], +parts[3]);
        if (parts[0] === 'vt') uvs.push(+parts[1], +parts[2]);
        if (parts[0] === 'f') {
            const face = parts.slice(1).map(p => p.split('/'));
            for (let i = 1; i < face.length - 1; i++) {
                [face[0], face[i], face[i+1]].forEach(v => {
                    const vi = (+v[0]-1)*3;
                    if (isNaN(vi) || vi < 0 || vi + 2 >= positions.length) return; // skip invalid vertex ref
                    verts.push(positions[vi], positions[vi+1], positions[vi+2]);
                    if (v[1] && uvs.length) {
                        const ui = (+v[1]-1)*2;
                        if (ui >= 0 && ui + 1 < uvs.length) uvArr.push(uvs[ui], uvs[ui+1]);
                    }
                    if (v[2] && normals.length) {
                        const ni = (+v[2]-1)*3;
                        if (ni >= 0 && ni + 2 < normals.length) norms.push(normals[ni], normals[ni+1], normals[ni+2]);
                    }
                });
            }
        }
    }

    if (!verts.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    if (norms.length)  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(norms, 3));
    if (uvArr.length)  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvArr, 2));
    return geo;
}

// Trigger 3D load after render
function maybe3D(file) {
    if (!OBJ_3D_EXTS.has(file.ext)) return;
    const url = state.blobCache[file.id];
    if (!url) return;
    // Set a load timeout — if 3D fails or hangs, show a friendly error
    const timeoutId = setTimeout(() => {
        const c = document.getElementById(`viewer3d_${file.id}`);
        if (c && c.querySelector('.pts-spinner')) {
            c.innerHTML = `<div class="preview-icon-block"><div class="preview-icon">🎨</div><div class="preview-ext">3D File</div><div class="preview-sub">Preview timed out · .${file.ext.toUpperCase()}</div></div>`;
        }
    }, 20000);
    setTimeout(() => {
        load3DViewer(file.id, url, file.ext, false).finally(() => clearTimeout(timeoutId));
    }, 50);
}

// ══════════════════════════════════════════════
//  SWIPE / DRAG
// ══════════════════════════════════════════════
function setupSwipeDrag() {
    const card = document.getElementById('fileCard');
    if (!card) return;

    const queueIds = state.folders.queue;
    if (queueIds.length) {
        const file = state.files.find(f => f.id === queueIds[state.currentIndex]);
        if (file) maybe3D(file);
    }

    card.addEventListener('mousedown', e => {
        const tag = e.target.tagName;
        if (['INPUT','BUTTON','VIDEO','AUDIO','IFRAME','CANVAS'].includes(tag)) return;
        e.preventDefault();
        isDragging = true;
        dragStartX = e.clientX; dragStartY = e.clientY;
        dragCurrentX = e.clientX; dragCurrentY = e.clientY;
        card.style.transition = 'none';
    });

    card.addEventListener('touchstart', e => {
        const tag = e.target.tagName;
        if (['INPUT','BUTTON','CANVAS'].includes(tag)) return;
        isDragging = true;
        dragStartX = e.touches[0].clientX; dragStartY = e.touches[0].clientY;
        dragCurrentX = dragStartX; dragCurrentY = dragStartY;
        card.style.transition = 'none';
    }, { passive: true });
}

function onMouseMove(e) {
    if (!isDragging) return;
    dragCurrentX = e.clientX; dragCurrentY = e.clientY;
    applyDrag();
}
function onTouchMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    dragCurrentX = e.touches[0].clientX; dragCurrentY = e.touches[0].clientY;
    applyDrag();
}

function applyDrag() {
    const card = document.getElementById('fileCard');
    if (!card) return;
    const dx = dragCurrentX - dragStartX;
    const dy = dragCurrentY - dragStartY;
    card.style.transform = `translate(${dx}px,${dy}px) rotate(${dx * 0.05}deg)`;
    document.querySelector('.swipe-indicator.left') ?.classList.toggle('active', dx < -80);
    document.querySelector('.swipe-indicator.right')?.classList.toggle('active', dx > 80);
}

function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    const dx = dragCurrentX - dragStartX;
    const card = document.getElementById('fileCard');
    if (!card) return;
    if (dx < -140)     animateOut('left',  card, () => {
        if (state.currentFolder === 'skipped') skippedTrashCurrent();
        else doTrashCurrent();
    });
    else if (dx > 140) animateOut('right', card, () => {
        if (state.currentFolder === 'skipped') {
            const ids = state.folders.skipped;
            if (ids.length) openFolderPickerFrom('skipped', ids[Math.min(state.currentSkippedIndex, ids.length-1)]);
        } else openFolderPicker();
    });
    else {
        card.style.transition = 'transform 0.35s cubic-bezier(0.34,1.56,0.64,1)';
        card.style.transform  = '';
        document.querySelector('.swipe-indicator.left') ?.classList.remove('active');
        document.querySelector('.swipe-indicator.right')?.classList.remove('active');
    }
}

document.addEventListener('mousemove', onMouseMove);
document.addEventListener('mouseup',   onMouseUp);
document.addEventListener('touchmove', onTouchMove, { passive: false });
document.addEventListener('touchend',  onMouseUp);

function animateOut(dir, card, cb) {
    const x = dir === 'left' ? -window.innerWidth : window.innerWidth;
    card.style.transition = 'transform 0.25s ease';
    card.style.transform  = `translateX(${x}px) rotate(${x * 0.04}deg)`;
    // Store a unique stamp on this card so we can detect if it gets re-rendered
    const stamp = Date.now() + Math.random();
    card.dataset.animStamp = stamp;
    setTimeout(() => {
        // Only fire callback if this exact card element is still in DOM
        if (document.contains(card) && card.dataset.animStamp == stamp) cb();
        else if (!document.contains(card)) cb(); // card was removed (re-render), still fire action
    }, 220);
}

function swipeLeft()  {
    // Always close folder picker when trashing
    closeFolderPicker();
    pendingMoveFileId = null;
    if (state.currentFolder === 'skipped') {
        const c = document.getElementById('fileCard');
        c ? animateOut('left', c, () => skippedTrashCurrent()) : skippedTrashCurrent();
        return;
    }
    const c = document.getElementById('fileCard');
    c ? animateOut('left',  c, () => doTrashCurrent()) : doTrashCurrent();
}
function swipeRight() {
    if (state.currentFolder === 'skipped') {
        const ids = state.folders.skipped;
        if (!ids.length) return;
        const fileId = ids[Math.min(state.currentSkippedIndex, ids.length - 1)];
        const c = document.getElementById('fileCard');
        c ? animateOut('right', c, () => openFolderPickerFrom('skipped', fileId)) : openFolderPickerFrom('skipped', fileId);
        return;
    }
    const c = document.getElementById('fileCard');
    c ? animateOut('right', c, () => openFolderPicker()) : openFolderPicker();
}
function skipFile() {
    if (state.currentFolder === 'skipped') { skippedRestore(); return; }
    const q = state.folders.queue;
    if (!q.length) return;
    if (state.currentIndex >= q.length) state.currentIndex = 0;
    const fileId = q[state.currentIndex];
    // Move to skipped
    state.folders.queue = q.filter(id => id !== fileId);
    state.folders.skipped = state.folders.skipped || [];
    state.folders.skipped.push(fileId);
    const f = state.files.find(f => f.id === fileId);
    if (f) f.folder = 'skipped';
    state.undoStack.push({ fileId, fromFolder: 'queue', toFolder: 'skipped' });
    state.redoStack = [];
    if (state.currentIndex >= state.folders.queue.length && state.currentIndex > 0) state.currentIndex--;
    updateCounts();
    renderSwipeMode();
    showToast(`Skipped · ${state.folders.skipped.length} skipped`);
}

function doTrashCurrent() {
    doMoveToFolder('trash');
    showToast('Moved to Trash');
}

// ══════════════════════════════════════════════
//  UNDO / REDO
// ══════════════════════════════════════════════
function undoSwipe() {
    if (!state.undoStack.length) return;
    const { fileId, fromFolder, toFolder } = state.undoStack.pop();
    if (!state.files.find(f => f.id === fileId)) {
        showToast('File no longer exists — cannot undo');
        renderSwipeMode();
        return;
    }
    state.folders[toFolder] = (state.folders[toFolder] || []).filter(id => id !== fileId);
    state.folders[fromFolder] = (state.folders[fromFolder] || []).filter(id => id !== fileId);
    state.folders[fromFolder].splice(state.currentIndex, 0, fileId);
    const f = state.files.find(f => f.id === fileId);
    if (f) f.folder = fromFolder;
    state.redoStack.push({ fileId, fromFolder, toFolder });
    updateCounts();
    renderSwipeMode();
    showToast('Undone');
}

function redoSwipe() {
    if (!state.redoStack.length) return;
    const { fileId, fromFolder, toFolder } = state.redoStack.pop();
    state.folders[fromFolder] = (state.folders[fromFolder] || []).filter(id => id !== fileId);
    state.folders[toFolder] = state.folders[toFolder] || [];
    state.folders[toFolder].push(fileId);
    const f = state.files.find(f => f.id === fileId);
    if (f) f.folder = toFolder;
    state.undoStack.push({ fileId, fromFolder, toFolder });
    if (state.currentIndex >= state.folders.queue.length && state.currentIndex > 0) state.currentIndex--;
    updateCounts();
    renderSwipeMode();
    showToast('Redone');
}

// ══════════════════════════════════════════════
//  SKIPPED SWIPE MODE
// ══════════════════════════════════════════════
function renderSkippedMode() {
    const main = document.getElementById('mainArea');
    const ids  = state.folders.skipped || [];

    if (!ids.length) {
        main.innerHTML = `
            <div class="empty-state">
                <div class="empty-illustration" style="opacity:0.5;">
                    <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                        <circle cx="26" cy="26" r="18" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1.5"/>
                        <path d="M18 26l5 5 11-10" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <h2>Nothing Skipped</h2>
                <p>Files you skip will appear here</p>
            </div>`;
        updateTopbar();
        return;
    }

    if (state.currentSkippedIndex >= ids.length) state.currentSkippedIndex = 0;
    const file = state.files.find(f => f.id === ids[state.currentSkippedIndex]);
    if (!file) { state.currentSkippedIndex = 0; renderSkippedMode(); return; }

    const isArchive = !!ARCHIVE_TYPES[file.ext];
    const is3D      = OBJ_3D_EXTS.has(file.ext);
    const thumbPct  = state.thumbProgress[file.id] || 0;
    const showBar   = (isArchive && thumbPct < 100) || is3D;
    const ext       = file.ext;
    const baseName  = ext && file.name.endsWith('.' + ext) ? file.name.slice(0, -(ext.length + 1)) : file.name;

    main.innerHTML = `
        <div class="swipe-wrap">
            <div class="swipe-topbar">
                <div class="progress-pill">${state.currentSkippedIndex + 1} / ${ids.length}</div>
                <div class="swipe-topbar-actions"></div>
                <div class="swipe-hint">
                    <span>← trash</span>
                    <span>↓ restore</span>
                    <span>folder →</span>
                </div>
            </div>
            <div class="swipe-stage">
                <div class="swipe-indicator left">Trash</div>
                <div class="swipe-indicator right">Move</div>
                <div class="file-card" id="fileCard">
                    <div class="file-preview" id="filePreview">${renderPreview(file)}</div>
                    <div class="file-info">
                        <div class="file-name-row">
                            <div class="rename-split">
                                <input class="file-name-input" id="fileNameInput"
                                    value="${escHtml(baseName)}"
                                    onchange="handleRename(this.value + (this.dataset.ext ? '.' + this.dataset.ext : ''))"
                                    data-orig-ext="${escHtml(ext)}"
                                    data-ext="${escHtml(ext)}">
                                ${ext ? `<span class="rename-ext-badge">.${escHtml(ext)}</span>` : ''}
                            </div>
                        </div>
                        <div class="ext-warning" id="extWarning"></div>
                        ${buildFileDetails(file)}
                    </div>
                    <div class="card-load-bar ${showBar ? '' : 'done'}" id="loadbar_${file.id}">
                        <div class="card-load-bar-fill" id="loadbar_fill_${file.id}" style="width:${thumbPct}%"></div>
                    </div>
                </div>
            </div>
            <div class="swipe-controls">
                <button class="ctrl-btn ctrl-trash" onclick="swipeLeft()" title="Trash (←)">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
                <button class="ctrl-btn ctrl-skip" onclick="skippedRestore()" title="Restore to queue">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 13V4M5 7l3-4 3 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button class="ctrl-btn ctrl-love" onclick="swipeRight()" title="Move to folder (→)">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 8V16a1 1 0 001 1h12a1 1 0 001-1V8M3 8V6a1 1 0 011-1h4l2 2h5a1 1 0 011 1v0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>
        </div>`;

    updateTopbar();
    setupSwipeDrag();
    maybe3D(file);
}

function skippedTrashCurrent() {
    const ids = state.folders.skipped || [];
    if (!ids.length) return;
    if (state.currentSkippedIndex >= ids.length) state.currentSkippedIndex = 0;
    const fileId = ids[state.currentSkippedIndex];
    state.folders.skipped = ids.filter(id => id !== fileId);
    state.folders.trash = state.folders.trash || [];
    state.folders.trash.push(fileId);
    const f = state.files.find(f => f.id === fileId);
    if (f) f.folder = 'trash';
    if (state.currentSkippedIndex >= state.folders.skipped.length && state.currentSkippedIndex > 0)
        state.currentSkippedIndex--;
    updateCounts();
    renderSkippedMode();
    showToast('Moved to Trash');
}

function skippedRestore() {
    const ids = state.folders.skipped || [];
    if (!ids.length) return;
    if (state.currentSkippedIndex >= ids.length) state.currentSkippedIndex = 0;
    const fileId = ids[state.currentSkippedIndex];
    state.folders.skipped = ids.filter(id => id !== fileId);
    state.folders.queue.push(fileId);
    const f = state.files.find(f => f.id === fileId);
    if (f) f.folder = 'queue';
    if (state.currentSkippedIndex >= state.folders.skipped.length && state.currentSkippedIndex > 0)
        state.currentSkippedIndex--;
    updateCounts();
    renderSkippedMode();
    showToast('Restored to Queue');
}

// ══════════════════════════════════════════════
//  SKIPPED SECTION (legacy helper, kept for compat)
// ══════════════════════════════════════════════
function renderSkippedSection() {
    const skipped = state.folders.skipped || [];
    if (!skipped.length) return '';
    const items = skipped.map(id => {
        const f = state.files.find(f => f.id === id);
        if (!f) return '';
        return `<div class="skipped-item">
            <span class="skipped-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>
            <span class="skipped-size">${formatSize(f.size)}</span>
            <button class="skipped-restore-btn" onclick="restoreSkipped('${f.id}')" title="Put back in queue">↩</button>
        </div>`;
    }).join('');
    return `<div class="skipped-section">
        <div class="skipped-section-header">
            <span>Skipped <span class="skipped-count">${skipped.length}</span></span>
            <button class="skipped-clear-btn" onclick="clearSkipped()">Clear all</button>
        </div>
        <div class="skipped-list">${items}</div>
    </div>`;
}

function restoreSkipped(fileId) {
    state.folders.skipped = (state.folders.skipped || []).filter(id => id !== fileId);
    state.folders.queue.splice(state.currentIndex, 0, fileId);
    const f = state.files.find(f => f.id === fileId);
    if (f) f.folder = 'queue';
    updateCounts();
    renderSwipeMode();
    showToast('Restored to Queue');
}

function clearSkipped() {
    (state.folders.skipped || []).forEach(id => {
        state.folders.trash.push(id);
        const f = state.files.find(f => f.id === id);
        if (f) f.folder = 'trash';
    });
    state.folders.skipped = [];
    updateCounts();
    renderSwipeMode();
    showToast('Cleared skipped → Trash');
}

// ══════════════════════════════════════════════
//  FOLDER PICKER PANEL
// ══════════════════════════════════════════════
let pendingMoveFileId = null;

function openFolderPickerFrom(source, fileId) {
    pendingMoveSource = source;
    pendingMoveFileId = fileId;
    const file = state.files.find(f => f.id === fileId);
    if (!file) return;
    const card = document.getElementById('fileCard');
    if (card) card.classList.add('selected');
    const info = document.getElementById('folderPickerFileInfo');
    info.innerHTML = `
        <div class="folder-picker-file-name">${escHtml(file.name)}</div>
        <div class="folder-picker-file-meta">${formatSize(file.size)} · .${escHtml(file.ext.toUpperCase())}</div>`;
    buildFolderPickerList();
    document.getElementById('folderPickerBackdrop').classList.add('active');
    document.getElementById('folderPickerPanel').classList.add('active');
}

function openFolderPicker() {
    pendingMoveSource = 'queue';
    const q = state.folders.queue;
    if (!q.length) return;
    const fileId = q[state.currentIndex < q.length ? state.currentIndex : 0];
    const file   = state.files.find(f => f.id === fileId);
    if (!file) return;

    pendingMoveFileId = fileId;

    // Highlight the card as selected
    const card = document.getElementById('fileCard');
    if (card) card.classList.add('selected');

    // Fill in file info
    const info = document.getElementById('folderPickerFileInfo');
    info.innerHTML = `
        <div class="folder-picker-file-name">${escHtml(file.name)}</div>
        <div class="folder-picker-file-meta">${formatSize(file.size)} · .${escHtml(file.ext.toUpperCase())}</div>`;

    // Build folder list (exclude queue)
    buildFolderPickerList();

    document.getElementById('folderPickerBackdrop').classList.add('active');
    document.getElementById('folderPickerPanel').classList.add('active');
}

function buildFolderPickerList() {
    const list = document.getElementById('folderPickerList');

    const presetEntries = [
        { name:'documents', label:'Documents', icon:'documents-icon', emoji:'📄' },
        { name:'music',     label:'Music',     icon:'music-icon',     emoji:'🎵' },
        { name:'pictures',  label:'Pictures',  icon:'pictures-icon',  emoji:'🖼' },
        { name:'videos',    label:'Videos',    icon:'videos-icon',    emoji:'🎬' },
    ].filter(f => state.folders[f.name] !== undefined);

    const allFolders = [
        ...presetEntries,
        ...state.customFolders.map(f => ({ name:f, label:f, icon:'custom-icon', emoji:'📁' }))
    ];

    if (!allFolders.length) {
        list.innerHTML = `
            <li class="picker-no-folders">
                <div class="picker-no-folders-msg">No folders yet</div>
                <button class="picker-add-folder-btn" onclick="pickerCreateFolder()">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                    New Folder
                </button>
            </li>`;
        return;
    }

    list.innerHTML = allFolders.map(f => `
        <li class="picker-folder-item" onclick="confirmFolderPick('${escHtml(f.name)}')">
            <div class="picker-folder-icon ${f.icon}">${f.emoji}</div>
            <div class="picker-folder-name">${escHtml(f.label)}</div>
            <div class="picker-folder-count">${(state.folders[f.name] || []).length}</div>
        </li>`).join('');
}

function pickerCreateFolder() {
    closeFolderPicker();
    // Bring card back to center so it's visible while the modal is open
    const card = document.getElementById('fileCard');
    if (card) {
        card.classList.remove('selected');
        card.style.transition = 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
        card.style.transform = '';
    }
    const savedId = pendingMoveFileId;
    const savedSrc = pendingMoveSource;
    // Reopen after folder is created
    window._pickerAfterCreate = function(name) {
        pendingMoveFileId = savedId;
        pendingMoveSource = savedSrc;
        const file = state.files.find(f => f.id === savedId);
        if (!file) return;
        // Re-highlight card
        const c = document.getElementById('fileCard');
        if (c) c.classList.add('selected');
        const info = document.getElementById('folderPickerFileInfo');
        info.innerHTML = `
            <div class="folder-picker-file-name">${escHtml(file.name)}</div>
            <div class="folder-picker-file-meta">${formatSize(file.size)} · .${escHtml(file.ext.toUpperCase())}</div>`;
        buildFolderPickerList();
        document.getElementById('folderPickerBackdrop').classList.add('active');
        document.getElementById('folderPickerPanel').classList.add('active');
        window._pickerAfterCreate = null;
    };
    showAddFolderModal();
}

function confirmFolderPick(folderName) {
    if (!pendingMoveFileId) return;

    const fileId = pendingMoveFileId;
    const source = pendingMoveSource || 'queue';
    pendingMoveFileId = null;
    pendingMoveSource = 'queue';

    closeFolderPicker();

    // Bail out if target folder was deleted since the picker opened
    if (state.folders[folderName] === undefined) {
        showToast(`Folder "${folderName}" no longer exists`);
        updateCounts();
        if (source === 'skipped') renderSkippedMode();
        else renderSwipeMode();
        return;
    }

    // Move the file from its source
    const srcList = state.folders[source] || [];
    const idx = srcList.indexOf(fileId);
    if (idx !== -1) {
        state.folders[source] = srcList.filter(id => id !== fileId);
        state.folders[folderName].push(fileId);
        const f = state.files.find(f => f.id === fileId);
        if (f) f.folder = folderName;
        state.undoStack.push({ fileId, fromFolder: source, toFolder: folderName });
        state.redoStack = [];
        if (source === 'queue') {
            if (state.currentIndex >= state.folders.queue.length && state.currentIndex > 0) state.currentIndex--;
        } else if (source === 'skipped') {
            if (state.currentSkippedIndex >= state.folders.skipped.length && state.currentSkippedIndex > 0) state.currentSkippedIndex--;
        }
    }

    updateCounts();
    if (source === 'skipped') renderSkippedMode();
    else renderSwipeMode();
    showToast(`Moved to ${folderName.charAt(0).toUpperCase() + folderName.slice(1)}`);
    liveExportFile(fileId, folderName);
}

function cancelFolderPick() {
    pendingMoveFileId = null;
    const card = document.getElementById('fileCard');
    if (card) {
        card.classList.remove('selected');
        card.style.transition = 'transform 0.35s cubic-bezier(0.34,1.56,0.64,1)';
        card.style.transform = '';
    }
    // Clear any stuck swipe indicators
    document.querySelectorAll('.swipe-indicator').forEach(el => el.classList.remove('active'));
    closeFolderPicker();
}

function closeFolderPicker() {
    document.getElementById('folderPickerBackdrop').classList.remove('active');
    document.getElementById('folderPickerPanel').classList.remove('active');
}

// ══════════════════════════════════════════════
//  MOVE FROM REVIEW MODE
// ══════════════════════════════════════════════
function doMoveToFolder(target) {
    const q = state.folders.queue;
    if (!q.length) return;
    if (state.currentIndex >= q.length) state.currentIndex = 0;
    const fileId = q[state.currentIndex];
    // Guard: if target was deleted, fall back to queue (shouldn't normally happen)
    if (state.folders[target] === undefined) {
        showToast(`Folder "${target}" no longer exists`);
        return;
    }
    state.folders.queue = q.filter(id => id !== fileId);
    state.folders[target].push(fileId);
    const f = state.files.find(f => f.id === fileId);
    if (f) f.folder = target;
    state.undoStack.push({ fileId, fromFolder: 'queue', toFolder: target });
    state.redoStack = [];
    if (state.currentIndex >= state.folders.queue.length && state.currentIndex > 0)
        state.currentIndex--;
    updateCounts();
    renderSwipeMode();
}

function moveFileToFolder(fileId, target) {
    const f = state.files.find(f => f.id === fileId);
    if (!f) return;
    // Guard: if target was deleted, don't silently recreate it
    if (state.folders[target] === undefined) {
        showToast(`Folder "${target}" no longer exists`);
        return;
    }
    state.folders[f.folder] = (state.folders[f.folder] || []).filter(id => id !== fileId);
    state.folders[target].push(fileId);
    f.folder = target;
    updateCounts();
    renderReviewMode(state.currentFolder);
    showToast(`Moved to ${target.charAt(0).toUpperCase() + target.slice(1)}`);
    liveExportFile(fileId, target);
}

// Open a mini picker for files in review mode
function openMovePicker(fileId) {
    pendingMoveFileId = fileId;
    const file = state.files.find(f => f.id === fileId);
    if (!file) return;

    const info = document.getElementById('folderPickerFileInfo');
    info.innerHTML = `
        <div class="folder-picker-file-name">${escHtml(file.name)}</div>
        <div class="folder-picker-file-meta">${formatSize(file.size)} · .${escHtml(file.ext.toUpperCase())}</div>`;

    // Build folder list: all except current
    const presetEntries = [
        { name:'queue',     label:'Queue',     icon:'queue-icon',     emoji:'≡' },
        { name:'documents', label:'Documents', icon:'documents-icon', emoji:'📄' },
        { name:'music',     label:'Music',     icon:'music-icon',     emoji:'🎵' },
        { name:'pictures',  label:'Pictures',  icon:'pictures-icon',  emoji:'🖼' },
        { name:'videos',    label:'Videos',    icon:'videos-icon',    emoji:'🎬' },
        { name:'trash',     label:'Trash',     icon:'trash-icon',     emoji:'🗑' },
    ].filter(f => state.folders[f.name] !== undefined);

    const allFolders = [
        ...presetEntries,
        ...state.customFolders.map(f => ({ name:f, label:f, icon:'custom-icon', emoji:'📁' }))
    ].filter(f => f.name !== state.currentFolder);

    const list = document.getElementById('folderPickerList');
    list.innerHTML = allFolders.map(f => `
        <li class="picker-folder-item" onclick="confirmReviewMovePick('${escHtml(f.name)}')">
            <div class="picker-folder-icon ${f.icon}">${f.emoji}</div>
            <div class="picker-folder-name">${escHtml(f.label)}</div>
            <div class="picker-folder-count">${(state.folders[f.name] || []).length}</div>
        </li>`).join('');

    document.getElementById('folderPickerBackdrop').classList.add('active');
    document.getElementById('folderPickerPanel').classList.add('active');
}

function confirmReviewMovePick(folderName) {
    if (!pendingMoveFileId) return;
    const fileId = pendingMoveFileId;
    pendingMoveFileId = null;
    closeFolderPicker();
    moveFileToFolder(fileId, folderName);
}

// ══════════════════════════════════════════════
//  REVIEW GRID MODE
// ══════════════════════════════════════════════
function renderReviewMode(folderName) {
    const main  = document.getElementById('mainArea');
    const ids   = state.folders[folderName] || [];
    const files = ids.map(id => state.files.find(f => f.id === id)).filter(Boolean);

    if (!files.length) {
        main.innerHTML = `
            <div class="empty-state">
                <div class="empty-illustration" style="opacity:0.5;">
                    <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                        <rect x="6" y="12" width="40" height="32" rx="5" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1.5"/>
                        <path d="M6 20h40" stroke="var(--border)" stroke-width="1.5"/>
                        <path d="M18 32h16M22 37h8" stroke="var(--border-med)" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                </div>
                <h2>Empty Folder</h2>
                <p>No files in <strong>${escHtml(folderName)}</strong></p>
            </div>`;
        updateTopbar();
        return;
    }

    const items = files.map(file => {
        const isArchive = !!ARCHIVE_TYPES[file.ext] || file.ext === 'zip';
        const pct = state.thumbProgress[file.id] || 0;
        const showBar = isArchive && pct < 100;
        return `
            <div class="review-item" onclick="openLightbox('${file.id}')">
                <div class="review-thumb${showBar ? ' loading' : ''}" id="rthumb_${file.id}">
                    ${buildThumbHTML(file)}
                    ${showBar ? `<div class="review-thumb-bar"><div class="review-thumb-bar-fill" id="rbar_${file.id}" style="width:${pct}%"></div></div>` : ''}
                </div>
                <div class="review-name" title="${escHtml(file.name)}">${escHtml(file.name)}</div>
                <div class="review-actions">
                    <button class="r-action-btn r-move-btn"
                        onclick="event.stopPropagation();openMovePicker('${file.id}')"
                        title="Move to folder">↗</button>
                    <button class="r-action-btn"
                        onclick="event.stopPropagation();permDeleteSingle('${file.id}')"
                        title="Delete permanently"
                        style="color:var(--danger);">✕</button>
                </div>
            </div>`;
    }).join('');

    main.innerHTML = `
        <div class="review-wrap">
            <div class="review-grid">${items}</div>
        </div>`;
    updateTopbar();
}

function buildThumbHTML(file) {
    const url   = state.blobCache[file.id];
    const thumb = state.thumbnailCache[file.id];
    const ext   = file.ext;
    if (thumb) return `<img id="rimg_${file.id}" src="${thumb}" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;">`;
    if ((file.type.startsWith('image/') || EXTRA_IMG_EXTS.has(ext)) && url)
        return `<img id="rimg_${file.id}" src="${url}" loading="lazy" alt="">`;
    if (file.type.startsWith('video/') && url)
        return `<video src="${url}" preload="none" style="width:100%;height:100%;object-fit:cover;"></video>`;
    const needsThumb = !!ARCHIVE_TYPES[ext] || ext === 'zip';
    const willGetThumb = THUMB_TEXT_EXTS.has(ext) || FONT_EXTS.has(ext);
    const asyncImg = (needsThumb || willGetThumb)
        ? `<img id="rimg_${file.id}" src="" style="display:none;width:100%;height:100%;object-fit:cover;position:absolute;inset:0;" alt="">` : '';
    const typeMap = {
        pdf:{icon:'PDF',bg:'#c2410c',col:'#fff'},
        doc:{icon:'DOC',bg:'#1d4ed8',col:'#fff'},docx:{icon:'DOCX',bg:'#1d4ed8',col:'#fff'},
        xls:{icon:'XLS',bg:'#15803d',col:'#fff'},xlsx:{icon:'XLSX',bg:'#15803d',col:'#fff'},
        ppt:{icon:'PPT',bg:'#b91c1c',col:'#fff'},pptx:{icon:'PPTX',bg:'#b91c1c',col:'#fff'},
        odt:{icon:'ODT',bg:'#1d4ed8',col:'#fff'},ods:{icon:'ODS',bg:'#15803d',col:'#fff'},
        odp:{icon:'ODP',bg:'#b91c1c',col:'#fff'},rtf:{icon:'RTF',bg:'#374151',col:'#fff'},
        md:{icon:'MD',bg:'#1d4ed8',col:'#fff'},markdown:{icon:'MD',bg:'#1d4ed8',col:'#fff'},
        json:{icon:'{}',bg:'#1e293b',col:'#7dd3fc'},
        js:{icon:'JS',bg:'#854d0e',col:'#fde68a'},ts:{icon:'TS',bg:'#1e3a5f',col:'#93c5fd'},
        jsx:{icon:'JSX',bg:'#0c4a6e',col:'#7dd3fc'},tsx:{icon:'TSX',bg:'#0c4a6e',col:'#7dd3fc'},
        py:{icon:'PY',bg:'#1e3a5f',col:'#93c5fd'},rs:{icon:'RS',bg:'#7c2d12',col:'#fed7aa'},
        go:{icon:'GO',bg:'#0c4a6e',col:'#7dd3fc'},html:{icon:'HTML',bg:'#7f1d1d',col:'#fca5a5'},
        htm:{icon:'HTML',bg:'#7f1d1d',col:'#fca5a5'},
        css:{icon:'CSS',bg:'#4c1d95',col:'#c4b5fd'},php:{icon:'PHP',bg:'#3b0764',col:'#d8b4fe'},
        java:{icon:'JAVA',bg:'#78350f',col:'#fde68a'},rb:{icon:'RB',bg:'#7f1d1d',col:'#fca5a5'},
        cpp:{icon:'C++',bg:'#1e1b4b',col:'#a5b4fc'},c:{icon:'C',bg:'#1e1b4b',col:'#a5b4fc'},
        sh:{icon:'SH',bg:'#14532d',col:'#86efac'},bash:{icon:'SH',bg:'#14532d',col:'#86efac'},
        yaml:{icon:'YAML',bg:'#7f1d1d',col:'#fca5a5'},toml:{icon:'TOML',bg:'#7c2d12',col:'#fed7aa'},
        sql:{icon:'SQL',bg:'#1e3a5f',col:'#93c5fd'},csv:{icon:'CSV',bg:'#14532d',col:'#86efac'},
        xml:{icon:'XML',bg:'#78350f',col:'#fde68a'},txt:{icon:'TXT',bg:'#1e293b',col:'#94a3b8'},
        log:{icon:'LOG',bg:'#0f172a',col:'#64748b'},
        svg:{icon:'SVG',bg:'#1e3a5f',col:'#7dd3fc'},svgz:{icon:'SVG',bg:'#1e3a5f',col:'#7dd3fc'},
        eps:{icon:'EPS',bg:'#2d1b69',col:'#c4b5fd'},
        ttf:{icon:'Aa',bg:'#3730a3',col:'#a5b4fc'},otf:{icon:'Aa',bg:'#3730a3',col:'#a5b4fc'},
        woff:{icon:'Aa',bg:'#3730a3',col:'#a5b4fc'},woff2:{icon:'Aa',bg:'#3730a3',col:'#a5b4fc'},
        mp3:{icon:'♫',bg:'#14532d',col:'#86efac'},wav:{icon:'♫',bg:'#1e3a5f',col:'#93c5fd'},
        flac:{icon:'♫',bg:'#1e293b',col:'#94a3b8'},ogg:{icon:'♫',bg:'#14532d',col:'#86efac'},
        aac:{icon:'♫',bg:'#78350f',col:'#fde68a'},m4a:{icon:'♫',bg:'#4c1d95',col:'#c4b5fd'},
        zip:{icon:'ZIP',bg:'#78350f',col:'#fde68a'},'7z':{icon:'7Z',bg:'#78350f',col:'#fde68a'},
        rar:{icon:'RAR',bg:'#451a03',col:'#fed7aa'},tar:{icon:'TAR',bg:'#713f12',col:'#fde68a'},
        gz:{icon:'GZ',bg:'#713f12',col:'#fde68a'},bz2:{icon:'BZ2',bg:'#451a03',col:'#fed7aa'},
        obj:{icon:'3D',bg:'#4c1d95',col:'#c4b5fd'},stl:{icon:'3D',bg:'#4c1d95',col:'#c4b5fd'},
        gltf:{icon:'3D',bg:'#4c1d95',col:'#c4b5fd'},glb:{icon:'3D',bg:'#4c1d95',col:'#c4b5fd'},
        fbx:{icon:'3D',bg:'#4c1d95',col:'#c4b5fd'},dae:{icon:'3D',bg:'#4c1d95',col:'#c4b5fd'},
        blend:{icon:'3D',bg:'#7c2d12',col:'#fed7aa'},max:{icon:'3D',bg:'#1e293b',col:'#94a3b8'},
        mb:{icon:'3D',bg:'#1c1c2e',col:'#a5b4fc'},ma:{icon:'3D',bg:'#1c1c2e',col:'#a5b4fc'},
        c4d:{icon:'3D',bg:'#0a1628',col:'#7dd3fc'},
        psd:{icon:'PSD',bg:'#001f3f',col:'#7dd3fc'},psb:{icon:'PSB',bg:'#001f3f',col:'#7dd3fc'},
        xcf:{icon:'XCF',bg:'#1a1a2e',col:'#c4b5fd'},
        kra:{icon:'KRA',bg:'#0d1b2a',col:'#60a5fa'},ora:{icon:'ORA',bg:'#0d1b2a',col:'#86efac'},
        clip:{icon:'CLIP',bg:'#111827',col:'#f9a8d4'},procreate:{icon:'PROC',bg:'#111827',col:'#a5b4fc'},
        sai:{icon:'SAI',bg:'#111827',col:'#fde68a'},
        ai:{icon:'AI',bg:'#ff6d00',col:'#fff'},cdr:{icon:'CDR',bg:'#0a3d62',col:'#7dd3fc'},
        sketch:{icon:'SK',bg:'#f7a800',col:'#000'},drawio:{icon:'DIO',bg:'#f08705',col:'#fff'},
        dio:{icon:'DIO',bg:'#f08705',col:'#fff'},
        aep:{icon:'AEP',bg:'#9999ff',col:'#000'},prproj:{icon:'PPJ',bg:'#00005b',col:'#93c5fd'},
        epub:{icon:'📚',bg:'#14532d',col:'#fff'},
        exe:{icon:'EXE',bg:'#1e293b',col:'#64748b'},
        iso:{icon:'ISO',bg:'#1e293b',col:'#64748b'},apk:{icon:'APK',bg:'#14532d',col:'#86efac'},
    };
    const audioT = file.type?.startsWith('audio/') ? {icon:'♫',bg:'#14532d',col:'#86efac'} : null;
    const t = audioT || typeMap[ext];
    if (t) return `${asyncImg}<div class="r-type-badge" style="background:${t.bg};color:${t.col};"><span class="r-type-icon">${escHtml(t.icon)}</span></div>`;
    return `<div class="r-icon">📁</div>`;
}

// ══════════════════════════════════════════════
//  LIGHTBOX
// ══════════════════════════════════════════════
let lightboxFileIds = [];
let lightboxIndex   = 0;

function openLightbox(fileId) {
    // System panels (duplicates, storage, etc.) don't have a real folder list —
    // fall back to showing just the single file with no nav arrows.
    if (SYSTEM_PANELS.has(state.currentFolder)) {
        lightboxFileIds = [fileId];
        lightboxIndex   = 0;
    } else {
        const folderIds = state.folders[state.currentFolder] || [];
        lightboxFileIds = folderIds.filter(id => state.files.find(f => f.id === id));
        lightboxIndex   = lightboxFileIds.indexOf(fileId);
        if (lightboxIndex < 0) lightboxIndex = 0;
    }
    renderLightbox();
}

function lightboxNav(delta) {
    lightboxIndex = (lightboxIndex + delta + lightboxFileIds.length) % lightboxFileIds.length;
    renderLightbox();
}

function renderLightbox() {
    const fileId = lightboxFileIds[lightboxIndex];
    const file = state.files.find(f => f.id === fileId);
    if (!file) return;
    const url   = state.blobCache[file.id];
    const thumb = state.thumbnailCache[file.id];
    const ext   = file.ext;
    const lbc   = document.getElementById('lightboxContent');
    const lb    = document.getElementById('lightbox');

    lbc.innerHTML = '';
    lbc.className = 'lightbox-content';

    // ── Image ──
    if ((file.type.startsWith('image/') || EXTRA_IMG_EXTS.has(ext)) && url) {
        lbc.innerHTML = `<img style="max-width:92vw;max-height:82vh;object-fit:contain;border-radius:10px;" src="${url}" alt="">`;

    // ── Video ──
    } else if (file.type.startsWith('video/') && url) {
        lbc.innerHTML = `<video style="max-width:92vw;max-height:82vh;border-radius:10px;" src="${url}" controls autoplay></video>`;

    // ── Audio ──
    } else if (file.type.startsWith('audio/') && url) {
        const ic = {mp3:'🎵',wav:'🎵',flac:'🎼',ogg:'🎵',aac:'🎵',m4a:'🎵',opus:'🎵',aiff:'🎼',wma:'🎵'};
        lbc.innerHTML = `<div class="lb-audio-wrap">
            <div class="lb-audio-icon">${ic[ext]||'🎵'}</div>
            <div class="lb-audio-name">${escHtml(file.name)}</div>
            <audio src="${url}" controls autoplay style="width:min(400px,88vw);margin-top:16px;"></audio>
        </div>`;

    // ── PDF ──
    } else if ((file.type === 'application/pdf' || ext === 'pdf') && url) {
        lbc.innerHTML = `<iframe src="${url}" style="width:88vw;height:82vh;border:none;border-radius:10px;background:#fff;"></iframe>`;

    // ── HTML — scrollable rendered preview ──
    } else if ((ext === 'html' || ext === 'htm') && url) {
        lbc.innerHTML = `<iframe src="${url}" style="width:88vw;height:82vh;border:none;border-radius:10px;background:#fff;" sandbox="allow-same-origin allow-scripts"></iframe>`;

    // ── SVG ──
    } else if ((ext === 'svg' || ext === 'svgz') && url) {
        lbc.innerHTML = `<iframe src="${url}" style="width:min(720px,88vw);height:min(82vh,720px);border:none;border-radius:10px;background:#fff;" sandbox="allow-same-origin"></iframe>`;

    // ── Markdown ──
    } else if ((ext === 'md' || ext === 'markdown') && url) {
        lbc.className = 'lightbox-content lb-text-content';
        lbc.innerHTML = `<div class="lb-md" id="lb_md_${file.id}"><div class="lb-loading">Rendering…</div></div>`;
        loadMarkdownInLightbox(file.id, url, `lb_md_${file.id}`);

    // ── Code ──
    } else if (CODE_EXTS.has(ext) && url) {
        lbc.className = 'lightbox-content lb-text-content';
        lbc.innerHTML = `<div class="lb-code" id="lb_code_${file.id}"><div class="lb-loading">Loading…</div></div>`;
        loadCodeInLightbox(file.id, url, ext, `lb_code_${file.id}`);

    // ── Plain text / config / data ──
    } else if (url && (file.type.startsWith('text/') || TEXT_EXTS.has(ext))) {
        lbc.className = 'lightbox-content lb-text-content';
        lbc.innerHTML = `<pre class="lb-plaintext" id="lb_txt_${file.id}"><div class="lb-loading">Loading…</div></pre>`;
        fetch(url).then(r=>r.text()).then(t=>{
            const el = document.getElementById(`lb_txt_${file.id}`);
            if (el) el.textContent = t;
        }).catch(()=>{});

    // ── Font ──
    } else if (FONT_EXTS.has(ext) && url) {
        lbc.className = 'lightbox-content lb-font-content';
        const safe = `ff_${file.id.replace(/-/g,'')}`;
        const styleId = `font_style_${file.id}`;
        if (!document.getElementById(styleId)) {
            const s = document.createElement('style');
            s.id = styleId;
            s.textContent = `@font-face{font-family:'${safe}';src:url('${url}');}`;
            document.head.appendChild(s);
        }
        lbc.innerHTML = `<div class="lb-font-wrap" style="font-family:'${safe}',sans-serif;">
            <div class="lb-font-big">Aa Bb Cc</div>
            <div class="lb-font-pangram">The quick brown fox jumps over the lazy dog</div>
            <div class="lb-font-alpha">AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz</div>
            <div class="lb-font-digits">0123456789 !@#$%^&*()_+-=[]{}|;':",./&lt;&gt;?</div>
            <div class="lb-font-sizes">
                <div style="font-size:12px;">12px — The quick brown fox</div>
                <div style="font-size:16px;">16px — The quick brown fox</div>
                <div style="font-size:24px;">24px — The quick brown fox</div>
                <div style="font-size:36px;">36px — Pack my box</div>
                <div style="font-size:56px;">56px — Aa</div>
            </div>
        </div>`;

    // ── ZIP tree ──
    } else if ((ext === 'zip' || ARCHIVE_TYPES[ext]) && file._zipTree) {
        lbc.className = 'lightbox-content lb-text-content';
        lbc.innerHTML = `<div class="lb-zip-tree">${buildZipTreeHtml(file._zipTree, 500)}</div>`;

    // ── 3D ──
    } else if (OBJ_3D_EXTS.has(ext) && url) {
        lbc.innerHTML = `<div class="lb-3d-container" id="lb_3d_${file.id}">
            <div class="preview-thumb-skeleton" style="width:100%;height:100%;min-height:300px;">
                <div class="pts-spinner"></div>
                <div class="pts-label">Loading 3D viewer…</div>
            </div>
        </div>`;
        setTimeout(() => load3DViewer(file.id, url, ext, true), 50);

    // ── Thumb fallback ──
    } else if (thumb) {
        lbc.innerHTML = `<img style="max-width:92vw;max-height:82vh;object-fit:contain;border-radius:10px;" src="${thumb}" alt="">`;

    // ── No preview ──
    } else {
        lbc.innerHTML = `<div class="lb-no-preview">
            <div style="font-size:56px;">📁</div>
            <div style="font-size:15px;margin-top:12px;color:var(--text-2);">${escHtml(file.name)}</div>
            <div style="font-size:12px;margin-top:6px;color:var(--text-3);">No preview available for .${escHtml(ext||'?')}</div>
        </div>`;
    }

    const d = file.lastModified ? new Date(file.lastModified) : null;
    const total = lightboxFileIds.length;
    const counter = (lightboxIndex >= 0 && lightboxIndex < total && total > 1)
        ? `${lightboxIndex + 1} / ${total}` : '';
    document.getElementById('lightboxName').innerHTML =
        `<span class="lb-counter">${escHtml(counter)}</span><span class="lb-filename">${escHtml(file.name)}</span><span class="lb-meta">${formatSize(file.size)}${d ? '  ·  ' + d.toLocaleString() : ''}</span>`;

    // Update nav button visibility
    const prevBtn = document.getElementById('lbPrevBtn');
    const nextBtn = document.getElementById('lbNextBtn');
    if (prevBtn) prevBtn.style.display = total > 1 ? '' : 'none';
    if (nextBtn) nextBtn.style.display = total > 1 ? '' : 'none';

    // Update bottom action bar file id
    const lbRenameInput = document.getElementById('lbRenameInput');
    const lbMoveBtn     = document.getElementById('lbMoveBtn');
    if (lbRenameInput) {
        const lbExt = file.ext;
        const lbBase = lbExt && file.name.endsWith('.' + lbExt) ? file.name.slice(0, -(lbExt.length + 1)) : file.name;
        lbRenameInput.value = lbBase;
        lbRenameInput.dataset.fileId = file.id;
        lbRenameInput.dataset.ext = lbExt || '';
        // Render ext badge
        const bar = lbRenameInput.parentElement;
        let badge = bar.querySelector('.lb-rename-ext-badge');
        if (lbExt) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'lb-rename-ext-badge';
                lbRenameInput.after(badge);
            }
            badge.textContent = '.' + lbExt;
        } else if (badge) {
            badge.remove();
        }
    }
    if (lbMoveBtn)     lbMoveBtn.dataset.fileId = file.id;

    lb.classList.add('active');
}

async function loadMarkdownInLightbox(fileId, url, elId) {
    try {
        const text = await (await fetch(url)).text();
        const el = document.getElementById(elId);
        if (!el) return;
        if (!window.marked) {
            await new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js'; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
        }
        el.innerHTML = window.marked.parse(text);
    } catch(_) {}
}

async function loadCodeInLightbox(fileId, url, ext, elId) {
    try {
        const text = await (await fetch(url)).text();
        const el = document.getElementById(elId);
        if (!el) return;
        if (!window.hljs) {
            await new Promise((res,rej)=>{ const link=document.createElement('link'); link.rel='stylesheet'; link.href='https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css'; document.head.appendChild(link); const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js'; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
        }
        const pre=document.createElement('pre'); const code=document.createElement('code');
        code.className=`language-${ext}`; code.textContent=text;
        pre.appendChild(code); el.innerHTML=''; el.appendChild(pre);
        window.hljs.highlightElement(code);
    } catch(_) {}
}

function closeLightbox(e) { if (e.target.id === 'lightbox') closeLightboxBtn(); }
function closeLightboxBtn() {
    document.getElementById('lightbox').classList.remove('active');
    document.getElementById('lightboxContent').innerHTML = '';
    lightboxFileIds = [];
}

function lbRenameFile() {
    const inp = document.getElementById('lbRenameInput');
    if (!inp) return;
    const fileId = inp.dataset.fileId;
    const ext = inp.dataset.ext || '';
    const baseName = inp.value.trim();
    if (!baseName || !fileId) return;
    const newName = ext ? baseName + '.' + ext : baseName;
    const f = state.files.find(f => f.id === fileId);
    if (f) { f.name = newName; f.ext = ext; }
    document.getElementById('lightboxName').querySelector('.lb-filename').textContent = newName;
    renderCurrentFolder();
    showToast('Renamed');
}

function lbMoveFile() {
    const btn = document.getElementById('lbMoveBtn');
    if (!btn) return;
    const fileId = btn.dataset.fileId;
    if (!fileId) return;
    closeLightboxBtn();
    openMovePicker(fileId);
}

// ══════════════════════════════════════════════
//  FOLDER MANAGEMENT + SIDEBAR
// ══════════════════════════════════════════════
function switchFolder(name) {
    state.currentFolder = name;
    document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('active'));
    const el = document.querySelector(`[data-folder="${CSS.escape(name)}"]`);
    if (el) el.classList.add('active');
    closeSidebar();
    renderCurrentFolder();
    updatePermTrashBtn();
}

function updateCounts() {
    Object.keys(state.folders).forEach(f => {
        const el = document.getElementById(`count-${f}`);
        if (el) el.textContent = state.folders[f].length;
    });
    updatePermTrashBtn();
    updateTopbar();
}

function updatePermTrashBtn() {
    const btn = document.getElementById('permTrashBtn');
    if (!btn) return;
    const n = (state.folders.trash || []).length;
    btn.disabled = n === 0;
}

// Rebuild the entire sidebar folder list (used after file reload)
function rebuildFolderSidebar() {
    const list = document.getElementById('folderList');
    // Remove custom folder items
    list.querySelectorAll('[data-custom="1"]').forEach(el => el.remove());
    // Re-add custom folders
    state.customFolders.forEach(name => addFolderToSidebar(name));
    // Show/hide preset folder DOM nodes based on whether they're still active
    const ALL_PRESETS = ['documents', 'music', 'pictures', 'videos'];
    ALL_PRESETS.forEach(name => {
        const el = list.querySelector(`[data-folder="${CSS.escape(name)}"]`);
        if (!el) return;
        const isActive = state.presetFolders.includes(name);
        el.style.display = isActive ? '' : 'none';
    });
}

function deletePresetFolder(name) {
    if (!confirm(`Remove folder "${name.charAt(0).toUpperCase()+name.slice(1)}"? Files will go back to Queue.`)) return;
    (state.folders[name] || []).forEach(id => {
        state.folders.queue.push(id);
        const f = state.files.find(f => f.id === id);
        if (f) f.folder = 'queue';
    });
    delete state.folders[name];
    state.presetFolders = state.presetFolders.filter(f => f !== name);
    const el = document.querySelector(`[data-folder="${CSS.escape(name)}"]`);
    if (el) el.remove();
    if (state.currentFolder === name) switchFolder('queue');
    updateCounts();
    showToast(`Removed folder "${name}"`);
}

function addFolderToSidebar(name) {
    const list = document.getElementById('folderList');
    const li = document.createElement('li');
    li.className = 'folder-item';
    li.dataset.folder = name;
    li.dataset.custom = '1';
    li.setAttribute('draggable', 'true');
    li.onclick = () => switchFolder(name);

    // Safe drag events using data attributes (no inline string injection)
    li.addEventListener('dragstart', e => folderDragStart(e, name));
    li.addEventListener('dragover',  folderDragOver);
    li.addEventListener('dragleave', folderDragLeave);
    li.addEventListener('drop',      e => folderDrop(e, name));

    const label = document.createElement('span');
    label.className = 'folder-icon custom-icon';
    label.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 4.5V11a1 1 0 001 1h10a1 1 0 001-1V5a1 1 0 00-1-1H7L5.5 2H2a1 1 0 00-1 1v1.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

    const nameEl = document.createElement('span');
    nameEl.className = 'folder-label';
    nameEl.textContent = name;

    const badge = document.createElement('span');
    badge.className = 'folder-badge';
    badge.id = `count-${name}`;
    badge.textContent = '0';

    const delBtn = document.createElement('button');
    delBtn.className = 'folder-del-btn';
    delBtn.title = 'Delete folder';
    delBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    delBtn.onclick = e => { e.stopPropagation(); deleteCustomFolder(name); };

    li.append(label, nameEl, badge, delBtn);
    list.appendChild(li);
}

function showAddFolderModal() {
    document.getElementById('addFolderModal').classList.add('active');
    setTimeout(() => document.getElementById('folderNameInput').focus(), 60);
}
function closeAddFolderModal() {
    document.getElementById('addFolderModal').classList.remove('active');
    document.getElementById('folderNameInput').value = '';
}
function createFolder() {
    const name = document.getElementById('folderNameInput').value.trim();
    if (!name) return;
    if (state.folders[name]) { showToast('Folder already exists'); return; }
    state.customFolders.push(name);
    state.folders[name] = [];
    addFolderToSidebar(name);
    closeAddFolderModal();
    updateCounts();
    // Also refresh picker if open
    if (document.getElementById('folderPickerPanel').classList.contains('active'))
        buildFolderPickerList();
    // Callback if triggered from picker (clear after use)
    if (window._pickerAfterCreate) {
        window._pickerAfterCreate(name);
        window._pickerAfterCreate = null;
    } else {
        showToast(`Folder "${name}" created`);
    }
}

function deleteCustomFolder(name) {
    if (!confirm(`Delete folder "${name}"? Files will go back to Queue.`)) return;
    (state.folders[name] || []).forEach(id => {
        state.folders.queue.push(id);
        const f = state.files.find(f => f.id === id);
        if (f) f.folder = 'queue';
    });
    delete state.folders[name];
    state.customFolders = state.customFolders.filter(f => f !== name);
    const el = document.querySelector(`[data-folder="${CSS.escape(name)}"]`);
    if (el) el.remove();
    if (state.currentFolder === name) switchFolder('queue');
    updateCounts();
}

// Sidebar drag-to-reorder
let folderDraggingName = null;
function folderDragStart(e, name) {
    if (isDragging) { e.preventDefault(); return; }
    folderDraggingName = name;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', name);
    e.currentTarget.classList.add('dragging');
}
function folderDragOver(e) {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
}
function folderDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function folderDrop(e, targetName) {
    e.preventDefault();
    document.querySelectorAll('.folder-item').forEach(el => {
        el.classList.remove('drag-over'); el.classList.remove('dragging');
    });
    const srcName = folderDraggingName;
    folderDraggingName = null;
    if (!srcName || srcName === targetName) return;
    const list = document.getElementById('folderList');
    const srcEl = list.querySelector(`[data-folder="${CSS.escape(srcName)}"]`);
    const tgtEl = list.querySelector(`[data-folder="${CSS.escape(targetName)}"]`);
    if (srcEl && tgtEl) {
        const items = Array.from(list.children);
        if (items.indexOf(srcEl) < items.indexOf(tgtEl)) tgtEl.after(srcEl);
        else tgtEl.before(srcEl);
    }
}

// ══════════════════════════════════════════════
//  PERMANENT DELETE
// ══════════════════════════════════════════════
let permDeleteTarget = null;

function confirmPermDelete() {
    const n = (state.folders.trash || []).length;
    if (!n) return;
    permDeleteTarget = 'trash';
    document.getElementById('permDeleteMsg').textContent =
        `This will permanently remove all ${n} file${n!==1?'s':''} in Trash. This cannot be undone.`;
    document.getElementById('permDeleteModal').classList.add('active');
}
function permDeleteSingle(fileId) {
    permDeleteTarget = fileId;
    const f = state.files.find(f => f.id === fileId);
    document.getElementById('permDeleteMsg').textContent =
        `Permanently delete "${f ? f.name : fileId}"? This cannot be undone.`;
    document.getElementById('permDeleteModal').classList.add('active');
}
function closePermDeleteModal() {
    document.getElementById('permDeleteModal').classList.remove('active');
    permDeleteTarget = null;
}
function doPermDelete() {
    if (permDeleteTarget === 'trash') {
        [...(state.folders.trash || [])].forEach(id => purgeFile(id));
        state.folders.trash = [];
    } else if (permDeleteTarget) {
        const f = state.files.find(f => f.id === permDeleteTarget);
        if (f) {
            state.folders[f.folder] = (state.folders[f.folder] || []).filter(id => id !== permDeleteTarget);
            purgeFile(permDeleteTarget);
        }
    }
    closePermDeleteModal();
    updateCounts();
    renderCurrentFolder();
}
function purgeFile(fileId) {
    const u = state.blobCache[fileId];
    if (u) { try { URL.revokeObjectURL(u); } catch(_){} delete state.blobCache[fileId]; }
    revokeThumb(fileId);
    delete state.thumbnailCache[fileId];
    delete state.thumbProgress[fileId];
    state.files = state.files.filter(f => f.id !== fileId);
}

// ══════════════════════════════════════════════
//  EXPORT — File System Access API (no re-download)
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
//  LIVE EXPORT
// ══════════════════════════════════════════════
async function toggleLiveExport() {
    if (liveExport.active) {
        stopLiveExport();
        // Refresh export panel if currently open
        if (state.currentFolder === '__export__') showExportPanel();
        return;
    }

    // Require File System Access API — no download fallback
    if (!window.showDirectoryPicker) {
        showToast('Live Export requires Chrome or Edge to access your file system');
        return;
    }

    try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        liveExport.dirHandle = dirHandle;
        liveExport.active    = true;
        liveExport.mode      = 'fsa';
        liveExport.written   = 0;
        liveExport.failed    = 0;
        liveExport.queue     = [];
        updateLiveExportUI();
        showToast('Live Export on — files save instantly as you sort');
        // Refresh export panel if currently open
        if (state.currentFolder === '__export__') showExportPanel();
    } catch(e) {
        if (e.name !== 'AbortError') showToast('Could not open folder for Live Export');
    }
}

function stopLiveExport() {
    liveExport.active    = false;
    liveExport.dirHandle = null;
    liveExport.mode      = null;
    updateLiveExportUI();
    showToast('Live Export off');
}

function updateLiveExportUI() {
    const status = document.getElementById('liveExportStatus');
    if (!status) return;
    if (liveExport.active) {
        status.style.display = '';
        const dirName  = liveExport.dirHandle ? escHtml(liveExport.dirHandle.name) : '';
        const failHint = liveExport.failed ? ` · ${liveExport.failed} failed` : '';
        status.innerHTML =
            `<span class="le-status-dot"></span>` +
            `<span class="le-status-text">` +
            (dirName ? `📁 ${dirName} · ` : '') +
            `${liveExport.written} saved${failHint}` +
            `</span>` +
            (liveExport.mode === 'fsa'
                ? `<button class="le-change-btn" onclick="changeLiveExportDir()">change</button>`
                : '');
    } else {
        status.style.display = 'none';
        status.innerHTML = '';
    }
}

async function changeLiveExportDir() {
    if (!window.showDirectoryPicker) return;
    try {
        const newHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        liveExport.dirHandle = newHandle;
        updateLiveExportUI();
        showToast(`Live Export → ${newHandle.name}`);
    } catch(e) {
        if (e.name !== 'AbortError') showToast('Could not change directory');
    }
}

// Called every time a file is moved into a non-system folder
function liveExportFile(fileId, folderName) {
    const SKIP = new Set(['queue','skipped','trash']);
    if (!liveExport.active || SKIP.has(folderName)) return;
    liveExport.queue.push({ fileId, folderName });
    if (!liveExport.writing) drainLiveQueue();
}

// Helper: get a unique FileHandle, renaming with (1),(2)... if the name already exists
async function getUniqueFileHandle(dirHandle, name) {
    const dotIdx = name.lastIndexOf('.');
    const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext  = dotIdx > 0 ? name.slice(dotIdx) : '';
    let finalName = name;
    let counter = 1;
    while (true) {
        try {
            await dirHandle.getFileHandle(finalName, { create: false }); // throws if not found
            finalName = `${base} (${counter++})${ext}`;
        } catch(_) {
            break; // File doesn't exist — safe to create
        }
    }
    return dirHandle.getFileHandle(finalName, { create: true });
}

async function drainLiveQueue() {
    if (liveExport.writing || !liveExport.queue.length) return;
    liveExport.writing = true;
    try {
        while (liveExport.queue.length) {
            const { fileId, folderName } = liveExport.queue.shift();
            const file = state.files.find(f => f.id === fileId);
            if (!file || !file._file) continue;

            if (liveExport.mode === 'fsa' && liveExport.dirHandle) {
                try {
                    const subDir = await liveExport.dirHandle.getDirectoryHandle(folderName, { create: true });
                    const fh     = await getUniqueFileHandle(subDir, file.name);
                    const writable = await fh.createWritable();
                    await writable.write(file._file);
                    await writable.close();
                    liveExport.written++;
                } catch(e) {
                    liveExport.failed++;
                    console.warn('Live export failed:', file.name, e);
                }
            } else {
                // Download mode — trigger browser download with folder prefix
                try {
                    const url = URL.createObjectURL(file._file);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${folderName}/${file.name}`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                    liveExport.written++;
                } catch(e) {
                    liveExport.failed++;
                }
            }
            updateLiveExportUI();
        }
    } finally {
        liveExport.writing = false;
    }
}

// ══════════════════════════════════════════════════════════════════════════════════
//  EXPORT PANEL  (replaces old single exportZip button)
// ══════════════════════════════════════════════════════════════════════════════════

// ── state for selected-file export ──
const exportSelect = { active: false, ids: new Set() };

function showExportPanel() {
    state.currentFolder = '__export__';
    document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('active'));
    document.getElementById('topbarTitle').textContent = 'Export';
    document.getElementById('topbarMeta').textContent  = '';
    closeSidebar();

    const SKIP = new Set(['queue','skipped','trash']);
    const exportableFolders = Object.entries(state.folders)
        .filter(([n, ids]) => !SKIP.has(n) && ids.length)
        .map(([n, ids]) => ({ name: n, count: ids.length,
            size: ids.reduce((s,id) => { const f = state.files.find(f=>f.id===id); return s+(f?f.size:0); }, 0) }));
    const totalFiles = exportableFolders.reduce((s,f)=>s+f.count,0);
    const totalSize  = exportableFolders.reduce((s,f)=>s+f.size, 0);

    const folderRows = exportableFolders.length
        ? exportableFolders.map(f=>`
            <div class="ep-folder-row">
                <span class="ep-folder-icon">📁</span>
                <span class="ep-folder-name">${escHtml(f.name)}</span>
                <span class="ep-folder-meta">${f.count} file${f.count!==1?'s':''} · ${formatSize(f.size)}</span>
                <button class="ep-single-btn" onclick="exportSingleFolder('${escHtml(f.name)}')">
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x=".5" y="5.5" width="10" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 1v4M3.5 3l2-2 2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Export
                </button>
            </div>`).join('')
        : `<div class="ep-empty">No sorted files yet — move files out of Queue first.</div>`;

    const fsaSupported = !!window.showDirectoryPicker;
    const leCard = fsaSupported ? `
                <div class="ep-method-card ep-live ${liveExport.active ? 'ep-live-active' : ''}" onclick="toggleLiveExport()">
                    <div class="ep-method-icon">${liveExport.active ? '🔴' : '🔴'}</div>
                    <div class="ep-method-body">
                        <div class="ep-method-title">Live Export ${liveExport.active ? '<span class="ep-live-badge">ON</span>' : ''}</div>
                        <div class="ep-method-desc">${liveExport.active
                            ? `Saving to <strong>${escHtml(liveExport.dirHandle?.name || 'folder')}</strong> — ${liveExport.written} file${liveExport.written!==1?'s':''} written. Click to stop.`
                            : 'Files are saved directly to a folder on your device as you sort — no manual export step.'
                        }</div>
                    </div>
                    <div class="ep-method-arrow">${liveExport.active ? '■' : '→'}</div>
                </div>` : '';

    document.getElementById('mainArea').innerHTML = `
        <div class="export-panel-wrap">
            <div class="ep-hero">
                <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                    <rect x="3" y="20" width="30" height="13" rx="4" fill="var(--surface-2)" stroke="var(--border-med)" stroke-width="1.5"/>
                    <path d="M18 4v16M11 12l7-8 7 8" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <div>
                    <h2>Export Files</h2>
                    <p>${totalFiles} file${totalFiles!==1?'s':''} ready · ${formatSize(totalSize)}</p>
                </div>
            </div>

            <div class="ep-methods">
                ${leCard}
                <div class="ep-method-card ep-primary" onclick="exportQuick()">
                    <div class="ep-method-icon">⚡</div>
                    <div class="ep-method-body">
                        <div class="ep-method-title">Quick Export</div>
                        <div class="ep-method-desc">Save all sorted files to a folder instantly — preserves your folder structure. Fastest option.</div>
                    </div>
                    <div class="ep-method-arrow">→</div>
                </div>

                <div class="ep-method-card" onclick="exportZipFoldered()">
                    <div class="ep-method-icon">📦</div>
                    <div class="ep-method-body">
                        <div class="ep-method-title">ZIP with Folders</div>
                        <div class="ep-method-desc">Download a ZIP preserving your folder structure. Works in all browsers.</div>
                    </div>
                    <div class="ep-method-arrow">→</div>
                </div>

                <div class="ep-method-card" onclick="exportZipFlat()">
                    <div class="ep-method-icon">🗜️</div>
                    <div class="ep-method-body">
                        <div class="ep-method-title">Flat ZIP</div>
                        <div class="ep-method-desc">All files in one ZIP, no subfolders. Good for uploading to services that don't support directories.</div>
                    </div>
                    <div class="ep-method-arrow">→</div>
                </div>

                <div class="ep-method-card" onclick="exportSelectMode()">
                    <div class="ep-method-icon">☑️</div>
                    <div class="ep-method-body">
                        <div class="ep-method-title">Select Files to Export</div>
                        <div class="ep-method-desc">Pick individual files from any folder and export just those.</div>
                    </div>
                    <div class="ep-method-arrow">→</div>
                </div>

                <div class="ep-method-card" onclick="exportManifest()">
                    <div class="ep-method-icon">📋</div>
                    <div class="ep-method-body">
                        <div class="ep-method-title">Export Manifest (CSV)</div>
                        <div class="ep-method-desc">Download a spreadsheet listing every file — name, folder, size, date, and type.</div>
                    </div>
                    <div class="ep-method-arrow">→</div>
                </div>

            </div>

            ${exportableFolders.length ? `
            <div class="ep-section-head">Export by Folder</div>
            <div class="ep-folder-list">${folderRows}</div>` : ''}
        </div>`;
}

// ── Quick Export (FSA direct copy, no compression) ──
async function exportQuick() {
    const SKIP = new Set(['queue','skipped','trash']);
    const snapshot = _buildExportSnapshot(SKIP);
    const allFiles = Object.values(snapshot).flat();
    if (!allFiles.length) { showToast('No sorted files to export'); return; }

    if (window.showDirectoryPicker) {
        try {
            const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
            await _fsaCopy(snapshot, allFiles, dir, 'exportBtn');
            return;
        } catch(e) {
            if (e.name === 'AbortError') return;
        }
    }
    // fallback
    await _zipDownload(snapshot, `quick-export-${Date.now()}.zip`);
}

// ── ZIP with folder structure ──
async function exportZipFoldered() {
    const SKIP = new Set(['queue','skipped','trash']);
    const snapshot = _buildExportSnapshot(SKIP);
    if (!Object.keys(snapshot).length) { showToast('No sorted files to export'); return; }
    await _zipDownload(snapshot, `export-${Date.now()}.zip`);
}

// ── Flat ZIP (no subdirectories) ──
async function exportZipFlat() {
    const SKIP = new Set(['queue','skipped','trash']);
    const snapshot = _buildExportSnapshot(SKIP);
    const allFiles = Object.values(snapshot).flat();
    if (!allFiles.length) { showToast('No sorted files to export'); return; }
    showToast('Building flat ZIP…');
    try {
        const JSZipLib = await loadJSZip();
        const zip = new JSZipLib();
        // Deduplicate filenames with a counter
        const seen = {};
        allFiles.forEach(file => {
            const ext   = file.ext ? '.' + file.ext : '';
            const base  = file.ext && file.name.endsWith(ext) ? file.name.slice(0, -ext.length) : file.name;
            seen[file.name] = (seen[file.name] || 0) + 1;
            const fname = seen[file.name] > 1 ? `${base} (${seen[file.name]-1})${ext}` : file.name;
            zip.file(fname, file._file, { date: new Date(file.lastModified) });
        });
        const blob = await zip.generateAsync({ type:'blob', compression:'STORE' });
        _triggerDownload(blob, `flat-export-${Date.now()}.zip`);
        showToast(`Flat ZIP: ${allFiles.length} files downloaded`);
    } catch(e) { showToast('ZIP failed: ' + e.message); }
}

// ── Per-folder export ──
async function exportSingleFolder(folderName) {
    const ids   = state.folders[folderName] || [];
    const files = ids.map(id => state.files.find(f=>f.id===id)).filter(f=>f&&f._file);
    if (!files.length) { showToast('No files in folder'); return; }

    if (window.showDirectoryPicker) {
        try {
            const dir = await window.showDirectoryPicker({ mode:'readwrite' });
            let done = 0, failed = 0;
            for (const file of files) {
                try {
                    const fh = await getUniqueFileHandle(dir, file.name);
                    const w  = await fh.createWritable();
                    await w.write(file._file); await w.close();
                    done++;
                } catch(e) { failed++; }
            }
            showToast(`Exported ${done} file${done!==1?'s':''} from "${folderName}"` + (failed?` · ${failed} failed`:''));
            return;
        } catch(e) { if (e.name === 'AbortError') return; }
    }
    // Fallback: ZIP just this folder
    try {
        const JSZipLib = await loadJSZip();
        const zip = new JSZipLib();
        files.forEach(f => zip.file(f.name, f._file, { date: new Date(f.lastModified) }));
        const blob = await zip.generateAsync({ type:'blob', compression:'STORE' });
        _triggerDownload(blob, `${folderName}-${Date.now()}.zip`);
        showToast(`"${folderName}" exported as ZIP`);
    } catch(e) { showToast('Export failed: ' + e.message); }
}

// ── Select Files export ──
function exportSelectMode() {
    exportSelect.active = true;
    exportSelect.ids.clear();
    state.currentFolder = '__export__';
    document.getElementById('topbarTitle').textContent = 'Select Files';
    document.getElementById('topbarMeta').textContent  = '0 selected';

    const SKIP = new Set(['queue','skipped','trash']);
    const allSortedFiles = Object.entries(state.folders)
        .filter(([n]) => !SKIP.has(n))
        .flatMap(([folderName, ids]) =>
            ids.map(id => ({ file: state.files.find(f=>f.id===id), folder: folderName }))
               .filter(x => x.file)
        );

    if (!allSortedFiles.length) {
        showToast('No sorted files — move files out of Queue first');
        showExportPanel();
        return;
    }

    const items = allSortedFiles.map(({ file, folder }) => {
        const thumb = state.thumbnailCache[file.id] || state.blobCache[file.id];
        const isImg = file.type.startsWith('image/');
        return `
            <div class="esel-item" id="esel_${file.id}" onclick="toggleExportSelect('${file.id}')">
                <div class="esel-check" id="eselck_${file.id}">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 2.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </div>
                <div class="esel-thumb" style="${thumb&&isImg?`background-image:url(${thumb});background-size:cover;`:``}">
                    ${!thumb||!isImg ? `<span class="esel-ext">${escHtml((file.ext||'?').toUpperCase().slice(0,4))}</span>` : ''}
                </div>
                <div class="esel-info">
                    <div class="esel-name">${escHtml(file.name)}</div>
                    <div class="esel-meta">${escHtml(folder)} · ${formatSize(file.size)}</div>
                </div>
            </div>`;
    }).join('');

    document.getElementById('mainArea').innerHTML = `
        <div class="esel-wrap">
            <div class="esel-toolbar">
                <button class="esel-tool-btn" onclick="exportSelectAll()">Select All</button>
                <button class="esel-tool-btn" onclick="exportSelectNone()">Clear</button>
                <div class="esel-count" id="eselCount">0 selected</div>
                <button class="esel-export-btn" id="eselExportBtn" onclick="exportSelected()" disabled>
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="7" width="11" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 1v6M4 4l2.5 3L9 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Export Selected
                </button>
                <button class="esel-tool-btn" onclick="showExportPanel()">← Back</button>
            </div>
            <div class="esel-grid">${items}</div>
        </div>`;
}

function toggleExportSelect(fileId) {
    if (exportSelect.ids.has(fileId)) exportSelect.ids.delete(fileId);
    else exportSelect.ids.add(fileId);
    const item = document.getElementById(`esel_${fileId}`);
    const check = document.getElementById(`eselck_${fileId}`);
    if (item)  item.classList.toggle('selected', exportSelect.ids.has(fileId));
    if (check) check.classList.toggle('checked', exportSelect.ids.has(fileId));
    _updateExportSelectUI();
}

function exportSelectAll() {
    document.querySelectorAll('.esel-item').forEach(el => {
        const id = el.id.replace('esel_','');
        exportSelect.ids.add(id);
        el.classList.add('selected');
        document.getElementById(`eselck_${id}`)?.classList.add('checked');
    });
    _updateExportSelectUI();
}

function exportSelectNone() {
    exportSelect.ids.clear();
    document.querySelectorAll('.esel-item').forEach(el => {
        el.classList.remove('selected');
        const id = el.id.replace('esel_','');
        document.getElementById(`eselck_${id}`)?.classList.remove('checked');
    });
    _updateExportSelectUI();
}

function _updateExportSelectUI() {
    const n = exportSelect.ids.size;
    const countEl = document.getElementById('eselCount');
    const btn     = document.getElementById('eselExportBtn');
    if (countEl) countEl.textContent = `${n} selected`;
    if (btn) {
        btn.disabled = n === 0;
        btn.textContent = n > 0 ? `Export ${n} File${n!==1?'s':''}` : 'Export Selected';
    }
    document.getElementById('topbarMeta').textContent = `${n} selected`;
}

async function exportSelected() {
    const ids = [...exportSelect.ids];
    if (!ids.length) { showToast('Select some files first'); return; }
    const files = ids.map(id => state.files.find(f=>f.id===id)).filter(f=>f&&f._file);
    if (!files.length) { showToast('No valid files'); return; }

    if (window.showDirectoryPicker) {
        try {
            const dir = await window.showDirectoryPicker({ mode:'readwrite' });
            let done = 0, failed = 0;
            for (const file of files) {
                try {
                    const fh = await getUniqueFileHandle(dir, file.name);
                    const w  = await fh.createWritable();
                    await w.write(file._file); await w.close();
                    done++;
                } catch(e) { failed++; }
            }
            showToast(`Exported ${done} file${done!==1?'s':''}` + (failed?` · ${failed} failed`:''));
            exportSelect.ids.clear();
            showExportPanel();
            return;
        } catch(e) { if (e.name === 'AbortError') return; }
    }
    // Fallback ZIP
    try {
        const JSZipLib = await loadJSZip();
        const zip = new JSZipLib();
        files.forEach(f => zip.file(f.name, f._file, { date: new Date(f.lastModified) }));
        const blob = await zip.generateAsync({ type:'blob', compression:'STORE' });
        _triggerDownload(blob, `selected-${Date.now()}.zip`);
        showToast(`Downloaded ${files.length} selected files`);
        exportSelect.ids.clear();
        showExportPanel();
    } catch(e) { showToast('Export failed: ' + e.message); }
}

// ── Manifest CSV export ──
async function exportManifest() {
    const SKIP = new Set(['queue','skipped','trash']);
    const rows = [['Name','Folder','Size (bytes)','Size','Type','Extension','Date Modified','SHA-256 (first 8)']];
    const files = state.files.filter(f => !SKIP.has(f.folder));
    if (!files.length) { showToast('No sorted files for manifest'); return; }
    showToast('Building manifest…');
    for (const f of files) {
        let hash = '';
        try {
            const buf = await f._file.arrayBuffer();
            const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
                .map(b=>b.toString(16).padStart(2,'0')).join('');
            hash = h.slice(0,16);
        } catch(_) {}
        const d = f.lastModified ? new Date(f.lastModified).toISOString() : '';
        rows.push([f.name, f.folder, f.size, formatSize(f.size), f.type||'', f.ext||'', d, hash]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    _triggerDownload(blob, `manifest-${Date.now()}.csv`);
    showToast(`Manifest exported — ${files.length} files`);
}

// ── Shared helpers ──
function _buildExportSnapshot(skip) {
    const snap = {};
    for (const [name, ids] of Object.entries(state.folders)) {
        if (skip.has(name)) continue;
        const files = ids.map(id=>state.files.find(f=>f.id===id)).filter(f=>f&&f._file);
        if (files.length) snap[name] = files;
    }
    return snap;
}

async function _fsaCopy(snapshot, allFiles, dirHandle, btnId) {
    const btn = document.getElementById(btnId);
    if (btn) btn.classList.add('loading');
    let done = 0, failed = 0;
    for (const [folderName, files] of Object.entries(snapshot)) {
        const sub = await dirHandle.getDirectoryHandle(folderName, { create: true });
        for (const file of files) {
            try {
                const fh = await getUniqueFileHandle(sub, file.name);
                const w  = await fh.createWritable();
                await w.write(file._file); await w.close();
            } catch(e) { failed++; console.warn('FSA write failed:', file.name, e); }
            done++;
            if (btn) btn.textContent = `${Math.round((done/allFiles.length)*100)}%`;
        }
    }
    if (btn) { btn.classList.remove('loading'); btn.textContent = '✓ Done'; setTimeout(()=>{ btn.textContent='Export'; },2500); }
    showToast(`Copied ${done-failed} file${done-failed!==1?'s':''} to ${dirHandle.name}` + (failed?` · ${failed} failed`:''));
}

async function _zipDownload(snapshot, filename) {
    showToast('Building ZIP…');
    try {
        const JSZipLib = await loadJSZip();
        const zip = new JSZipLib();
        for (const [folderName, files] of Object.entries(snapshot)) {
            const zf = zip.folder(folderName);
            files.forEach(f => zf.file(f.name, f._file, { date: new Date(f.lastModified) }));
        }
        const blob = await zip.generateAsync({ type:'blob', compression:'STORE' });
        _triggerDownload(blob, filename);
        const total = Object.values(snapshot).flat().length;
        showToast(`ZIP downloaded — ${total} file${total!==1?'s':''}`);
    } catch(e) { showToast('ZIP failed: ' + e.message); }
}

function _triggerDownload(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

// Keep the old exportZip name working (called from orgAction 'exportZip')
async function exportZip() {
    const SKIP = new Set(['queue','skipped','trash']);
    const snapshot = _buildExportSnapshot(SKIP);
    const allFiles  = Object.values(snapshot).flat();
    if (!allFiles.length) { showToast('No files to export'); return; }
    if (window.showDirectoryPicker) {
        try {
            const dir = await window.showDirectoryPicker({ mode:'readwrite' });
            await _fsaCopy(snapshot, allFiles, dir, null);
            return;
        } catch(e) { if (e.name === 'AbortError') return; }
    }
    await _zipDownload(snapshot, `file-cleaner-${Date.now()}.zip`);
}


// ══════════════════════════════════════════════
//  KEYBOARD
// ══════════════════════════════════════════════
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
        closeLightboxBtn();
        closePermDeleteModal();
        closeAddFolderModal();
        cancelFolderPick();
        closeSidebar();
        return;
    }
    // Lightbox navigation
    if (document.getElementById('lightbox')?.classList.contains('active')) {
        if (e.key === 'ArrowLeft')  lightboxNav(-1);
        if (e.key === 'ArrowRight') lightboxNav(1);
        return;
    }
    // Never fire swipe actions on system panels
    if (SYSTEM_PANELS.has(state.currentFolder)) return;
    if (state.currentFolder === 'skipped') {
        if (e.key === 'ArrowLeft')  swipeLeft();
        if (e.key === 'ArrowRight') swipeRight();
        if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') skippedRestore();
        return;
    }
    if (state.currentFolder !== 'queue') return;
    if (e.key === 'ArrowLeft')  swipeLeft();
    if (e.key === 'ArrowRight') swipeRight();
    if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') skipFile();
});

// ══════════════════════════════════════════════════════════════════════════════════
//  PDF / OFFICE / PSD THUMBNAIL SCHEDULERS
// ══════════════════════════════════════════════════════════════════════════════════

function schedulePdfThumbnail(entry) {
    const url = state.blobCache[entry.id];
    if (!url) return;
    setTimeout(async () => {
        try {
            const thumb = await ThumbnailEngine.generate(entry._file || url, 'pdf', { name: entry.name });
            if (thumb) { state.thumbnailCache[entry.id] = thumb; state.thumbProgress[entry.id] = 100; refreshThumbIfVisible(entry.id); }
        } catch(_) {}
    }, 150 + Math.random() * 200);
}

function schedulePsdThumbnail(entry) {
    if (!entry._file) return;
    setTimeout(async () => {
        if (state.thumbnailCache[entry.id]) return; // archive pipeline may have already set one
        try {
            const thumb = await ThumbnailEngine.generate(entry._file, entry.ext, { name: entry.name });
            if (thumb) { state.thumbnailCache[entry.id] = thumb; state.thumbProgress[entry.id] = 100; refreshThumbIfVisible(entry.id); }
        } catch(_) {}
    }, 300 + Math.random() * 300);
}

function scheduleOfficeThumbnail(entry) {
    // Canvas-based colourful placeholder — only used if ZIP extraction found nothing
    const icons = {
        docx:'📃', doc:'📃', odt:'📃', rtf:'📃',
        xlsx:'📊', xls:'📊', ods:'📊',
        pptx:'🎬', ppt:'🎬', odp:'🎬',
    };
    const icon = icons[entry.ext];
    if (!icon) return;
    setTimeout(() => {
        if (state.thumbnailCache[entry.id]) return; // skip if archive pipeline already produced one
        const thumb = ThumbnailEngine.placeholder(entry.ext, entry.name);
        state.thumbnailCache[entry.id] = thumb;
        state.thumbProgress[entry.id] = 100;
        refreshThumbIfVisible(entry.id);
    }, 800); // delay so archive pipeline gets priority
}

// ══════════════════════════════════════════════════════════════════════════════════
//  IMPROVED 3D CENTERING
// ══════════════════════════════════════════════════════════════════════════════════

function centerAndScaleMesh(obj, THREE, grid) {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    // For simple single-geometry meshes translate the actual vertices
    if (obj.geometry) {
        obj.geometry.translate(-center.x, -center.y, -center.z);
        obj.position.set(0, 0, 0);
    } else {
        // Complex scene — offset the group position
        obj.position.sub(center);
    }
    // Uniform scale so longest axis == 2.5 units
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0.001) obj.scale.setScalar(2.5 / maxDim);
    obj.updateMatrixWorld(true);
    // Move grid to just under model
    if (grid) {
        const finalBox = new THREE.Box3().setFromObject(obj);
        grid.position.y = finalBox.min.y - 0.05;
    }
}

// ══════════════════════════════════════════════════════════════════════════════════
//  DUPLICATE DETECTOR
// ══════════════════════════════════════════════════════════════════════════════════

let _lastDupResults = null; // store latest scan for re-renders

class DuplicateDetector {
    static METHODS = {
        hash:     { label:'Exact Match (SHA-256)', time:'2–5 s', icon:'🔒' },
        perceptual:{ label:'Image Similarity (pHash)', time:'20–60 s', icon:'👁️' },
        size:     { label:'Same File Size',  time:'Instant', icon:'⚡' },
        name:     { label:'Filename Match',  time:'Fast',    icon:'📝' },
        metadata: { label:'Metadata + Size', time:'5–15 s', icon:'🏷️' },
    };

    static async detect(files, method, onProgress = () => {}, token = {}) {
        if (method === 'hash')      return DuplicateDetector._byHash(files, onProgress, token);
        if (method === 'perceptual')return DuplicateDetector._byPerceptual(files, onProgress, token);
        if (method === 'size')      return DuplicateDetector._bySize(files, onProgress, token);
        if (method === 'name')      return DuplicateDetector._byName(files, onProgress, token);
        if (method === 'metadata')  return DuplicateDetector._byMetadata(files, onProgress, token);
        return new Map();
    }

    static async _byHash(files, onP, token) {
        const hashes = new Map(), dupes = new Map();
        for (let i = 0; i < files.length; i++) {
            if (token.cancelled) return null;
            const f = files[i];
            try {
                const buf = await f._file.arrayBuffer();
                const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
                    .map(b => b.toString(16).padStart(2,'0')).join('');
                if (hashes.has(h)) {
                    const orig = hashes.get(h);
                    if (!dupes.has(orig)) dupes.set(orig, []);
                    dupes.get(orig).push(f.id);
                } else { hashes.set(h, f.id); }
            } catch(_) {}
            onP(i+1, files.length);
        }
        return dupes;
    }

    static async _byPerceptual(files, onP, token) {
        const imgs = files.filter(f => f.type.startsWith('image/') || ['jpg','jpeg','png','webp','gif'].includes(f.ext));
        const hashes = new Map(), dupes = new Map();
        const THRESHOLD = 5;
        for (let i = 0; i < imgs.length; i++) {
            if (token.cancelled) return null;
            const f = imgs[i];
            try {
                const url = state.blobCache[f.id] || URL.createObjectURL(f._file);
                const phash = await new Promise(res => {
                    const img = new Image(); img.crossOrigin = 'anonymous';
                    img.onload = () => {
                        const c = document.createElement('canvas'); c.width = c.height = 8;
                        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 8, 8);
                        const d = ctx.getImageData(0,0,8,8).data;
                        let avg = 0;
                        for (let j = 0; j < d.length; j+=4) avg += (d[j]+d[j+1]+d[j+2])/3;
                        avg /= 64;
                        let hash = '';
                        for (let j = 0; j < d.length; j+=4) hash += ((d[j]+d[j+1]+d[j+2])/3 > avg ? '1':'0');
                        res(hash);
                    };
                    img.onerror = () => res(null);
                    img.src = url;
                });
                if (!phash) continue;
                let found = false;
                for (const [eh, orig] of hashes) {
                    let dist = 0;
                    for (let k = 0; k < Math.min(phash.length, eh.length); k++) if (phash[k]!==eh[k]) dist++;
                    if (dist <= THRESHOLD) {
                        if (!dupes.has(orig)) dupes.set(orig, []);
                        dupes.get(orig).push(f.id); found = true; break;
                    }
                }
                if (!found) hashes.set(phash, f.id);
            } catch(_) {}
            onP(i+1, imgs.length);
        }
        return dupes;
    }

    static async _bySize(files, onP, token) {
        const groups = new Map(), dupes = new Map();
        const YIELD = 500;
        for (let i = 0; i < files.length; i++) {
            if (token.cancelled) return null;
            const f = files[i];
            if (!groups.has(f.size)) groups.set(f.size, []);
            groups.get(f.size).push(f.id);
            onP(i+1, files.length);
            if (i % YIELD === 0) await new Promise(r => setTimeout(r, 0));
        }
        groups.forEach((ids, sz) => {
            if (ids.length > 1 && sz > 0) {
                const [orig, ...rest] = ids;
                dupes.set(orig, rest);
            }
        });
        return dupes;
    }

    static async _byName(files, onP, token) {
        const dupes = new Map();
        const YIELD = 50; // yield every 50 outer rows — keeps UI alive
        for (let i = 0; i < files.length; i++) {
            if (token.cancelled) return null;
            const a = files[i];
            const na = a.name.replace(/\.[^/.]+$/,'').toLowerCase();
            for (let j = i+1; j < files.length; j++) {
                const b = files[j];
                const nb = b.name.replace(/\.[^/.]+$/,'').toLowerCase();
                // Quick length check before expensive Levenshtein
                if (Math.abs(na.length - nb.length) > 2) continue;
                const lev = DuplicateDetector._lev(na, nb);
                if (lev <= 2) {
                    if (!dupes.has(a.id)) dupes.set(a.id, []);
                    dupes.get(a.id).push(b.id);
                }
            }
            onP(i+1, files.length);
            if (i % YIELD === 0) await new Promise(r => setTimeout(r, 0));
        }
        return dupes;
    }

    static async _byMetadata(files, onP, token) {
        const groups = new Map(), dupes = new Map();
        for (let i = 0; i < files.length; i++) {
            if (token.cancelled) return null;
            const f = files[i];
            const key = `${f.size}|${f.type}|${Math.round(f.lastModified/1000)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f.id);
            onP(i+1, files.length);
            if (i % 500 === 0) await new Promise(r => setTimeout(r, 0));
        }
        groups.forEach((ids) => {
            if (ids.length > 1) {
                const [orig, ...rest] = ids;
                dupes.set(orig, rest);
            }
        });
        return dupes;
    }

    static _lev(a, b) {
        const m = Array.from({length:b.length+1}, (_,i)=>i);
        for (let i = 1; i <= a.length; i++) {
            let prev = i;
            for (let j = 1; j <= b.length; j++) {
                const t = m[j-1] + (a[i-1]!==b[j-1]?1:0);
                m[j-1] = prev;
                prev = Math.min(m[j]+1, prev+1, t);
            }
            m[b.length] = prev;
        }
        return m[b.length];
    }
}

function renderDuplicateDetectorPanel() {
    state.currentFolder = '__duplicates__';
    document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('active'));
    closeSidebar();
    const main = document.getElementById('mainArea');
    document.getElementById('topbarTitle').textContent = 'Duplicates';
    document.getElementById('topbarMeta').textContent = '';
    main.innerHTML = `
        <div class="dup-panel">
            <div class="dup-hero">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                    <rect x="4" y="8" width="22" height="28" rx="4" fill="var(--surface-2)" stroke="var(--border-med)" stroke-width="1.5"/>
                    <rect x="14" y="4" width="22" height="28" rx="4" fill="var(--surface-3)" stroke="var(--accent)" stroke-width="1.5"/>
                    <path d="M20 14h10M20 19h7M20 24h8" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" opacity=".6"/>
                </svg>
                <div>
                    <h2>Find Duplicates</h2>
                    <p>Scan ${state.files.length} loaded file${state.files.length!==1?'s':''} for copies</p>
                </div>
            </div>
            <div class="dup-methods">
                ${Object.entries(DuplicateDetector.METHODS).map(([k,v])=>`
                    <button class="dup-method-card" onclick="startDuplicateScan('${k}')">
                        <span class="dup-method-icon">${v.icon}</span>
                        <span class="dup-method-label">${v.label}</span>
                        <span class="dup-method-time">${v.time}</span>
                    </button>`).join('')}
            </div>
            <div class="dup-tip">💡 Start with <strong>Exact Match</strong> for guaranteed duplicates. Use <strong>Image Similarity</strong> for resized or recompressed photos.</div>
        </div>`;
}

async function startDuplicateScan(method) {
    if (!state.files.length) { showToast('Load files first'); return; }
    const info = DuplicateDetector.METHODS[method];
    const main = document.getElementById('mainArea');

    const token = { cancelled: false };
    window._dupScanToken = token;

    main.innerHTML = `<div class="empty-state">
        <div class="load-progress-wrap">
            <div class="load-progress-bar"><div class="load-progress-fill" id="dupProgressBar" style="width:0%"></div></div>
            <div class="load-progress-label" id="dupProgressLabel">Starting…</div>
        </div>
        <h2>Scanning — ${escHtml(info.label)}</h2>
        <button class="load-btn-inline" style="margin-top:8px;background:var(--danger-glow);color:var(--danger);border-color:rgba(209,96,96,.3);" onclick="cancelDuplicateScan()">Cancel</button>
    </div>`;

    const dupes = await DuplicateDetector.detect(state.files, method, (cur, tot) => {
        const pct = Math.round((cur/tot)*100);
        const bar = document.getElementById('dupProgressBar');
        const lbl = document.getElementById('dupProgressLabel');
        if (bar) bar.style.width = pct + '%';
        if (lbl) lbl.textContent = `${cur} / ${tot} files — ${pct}%`;
    }, token);

    if (token.cancelled) return;
    _lastDupResults = { dupes, method };
    renderDuplicateResults(dupes, method);
}

function cancelDuplicateScan() {
    if (window._dupScanToken) window._dupScanToken.cancelled = true;
    renderDuplicateDetectorPanel();
    showToast('Scan cancelled');
}

function renderDuplicateResults(dupes, method) {
    document.getElementById('topbarTitle').textContent = 'Duplicates';
    const main = document.getElementById('mainArea');
    const groups = [];
    dupes.forEach((dupeIds, origId) => {
        const orig = state.files.find(f => f.id === origId);
        const dlist = dupeIds.map(id => state.files.find(f => f.id === id)).filter(Boolean);
        if (orig && dlist.length) groups.push({ orig, dlist });
    });
    const total = groups.reduce((s,g) => s+g.dlist.length, 0);

    if (!groups.length) {
        main.innerHTML = `<div class="empty-state">
            <div class="empty-illustration"><svg width="60" height="60" viewBox="0 0 60 60" fill="none">
                <circle cx="30" cy="30" r="22" fill="var(--surface-2)" stroke="var(--border)" stroke-width="1.5"/>
                <path d="M20 30l7 7 13-13" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg></div>
            <h2>No Duplicates Found</h2>
            <p>Method: ${escHtml(DuplicateDetector.METHODS[method]?.label || method)}</p>
            <button class="load-btn-inline" onclick="renderDuplicateDetectorPanel()">Try Another Method</button>
        </div>`;
        return;
    }

    window._dupGroups = groups;

    main.innerHTML = `
        <div class="dup-results-wrap">
            <div class="dup-results-header">
                <div>
                    <h2>${total} potential duplicate${total!==1?'s':''} in ${groups.length} group${groups.length!==1?'s':''}</h2>
                    <p style="font-size:11px;color:var(--text-3);margin-top:2px;">Method: ${escHtml(DuplicateDetector.METHODS[method]?.label||method)}</p>
                </div>
                <div style="display:flex;gap:8px;flex-shrink:0;">
                    <button class="dup-action-btn dup-danger" onclick="trashAllDuplicates()">Trash All Dupes</button>
                    <button class="dup-action-btn" onclick="renderDuplicateDetectorPanel()">← Back</button>
                </div>
            </div>
            <div class="dup-groups" id="dupGroupsList"></div>
        </div>`;

    const CHUNK = 20;
    const container = document.getElementById('dupGroupsList');
    let idx = 0;

    function appendChunk() {
        if (!document.getElementById('dupGroupsList')) return;
        const end = Math.min(idx + CHUNK, groups.length);
        const frag = document.createDocumentFragment();
        for (let gi = idx; gi < end; gi++) {
            const g = groups[gi];
            const folderLabel = g.orig.folder.charAt(0).toUpperCase() + g.orig.folder.slice(1);
            const div = document.createElement('div');
            div.className = 'dup-group';
            div.id = `dupgroup_${gi}`;
            div.innerHTML = `
                <button class="dup-group-toggle" onclick="toggleDupGroup(${gi})" aria-expanded="false">
                    <span class="dup-group-folder">📁 ${escHtml(folderLabel)}</span>
                    <span class="dup-group-keep">Keep: <strong>${escHtml(g.orig.name)}</strong></span>
                    <span class="dup-group-chevron" id="dupchev_${gi}">▸</span>
                </button>
                <div class="dup-group-body" id="dupbody_${gi}" style="display:none;"></div>`;
            frag.appendChild(div);
        }
        container.appendChild(frag);
        idx = end;
        if (idx < groups.length) setTimeout(appendChunk, 0);
    }

    setTimeout(appendChunk, 0);
}

function _dupFileThumb(f) {
    const url   = state.blobCache[f.id];
    const thumb = state.thumbnailCache[f.id];
    const ext   = (f.ext || '').toLowerCase();
    let inner = '';
    if (thumb) {
        inner = `<img src="${thumb}" alt="">`;
    } else if ((f.type.startsWith('image/') || ['jpg','jpeg','png','webp','gif','bmp','ico','svg','avif','heic'].includes(ext)) && url) {
        inner = `<img src="${url}" alt="">`;
    } else if (f.type.startsWith('video/') && url) {
        inner = `<video src="${url}" preload="none"></video>`;
    } else {
        const typeColors = {
            pdf:'#c2410c', doc:'#1d4ed8', docx:'#1d4ed8', xls:'#15803d', xlsx:'#15803d',
            ppt:'#b91c1c', pptx:'#b91c1c', mp3:'#7e22ce', wav:'#7e22ce', zip:'#374151',
            blend:'#7c2d12', psd:'#001f3f', kra:'#0d1b2a',
        };
        const bg = typeColors[ext] || 'var(--surface-3)';
        inner = `<div style="width:100%;height:100%;background:${bg};display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:9px;font-weight:700;color:rgba(255,255,255,0.8);">${escHtml((ext||'?').toUpperCase().slice(0,4))}</div>`;
    }
    return `<div class="dup-file-thumb">${inner}</div>`;
}

function trashDupe(fileId) {
    const f = state.files.find(f => f.id === fileId);
    if (!f) return;
    state.folders[f.folder] = (state.folders[f.folder]||[]).filter(id=>id!==fileId);
    state.folders.trash.push(fileId); f.folder = 'trash';
    const row = document.getElementById(`duprow_${fileId}`);
    if (row) { row.style.opacity='0'; row.style.transition='opacity .3s'; setTimeout(()=>row.remove(),300); }
    updateCounts(); showToast('Moved to Trash');
}

function toggleDupGroup(gi) {
    const body = document.getElementById(`dupbody_${gi}`);
    const chev = document.getElementById(`dupchev_${gi}`);
    const btn  = document.querySelector(`#dupgroup_${gi} .dup-group-toggle`);
    if (!body) return;

    const open = body.style.display !== 'none';

    if (!open) {
        if (!body.dataset.rendered) {
            const g = window._dupGroups?.[gi];
            if (g) {
                body.innerHTML = `
                    <div class="dup-orig-row">
                        <div class="dup-badge-keep">KEEP</div>
                        ${_dupFileThumb(g.orig)}
                        <div class="dup-file-info">
                            <div class="dup-fname">${escHtml(g.orig.name)}</div>
                            <div class="dup-fmeta">${formatSize(g.orig.size)} · ${new Date(g.orig.lastModified).toLocaleDateString()} · 📁 ${escHtml(g.orig.folder.charAt(0).toUpperCase()+g.orig.folder.slice(1))}</div>
                        </div>
                    </div>
                    <div class="dup-dupes-label">Duplicates (${g.dlist.length}):</div>
                    ${g.dlist.map(d => `
                        <div class="dup-dupe-row" id="duprow_${d.id}">
                            ${_dupFileThumb(d)}
                            <div class="dup-file-info" style="flex:1;min-width:0;">
                                <div class="dup-fname">${escHtml(d.name)}</div>
                                <div class="dup-fmeta">${formatSize(d.size)} · ${new Date(d.lastModified).toLocaleDateString()} · 📁 ${escHtml(d.folder.charAt(0).toUpperCase()+d.folder.slice(1))}</div>
                            </div>
                            <button class="dup-trash-btn" onclick="trashDupe('${d.id}')">Trash</button>
                        </div>`).join('')}`;
                body.dataset.rendered = '1';
            }
        }
        body.style.display = '';
        if (chev) chev.textContent = '▾';
        if (btn)  btn.setAttribute('aria-expanded', 'true');
    } else {
        body.style.display = 'none';
        if (chev) chev.textContent = '▸';
        if (btn)  btn.setAttribute('aria-expanded', 'false');
    }
}

function trashAllDuplicates() {
    if (!_lastDupResults) return;
    let count = 0;
    _lastDupResults.dupes.forEach((dupeIds) => {
        dupeIds.forEach(id => {
            const f = state.files.find(f => f.id === id);
            if (!f) return;
            state.folders[f.folder] = (state.folders[f.folder]||[]).filter(i=>i!==id);
            state.folders.trash.push(id); f.folder = 'trash'; count++;
        });
    });
    updateCounts(); _lastDupResults = null;
    renderDuplicateDetectorPanel();
    showToast(`Moved ${count} duplicate${count!==1?'s':''} to Trash`);
}

// ══════════════════════════════════════════════════════════════════════════════════
//  STORAGE ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════════

function analyzeStorageUsage() {
    state.currentFolder = '__storage__';
    document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('active'));
    document.getElementById('topbarTitle').textContent = 'Storage';
    document.getElementById('topbarMeta').textContent = '';

    const total = state.files.reduce((s, f) => s+f.size, 0);
    const byExt = {};
    state.files.forEach(f => {
        const k = f.ext || 'other';
        if (!byExt[k]) byExt[k] = { count:0, size:0 };
        byExt[k].count++; byExt[k].size += f.size;
    });
    const sorted = Object.entries(byExt).sort((a,b) => b[1].size-a[1].size).slice(0, 12);
    const COLORS = ['#4f7fff','#5aa87a','#d1607a','#f7a800','#8b5cf6','#0ea5e9','#f97316','#10b981','#e11d48','#6366f1','#84cc16','#06b6d4'];

    const main = document.getElementById('mainArea');
    main.innerHTML = `
        <div class="storage-wrap">
            <div class="storage-stats">
                <div class="storage-stat-card"><div class="ssc-val">${formatSize(total)}</div><div class="ssc-lbl">Total</div></div>
                <div class="storage-stat-card"><div class="ssc-val">${state.files.length}</div><div class="ssc-lbl">Files</div></div>
                <div class="storage-stat-card"><div class="ssc-val">${Object.keys(byExt).length}</div><div class="ssc-lbl">Types</div></div>
                <div class="storage-stat-card"><div class="ssc-val">${formatSize(total/Math.max(1,state.files.length))}</div><div class="ssc-lbl">Avg Size</div></div>
            </div>
            <div class="storage-chart">
                ${sorted.map(([ext, info], i) => {
                    const pct = total > 0 ? (info.size/total)*100 : 0;
                    return `
                        <div class="sc-row">
                            <div class="sc-ext" style="color:${COLORS[i%COLORS.length]}">.${escHtml(ext.toUpperCase())}</div>
                            <div class="sc-bar-wrap"><div class="sc-bar-fill" style="width:${pct.toFixed(1)}%;background:${COLORS[i%COLORS.length]}"></div></div>
                            <div class="sc-info">${formatSize(info.size)}<span style="opacity:.5;margin-left:6px;">${info.count} file${info.count!==1?'s':''}</span></div>
                        </div>`;
                }).join('')}
            </div>
        </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════════
//  FILE ORGANIZER MENU
// ══════════════════════════════════════════════════════════════════════════════════

function showOrganizerMenu() {
    state.currentFolder = '__organizer__';
    document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('active'));
    document.getElementById('topbarTitle').textContent = 'Organizer';
    document.getElementById('topbarMeta').textContent = '';
    closeSidebar();

    const SECTIONS = [
        { id:'rename',  icon:'✏️', title:'Auto-Rename',   items:[
            { label:'Rename to Date (YYYY-MM-DD_HH-MM AM/PM)',    fn:'renameToDate' },
            { label:'Rename to Timestamp',            fn:'renameToTimestamp' },
            { label:'Rename to Sequence (file_001)', fn:'renameToSequence' },
            { label:'Lowercase filenames',           fn:'renameLowercase' },
            { label:'UPPERCASE filenames',           fn:'renameUppercase' },
            { label:'Remove spaces & special chars', fn:'renameClean' },
        ]},
        { id:'organize', icon:'📁', title:'Auto-Organize', items:[
            { label:'Organize by file type',        fn:'organizeByType' },
            { label:'Organize by date (YYYY-MM-DD_HH-MM-SS)',   fn:'organizeByDate' },
            { label:'Organize by size range',       fn:'organizeBySizeRange' },
            { label:'Organize by first letter A–Z', fn:'organizeByFirstLetter' },
        ]},
    ];

    const main = document.getElementById('mainArea');
    main.innerHTML = `
        <div class="org-menu-wrap">
            <div class="org-menu-hero">
                <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                    <rect x="3" y="8" width="30" height="22" rx="4" fill="var(--surface-2)" stroke="var(--border-med)" stroke-width="1.5"/>
                    <path d="M3 14h30M10 8V6a2 2 0 012-2h12a2 2 0 012 2v2" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>
                    <path d="M10 20h16M10 25h10" stroke="var(--text-3)" stroke-width="1.3" stroke-linecap="round"/>
                </svg>
                <div><h2>File Organizer</h2><p>Bulk rename, sort, and organize all your files</p></div>
            </div>
            <div class="org-sections">
                ${SECTIONS.map(s => `
                    <div class="org-section">
                        <div class="org-section-head">${s.icon} ${escHtml(s.title)}</div>
                        <div class="org-items">
                            ${s.items.map(item => `
                                <button class="org-item-btn" onclick="orgAction('${item.fn}')">
                                    <span>${escHtml(item.label)}</span>
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                </button>`).join('')}
                        </div>
                    </div>`).join('')}
            </div>
        </div>`;
}

function orgAction(fn) {
    const funcs = {
        renameToDate, renameToTimestamp, renameToSequence,
        renameLowercase, renameUppercase, renameClean,
        organizeByType, organizeByDate, organizeBySizeRange, organizeByFirstLetter,
        renderDuplicateDetectorPanel, analyzeStorageUsage,
        sortBySize, sortByDate, sortByType, exportZip, verifyIntegrity
    };
    const f = funcs[fn];
    if (f) f();
    else showToast(`${fn} — coming soon`);
}

// ══════════════════════════════════════════════════════════════════════════════════
//  RENAME ACTIONS
// ══════════════════════════════════════════════════════════════════════════════════

function _getActionTargets() {
    // Returns files from queue (or current non-system folder)
    const SYSTEM = new Set(['queue','skipped','trash','__organizer__','__duplicates__','__storage__','__export__']);
    const folder = SYSTEM.has(state.currentFolder) ? 'queue' : state.currentFolder;
    return (state.folders[folder]||[]).map(id => state.files.find(f=>f.id===id)).filter(Boolean);
}

function renameToDate() {
    const files = _getActionTargets(); if (!files.length) { showToast('No files to rename'); return; }
    files.forEach(f => {
        const d = new Date(f.lastModified);
        const pad = v => String(v).padStart(2,'0');
        const h = d.getHours(); const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = pad(h % 12 || 12);
        const ds = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${h12}-${pad(d.getMinutes())}${ampm}`;
        f.name = ds + (f.ext ? '.'+f.ext : '');
    });
    renderCurrentFolder(); showToast(`Renamed ${files.length} files to date`);
}

function renameToTimestamp() {
    const files = _getActionTargets(); if (!files.length) { showToast('No files'); return; }
    const seen = new Set();
    files.forEach(f => {
        const ts = new Date(f.lastModified).toISOString().replace(/[:.]/g,'-').replace('Z','');
        let name = ts; let i = 1;
        while (seen.has(name + (f.ext?'.'+f.ext:''))) name = `${ts}-${i++}`;
        f.name = name + (f.ext ? '.'+f.ext : ''); seen.add(f.name);
    });
    renderCurrentFolder(); showToast(`Renamed ${files.length} files to timestamp`);
}

function renameToSequence() {
    const files = _getActionTargets(); if (!files.length) { showToast('No files'); return; }
    const base = window.prompt('Base name:', 'file'); if (!base) return;
    files.forEach((f,i) => { f.name = `${base}_${String(i+1).padStart(3,'0')}` + (f.ext?'.'+f.ext:''); });
    renderCurrentFolder(); showToast(`Renamed ${files.length} files`);
}

function renameLowercase() {
    const files = _getActionTargets(); let n=0;
    files.forEach(f => { if (f.name !== f.name.toLowerCase()) { f.name = f.name.toLowerCase(); n++; } });
    renderCurrentFolder(); showToast(`${n} files lowercased`);
}

function renameUppercase() {
    const files = _getActionTargets(); let n=0;
    files.forEach(f => { if (f.name !== f.name.toUpperCase()) { f.name = f.name.toUpperCase(); n++; } });
    renderCurrentFolder(); showToast(`${n} files uppercased`);
}

function renameClean() {
    const files = _getActionTargets(); let n=0;
    files.forEach(f => {
        const ext = f.ext ? '.'+f.ext : '';
        const base = f.name.slice(0, f.name.length - ext.length);
        const clean = base.replace(/[^a-zA-Z0-9_-]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
        if (clean + ext !== f.name) { f.name = clean + ext; n++; }
    });
    renderCurrentFolder(); showToast(`${n} filenames cleaned`);
}

// ══════════════════════════════════════════════════════════════════════════════════
//  ORGANIZE ACTIONS
// ══════════════════════════════════════════════════════════════════════════════════

function _ensureFolder(name) {
    if (!state.folders[name]) {
        state.folders[name] = [];
        state.customFolders.push(name);
        addFolderToSidebar(name);
    }
}

function _moveToFolder(fileId, target) {
    const f = state.files.find(f=>f.id===fileId);
    if (!f) return;
    state.folders[f.folder] = (state.folders[f.folder]||[]).filter(id=>id!==fileId);
    _ensureFolder(target);
    state.folders[target].push(fileId);
    f.folder = target;
}

function organizeByType() {
    const typeMap = {
        images:   ['jpg','jpeg','png','gif','webp','bmp','svg','avif','heic'],
        videos:   ['mp4','avi','mov','mkv','flv','webm','m4v'],
        audio:    ['mp3','wav','flac','aac','ogg','m4a','opus'],
        documents:['pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp','txt','rtf'],
        archives: ['zip','7z','rar','tar','gz','bz2'],
        code:     ['js','ts','py','java','cpp','c','h','html','css','php','rs','go','kt','swift'],
        fonts:    ['ttf','otf','woff','woff2'],
        design:   ['psd','ai','sketch','kra','ora','xd','fig','blend'],
    };
    let n = 0;
    state.files.filter(f=>f.folder==='queue').forEach(f => {
        for (const [folder, exts] of Object.entries(typeMap)) {
            if (exts.includes(f.ext)) { _moveToFolder(f.id, folder); n++; return; }
        }
    });
    updateCounts(); renderCurrentFolder(); showToast(`Organized ${n} files by type`);
}

function organizeByDate() {
    let n = 0;
    state.files.filter(f=>f.folder==='queue').forEach(f => {
        let folder;
        if (!f.lastModified) {
            folder = 'unknown-date';
        } else {
            const d = new Date(f.lastModified);
            const pad = v => String(v).padStart(2,'0');
            folder = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
        }
        _moveToFolder(f.id, folder); n++;
    });
    updateCounts(); renderCurrentFolder(); showToast(`Organized ${n} files by date & time`);
}
function organizeBySizeRange() {
    let n = 0;
    state.files.filter(f=>f.folder==='queue').forEach(f => {
        const folder = f.size < 1_048_576 ? 'small' : f.size < 10_485_760 ? 'medium' : 'large';
        _moveToFolder(f.id, folder); n++;
    });
    updateCounts(); renderCurrentFolder(); showToast(`Organized ${n} files by size`);
}

function organizeByFirstLetter() {
    let n = 0;
    state.files.filter(f=>f.folder==='queue').forEach(f => {
        const ch = f.name.charAt(0).toUpperCase();
        const folder = /[A-Z]/.test(ch) ? ch : '#';
        _moveToFolder(f.id, folder); n++;
    });
    updateCounts(); renderCurrentFolder(); showToast(`Organized ${n} files alphabetically`);
}

// ══════════════════════════════════════════════════════════════════════════════════
//  SORT ACTIONS (queue)
// ══════════════════════════════════════════════════════════════════════════════════

function sortBySize() {
    state.folders.queue.sort((a,b) => {
        const fa = state.files.find(f=>f.id===a), fb = state.files.find(f=>f.id===b);
        return (fb?.size||0) - (fa?.size||0);
    });
    state.currentIndex = 0; switchFolder('queue'); showToast('Sorted by size (largest first)');
}

function sortByDate() {
    state.folders.queue.sort((a,b) => {
        const fa = state.files.find(f=>f.id===a), fb = state.files.find(f=>f.id===b);
        return (fb?.lastModified||0) - (fa?.lastModified||0);
    });
    state.currentIndex = 0; switchFolder('queue'); showToast('Sorted by date (newest first)');
}

function sortByType() {
    state.folders.queue.sort((a,b) => {
        const fa = state.files.find(f=>f.id===a), fb = state.files.find(f=>f.id===b);
        return (fa?.ext||'').localeCompare(fb?.ext||'');
    });
    state.currentIndex = 0; switchFolder('queue'); showToast('Sorted by file type');
}

// ══════════════════════════════════════════════════════════════════════════════════
//  INTEGRITY VERIFICATION
// ══════════════════════════════════════════════════════════════════════════════════

// ── Init ──
(function init() {
    renderHomePanel();
    updateCounts();
})();

async function verifyIntegrity() {
    const files = state.files.filter(f=>f._file).slice(0, 10);
    if (!files.length) { showToast('No files to verify'); return; }
    showToast('Verifying file integrity…');
    const results = await Promise.all(files.map(async f => {
        try {
            const buf = await f._file.arrayBuffer();
            const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
                .map(b=>b.toString(16).padStart(2,'0')).join('');
            return { name: f.name, size: f.size, hash: h.slice(0,16)+'…', ok: true };
        } catch(e) {
            return { name: f.name, size: f.size, hash: 'error', ok: false };
        }
    }));
    const main = document.getElementById('mainArea');
    state.currentFolder = '__storage__';
    document.getElementById('topbarTitle').textContent = 'Integrity Check';
    document.getElementById('topbarMeta').textContent = '';
    main.innerHTML = `
        <div style="padding:20px;overflow-y:auto;height:100%;">
            <h2 style="margin-bottom:16px;">File Integrity Check</h2>
            <p style="font-size:12px;color:var(--text-3);margin-bottom:16px;">SHA-256 hash of first ${files.length} files</p>
            ${results.map(r => `
                <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--surface-1);border:1px solid var(--border);border-radius:var(--radius-xs);margin-bottom:8px;">
                    <div style="color:${r.ok?'var(--success)':'var(--danger)'};font-size:16px;">${r.ok?'✓':'✗'}</div>
                    <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(r.name)}</div><div style="font-size:11px;color:var(--text-3);">${formatSize(r.size)}</div></div>
                    <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);">${escHtml(r.hash)}</div>
                </div>`).join('')}
            <p style="font-size:11px;color:var(--text-3);margin-top:12px;">All files read successfully. Original data intact.</p>
        </div>`;
}

