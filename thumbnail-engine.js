'use strict';
// ════════════════════════════════════════════════════════════════════════════════════
//  UNIVERSAL THUMBNAIL ENGINE  v2.0
//  Drop-in solution for file types the browser can't natively preview.
//  Usage: const url = await ThumbnailEngine.generate(file, ext, options)
// ════════════════════════════════════════════════════════════════════════════════════

class ThumbnailEngine {
    static config = {
        canvasWidth:  300,
        canvasHeight: 225,
        jpegQuality:  0.87,
        timeout:      30000,
    };

    static COLOR_MAP = {
        psd:  { bg:'#001f3f', icon:'🎨', label:'Photoshop' },
        psb:  { bg:'#001f3f', icon:'🎨', label:'PS Large'  },
        xcf:  { bg:'#4a5568', icon:'🎨', label:'GIMP'      },
        kra:  { bg:'#0d1b2a', icon:'🎨', label:'Krita'     },
        ora:  { bg:'#0d1b2a', icon:'🎨', label:'OpenRaster' },
        clip: { bg:'#111827', icon:'🎨', label:'Clip Studio' },
        sai:  { bg:'#111827', icon:'✏️',  label:'SAI'       },
        procreate: { bg:'#1a1a2e', icon:'✏️', label:'Procreate' },
        ai:   { bg:'#ff6d00', icon:'✦',  label:'Illustrator'},
        svg:  { bg:'#ff6d00', icon:'✦',  label:'SVG'       },
        sketch:{ bg:'#f7a800', icon:'✦', label:'Sketch'    },
        drawio:{ bg:'#f08705', icon:'📊', label:'Draw.io'  },
        dio:  { bg:'#f08705', icon:'📊', label:'Draw.io'   },
        blend:{ bg:'#7c2d12', icon:'🧊', label:'Blender'   },
        pdf:  { bg:'#c2410c', icon:'📄', label:'PDF'        },
        doc:  { bg:'#1d4ed8', icon:'📃', label:'Word'       },
        docx: { bg:'#1d4ed8', icon:'📃', label:'Word'       },
        xls:  { bg:'#15803d', icon:'📊', label:'Excel'      },
        xlsx: { bg:'#15803d', icon:'📊', label:'Excel'      },
        ppt:  { bg:'#b91c1c', icon:'🎬', label:'PowerPoint' },
        pptx: { bg:'#b91c1c', icon:'🎬', label:'PowerPoint' },
        odt:  { bg:'#1d4ed8', icon:'📃', label:'Document'   },
        ods:  { bg:'#15803d', icon:'📊', label:'Spreadsheet'},
        odp:  { bg:'#b91c1c', icon:'🎬', label:'Presentation'},
        epub: { bg:'#14532d', icon:'📚', label:'EPUB'       },
        mobi: { bg:'#14532d', icon:'📚', label:'Mobi'       },
        azw:  { bg:'#14532d', icon:'📚', label:'Kindle'     },
        azw3: { bg:'#14532d', icon:'📚', label:'Kindle'     },
        fb2:  { bg:'#14532d', icon:'📚', label:'FictionBook'},
        aep:  { bg:'#3b0764', icon:'🎬', label:'After FX'   },
        prproj:{ bg:'#3b0764', icon:'🎬', label:'Premiere'  },
        max:  { bg:'#7c2d12', icon:'🧊', label:'3DS Max'    },
        c4d:  { bg:'#7c2d12', icon:'🧊', label:'Cinema 4D'  },
        mb:   { bg:'#7c2d12', icon:'🧊', label:'Maya'       },
        ma:   { bg:'#7c2d12', icon:'🧊', label:'Maya ASCII' },
        lxo:  { bg:'#7c2d12', icon:'🧊', label:'Modo'       },
        hip:  { bg:'#7c2d12', icon:'🧊', label:'Houdini'    },
        hipnc:{ bg:'#7c2d12', icon:'🧊', label:'Houdini NC' },
    };

    // ── Main API ──────────────────────────────────────────────────────────────────

