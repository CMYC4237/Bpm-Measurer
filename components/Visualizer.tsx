import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { AudioData, ViewState, TimingPoint } from '../types';
import {
  SpectrogramView,
  planSpectrogramPaint,
  renderSpectrogramStrip,
} from '../utils/spectrogramBitmap';
import { getPointAtTime } from '../utils/timingUtils';

interface VisualizerProps {
  /**
   * The decoded audio lives in a ref rather than in props/state on purpose:
   * React's development build records props (recursively) for the DevTools
   * performance panel, and walking the multi-megabyte spectrogram buffer froze
   * the page for seconds on every import. `audioVersion` is the change signal.
   */
  audioDataRef: React.RefObject<AudioData | null>;
  audioVersion: number;
  currentTime: number;
  /** Live view state. Kept in a ref so panning never has to re-render React. */
  viewRef: React.RefObject<ViewState>;
  /** Current zoom level, as a React value (only changes on zoom, not on pan). */
  zoom: number;
  /** Receives the imperative "redraw now" entry point for the parent. */
  redrawRef: React.RefObject<(() => void) | null>;
  timingPoints: TimingPoint[];
  onUpdateBpm: (beatIndex: number, bpm: number) => void;
  onUpdateOffset: (offset: number) => void;
  onSeek: (time: number) => void;
  width: number;
  height: number;
  specLogBase: number; // New prop for logarithmic scaling
}

const TIMELINE_HEIGHT = 40; 

