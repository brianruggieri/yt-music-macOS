// ===== TEMPORARY Spike B (remove in Task 12) =====
// Proves: AudioWorkletNode emitting stereo PCM drives Butterchurn via connectAudio().
// Node graph: worklet -> viz.connectAudio() AND worklet -> GainNode(0) -> destination.
// HUD shows ctx.state, RMS level, PASS/FAIL. Click page to resume suspended AudioContext.
(function () {
  'use strict';

  // ---- HUD ---------------------------------------------------------------
  var hud = document.createElement('div');
  Object.assign(hud.style, {
    position: 'fixed', top: '10px', right: '10px', zIndex: '999999',
    background: 'rgba(0,0,0,0.88)', color: '#00ff88', fontFamily: 'monospace',
    fontSize: '13px', padding: '12px 16px', borderRadius: '8px',
    lineHeight: '1.7', pointerEvents: 'none', minWidth: '260px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.5)'
  });
  hud.innerHTML = '<b>Spike B: Butterchurn Feed</b><br>Initializing...';
  document.body.appendChild(hud);

  function setHUD(lines) {
    hud.innerHTML = '<b>Spike B: Butterchurn Feed</b><br>' + lines.join('<br>');
  }

  // ---- Canvas ------------------------------------------------------------
  var canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  Object.assign(canvas.style, {
    position: 'fixed', top: '70px', right: '10px', zIndex: '999998',
    pointerEvents: 'none',  // clicks pass through to YT controls (so Spike A can play a track)
    borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)',
    boxShadow: '0 2px 12px rgba(0,0,0,0.5)'
  });
  document.body.appendChild(canvas);

  // ---- AudioWorkletProcessor source (stereo sine sweep 200-2000 Hz / 5s) -----
  var processorSrc = [
    'class SineSweepProcessor extends AudioWorkletProcessor {',
    '  constructor() { super(); this._phase = 0; this._sweep = 0; }',
    '  process(inputs, outputs) {',
    '    var out = outputs[0];',
    '    if (!out || !out[0]) return true;',
    '    var sr = sampleRate;',
    '    for (var i = 0; i < out[0].length; i++) {',
    '      this._sweep = (this._sweep + 1) % (sr * 5);',
    '      var f = 200 + (1800 * this._sweep / (sr * 5));',
    '      this._phase += (2 * Math.PI * f) / sr;',
    '      var s = Math.sin(this._phase) * 0.5;',
    '      for (var ch = 0; ch < out.length; ch++) {',
    '        if (out[ch]) out[ch][i] = s;',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('sine-sweep', SineSweepProcessor);"
  ].join('\n');

  // ---- Init --------------------------------------------------------------
  function init() {
    if (typeof window.butterchurn === 'undefined') {
      setHUD([
        'FAIL: window.butterchurn not found',
        'Check WKUserScript injection order'
      ]);
      return;
    }
    if (typeof window.butterchurnPresets === 'undefined') {
      setHUD([
        'FAIL: window.butterchurnPresets not found',
        'Check WKUserScript injection order'
      ]);
      return;
    }

    // butterchurn 2.6.7 UMD is built without libraryExport:'default', so the
    // global is the webpack module namespace — the real API is at `.default`.
    var butterchurn = window.butterchurn.default || window.butterchurn;
    var butterchurnPresets = window.butterchurnPresets.default || window.butterchurnPresets;
    if (typeof butterchurn.createVisualizer !== 'function') {
      setHUD(['FAIL: butterchurn.createVisualizer missing',
              'window.butterchurn keys: ' + Object.keys(window.butterchurn).join(',')]);
      return;
    }

    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    setHUD(['ctx.state: ' + ctx.state, 'Loading AudioWorklet...']);

    // Create worklet module via Blob URL.
    // OPEN QUESTION (Task 5): does YT Music CSP allow blob: in worker-src?
    // If not, addModule() throws and the HUD surfaces the error.
    var blob = new Blob([processorSrc], { type: 'application/javascript' });
    var blobUrl = URL.createObjectURL(blob);

    ctx.audioWorklet.addModule(blobUrl).then(function () {
      URL.revokeObjectURL(blobUrl);
      try {

      var worklet = new AudioWorkletNode(ctx, 'sine-sweep', {
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });

      // Zero-gain sink: keeps the Web Audio graph pulled (required for render).
      var sink = ctx.createGain();
      sink.gain.value = 0;
      worklet.connect(sink);
      sink.connect(ctx.destination);

      // Analyser for RMS level readout.
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      worklet.connect(analyser);

      // Butterchurn visualizer.
      var viz = butterchurn.createVisualizer(ctx, canvas, {
        width: canvas.width,
        height: canvas.height,
        pixelRatio: 1
      });

      var presets = butterchurnPresets.getPresets();
      var names = Object.keys(presets);
      if (names.length > 0) {
        viz.loadPreset(presets[names[0]], 0);
      }

      // Connect worklet as Butterchurn's audio input.
      viz.connectAudio(worklet);

      // rAF render loop.
      function render() {
        viz.render();
        requestAnimationFrame(render);
      }
      requestAnimationFrame(render);

      // HUD update every 200 ms.
      var buf = new Float32Array(analyser.fftSize);
      setInterval(function () {
        analyser.getFloatTimeDomainData(buf);
        var rms = 0;
        for (var i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
        var levelStr = rms.toFixed(6);
        var verdict = rms > 0.001 ? 'FEED OK  (level > 0)' : 'FEED?: level near zero';
        setHUD([
          'ctx.state: ' + ctx.state,
          'AudioWorklet: OK (blob)',
          'Butterchurn: connected',
          'RMS level: ' + levelStr,
          verdict
        ]);
      }, 200);

      // Resume suspended context on first click (autoplay policy).
      if (ctx.state === 'suspended') {
        setHUD([
          'ctx.state: suspended',
          'Click anywhere to start',
          'AudioWorklet loaded OK'
        ]);
        document.addEventListener('click', function resume() {
          ctx.resume();
          document.removeEventListener('click', resume);
        }, { once: true });
      }

      } catch (e) {
        // Worklet loaded fine; failure is downstream (NOT a CSP/blob issue).
        setHUD([
          'ctx.state: ' + ctx.state,
          'AudioWorklet: OK (blob loaded)',
          'FAIL after load: ' + String(e).substring(0, 80)
        ]);
      }
    }).catch(function (err) {
      // Only addModule() rejection lands here — this IS the CSP/blob signal.
      URL.revokeObjectURL(blobUrl);
      setHUD([
        'ctx.state: ' + ctx.state,
        'FAIL: addModule(blob) REJECTED:',
        String(err).substring(0, 80),
        'CSP blocks blob: in worker-src',
        'Task 5 must use CSP fallback for the worklet'
      ]);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
// ===== END Spike B =====
