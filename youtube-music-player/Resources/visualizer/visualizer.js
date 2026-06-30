// Temporary boot marker — removed in Task 12.
window.__vizScriptLoaded = true;

// Audio sink: native PCM (window.__milkFeed) -> AudioWorklet -> Butterchurn.
// Task 7 owns canvas mounting, sizing, and the render loop; this file only gets
// audio flowing and exposes the test hooks (MilkViz.viz, MilkViz.audioLevel()).
(function () {
    'use strict';

    const MilkViz = window.MilkViz = window.MilkViz || {};

    let ctx = null;
    let node = null;
    let analyser = null;
    let levelBuf = null;
    let initPromise = null;

    // Butterchurn 2.6.7 UMD is built without libraryExport:'default', so the
    // global is the webpack namespace — the real API lives at `.default`.
    function resolveButterchurn() {
        return window.butterchurn && (window.butterchurn.default || window.butterchurn);
    }

    async function init() {
        ctx = new (window.AudioContext || window.webkitAudioContext)();

        // A worklet must load into the AudioWorklet context, so visualizer.js
        // receives its source as a string (window.__pcmWorkletSource, injected
        // natively) and builds a blob: module URL — proven under YT Music CSP.
        const blob = new Blob([window.__pcmWorkletSource], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        node = new AudioWorkletNode(ctx, 'pcm-worklet', {
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });

        // Zero-gain sink keeps the Web Audio graph pulled (required to render).
        const sink = ctx.createGain();
        sink.gain.value = 0;
        node.connect(sink);
        sink.connect(ctx.destination);

        // Analyser drives audioLevel() — independent of Butterchurn's own tap.
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        levelBuf = new Float32Array(analyser.fftSize);
        node.connect(analyser);

        // ponytail: detached canvas + placeholder size; Task 7 mounts/sizes it.
        const butterchurn = resolveButterchurn();
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const viz = butterchurn.createVisualizer(ctx, canvas, {
            width: canvas.width,
            height: canvas.height,
            pixelRatio: window.devicePixelRatio || 1,
        });
        viz.connectAudio(node);

        MilkViz.viz = viz;
        MilkViz.canvas = canvas;
    }

    function ensureInit() {
        if (!initPromise) {
            initPromise = init().catch((e) => {
                initPromise = null;        // allow a later feed to retry
                console.error('MilkViz init failed', e);
            });
        }
        return initPromise;
    }

    // Called ~60 Hz by native with base64 of interleaved-stereo Float32LE.
    // The first feeds kick off async init and are dropped until the node exists.
    window.__milkFeed = function (b64) {
        // First feed since activation cancels the no-audio fallback timer (Task 11).
        if (!_feedArrived) { _feedArrived = true; clearNoAudioTimer(); }
        if (!node) { ensureInit(); return; }
        // AudioContext may start suspended under the autoplay policy; resume so
        // the graph actually pulls the worklet. May require a page gesture.
        if (ctx.state === 'suspended') ctx.resume();
        const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
        node.port.postMessage(new Float32Array(buf), [buf]);   // transfer: zero-copy
    };

    // RMS of the most recent analyser window — a reliable nonzero-tracks-music
    // readout for tests.
    MilkViz.audioLevel = function () {
        if (!analyser) return 0;
        analyser.getFloatTimeDomainData(levelBuf);
        let sum = 0;
        for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
        return Math.sqrt(sum / levelBuf.length);
    };

    // --- Task 7: canvas mount, render loop, resize handling ---

    let _container = null;
    let _resizeObs = null;
    let _fallbackMsg = null;
    let _rafId = null;
    let _loopActive = false;

    function hasWebGL2() {
        try { return !!document.createElement('canvas').getContext('webgl2'); }
        catch (_) { return false; }
    }

    // Recompute backing-store size and notify Butterchurn. Requires viz + canvas
    // to exist and the canvas to be mounted (so clientWidth/Height are nonzero).
    function applySize() {
        if (!MilkViz.canvas || !MilkViz.viz || !_container) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.floor(_container.clientWidth * dpr);
        const h = Math.floor(_container.clientHeight * dpr);
        if (w === 0 || h === 0) return;
        MilkViz.canvas.width = w;
        MilkViz.canvas.height = h;
        MilkViz.viz.setRendererSize(w, h);
    }

    // ponytail: single rAF token; _loopActive flag makes resume() idempotent.
    function loop() {
        if (!_loopActive) return;
        _rafId = requestAnimationFrame(loop);
        if (MilkViz.viz) MilkViz.viz.render();
    }

    MilkViz.resume = function () {
        if (_loopActive) return;
        _loopActive = true;
        _rafId = requestAnimationFrame(loop);
    };

    MilkViz.pause = function () {
        _loopActive = false;
        if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    };

    // mount(container) — inserts canvas, starts render loop.
    // If WebGL2 unavailable: shows a static message div instead; render is a no-op.
    // If called before audio init has run: ensureInit() triggers it; canvas is
    // inserted once init resolves (viz-not-ready is handled transparently).
    MilkViz.mount = function (container) {
        if (!hasWebGL2()) {
            _fallbackMsg = document.createElement('div');
            _fallbackMsg.textContent = 'Visualizer needs WebGL2';
            _fallbackMsg.style.cssText = 'display:flex;align-items:center;justify-content:center;' +
                'width:100%;height:100%;color:#fff;font-family:sans-serif;font-size:1rem;';
            container.appendChild(_fallbackMsg);
            return;
        }

        _container = container;

        ensureInit().then(function () {
            // Bail if unmount (or a re-mount) changed _container while init was async —
            // otherwise a stale closure restarts the rAF loop on a detached canvas.
            if (_container !== container) return;
            // Guard against double-mount leaking the prior ResizeObserver.
            if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }

            const canvas = MilkViz.canvas;
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            container.appendChild(canvas);
            applySize();

            _resizeObs = new ResizeObserver(applySize);
            _resizeObs.observe(container);

            MilkViz.resume();
        });
    };

    MilkViz.unmount = function () {
        MilkViz.pause();
        clearNoAudioTimer();        // Task 11: no background timer once unmounted
        clearStatusOverlay();
        if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
        if (_fallbackMsg) { _fallbackMsg.remove(); _fallbackMsg = null; }
        if (MilkViz.canvas && MilkViz.canvas.parentNode) {
            MilkViz.canvas.parentNode.removeChild(MilkViz.canvas);
        }
        _container = null;
    };

    // --- Task 8: Visualizer toggle segment, overlay fallback, and mode lifecycle ---
    // Segment-detection selectors are best-effort — YT Music's DOM is not inspectable
    // headlessly. The overlay fallback is the guaranteed path until human QA confirms
    // which selectors actually match in the live app.

    let _active = false;
    let _segInjected = false;    // our Visualizer segment is currently in the DOM
    let _overlayBtn = null;      // fallback overlay button element
    let _canvasHost = null;      // div we mount the canvas into
    let _stageResizeHandler = null;  // window resize -> reposition fixed host
    let _t8FallbackTimer = null; // 5-second timer before injecting overlay fallback
    let _injectPending = false;  // debounce flag for MutationObserver callbacks

    // Guard: window.webkit?.messageHandlers?.visualizer only present in WKWebView context.
    function postVizAction(action) {
        try {
            if (window.webkit && window.webkit.messageHandlers &&
                    window.webkit.messageHandlers.visualizer) {
                window.webkit.messageHandlers.visualizer.postMessage({ action });
            }
        } catch (e) {
            console.warn('MilkViz: postMessage failed', e);
        }
    }

    // Find the CONSISTENT stage region to size the visualizer to. From the live DOM:
    // `ytmusic-player #main-panel` is the stable stage box regardless of Song/Video
    // entry point (the media letterboxes within it), so prefer it over the media
    // element itself (which shrinks to album-art square vs 16:9 video).
    // Compute the consistent center-stage rect in viewport coords. Ground truth:
    // ytmusic-player-page stays 1272x688 in BOTH Song and Video, while ytmusic-player
    // (the media element) resizes to album(square)/video(16:9) — so we must NOT track
    // the media element. We carve the stage COLUMN out of the page: from the page's
    // left edge to the queue/side-panel's left edge, and from just below the Song/Video
    // toggle down to the page bottom. This excludes the toggle (stays clickable) and the
    // UP-NEXT queue (stays visible), and is identical regardless of Song/Video.
    function computeStageRect() {
        const page = document.querySelector('ytmusic-player-page');
        if (!page) return null;
        const pr = page.getBoundingClientRect();
        if (pr.width === 0 || pr.height === 0) return null;
        const tog = document.querySelector('ytmusic-av-toggle') || document.querySelector('div.av-toggle');
        const queue = document.querySelector('#side-panel') || document.querySelector('ytmusic-player-queue');
        const tr = tog && tog.getBoundingClientRect();
        const qr = queue && queue.getBoundingClientRect();
        const left = pr.left;
        const top = (tr && tr.bottom > pr.top) ? tr.bottom + 12 : pr.top;
        const right = (qr && qr.left > left + 50) ? qr.left : pr.right;
        const bottom = pr.bottom;
        return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }

    // Position the fixed canvas host over the computed stage rect, then resize the canvas.
    function applyStageRect() {
        if (!_canvasHost) return;
        const r = computeStageRect();
        if (!r || r.width === 0 || r.height === 0) return;
        _canvasHost.style.left = r.left + 'px';
        _canvasHost.style.top = r.top + 'px';
        _canvasHost.style.width = r.width + 'px';
        _canvasHost.style.height = r.height + 'px';
        applySize();
    }

    // Find the REAL Song/Video control container. Ground truth from the live page:
    //   <ytmusic-av-toggle><div class="av-toggle ...">
    //     <button class="song-button ..." aria-pressed="false">Song</button>
    //     <button class="video-button ..." aria-pressed="false">Video</button>
    //   </div></ytmusic-av-toggle>
    // The `.av-toggle` div is the container; its direct children are the buttons.
    // Returns the container element, or null if not found.
    function findSegmentContainer() {
        // Primary: the real av-toggle div.
        const real = document.querySelector('ytmusic-av-toggle .av-toggle') ||
            document.querySelector('div.av-toggle');
        if (real) {
            console.log('MilkViz: segment found — av-toggle', real.className.slice(0, 40));
            return real;
        }

        // Fallback: a container whose direct children are buttons "Song" and "Video".
        const els = document.querySelectorAll('button, [role="button"], [role="tab"]');
        for (const el of els) {
            if (/^\s*song\s*$/i.test(el.textContent)) {
                const p = el.parentElement;
                if (p && Array.from(p.children).some((c) => /^\s*video\s*$/i.test(c.textContent))) {
                    console.log('MilkViz: segment found — text-scan fallback, parent:', p.tagName);
                    return p;
                }
            }
        }
        return null;
    }

    // ytmusic-av-toggle's scoped CSS keys the active pill fill on aria-pressed="true",
    // so selection state is driven entirely by that attribute (the cloned button class
    // supplies the rest of the styling).
    function markPressed(el) { el.setAttribute('aria-pressed', 'true'); }
    function clearPressed(el) { el.setAttribute('aria-pressed', 'false'); }

    // Replace only the visible label text of a deep-cloned tab, preserving every
    // wrapper/icon/class. Swaps the first non-empty text node (the label).
    function setSegLabel(el, text) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = walker.nextNode())) {
            if (n.nodeValue && n.nodeValue.trim()) { n.nodeValue = text; break; }
        }
        if (!n) el.textContent = text;   // fallback: no text node found
        if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', text);
    }

    // Inject a "Visualizer" 3rd button into the av-toggle container.
    // DEEP-clone an existing button (the video-button) so it keeps YT's exact
    // class="video-button style-scope ytmusic-av-toggle" + inner structure — that
    // shared class is what makes ytmusic-av-toggle's scoped CSS style it identically.
    // We only change the id + label; selection state is the aria-pressed attribute.
    function injectSegment(container) {
        if (container.querySelector('#milkviz-seg-btn')) return;  // already there

        const siblings = Array.from(container.children).filter((c) => c.id !== 'milkviz-seg-btn');
        if (siblings.length === 0) return;

        // Clone the video-button if present (so we inherit its class), else any sibling.
        const tmpl = siblings.find((s) => s.classList && s.classList.contains('video-button'))
            || siblings[siblings.length - 1];

        const btn = tmpl.cloneNode(true);   // deep clone: keeps full inner structure
        btn.id = 'milkviz-seg-btn';
        clearPressed(btn);                  // unpressed default after clone
        setSegLabel(btn, 'Visualizer');
        btn.style.cursor = 'pointer';

        btn.addEventListener('click', (e) => {
            // Our button is synthetic; stop YT's toggle from also handling it.
            e.stopPropagation();
            if (!_active) {
                // Activate: press ours, let YT's own buttons read unpressed.
                siblings.forEach(clearPressed);
                markPressed(btn);
                MilkViz.setActive(true);
            } else {
                clearPressed(btn);
                MilkViz.setActive(false);
            }
        });

        // Clicking Song or Video deactivates the visualizer. Only release OUR pressed
        // state — YT manages its own buttons' aria-pressed.
        siblings.forEach((sib) => {
            sib.addEventListener('click', () => {
                if (_active) {
                    clearPressed(btn);
                    MilkViz.setActive(false);
                }
            }, true);
        });

        container.appendChild(btn);   // 3rd child of .av-toggle
        if (_active) {   // SPA re-injection while active: reflect pressed state
            siblings.forEach(clearPressed);
            markPressed(btn);
        }
        _segInjected = true;
        console.log('MilkViz: Visualizer button injected (clone of',
            (tmpl.className || '').slice(0, 40), ')');
    }

    // Inject a floating fallback button when the segment control is absent.
    function injectOverlayBtn() {
        if (_overlayBtn) return;

        const btn = document.createElement('button');
        btn.id = 'milkviz-overlay-btn';
        btn.textContent = 'Visualizer';
        // ponytail: inline styles — no external CSS needed; works regardless of YT stylesheet
        btn.style.cssText =
            'position:fixed;top:12px;right:16px;z-index:9997;' +
            'padding:6px 14px;border-radius:16px;border:none;' +
            'background:rgba(255,255,255,0.15);color:#fff;' +
            'font-family:sans-serif;font-size:13px;cursor:pointer;' +
            'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';

        btn.addEventListener('click', () => {
            if (!_active) {
                btn.textContent = 'Close Visualizer';
                btn.style.background = 'rgba(200,50,50,0.6)';
                MilkViz.setActive(true);
            } else {
                btn.textContent = 'Visualizer';
                btn.style.background = 'rgba(255,255,255,0.15)';
                MilkViz.setActive(false);
            }
        });

        document.body.appendChild(btn);
        _overlayBtn = btn;
        console.log('MilkViz: overlay fallback button injected (Song/Video segment not found)');
    }

    // Core mode lifecycle. Idempotent: setActive(true) twice or setActive(false)
    // when already inactive are both no-ops.
    MilkViz.setActive = function (on) {
        if (on === _active) return;
        _active = on;

        if (on) {
            if (!_canvasHost) {
                _canvasHost = document.createElement('div');
                _canvasHost.id = 'milkviz-canvas-host';
                // Fixed overlay positioned over the consistent stage column (computed from
                // ytmusic-player-page, not the resizing media element). pointer-events:auto
                // so canvas clicks land on us (preset skip, Fix 3) not YT's play/pause.
                _canvasHost.style.cssText =
                    'position:fixed;z-index:9998;background:#000;pointer-events:auto;';
                document.body.appendChild(_canvasHost);
                const r = computeStageRect();
                if (r) {
                    applyStageRect();
                    console.log('MilkViz: stage host', Math.round(r.width) + 'x' + Math.round(r.height));
                } else {
                    // ponytail: full-viewport fallback when the player page isn't found
                    _canvasHost.style.inset = '0';
                    console.log('MilkViz: stage host as full-viewport fallback');
                }
                if (!_stageResizeHandler) {
                    _stageResizeHandler = function () { applyStageRect(); };
                    window.addEventListener('resize', _stageResizeHandler);
                }
            }
            MilkViz.mount(_canvasHost);
            addFullscreenControl();
            MilkViz.resume();   // mount is async; resume is idempotent — starts loop immediately
            postVizAction('modeOn');
            startPresets();
            startNoAudioTimer();   // Task 11: hint if neither feed nor nativeStatus arrives
        } else {
            stopPresets();
            removeFullscreenControl();
            MilkViz.unmount();
            if (_stageResizeHandler) { window.removeEventListener('resize', _stageResizeHandler); _stageResizeHandler = null; }
            if (_canvasHost) { _canvasHost.remove(); _canvasHost = null; }
            MilkViz.pause();    // unmount calls pause, but call again per spec
            postVizAction('modeOff');
        }
    };

    // --- Task 11: Native status (permission / no-audio) overlays ---
    // The render loop keeps running with no PCM (idle, gentle motion); these overlays
    // only inform — they never tear the visualizer down. All cleaned up on deactivate
    // (via MilkViz.unmount) so no timer or DOM node survives the visualizer being off.

    let _statusOverlay = null;   // permission-error / no-audio message element
    let _feedArrived = false;    // any __milkFeed call since last activation
    let _statusArrived = false;  // any nativeStatus call since last activation
    let _noAudioTimer = null;    // ~3s fallback timer armed on activation

    function clearStatusOverlay() {
        if (_statusOverlay) { _statusOverlay.remove(); _statusOverlay = null; }
    }

    // Centered message over the canvas host. pointer-events:none on the container so it
    // never blocks canvas clicks (preset skip); only the optional button takes events.
    function showStatusOverlay(message, withRetry) {
        clearStatusOverlay();
        if (!_canvasHost) return;
        const el = document.createElement('div');
        el.id = 'milkviz-status-overlay';
        el.style.cssText =
            'position:absolute;inset:0;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;gap:14px;z-index:9999;' +
            'background:rgba(0,0,0,0.45);color:#fff;font-family:sans-serif;' +
            'font-size:15px;line-height:1.5;text-align:center;padding:24px;' +
            'pointer-events:none;white-space:pre-line;';
        const msg = document.createElement('div');
        msg.textContent = message;
        el.appendChild(msg);
        if (withRetry) {
            const btn = document.createElement('button');
            btn.textContent = 'Try again';
            btn.style.cssText =
                'pointer-events:auto;padding:6px 16px;border:none;border-radius:16px;' +
                'cursor:pointer;background:rgba(255,255,255,0.2);color:#fff;font-size:13px;';
            btn.addEventListener('click', function () {
                clearStatusOverlay();
                startNoAudioTimer();      // re-arm: a fresh modeOn may also stay silent
                postVizAction('modeOn');  // guarded; native re-attempts the tap
            });
            el.appendChild(btn);
        }
        _canvasHost.appendChild(el);
        _statusOverlay = el;
    }

    // Called by native (Task 4): {state:'ok'} on tap start, {state:'error',
    // code:'audioCaptureDenied'} on failure. Either way a status has arrived, so the
    // generic no-audio fallback timer is cancelled.
    MilkViz.nativeStatus = function (s) {
        _statusArrived = true;
        clearNoAudioTimer();
        if (!s) return;
        if (s.state === 'error' && s.code === 'audioCaptureDenied') {
            showStatusOverlay(
                'Audio capture permission needed\n' +
                'System Settings > Privacy & Security > Audio Capture',
                true);
        } else if (s.state === 'ok') {
            clearStatusOverlay();
        }
    };

    function clearNoAudioTimer() {
        if (_noAudioTimer) { clearTimeout(_noAudioTimer); _noAudioTimer = null; }
    }

    // Armed on activation: if no __milkFeed and no nativeStatus arrive within ~3s,
    // show a generic hint. Cancelled by the first feed or any status.
    function startNoAudioTimer() {
        clearNoAudioTimer();
        _feedArrived = false;
        _statusArrived = false;
        _noAudioTimer = setTimeout(function () {
            _noAudioTimer = null;
            if (!_feedArrived && !_statusArrived) showStatusOverlay('No audio detected', false);
        }, 3000);
    }

    // --- Task 9: Preset manager (auto-cycle, manual skip, track-change, name toast) ---
    // All timers and listeners are started on setActive(true) and fully torn down on
    // setActive(false) — no background work when the visualizer is off (battery).

    let _presetsObj = null;   // { [name]: presetObject } from butterchurnPresets.getPresets()
    let _presetNames = [];    // shuffled working list (capped at 40)
    let _presetIdx = 0;
    let _cycleTimer = null;
    let _trackPollTimer = null;
    let _lastTrackTitle = null;
    let _toastEl = null;

    // Resolve the preset global and build the working list once; _presetsObj guards re-entry.
    function initPresetList() {
        if (_presetsObj) return;
        const pg = window.butterchurnPresets;
        if (!pg) { console.warn('MilkViz: butterchurnPresets not found'); return; }
        const api = pg.default || pg;
        _presetsObj = api.getPresets();
        const allNames = Object.keys(_presetsObj);

        const curated = window.__milkPresets || [];
        let working = curated.length
            ? curated.filter(function (n) { return !!_presetsObj[n]; })  // drop invalid names
            : allNames;
        if (!working.length) working = allNames;   // fallback: intersection was empty

        // Fisher-Yates shuffle, cap at 40
        for (let i = working.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = working[i]; working[i] = working[j]; working[j] = tmp;
        }
        _presetNames = working.slice(0, 40);
        console.log('MilkViz: preset list built —', _presetNames.length, 'presets');
    }

    // Auto-fading name toast over the canvas host.
    function showToast(name) {
        if (_toastEl) { _toastEl.remove(); _toastEl = null; }
        if (!_canvasHost) return;
        const el = document.createElement('div');
        el.textContent = name;
        el.style.cssText =
            'position:absolute;bottom:24px;left:50%;transform:translateX(-50%);' +
            'background:rgba(0,0,0,0.55);color:#fff;font-family:sans-serif;font-size:13px;' +
            'padding:4px 12px;border-radius:12px;pointer-events:none;z-index:9999;' +
            'opacity:1;transition:opacity 1s ease;white-space:nowrap;';
        _canvasHost.appendChild(el);
        _toastEl = el;
        setTimeout(function () { if (_toastEl === el) el.style.opacity = '0'; }, 2000);
        setTimeout(function () {
            if (_toastEl === el) { el.remove(); _toastEl = null; }
        }, 3100);
    }

    // Load preset at index i (wrapping), show toast.
    function doLoadPreset(i, blend) {
        if (!_presetsObj || !_presetNames.length || !MilkViz.viz) return;
        _presetIdx = ((i % _presetNames.length) + _presetNames.length) % _presetNames.length;
        const name = _presetNames[_presetIdx];
        MilkViz.viz.loadPreset(_presetsObj[name], blend != null ? blend : 2.7);
        showToast(name);
    }

    // Reschedule auto-advance; random interval 18-28s for variety.
    function scheduleCycle() {
        if (_cycleTimer) { clearTimeout(_cycleTimer); _cycleTimer = null; }
        var delay = 18000 + Math.random() * 10000;
        _cycleTimer = setTimeout(function () {
            doLoadPreset(_presetIdx + 1, 2.7);
            scheduleCycle();
        }, delay);
    }

    function _onKeyDown(e) {
        if (!_active) return;   // ponytail: guard (listener is only attached while active)
        if (e.key === 'ArrowRight') {
            e.preventDefault(); doLoadPreset(_presetIdx + 1, 2.7); scheduleCycle();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault(); doLoadPreset(_presetIdx - 1, 2.7); scheduleCycle();
        }
    }

    // YT's play/pause handler lives on ytmusic-player#player — an ANCESTOR of our
    // canvas — so a bubble-phase stopPropagation runs too late. Intercept on the
    // document in the CAPTURE phase: if the click landed on our canvas, kill it
    // before it reaches YT's player handler, then advance the preset. The fullscreen
    // button is not the canvas, so its own clicks pass the contains() check.
    function _onDocClickCapture(e) {
        if (!_active || !MilkViz.canvas || !MilkViz.canvas.contains(e.target)) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        doLoadPreset(_presetIdx + 1, 2.7);
        scheduleCycle();
    }

    function _checkTrack() {
        var meta = navigator.mediaSession && navigator.mediaSession.metadata;
        var title = meta ? meta.title : null;
        if (title && title !== _lastTrackTitle) {
            _lastTrackTitle = title;
            doLoadPreset(_presetIdx + 1, 2.7);
            scheduleCycle();
        }
    }

    function startPresets() {
        initPresetList();
        if (!_presetNames.length) return;   // butterchurnPresets not available yet

        // Remove before add: prevents double-binding if re-activated after init resolved.
        document.removeEventListener('keydown', _onKeyDown);
        document.addEventListener('keydown', _onKeyDown);
        // Capture-phase, on document, to beat YT's ancestor play/pause handler (Fix 2).
        document.removeEventListener('click', _onDocClickCapture, true);
        document.addEventListener('click', _onDocClickCapture, true);

        var meta = navigator.mediaSession && navigator.mediaSession.metadata;
        _lastTrackTitle = meta ? meta.title : null;
        if (_trackPollTimer) { clearInterval(_trackPollTimer); }
        _trackPollTimer = setInterval(_checkTrack, 3000);

        // First preset requires viz to exist — wait for init.
        ensureInit().then(function () {
            if (!_active) return;   // deactivated while async init was in flight
            doLoadPreset(Math.floor(Math.random() * _presetNames.length), 0);
            scheduleCycle();
        });
    }

    function stopPresets() {
        if (_cycleTimer) { clearTimeout(_cycleTimer); _cycleTimer = null; }
        if (_trackPollTimer) { clearInterval(_trackPollTimer); _trackPollTimer = null; }
        document.removeEventListener('keydown', _onKeyDown);
        document.removeEventListener('click', _onDocClickCapture, true);
        if (_toastEl) { _toastEl.remove(); _toastEl = null; }
    }

    // --- Task 10: Fullscreen control ---
    // Button lives on _canvasHost; listener + button torn down on setActive(false).

    let _fsBtn = null;
    let _fsChangeHandler = null;

    // Corner-bracket fullscreen icon matching YT's native control (used when the live
    // control can't be cloned). Inherits currentColor so it tracks light/dark text.
    const FS_ICON_SVG =
        '<svg viewBox="0 0 36 36" width="20" height="20" fill="currentColor" aria-hidden="true">' +
        '<path d="M10 16h2v-4h4v-2h-6v6zm14-6h-6v2h4v4h2v-6zm-2 16v-4h-2v6h6v-2h-4zM12 20h-2v6h6v-2h-4v-4z"/>' +
        '</svg>';

    function addFullscreenControl() {
        if (_fsBtn || !_canvasHost) return;

        // Reuse YT's NATIVE fullscreen control look by cloning it when present; else a
        // corner-bracket SVG button. EITHER WAY we enforce an explicit small box below
        // so a cloned/giant control can never render full-size over the canvas.
        let btn;
        const native = document.querySelector('.ytp-fullscreen-button') ||
            document.querySelector('button[aria-label*="ull screen" i]') ||
            document.querySelector('[aria-label*="fullscreen" i]');
        if (native) {
            btn = native.cloneNode(true);
            btn.removeAttribute('id');
            console.log('MilkViz: fullscreen control cloned from native', native.className || native.tagName);
        } else {
            btn = document.createElement('button');
            btn.innerHTML = FS_ICON_SVG;
            console.log('MilkViz: fullscreen control — replicated corner-bracket SVG (native not found)');
        }
        btn.id = 'milkviz-fs-btn';
        btn.title = 'Enter fullscreen';

        // Enforce a small fixed control + icon size (YT-like), regardless of clone.
        // !important beats any inherited/scoped sizing from the cloned native button.
        const fixed = [
            'box-sizing:border-box', 'width:32px', 'height:32px',
            'min-width:0', 'min-height:0', 'max-width:32px', 'max-height:32px',
            'padding:6px', 'border:none', 'border-radius:4px', 'background:transparent',
            'color:#fff', 'cursor:pointer', 'opacity:0.7',
            'display:inline-flex', 'align-items:center', 'justify-content:center',
            'position:absolute', 'right:8px', 'bottom:8px', 'top:auto', 'left:auto',
            'z-index:9999',
        ];
        btn.setAttribute('style', fixed.map((d) => d + ' !important').join(';'));
        // Clamp any inner icon (SVG/img/span) the cloned native button may carry.
        Array.from(btn.querySelectorAll('svg, img, span')).forEach((el) => {
            el.style.setProperty('width', '20px', 'important');
            el.style.setProperty('height', '20px', 'important');
        });
        btn.addEventListener('mouseenter', function () { btn.style.setProperty('opacity', '1', 'important'); });
        btn.addEventListener('mouseleave', function () { btn.style.setProperty('opacity', '0.7', 'important'); });

        btn.addEventListener('click', function () {
            if (!document.fullscreenElement) {
                const req = _canvasHost.requestFullscreen || _canvasHost.webkitRequestFullscreen;
                if (req) req.call(_canvasHost);
            } else {
                document.exitFullscreen();
            }
        });

        _canvasHost.appendChild(btn);
        _fsBtn = btn;

        _fsChangeHandler = function () {
            applySize();
            if (_fsBtn) {
                const inFs = !!document.fullscreenElement;
                _fsBtn.title = inFs ? 'Exit fullscreen' : 'Enter fullscreen';
            }
        };
        document.addEventListener('fullscreenchange', _fsChangeHandler);
        document.addEventListener('webkitfullscreenchange', _fsChangeHandler);
    }

    function removeFullscreenControl() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(function () {});
        }
        if (_fsChangeHandler) {
            document.removeEventListener('fullscreenchange', _fsChangeHandler);
            document.removeEventListener('webkitfullscreenchange', _fsChangeHandler);
            _fsChangeHandler = null;
        }
        if (_fsBtn) { _fsBtn.remove(); _fsBtn = null; }
    }

    // Debounced segment-injection check. Called by MutationObserver on DOM changes.
    function scheduleInjectCheck() {
        if (_injectPending) return;
        _injectPending = true;
        setTimeout(() => {
            _injectPending = false;
            if (_overlayBtn) return;   // already on fallback path — stop scanning
            if (document.querySelector('#milkviz-seg-btn')) return;  // segment still in DOM
            _segInjected = false;
            const container = findSegmentContainer();
            if (container) {
                if (_t8FallbackTimer) { clearTimeout(_t8FallbackTimer); _t8FallbackTimer = null; }
                injectSegment(container);
            }
        }, 200);
    }

    // Boot the segment observer. Gated entirely on __ytmVizSupported.
    function startSegObserver() {
        if (!window.__ytmVizSupported) {
            console.log('MilkViz: __ytmVizSupported falsy — visualizer toggle disabled');
            return;
        }

        // Attempt injection immediately (page may already have the control).
        scheduleInjectCheck();

        // If segment control not found within 5s, fall back to overlay button.
        _t8FallbackTimer = setTimeout(() => {
            _t8FallbackTimer = null;
            if (!_segInjected) injectOverlayBtn();
        }, 5000);

        // MutationObserver re-injects after SPA navigation removes our segment.
        const obs = new MutationObserver(scheduleInjectCheck);
        obs.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startSegObserver);
    } else {
        startSegObserver();
    }

})();

// Temporary probe: confirms the script executed in the page's JS context.
// Removed in Task 12 along with __vizScriptLoaded.
setTimeout(function() {
    console.log('VIZ boot', !!window.MilkViz, window.__vizScriptLoaded === true);
}, 3000);