const Visualizer: React.FC<VisualizerProps> = ({
  audioDataRef,
  audioVersion,
  currentTime,
  viewRef,
  zoom,
  redrawRef,
  timingPoints,
  onUpdateBpm,
  onUpdateOffset,
  onSeek,
  width,
  height,
  specLogBase,
}) => {
  const audioData = audioDataRef.current;
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const spectrogramRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const [dragging, setDragging] = useState<{ 
      type: 'offset' | 'bpm'; 
      pointIndex: number; 
      beatIndex: number; 
      startX: number; 
      initialVal: number; 
  } | null>(null);

  const intWidth = Math.floor(width);
  const intHeight = Math.floor(height);
  
  const availableHeight = Math.max(0, intHeight - TIMELINE_HEIGHT);
  const waveHeight = Math.floor(availableHeight * 0.5);
  const specHeight = availableHeight - waveHeight;

  const dpr = window.devicePixelRatio || 1;
  // Scroll positions are snapped to whole device pixels. Every layer then agrees
  // on the same mapping, and panning can shift the cached bitmap without
  // resampling (sub-pixel movement is below what a display can show anyway).
  //
  // `deviceOffset` is the absolute device-pixel column at view x = 0, i.e. the
  // time axis expressed in device pixels: time = column / (zoom * dpr). It is
  // NOT the zoom-scaled value, which would run away from the song as you scroll.
  const snapScrollLeft = useCallback((scrollLeft: number) => {
    // A non-finite offset would make every column read out of range and paint the
    // whole spectrogram black, so fall back to the start of the song instead.
    const raw = scrollLeft * dpr;
    return Number.isFinite(raw) ? Math.round(raw) / dpr : 0;
  }, [dpr]);

  const timeToX = useCallback(
    (t: number) => (t * viewRef.current.zoom) - snapScrollLeft(viewRef.current.scrollLeft),
    [snapScrollLeft, viewRef]
  );
  const xToTime = useCallback(
    (x: number) => (x + snapScrollLeft(viewRef.current.scrollLeft)) / viewRef.current.zoom,
    [snapScrollLeft, viewRef]
  );
  const specViewRef = useRef<SpectrogramView | null>(null);
  const specMirrorRef = useRef<{ canvas: HTMLCanvasElement; image: ImageData; buf32: Uint32Array } | null>(null);

  // Browsers may drop canvas contents while the tab is hidden; force a full
  // repaint when it comes back so the cached bitmap can never go stale.
  const [drawEpoch, setDrawEpoch] = useState(0);
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        specViewRef.current = null;
        setDrawEpoch(epoch => epoch + 1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // --- Draw Waveform ---
  // Three modes, cheapest first:
  //   pan    - slide the previous frame and repaint only the strip that scrolled in
  //   zoom   - stretch the last exact frame (one drawImage) while the gesture runs
  //   refine - rebuild the exact frame into an offscreen canvas a slice at a time
  //            and swap it in, so no single frame has to pay for the whole song
  const waveViewRef = useRef<{
    zoom: number; scrollLeft: number; w: number; h: number; audioData: AudioData;
    deviceOffset: number; approximate: boolean;
  } | null>(null);
  /** The last exact waveform frame, and the source every zoom preview stretches. */
  const wavePreciseRef = useRef<{
    canvas: HTMLCanvasElement; zoom: number; scrollLeft: number; w: number; h: number; audioData: AudioData;
  } | null>(null);
  const waveRefineCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveRefineRef = useRef<{ nextColumn: number; zoom: number; scrollLeft: number; audioData: AudioData } | null>(null);
  const waveRefineRafRef = useRef<number | null>(null);
  const waveRefineTimerRef = useRef<number | null>(null);
  const wavePreciseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawWaveformRef = useRef<() => void>(() => {});
  const runWaveRefineRef = useRef<() => void>(() => {});

  const ensureOffscreen = useCallback((ref: React.MutableRefObject<HTMLCanvasElement | null>, w: number, h: number) => {
    let c = ref.current;
    if (!c || c.width !== w || c.height !== h) {
      c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      ref.current = c;
    }
    return c;
  }, []);

  const cancelWaveRefine = useCallback(() => {
    if (waveRefineRafRef.current !== null) {
      window.cancelAnimationFrame(waveRefineRafRef.current);
      waveRefineRafRef.current = null;
    }
    if (waveRefineTimerRef.current !== null) {
      window.clearTimeout(waveRefineTimerRef.current);
      waveRefineTimerRef.current = null;
    }
    waveRefineRef.current = null;
  }, []);
  useEffect(() => cancelWaveRefine, [cancelWaveRefine]);

  /** Remembers the exact frame that is currently on screen. */
  const captureWavePrecise = useCallback((zoom: number, scrollLeft: number) => {
    const canvas = waveformRef.current;
    if (!canvas || !audioData) return;
    const precise = ensureOffscreen(wavePreciseCanvasRef, canvas.width, canvas.height);
    const pctx = precise.getContext('2d');
    if (!pctx) return;
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, precise.width, precise.height);
    pctx.drawImage(canvas, 0, 0);
    wavePreciseRef.current = {
      canvas: precise, zoom, scrollLeft, w: canvas.width, h: canvas.height, audioData,
    };
  }, [audioVersion, audioDataRef, ensureOffscreen]);

  /** Paints background, centre line and waveform columns for a CSS-pixel range. */
  const paintWaveformRange = useCallback((ctx: CanvasRenderingContext2D, x0: number, x1: number) => {
    if (!audioData || x1 <= x0) return;
    const scrollLeft = snapScrollLeft(viewRef.current.scrollLeft);
    const zoomNow = viewRef.current.zoom;
    const toX = (t: number) => (t * zoomNow) - scrollLeft;
    const toTime = (x: number) => (x + scrollLeft) / zoomNow;

    const centerY = waveHeight / 2;
    const ampScale = waveHeight / 2;

    ctx.fillStyle = '#0B1220';
    ctx.fillRect(x0, 0, x1 - x0, waveHeight);

    ctx.beginPath();
    ctx.strokeStyle = '#1a2438';
    ctx.lineWidth = 1;
    ctx.moveTo(x0, centerY);
    ctx.lineTo(x1, centerY);
    ctx.stroke();

    const startTime = Math.max(0, toTime(0));
    const endTime = Math.min(audioData.duration, toTime(intWidth));
    const startPixel = Math.max(Math.floor(Math.max(0, toX(startTime))), Math.ceil(x0));
    const endPixel = Math.min(Math.ceil(Math.min(intWidth, toX(endTime))), Math.floor(x1));
    if (endPixel < startPixel) return;

    const rawData = audioData.buffer.getChannelData(0);
    const step = Math.ceil(audioData.buffer.sampleRate / zoomNow);

    ctx.beginPath();
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 1;
    for (let x = startPixel; x <= endPixel; x++) {
        const t = toTime(x);
        const sampleIdx = Math.floor(t * audioData.buffer.sampleRate);
        if (sampleIdx < 0 || sampleIdx >= rawData.length) continue;

        let min = 1.0, max = -1.0;
        const chunkEnd = Math.min(sampleIdx + step, rawData.length);
        const stride = Math.max(1, Math.floor((chunkEnd - sampleIdx) / 10));
        for (let i = sampleIdx; i < chunkEnd; i += stride) {
            const val = rawData[i];
            if (val < min) min = val;
            if (val > max) max = val;
        }
        if (min > max) { min = 0; max = 0; }
        ctx.moveTo(x, centerY + min * ampScale);
        ctx.lineTo(x, centerY + max * ampScale);
    }
    ctx.stroke();
  }, [audioVersion, audioDataRef, intWidth, waveHeight, snapScrollLeft, viewRef]);

  /**
   * Rebuilds the exact waveform into the scratch canvas, a slice at a time, and
   * swaps it in when finished. The work per frame is capped, so a short zoom
   * gesture never ends with one long blocking frame.
   */
  const runWaveRefine = useCallback(() => {
    waveRefineRafRef.current = null;
    const job = waveRefineRef.current;
    const visible = waveViewRef.current;
    const canvas = waveformRef.current;
    if (!job || !visible || !canvas) { waveRefineRef.current = null; return; }
    // Abandon the rebuild if the view moved on (new gesture, pan, new audio).
    if (
      visible.zoom !== job.zoom ||
      visible.scrollLeft !== job.scrollLeft ||
      visible.audioData !== job.audioData ||
      !visible.approximate
    ) {
      waveRefineRef.current = null;
      return;
    }
    const target = waveRefineCanvasRef.current;
    const tctx = target?.getContext('2d');
    if (!target || !tctx) { waveRefineRef.current = null; return; }

    const fullWidth = target.width;
    const slice = Math.max(1, Math.ceil(intWidth / 24));
    const started = performance.now();
    while (job.nextColumn < fullWidth && performance.now() - started < 6) {
      const x0 = Math.floor(job.nextColumn / dpr);
      const x1 = Math.min(intWidth, x0 + slice);
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintWaveformRange(tctx, x0, x1);
      job.nextColumn = Math.ceil(x1 * dpr);
    }

    if (job.nextColumn >= fullWidth) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(target, 0, 0);
      }
      visible.approximate = false;
      captureWavePrecise(visible.zoom, visible.scrollLeft);
      waveRefineRef.current = null;
      return;
    }
    waveRefineRafRef.current = window.requestAnimationFrame(() => runWaveRefineRef.current());
  }, [dpr, intWidth, paintWaveformRange, captureWavePrecise]);
  useEffect(() => { runWaveRefineRef.current = runWaveRefine; }, [runWaveRefine]);

  /** Starts the deferred, sliced rebuild once the zoom gesture has stopped. */
  const scheduleWaveRefine = useCallback(() => {
    if (waveRefineTimerRef.current !== null) window.clearTimeout(waveRefineTimerRef.current);
    waveRefineTimerRef.current = window.setTimeout(() => {
      waveRefineTimerRef.current = null;
      const visible = waveViewRef.current;
      const canvas = waveformRef.current;
      if (!visible || !visible.approximate || !canvas) return;
      const target = ensureOffscreen(waveRefineCanvasRef, canvas.width, canvas.height);
      const tctx = target.getContext('2d');
      if (!tctx) return;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.fillStyle = '#0B1220';
      tctx.fillRect(0, 0, target.width, target.height);
      waveRefineRef.current = {
        nextColumn: 0, zoom: visible.zoom, scrollLeft: visible.scrollLeft, audioData: visible.audioData,
      };
      runWaveRefineRef.current();
    }, 180);
  }, [ensureOffscreen]);

  const drawWaveform = useCallback(() => {
    const canvas = waveformRef.current;
    if (!canvas || !audioData || intWidth <= 0 || waveHeight <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const fullWidth = Math.floor(intWidth * dpr);
    const fullHeight = Math.floor(waveHeight * dpr);
    if (fullWidth <= 0 || fullHeight <= 0) return;
    // Assigning width/height reallocates the backing store, so only do it when the
    // size changed; that also invalidates everything remembered about the frame.
    if (canvas.width !== fullWidth || canvas.height !== fullHeight) {
      canvas.width = fullWidth;
      canvas.height = fullHeight;
      waveViewRef.current = null;
      wavePreciseRef.current = null;
      cancelWaveRefine();
    }
    canvas.style.width = `${intWidth}px`;
    canvas.style.height = `${waveHeight}px`;

    const scrollLeft = snapScrollLeft(viewRef.current.scrollLeft);
    const deviceOffset = Math.round(scrollLeft * dpr);
    const zoomNow = viewRef.current.zoom;
    const previous = waveViewRef.current;
    const sameFrame =
      previous !== null &&
      previous.w === fullWidth &&
      previous.h === fullHeight &&
      previous.audioData === audioData;
    const sameZoom = sameFrame && previous!.zoom === zoomNow;
    const shift = sameZoom ? deviceOffset - previous!.deviceOffset : 0;

    /** Exact rebuild straight onto the visible canvas, in one blocking pass. */
    const paintExactNow = () => {
      cancelWaveRefine();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintWaveformRange(ctx, 0, intWidth);
      waveViewRef.current = {
        zoom: zoomNow, scrollLeft, w: fullWidth, h: fullHeight, audioData, deviceOffset,
        approximate: false,
      };
      captureWavePrecise(zoomNow, scrollLeft);
    };

    /**
     * Exact rebuild spread over several frames (used when there is nothing worth
     * keeping on screen, e.g. the first draw after loading a song). Stroking a
     * full song is the most expensive paint in the app, so it must not run as one
     * blocking task.
     */
    const paintExactSliced = () => {
      cancelWaveRefine();
      const target = ensureOffscreen(waveRefineCanvasRef, fullWidth, fullHeight);
      const tctx = target.getContext('2d');
      if (!tctx) {
        paintExactNow();
        return;
      }
      // Blank the visible canvas while the slices are being built, so a previous
      // song never lingers behind the new one.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0B1220';
      ctx.fillRect(0, 0, fullWidth, fullHeight);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.fillStyle = '#0B1220';
      tctx.fillRect(0, 0, target.width, target.height);
      waveViewRef.current = {
        zoom: zoomNow, scrollLeft, w: fullWidth, h: fullHeight, audioData, deviceOffset,
        approximate: true,
      };
      waveRefineRef.current = {
        nextColumn: 0, zoom: zoomNow, scrollLeft, audioData,
      };
      runWaveRefineRef.current();
    };

    if (!sameFrame) {
      paintExactSliced();
      return;
    }

    if (!sameZoom) {
      // Zoom: stretch the last exact frame from its own canvas. Reading the
      // visible canvas here would sample the frame we are about to overwrite.
      const precise = wavePreciseRef.current;
      if (!precise || precise.w !== fullWidth || precise.h !== fullHeight) {
        // Nothing trustworthy to stretch yet (still building the first frame).
        paintExactSliced();
        return;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0B1220';
      ctx.fillRect(0, 0, fullWidth, fullHeight);
      {
        const srcAt = (x: number) =>
          dpr * (((scrollLeft + x / dpr) / zoomNow) * precise.zoom - precise.scrollLeft);
        const x0 = srcAt(0);
        const x1 = srcAt(fullWidth);
        if (x1 > x0) {
          const sx0 = Math.max(0, x0);
          const sx1 = Math.min(fullWidth, x1);
          if (sx1 > sx0) {
            const d0 = ((sx0 - x0) / (x1 - x0)) * fullWidth;
            const d1 = ((sx1 - x0) / (x1 - x0)) * fullWidth;
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(precise.canvas, sx0, 0, sx1 - sx0, fullHeight, d0, 0, d1 - d0, fullHeight);
          }
        }
      }
      waveViewRef.current = {
        zoom: zoomNow, scrollLeft, w: fullWidth, h: fullHeight, audioData, deviceOffset,
        approximate: true,
      };
      cancelWaveRefine();
      scheduleWaveRefine();
      return;
    }

    if (shift === 0 && !previous!.approximate) return;

    // An approximate frame can not be shifted: the error would accumulate, so a
    // pan needs a correct base immediately.
    if (previous!.approximate) {
      paintExactNow();
      return;
    }
    if (shift <= -fullWidth || shift >= fullWidth) {
      paintExactSliced();
      return;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(canvas, -shift, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const stripW = Math.abs(shift) / dpr;
    const stripX = shift > 0 ? intWidth - stripW : 0;
    paintWaveformRange(ctx, stripX, stripX + stripW);
    waveViewRef.current = {
      zoom: zoomNow, scrollLeft, w: fullWidth, h: fullHeight, audioData, deviceOffset,
      approximate: false,
    };
    // Keep the preview source in step with what panning just produced.
    captureWavePrecise(zoomNow, scrollLeft);
  }, [
    audioVersion, audioDataRef, intWidth, waveHeight, dpr, snapScrollLeft, viewRef, paintWaveformRange,
    cancelWaveRefine, scheduleWaveRefine, captureWavePrecise,
  ]);
  useEffect(() => { drawWaveformRef.current = drawWaveform; }, [drawWaveform]);
  // Test hook: forces a rebuild straight from the audio, so a preview frame can
  // be told apart from an exact one.
  useEffect(() => {
    (window as any).__forceWaveExact = () => {
      wavePreciseRef.current = null;
      waveViewRef.current = null;
      drawWaveformRef.current();
    };
  }, []);
  // --- Draw Spectrogram from precomputed data ---
  // Panning never recomputes the whole view: the bitmap kept in JS is shifted in
  // place and only the newly exposed columns are rendered. That bitmap is the
  // source of truth, and it is uploaded whole every time, so the canvas can never
  // drift out of sync with it (a canvas whose pixels the browser dropped, or that
  // was cleared by a resize, is repaired by the next paint).
  const drawSpectrogram = useCallback(() => {
    const sCanvas = spectrogramRef.current;
    if (!sCanvas) return;
    const ctx = sCanvas.getContext('2d');
    if (!ctx) return;

    const fullWidth = Math.floor(intWidth * dpr);
    const fullHeight = Math.floor(specHeight * dpr);
    if (fullWidth <= 0 || fullHeight <= 0) return;

    // Assigning width/height reallocates and clears the backing store, so the
    // bitmap has to be rebuilt for the new size.
    if (sCanvas.width !== fullWidth || sCanvas.height !== fullHeight) {
      sCanvas.width = fullWidth;
      sCanvas.height = fullHeight;
      specViewRef.current = null;
      specMirrorRef.current = null;
    }
    sCanvas.style.width = `${intWidth}px`;
    sCanvas.style.height = `${specHeight}px`;

    // Fall back to the coarse stand-in while the full-resolution data is computed.
    const spectrogram = audioData ? (audioData.spectrogram ?? audioData.spectrogramPreview) : null;

    if (!spectrogram) {
      specViewRef.current = null;
      specMirrorRef.current = null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, fullWidth, fullHeight);
      return;
    }

    const rawDeviceOffset = snapScrollLeft(viewRef.current.scrollLeft) * dpr;
    const deviceOffset = Number.isFinite(rawDeviceOffset) ? Math.round(rawDeviceOffset) : 0;
    const view: SpectrogramView = {
      width: fullWidth,
      height: fullHeight,
      dpr,
      zoom: viewRef.current.zoom,
      logBase: specLogBase,
      deviceOffset,
      spec: spectrogram,
    };

    const previous = specViewRef.current;
    const plan = planSpectrogramPaint(previous, view);

    let mirror = specMirrorRef.current;
    // The bitmap also has to match the canvas element itself: React can hand us a
    // fresh, blank canvas while the component instance (and its refs) survives.
    if (
      !mirror ||
      mirror.canvas !== sCanvas ||
      mirror.image.width !== fullWidth ||
      mirror.image.height !== fullHeight
    ) {
      const image = ctx.createImageData(fullWidth, fullHeight);
      mirror = { canvas: sCanvas, image, buf32: new Uint32Array(image.data.buffer) };
      specMirrorRef.current = mirror;
      mirror.buf32.fill(0xFF000000);
      renderSpectrogramStrip(mirror.buf32, fullWidth, view, view.deviceOffset, fullWidth);
    } else if (!plan) {
      // Nothing about the view changed; still repaint below so a canvas whose
      // pixels went missing is restored.
    } else if (plan.full) {
      mirror.buf32.fill(0xFF000000);
      renderSpectrogramStrip(mirror.buf32, fullWidth, view, view.deviceOffset, fullWidth);
    } else {
      const shift = view.deviceOffset - previous!.deviceOffset;
      mirror.buf32.copyWithin(shift > 0 ? 0 : -shift, shift > 0 ? shift : 0);
      renderSpectrogramStrip(
        mirror.buf32,
        fullWidth,
        view,
        plan.firstColumn,
        plan.count,
        plan.firstColumn - view.deviceOffset
      );
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(mirror.image, 0, 0);
    specViewRef.current = view;

    // Diagnostic switch: run `__specDebug = true` in the console to log what each
    // spectrogram paint drew (view parameters, data size, painted brightness).
    if ((window as any).__specDebug) {
      let nonBlack = 0;
      for (let i = 0; i < mirror.buf32.length; i += 997) {
        if ((mirror.buf32[i] >>> 0) !== 0xFF000000) nonBlack++;
      }
      console.log('[spec] ' + JSON.stringify({
        dpr, zoom: view.zoom, logBase: view.logBase, deviceOffset: view.deviceOffset,
        plan: plan ? (plan.full ? 'full' : 'strip') : 'none',
        timeBins: spectrogram.timeBins, freqBins: spectrogram.freqBins,
        dataLen: spectrogram.data.length, maxMag: spectrogram.maxMagnitude,
        nonBlackSamples: nonBlack,
      }));
      (window as any).__specData = spectrogram;
      (window as any).__specView = view;
      (window as any).__specScrollLeft = viewRef.current.scrollLeft;
    }
  }, [audioVersion, audioDataRef, intWidth, specHeight, specLogBase, dpr, drawEpoch, snapScrollLeft, viewRef]);

  // --- Draw Overlay ---
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas || intWidth <= 0 || intHeight <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const fullWidth = Math.floor(intWidth * dpr);
    const fullHeight = Math.floor(intHeight * dpr);
    if (fullWidth <= 0 || fullHeight <= 0) return;
    if (canvas.width !== fullWidth || canvas.height !== fullHeight) {
        canvas.width = fullWidth;
        canvas.height = fullHeight;
    }
    canvas.style.width = `${intWidth}px`;
    canvas.style.height = `${intHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, intWidth, intHeight);

    if (!audioData) return;

    const startTime = xToTime(0);
    const endTime = xToTime(intWidth);
    ctx.textAlign = 'center';
    ctx.font = 'bold 12px sans-serif';

    for (let i = 0; i < timingPoints.length; i++) {
        const point = timingPoints[i];
        const nextPoint = timingPoints[i+1];
        const sectionEndTime = nextPoint ? nextPoint.time : audioData.duration;
        if (sectionEndTime < startTime) continue;
        if (point.time > endTime) break;

        const interval = 60 / point.bpm;
        const visibleStart = Math.max(startTime, point.time);
        const timeOffsetFromPoint = visibleStart - point.time;
        const beatsFromPointStart = timeOffsetFromPoint / interval;
        const startBeatRel = Math.ceil(beatsFromPointStart);

        let relIndex = startBeatRel;
        while (true) {
            const beatIndex = point.beatIndex + relIndex;
            const time = point.time + relIndex * interval;
            if (nextPoint && beatIndex >= nextPoint.beatIndex) break;
            if (time > Math.min(endTime, sectionEndTime)) break;

            const x = timeToX(time);
            const isSectionStart = relIndex === 0;
            
            const color = isSectionStart ? '#ef4444' : 'rgba(0, 242, 255, 0.6)';
            const lineWidth = isSectionStart ? 2 : 1;

            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, waveHeight + specHeight);
            ctx.stroke();

            const arrowY = waveHeight + specHeight + 6;
            ctx.fillStyle = isSectionStart ? '#ef4444' : 'rgba(0, 242, 255, 0.8)';
            ctx.beginPath();
            ctx.moveTo(x, arrowY);
            ctx.lineTo(x - 5, arrowY + 8);
            ctx.lineTo(x + 5, arrowY + 8);
            ctx.fill();

            if (isSectionStart || relIndex % 4 === 0) {
                 ctx.fillStyle = isSectionStart ? '#ef4444' : '#00f2ff';
                 ctx.fillText(beatIndex.toString(), x, arrowY + 22);
            }
            relIndex++;
        }
    }

    const playheadX = timeToX(currentTime);
    if (playheadX >= -2 && playheadX <= intWidth + 2) {
        ctx.beginPath();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, intHeight);
        ctx.stroke();
    }
  }, [audioVersion, audioDataRef, timingPoints, currentTime, intWidth, intHeight, waveHeight, specHeight, dpr, drawEpoch, timeToX, xToTime]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!audioData) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (mouseY > waveHeight + specHeight) {
        const mouseTime = xToTime(mouseX);
        let bestDist = Infinity;
        let bestPointIdx = -1;
        let bestBeatIndex = -1;
        let isSectionStart = false;

        for (let i = 0; i < timingPoints.length; i++) {
            const point = timingPoints[i];
            const nextPoint = timingPoints[i+1];
            const sectionEndTime = nextPoint ? nextPoint.time : audioData.duration;
            if (point.time > mouseTime + 1) break; 
            if (sectionEndTime < mouseTime - 1) continue;
            const interval = 60 / point.bpm;
            const diff = mouseTime - point.time;
            const beats = Math.round(diff / interval);
            const beatIndex = point.beatIndex + beats;
            const time = point.time + beats * interval;
            if (nextPoint && beatIndex >= nextPoint.beatIndex) continue;
            if (beatIndex < point.beatIndex) continue;
            const dist = Math.abs(timeToX(time) - mouseX);
            if (dist < 15 && dist < bestDist) {
                bestDist = dist;
                bestPointIdx = i;
                bestBeatIndex = beatIndex;
                isSectionStart = (beatIndex === point.beatIndex);
            }
        }

        if (bestPointIdx !== -1) {
            let type: 'offset' | 'bpm' = 'bpm';
            let targetIdx = bestPointIdx;
            if (isSectionStart) {
                if (bestPointIdx === 0) type = 'offset';
                else targetIdx = bestPointIdx - 1;
            }
            setDragging({
                type,
                pointIndex: targetIdx,
                beatIndex: bestBeatIndex,
                startX: mouseX,
                initialVal: type === 'offset' ? timingPoints[0].time : timingPoints[targetIdx].bpm
            });
            return;
        }
    }
    onSeek(xToTime(mouseX));
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
      if (!dragging || !audioData) return;
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseTime = xToTime(mouseX);

      if (dragging.type === 'offset') {
          const roundedOffset = Math.round(mouseTime * 1000) / 1000;
          onUpdateOffset(roundedOffset);
      } 
      else if (dragging.type === 'bpm') {
          const point = timingPoints[dragging.pointIndex];
          const beatsFromStart = dragging.beatIndex - point.beatIndex;
          if (beatsFromStart === 0) return; 
          const timeDiff = mouseTime - point.time;
          if (timeDiff <= 0.001) return; 
          const rawBpm = (beatsFromStart * 60) / timeDiff;
          const roundedBpm = Math.round(rawBpm * 100) / 100;
          if (roundedBpm > 10 && roundedBpm < 1000) onUpdateBpm(point.beatIndex, roundedBpm);
      }
  }, [dragging, audioVersion, audioDataRef, xToTime, timingPoints, onUpdateBpm, onUpdateOffset]); 

  const handleMouseUp = () => setDragging(null);

  // --- Paint orchestration -------------------------------------------------
  // Panning is driven imperatively: the parent mutates `viewRef` and calls
  // `redrawRef.current()`, which coalesces into one paint per frame. React only
  // re-renders for things that are actually React state (zoom, timing points,
  // audio, size), and each of those renders also repaints.
  const lastPaintRef = useRef<{
    zoom: number; scrollLeft: number; currentTime: number; logBase: number;
    w: number; h: number; audioVersion: number; timingPoints: TimingPoint[] | null; epoch: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  const paint = useCallback((force: boolean) => {
    const view = viewRef.current;
    const previous = lastPaintRef.current;
    const sameAsLast =
      !force &&
      previous !== null &&
      previous.zoom === view.zoom &&
      previous.scrollLeft === view.scrollLeft &&
      previous.currentTime === currentTime &&
      previous.logBase === specLogBase &&
      previous.w === intWidth &&
      previous.h === intHeight &&
      previous.audioVersion === audioVersion &&
      previous.timingPoints === timingPoints &&
      previous.epoch === drawEpoch;
    if (sameAsLast) return;

    lastPaintRef.current = {
      zoom: view.zoom, scrollLeft: view.scrollLeft, currentTime, logBase: specLogBase,
      w: intWidth, h: intHeight, audioVersion, timingPoints, epoch: drawEpoch,
    };
    drawWaveform();
    drawSpectrogram();
    drawOverlay();
  }, [
    viewRef, currentTime, specLogBase, intWidth, intHeight, audioVersion, timingPoints, drawEpoch,
    drawWaveform, drawSpectrogram, drawOverlay,
  ]);

  const schedulePaint = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      paint(false);
    });
  }, [paint]);

  // Repaint on every React render: the signature check above keeps this cheap
  // when a render did not change anything the canvases depend on.
  useLayoutEffect(() => {
    paint(false);
  });

  // Hand the imperative entry point to the parent (used for wheel panning).
  useEffect(() => {
    redrawRef.current = schedulePaint;
    return () => {
      redrawRef.current = null;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [redrawRef, schedulePaint]);

  useEffect(() => {
    if (dragging) {
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, handleMouseMove]);

  return (
    <div className="relative select-none w-full h-full bg-[#0B1220]">
       <canvas ref={waveformRef} className="absolute top-0 left-0 pointer-events-none" />
       <canvas ref={spectrogramRef} className="absolute left-0 pointer-events-none" style={{ top: waveHeight }} />
       <div
         className="absolute left-0 right-0 pointer-events-none border-t border-white/10 bg-[#101826]"
         style={{ top: waveHeight + specHeight, height: TIMELINE_HEIGHT }}
       />
       <canvas ref={overlayRef} className="absolute top-0 left-0 cursor-crosshair" onMouseDown={handleMouseDown} />
    </div>
  );
};

export default Visualizer;