    static async generate(fileOrUrl, ext, options = {}) {
        const opts = { ...ThumbnailEngine.config, ...options };
        ext = (ext || '').toLowerCase();

        try {
            const extractors = {
                psd:    ThumbnailEngine._extractPSD,
                psb:    ThumbnailEngine._extractPSD,
                ai:     ThumbnailEngine._extractIllustrator,
                blend:  ThumbnailEngine._extractBlender,
                drawio: ThumbnailEngine._extractDrawIO,
                dio:    ThumbnailEngine._extractDrawIO,
                pdf:    ThumbnailEngine._extractPDF,
                svg:    ThumbnailEngine._extractSVG,
                svgz:   ThumbnailEngine._extractSVGZ,
            };

            const fn = extractors[ext];
            if (!fn) return ThumbnailEngine.placeholder(ext, options.name, opts);

            const result = await Promise.race([
                fn(fileOrUrl, opts),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), opts.timeout))
            ]);
            return result || ThumbnailEngine.placeholder(ext, options.name, opts);
        } catch(e) {
            return ThumbnailEngine.placeholder(ext, options.name, opts);
        }
    }

    // ── Extractors ───────────────────────────────────────────────────────────────

    static async _extractPSD(input, opts) {
        const buf = input instanceof Blob || input instanceof File
            ? await input.arrayBuffer()
            : await (await fetch(input)).arrayBuffer();
        const view = new Uint8Array(buf);
        // Verify PSD signature: "8BPS"
        if (view[0] !== 0x38 || view[1] !== 0x42 || view[2] !== 0x50 || view[3] !== 0x53) return null;
        // Search for JPEG marker (FFD8FF)
        for (let i = 4; i < view.length - 2; i++) {
            if (view[i] === 0xFF && view[i+1] === 0xD8 && view[i+2] === 0xFF) {
                const chunk = view.slice(i, Math.min(i + 2_000_000, view.length));
                // Find JPEG end marker FFD9
                let end = chunk.length;
                for (let j = chunk.length - 2; j > 0; j--) {
                    if (chunk[j] === 0xFF && chunk[j+1] === 0xD9) { end = j + 2; break; }
                }
                const blob = new Blob([chunk.slice(0, end)], { type: 'image/jpeg' });
                const url = URL.createObjectURL(blob);
                // Validate by trying to load the image
                const ok = await new Promise(res => {
                    const img = new Image();
                    img.onload = () => { res(true); };
                    img.onerror = () => { URL.revokeObjectURL(url); res(false); };
                    img.src = url;
                });
                if (ok) return url;
            }
        }
        return null;
    }

    static async _extractBlender(input, opts) {
        const buf = input instanceof Blob || input instanceof File
            ? await input.arrayBuffer()
            : await (await fetch(input)).arrayBuffer();
        const view = new Uint8Array(buf);
        // Search for PNG signature: 89 50 4E 47
        for (let i = 0; i < view.length - 8; i++) {
            if (view[i] === 0x89 && view[i+1] === 0x50 && view[i+2] === 0x4E && view[i+3] === 0x47) {
                const chunk = view.slice(i, Math.min(i + 2_000_000, view.length));
                const blob = new Blob([chunk], { type: 'image/png' });
                const url = URL.createObjectURL(blob);
                const ok = await new Promise(res => {
                    const img = new Image();
                    img.onload = () => res(true);
                    img.onerror = () => { URL.revokeObjectURL(url); res(false); };
                    img.src = url;
                });
                if (ok) return url;
            }
        }
        return null;
    }

    static async _extractIllustrator(input, opts) {
        // Modern AI files embed PDF — find %PDF marker and render as PDF
        const buf = input instanceof Blob || input instanceof File
            ? await input.arrayBuffer()
            : await (await fetch(input)).arrayBuffer();
        const view = new Uint8Array(buf);
        const head = new TextDecoder().decode(view.slice(0, Math.min(200_000, buf.byteLength)));
        const pdfIdx = head.indexOf('%PDF');
        if (pdfIdx < 0) return null;
        const pdfData = view.slice(pdfIdx);
        const blob = new Blob([pdfData], { type: 'application/pdf' });
        return await ThumbnailEngine._extractPDF(blob, opts);
    }

    static async _extractDrawIO(input, opts) {
        let text = '';
        if (typeof input === 'string') {
            text = await (await fetch(input)).text();
        } else if (input instanceof Blob || input instanceof File) {
            text = await input.text();
        }
        // Look for embedded base64 image in XML
        const m = text.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
        if (m) {
            try {
                const bin = atob(m[1]);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const blob = new Blob([bytes], { type: 'image/png' });
                return URL.createObjectURL(blob);
            } catch(_) {}
        }
        return null;
    }

    static async _extractPDF(input, opts) {
        await ThumbnailEngine._loadPDFJS();
        const pdfUrl = (input instanceof Blob || input instanceof File)
            ? URL.createObjectURL(input)
            : input;
        try {
            const pdf = await window.pdfjsLib.getDocument(pdfUrl).promise;
            const page = await pdf.getPage(1);
            const canvas = document.createElement('canvas');
            canvas.width  = opts.canvasWidth  || 300;
            canvas.height = opts.canvasHeight || 225;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const vp = page.getViewport({ scale: 1 });
            const scale = Math.min(canvas.width / vp.width, canvas.height / vp.height);
            const viewport = page.getViewport({ scale });
            const offsetX = (canvas.width  - viewport.width)  / 2;
            const offsetY = (canvas.height - viewport.height) / 2;
            ctx.save();
            ctx.translate(offsetX, offsetY);
            await page.render({ canvasContext: ctx, viewport }).promise;
            ctx.restore();
            return canvas.toDataURL('image/jpeg', opts.jpegQuality);
        } finally {
            if (input instanceof Blob || input instanceof File) URL.revokeObjectURL(pdfUrl);
        }
    }

    static async _extractSVG(input, opts) {
        return new Promise(res => {
            const src = (input instanceof Blob || input instanceof File)
                ? URL.createObjectURL(input) : input;
            const canvas = document.createElement('canvas');
            canvas.width = opts.canvasWidth; canvas.height = opts.canvasHeight;
            const ctx = canvas.getContext('2d');
            const img = new Image();
            img.onload = () => {
                ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
                const scale = Math.min(canvas.width/img.width, canvas.height/img.height);
                const w = img.width*scale, h = img.height*scale;
                ctx.drawImage(img, (canvas.width-w)/2, (canvas.height-h)/2, w, h);
                if (input instanceof Blob || input instanceof File) URL.revokeObjectURL(src);
                res(canvas.toDataURL('image/jpeg', opts.jpegQuality));
            };
            img.onerror = () => res(null);
            img.src = src;
        });
    }

    static async _extractSVGZ(input, opts) {
        await ThumbnailEngine._loadPako();
        const buf = input instanceof Blob || input instanceof File
            ? await input.arrayBuffer()
            : await (await fetch(input)).arrayBuffer();
        try {
            const decompressed = window.pako.inflate(new Uint8Array(buf));
            const blob = new Blob([decompressed], { type: 'image/svg+xml' });
            return await ThumbnailEngine._extractSVG(blob, opts);
        } catch(_) { return null; }
    }

    // ── Placeholder canvas ────────────────────────────────────────────────────────

    static placeholder(ext, name, opts = ThumbnailEngine.config) {
        const data = ThumbnailEngine.COLOR_MAP[ext] || { bg:'#1e293b', icon:'📁', label:(ext||'FILE').toUpperCase() };
        const W = opts.canvasWidth || 300, H = opts.canvasHeight || 225;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');

        const grad = ctx.createLinearGradient(0,0,W,H);
        const shade = c => { try { const h=c.replace('#',''); const v=parseInt(h,16); return `#${Math.max(0,((v>>16)&255)-30).toString(16).padStart(2,'0')}${Math.max(0,((v>>8)&255)-30).toString(16).padStart(2,'0')}${Math.max(0,(v&255)-30).toString(16).padStart(2,'0')}`; } catch(_){ return c; } };
        grad.addColorStop(0, data.bg); grad.addColorStop(1, shade(data.bg));
        ctx.fillStyle = grad; ctx.fillRect(0,0,W,H);

        // Subtle grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
        for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
        for (let y = 0; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `bold ${H*0.32}px serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.fillText(data.icon, W/2, H/2 - H*0.1);

        ctx.font = `bold ${H*0.1}px sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(data.label, W/2, H/2 + H*0.2);

        if (name) {
            ctx.font = `${H*0.048}px monospace`;
            ctx.fillStyle = 'rgba(255,255,255,0.32)';
            const display = name.length > 30 ? name.slice(0,27)+'…' : name;
            ctx.fillText(display, W/2, H - H*0.06);
        }
        return canvas.toDataURL('image/jpeg', opts.jpegQuality);
    }

    // ── Lazy-load helpers ─────────────────────────────────────────────────────────

    static _loadPDFJS() {
        if (window.pdfjsLib) return Promise.resolve();
        return new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            s.onload = () => {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                res();
            };
            s.onerror = rej; document.head.appendChild(s);
        });
    }

    static _loadPako() {
        if (window.pako) return Promise.resolve();
        return new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js';
            s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = ThumbnailEngine;
