import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { 
    Play, Pause, Square, ZoomIn, ZoomOut, Upload, Music, 
    Volume2, VolumeX, Plus, Trash2, Settings, 
    PanelRightClose, PanelRightOpen, Sliders, 
    Download, FileUp, Info, MousePointer2, Keyboard, HelpCircle,
    Loader2, CheckCircle2, AlertTriangle, AudioLines, X, Maximize2, SkipBack
} from 'lucide-react';
import Visualizer from './components/Visualizer';
import { Welcome, TapTempo } from './components/StudioControls';
import { AudioData, ViewState, TimingPoint } from './types';
import { extractPeaks } from './utils/audioUtils';
import { runSpectrogramJob, SpectrogramMessage, SpectrogramRequest } from './utils/spectrogram';
import { recalculateTiming, getPointAtTime, getTimeAtBeatIndex } from './utils/timingUtils';

const MIN_ZOOM = 10;
const MAX_ZOOM = 1500;
const DEFAULT_ZOOM = 250; 

// Spectrogram analysis settings.
// HOP = FFT_SIZE / 4 keeps frames close enough together that interpolation looks
// continuous; the coarse preview is 16x cheaper and lands almost instantly.
const FFT_SIZE = 1024;
const HOP_SIZE = 256;
const PREVIEW_HOP_SIZE = 4096;

type SpectrogramStatus =
    | { state: 'idle' }
    | { state: 'computing'; progress: number }
    | { state: 'ready' }
    | { state: 'error'; message: string };

interface TimingRowProps {
    point: TimingPoint;
    index: number;
    totalCount: number;
    onUpdate: (id: string, field: 'bpm' | 'beatIndex', value: number) => void;
    onRemove: (id: string) => void;
}

const TimingRow: React.FC<TimingRowProps> = React.memo(({ point, index, totalCount, onUpdate, onRemove }) => {
    const [bpmStr, setBpmStr] = useState(point.bpm.toFixed(2));
    const [beatStr, setBeatStr] = useState(point.beatIndex.toString());

    useEffect(() => {
        if (Math.abs(parseFloat(bpmStr) - point.bpm) > 0.001) {
             setBpmStr(point.bpm.toFixed(2));
        }
    }, [point.bpm]);

    useEffect(() => {
        if (Math.abs(parseFloat(beatStr) - point.beatIndex) > 0.001) {
            setBeatStr(point.beatIndex.toString());
        }
    }, [point.beatIndex]);

    const handleBlurBpm = () => {
        const val = parseFloat(bpmStr);
        if (!isNaN(val) && val > 0) {
            const rounded = Math.round(val * 100) / 100;
            onUpdate(point.id, 'bpm', rounded);
            setBpmStr(rounded.toFixed(2));
        } else {
            setBpmStr(point.bpm.toFixed(2));
        }
    };

    const handleBlurBeat = () => {
        const val = parseFloat(beatStr);
        if (!isNaN(val) && val >= 0) {
             onUpdate(point.id, 'beatIndex', val);
             setBeatStr(val.toString());
        } else {
             setBeatStr(point.beatIndex.toString());
        }
    };

    const isStartAnchor = point.beatIndex === 0;

    return (
        <div className={`timing-card bg-paper-soft rounded-xl p-4 border border-paper-line border-l-4 ${isStartAnchor ? 'border-l-rose' : 'border-l-sky'} group transition-all duration-200 shadow-panel hover:border-ink-faint/30`}>
            <div className="flex justify-between items-center mb-3">
                <span className="text-[11px] font-semibold text-ink-soft tracking-wide">
                    {isStartAnchor ? '起点锚点 (Offset)' : `变速段落 ${index}`}
                </span>
                {!isStartAnchor && (
                    <button onClick={() => onRemove(point.id)} className="text-ink-faint hover:text-rose opacity-0 group-hover:opacity-100 transition p-1.5 rounded-md hover:bg-rose-soft" title="删除段落">
                        <Trash2 size={15} />
                    </button>
                )}
            </div>
            
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="text-[11px] text-ink-faint block mb-1 font-medium">拍索引</label>
                    <input 
                        type="number" 
                        aria-label={`段落 ${index} 拍索引`}
                        disabled={isStartAnchor}
                        value={beatStr}
                        onChange={(e) => setBeatStr(e.target.value)}
                        onBlur={handleBlurBeat}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className={`w-full bg-paper border border-paper-line rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-teal focus:ring-2 focus:ring-teal/20 ${isStartAnchor ? 'text-ink-faint' : 'text-ink'}`}
                    />
                </div>
                <div>
                    <label className="text-[11px] text-ink-faint block mb-1 font-medium">BPM</label>
                    <input 
                        type="number" 
                        aria-label={`段落 ${index} BPM`}
                        step="0.01"
                        value={bpmStr}
                        onChange={(e) => setBpmStr(e.target.value)}
                        onBlur={handleBlurBpm}
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className="w-full bg-paper border border-paper-line rounded-lg px-3 py-2 text-sm text-sky font-mono font-semibold focus:outline-none focus:border-sky focus:ring-2 focus:ring-sky/20"
                    />
                </div>
            </div>
            
            <div className="mt-3 pt-3 border-t border-paper-line flex justify-between items-center text-xs font-mono">
                <span className="text-ink-faint font-medium">起始时间</span>
                <span className="text-teal font-semibold">{point.time.toFixed(3)}s</span>
            </div>
        </div>
    );
});

/**
 * State that follows high-frequency input (wheel, drag). Updates are coalesced
 * into one commit per animation frame, so a burst of wheel events costs one
 * render + one repaint instead of one per event.
 */
function useRafValue<T>(initial: T) {
    const [value, setValue] = useState<T>(initial);
    const ref = useRef<T>(initial);
    const rafRef = useRef<number | null>(null);

    const schedule = useCallback((next: T | ((prev: T) => T)) => {
        ref.current = typeof next === 'function' ? (next as (prev: T) => T)(ref.current) : next;
        if (rafRef.current === null) {
            rafRef.current = window.requestAnimationFrame(() => {
                rafRef.current = null;
                setValue(ref.current);
            });
        }
    }, []);

    useEffect(() => {
        // Keep the ref usable for reads inside event handlers, but never clobber
        // a newer value that is still waiting for its frame.
        if (rafRef.current === null) ref.current = value;
    }, [value]);

    useEffect(() => () => {
        if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    }, []);

    return { value, ref, schedule };
}

const OffsetInput = ({ value, onChange }: { value: number, onChange: (val: number) => void }) => {
    const [localVal, setLocalVal] = useState(value.toFixed(3));
    useEffect(() => {
        if (Math.abs(parseFloat(localVal) - value) > 0.0001) setLocalVal(value.toFixed(3));
    }, [value]);
    const handleBlur = () => {
        const val = parseFloat(localVal);
        if (!isNaN(val)) { 
            const rounded = Math.round(val * 1000) / 1000;
            onChange(rounded); 
            setLocalVal(rounded.toFixed(3)); 
        }
        else setLocalVal(value.toFixed(3));
    }
    return (
        <input 
            type="number" aria-label="全局起始偏移（秒）" step="0.001" value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="w-full bg-paper border border-paper-line rounded-lg px-3 py-2 text-base text-rose font-mono font-semibold focus:outline-none focus:border-rose focus:ring-2 focus:ring-rose/20"
        />
    )
}

function App() {
  const [audioContext] = useState(() => new (window.AudioContext || (window as any).webkitAudioContext)());
  // The decoded audio (buffer + peaks + multi-megabyte spectrogram) is kept in a
  // ref: React's dev build walks props/state to feed the DevTools performance
  // panel, which cost several seconds per import when this lived in state.
  const audioDataRef = useRef<AudioData | null>(null);
  const [audioVersion, setAudioVersion] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const hasAudio = audioVersion > 0;

  const commitAudioData = useCallback((next: AudioData | null) => {
    audioDataRef.current = next;
    setAudioDuration(next ? next.duration : 0);
    setAudioVersion(v => v + 1);
  }, []);
  const [spectrogramStatus, setSpectrogramStatus] = useState<SpectrogramStatus>({ state: 'idle' });
  const [fileName, setFileName] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isMetronomeOn, setIsMetronomeOn] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth > 760);
  const [specLogBase, setSpecLogBase] = useState(50);
  const [showHelp, setShowHelp] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragDepthRef = useRef(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const audioLoadIdRef = useRef(0);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  
  const { value: globalOffset, schedule: setGlobalOffset } = useRafValue(0);
  const { value: rawPoints, schedule: setRawPoints } = useRafValue<Omit<TimingPoint, 'time'>[]>([
      { id: 'initial', beatIndex: 0, bpm: 120 }
  ]);
  
  const timingPoints = useMemo(() => recalculateTiming(globalOffset, rawPoints), [globalOffset, rawPoints]);
  // Scroll position lives in a ref and is drawn imperatively: a wheel burst must
  // not turn into one React render per frame. Zoom stays in React state because
  // it is displayed in the footer and changes rarely compared to panning.
  const viewRef = useRef<ViewState>({ zoom: DEFAULT_ZOOM, scrollLeft: 0 });
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const visualizerRedrawRef = useRef<(() => void) | null>(null);
  const requestRedraw = useCallback(() => { visualizerRedrawRef.current?.(); }, []);
  // Wheel input drives a target; the view eases toward it once per frame so the
  // timeline slides smoothly instead of jumping a whole notch at a time.
  const scrollTargetRef = useRef(0);
  const scrollAnimRafRef = useRef<number | null>(null);

  const animateScroll = useCallback(() => {
    if (scrollAnimRafRef.current !== null) return;
    let last = performance.now();
    const step = (now: number) => {
      const view = viewRef.current;
      const dt = Math.min(64, Math.max(1, now - last));
      last = now;
      const target = scrollTargetRef.current;
      const diff = target - view.scrollLeft;
      if (Math.abs(diff) < 0.25) {
        view.scrollLeft = target;
        requestRedraw();
        scrollAnimRafRef.current = null;
        return;
      }
      // Ease-out: covers ~63% of the remaining distance every 25ms, so a single
      // wheel notch settles in roughly 150ms while a fast spin stays smooth.
      view.scrollLeft += diff * (1 - Math.exp(-dt / 25));
      requestRedraw();
      scrollAnimRafRef.current = window.requestAnimationFrame(step);
    };
    scrollAnimRafRef.current = window.requestAnimationFrame(step);
  }, [requestRedraw]);

  const stopScrollAnimation = useCallback(() => {
    if (scrollAnimRafRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimRafRef.current);
      scrollAnimRafRef.current = null;
    }
  }, []);
  useEffect(() => stopScrollAnimation, [stopScrollAnimation]);

  const setScrollTarget = useCallback((next: number) => {
    scrollTargetRef.current = next;
    animateScroll();
  }, [animateScroll]);
  const zoomLabelTimerRef = useRef<number | null>(null);
  // During a zoom gesture the label only needs to look live, so it refreshes a
  // few times per second instead of forcing a React render on every wheel event.
  const scheduleZoomLabel = useCallback(() => {
    if (zoomLabelTimerRef.current !== null) return;
    zoomLabelTimerRef.current = window.setTimeout(() => {
      zoomLabelTimerRef.current = null;
      setZoom(viewRef.current.zoom);
    }, 120);
  }, []);
  useEffect(() => () => {
    if (zoomLabelTimerRef.current !== null) window.clearTimeout(zoomLabelTimerRef.current);
  }, []);

  const applyZoomFactor = useCallback((factor: number) => {
    const view = viewRef.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor));
    if (next === view.zoom) return;
    view.zoom = next;
    scrollTargetRef.current = view.scrollLeft;
    setZoom(next);
    requestRedraw();
  }, [requestRedraw]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0); 
  const startOffsetRef = useRef<number>(0); 
  const rafRef = useRef<number | null>(null);
  const lastScheduledIndexRef = useRef<number>(-Infinity);

  const spectrogramWorkerRef = useRef<Worker | null>(null);
  const spectrogramJobRef = useRef<number>(0);

  useEffect(() => () => {
    spectrogramWorkerRef.current?.terminate();
    spectrogramWorkerRef.current = null;
  }, []);

  const applySpectrogramMessage = useCallback((message: SpectrogramMessage, jobId: number) => {
    // A newer file was loaded, so anything from this job is stale.
    if (jobId !== spectrogramJobRef.current) return;

    if (message.type === 'preview') {
      const prev = audioDataRef.current;
      if (!prev) return;
      audioDataRef.current = { ...prev, spectrogramPreview: message.spectrogram };
      setAudioVersion(v => v + 1);
    } else if (message.type === 'progress') {
      setSpectrogramStatus({ state: 'computing', progress: message.progress });
    } else if (message.type === 'done') {
      const prev = audioDataRef.current;
      if (!prev) return;
      audioDataRef.current = { ...prev, spectrogram: message.spectrogram };
      setAudioVersion(v => v + 1);
      setSpectrogramStatus({ state: 'ready' });
    } else {
      console.error('频谱图计算失败：', message.message);
      setSpectrogramStatus({ state: 'error', message: message.message });
    }
  }, []);

  // Fallback for environments where a module worker cannot be started.
  const computeSpectrogramOnMainThread = useCallback(async (request: SpectrogramRequest, jobId: number) => {
    try {
      await runSpectrogramJob(
        request,
        (message) => applySpectrogramMessage(message, jobId),
        () => new Promise<void>(resolve => { window.setTimeout(resolve, 0); })
      );
    } catch (error) {
      applySpectrogramMessage(
        { type: 'error', message: error instanceof Error ? error.message : String(error) },
        jobId
      );
    }
  }, [applySpectrogramMessage]);

  const startSpectrogramJob = useCallback((buffer: AudioBuffer) => {
    const jobId = ++spectrogramJobRef.current;
    spectrogramWorkerRef.current?.terminate();
    spectrogramWorkerRef.current = null;
    setSpectrogramStatus({ state: 'computing', progress: 0 });

    const request: SpectrogramRequest = {
      channelData: new Float32Array(buffer.getChannelData(0)),
      sampleRate: buffer.sampleRate,
      fftSize: FFT_SIZE,
      hopSize: HOP_SIZE,
      previewHopSize: PREVIEW_HOP_SIZE,
    };

    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./utils/spectrogramWorker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      console.warn('无法创建 Web Worker，改为在主线程分片计算频谱图。', error);
      worker = null;
    }

    if (!worker) {
      void computeSpectrogramOnMainThread(request, jobId);
      return;
    }

    const activeWorker = worker;
    let settled = false;
    activeWorker.onmessage = (event: MessageEvent<SpectrogramMessage>) => {
      if (event.data.type === 'done' || event.data.type === 'error') settled = true;
      applySpectrogramMessage(event.data, jobId);
    };
    activeWorker.onerror = () => {
      activeWorker.terminate();
      if (spectrogramWorkerRef.current === activeWorker) spectrogramWorkerRef.current = null;
      if (settled || jobId !== spectrogramJobRef.current) return;
      // The buffer handed to the worker is gone, so take a fresh copy.
      void computeSpectrogramOnMainThread(
        { ...request, channelData: new Float32Array(buffer.getChannelData(0)) },
        jobId
      );
    };

    spectrogramWorkerRef.current = activeWorker;
    activeWorker.postMessage(request, [request.channelData.buffer]);
  }, [applySpectrogramMessage, computeSpectrogramOnMainThread]);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const currentContainer = containerRef.current;
    setContainerWidth(currentContainer.clientWidth);
    setContainerHeight(currentContainer.clientHeight);
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(currentContainer);
    return () => observer.disconnect();
    // Only the presence of audio matters: the container mounts with it. Using a
    // boolean keeps the observer from being rebuilt when the spectrogram streams in.
  }, [hasAudio]);

  useEffect(() => {
    if (!hasAudio || containerWidth === 0) return;
    const view = viewRef.current;
    const maxScroll = Math.max(0, audioDuration * view.zoom - containerWidth);
    if (view.scrollLeft > maxScroll) {
       view.scrollLeft = maxScroll;
       scrollTargetRef.current = maxScroll;
       stopScrollAnimation();
       requestRedraw();
    }
  }, [containerWidth, zoom, audioDuration, hasAudio, requestRedraw, stopScrollAnimation]);
  
  useEffect(() => { lastScheduledIndexRef.current = -Infinity; }, [timingPoints]);

  const handleAddPoint = () => {
    setRawPoints(prev => {
        const sorted = [...prev].sort((a, b) => a.beatIndex - b.beatIndex);
        const lastPoint = sorted[sorted.length - 1];
        const newBeatIndex = lastPoint.beatIndex + 1;
        if (prev.some(p => p.beatIndex === newBeatIndex)) return prev;
        return [...sorted, { id: crypto.randomUUID(), beatIndex: newBeatIndex, bpm: lastPoint.bpm }];
    });
  };

  const handleUpdatePoint = useCallback((id: string, field: 'bpm' | 'beatIndex', value: number) => {
      setRawPoints(prev => prev.map(p => {
          if (p.id !== id) return p;
          if (p.beatIndex === 0 && field === 'beatIndex') return p; 
          return { ...p, [field]: value };
      }).sort((a, b) => a.beatIndex - b.beatIndex));
  }, []);

  const handleRemovePoint = useCallback((id: string) => {
      setRawPoints(prev => prev.filter(p => p.id !== id || p.beatIndex === 0));
  }, []);

  const loadAudioFile = useCallback(async (file: File) => {
    const loadId = ++audioLoadIdRef.current;
    setIsLoadingAudio(true);
    try {
        const arrayBuffer = await file.arrayBuffer();
        if (audioContext.state === 'suspended') await audioContext.resume();
        const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
        if (loadId !== audioLoadIdRef.current) return;
        if (sourceNodeRef.current) { try { sourceNodeRef.current.stop(); } catch {} sourceNodeRef.current = null; }
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        setFileName(file.name);
        const peaks = extractPeaks(decodedBuffer);
        commitAudioData({
            buffer: decodedBuffer,
            peaks,
            duration: decodedBuffer.duration,
            spectrogram: null,
            spectrogramPreview: null,
        });
        setGlobalOffset(0.1);
        setRawPoints([{ id: 'initial', beatIndex: 0, bpm: 120 }]);
        setCurrentTime(0);
        viewRef.current = { zoom: DEFAULT_ZOOM, scrollLeft: 0 };
        stopScrollAnimation();
        scrollTargetRef.current = 0;
        setZoom(DEFAULT_ZOOM);
        setIsPlaying(false);
        // Runs in a worker, so the waveform is interactive right away.
        startSpectrogramJob(decodedBuffer);
        setToast({ message: '音频已载入，可以开始对齐节拍' });
    } catch (err) {
        console.error(err);
        if (loadId === audioLoadIdRef.current) setToast({ message: '无法读取音频，请检查文件格式后重试', error: true });
    } finally {
        if (loadId === audioLoadIdRef.current) setIsLoadingAudio(false);
    }
  }, [audioContext, commitAudioData, setGlobalOffset, setRawPoints, stopScrollAnimation, startSpectrogramJob]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadAudioFile(file);
    e.target.value = '';
  };

  const loadDemo = () => {
    // A small, local PCM WAV follows the same import path as a user's audio.
    const sampleRate = 22050;
    const duration = 16;
    const frames = sampleRate * duration;
    const bytes = new ArrayBuffer(44 + frames * 2);
    const wav = new DataView(bytes);
    const writeText = (offset: number, value: string) => [...value].forEach((char, i) => wav.setUint8(offset + i, char.charCodeAt(0)));
    writeText(0, 'RIFF'); wav.setUint32(4, 36 + frames * 2, true); writeText(8, 'WAVE');
    writeText(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
    wav.setUint32(24, sampleRate, true); wav.setUint32(28, sampleRate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
    writeText(36, 'data'); wav.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate - 0.1;
      const phase = ((t % 0.5) + 0.5) % 0.5;
      const beat = Math.floor(t / 0.5);
      const kick = Math.sin(2 * Math.PI * (65 * phase + 8 * (1 - Math.exp(-phase * 30)))) * Math.exp(-phase * 22);
      const click = Math.sin(2 * Math.PI * (beat % 4 === 0 ? 1200 : 800) * phase) * Math.exp(-phase * 65);
      const value = t < 0 ? 0 : (kick * 0.6 + click * 0.15) * Math.min(1, phase * 1500);
      wav.setInt16(44 + i * 2, value * 32767, true);
    }
    void loadAudioFile(new File([bytes], '示例节奏 · 120 BPM.wav', { type: 'audio/wav' }));
  };

  const handleExportJson = () => {
      const config = {
          version: "1.0",
          offset: globalOffset,
          points: rawPoints.map(p => ({ beatIndex: p.beatIndex, bpm: p.bpm }))
      };
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timing_config_${new Date().getTime()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setToast({ message: '节奏配置已导出' });
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
          try {
              const config = JSON.parse(event.target?.result as string);
              if (typeof config.offset === 'number' && Array.isArray(config.points)) {
                  setGlobalOffset(config.offset);
                  setRawPoints(config.points.map((p: any) => ({
                      id: crypto.randomUUID(),
                      beatIndex: p.beatIndex,
                      bpm: p.bpm
                  })));
              } else {
                  alert("无效的配置文件格式。");
              }
          } catch (err) {
              alert("解析配置文件失败。");
          }
      };
      reader.readAsText(file);
      e.target.value = ''; // Reset input
  };

  const play = useCallback(async () => {
    const audioData = audioDataRef.current;
    if (!audioData) return;
    if (audioContext.state === 'suspended') await audioContext.resume();
    const source = audioContext.createBufferSource();
    source.buffer = audioData.buffer;
    source.connect(audioContext.destination);
    const startOffset = currentTime >= audioData.duration ? 0 : Math.min(currentTime, audioData.duration);
    source.start(0, startOffset);
    sourceNodeRef.current = source;
    startTimeRef.current = audioContext.currentTime;
    startOffsetRef.current = startOffset;
    const { point } = getPointAtTime(startOffset, timingPoints);
    lastScheduledIndexRef.current = Math.floor(point.beatIndex + (startOffset - point.time) / (60 / point.bpm));
    setIsPlaying(true);
  }, [audioVersion, audioContext, currentTime, timingPoints]);

  const stop = useCallback(() => {
    if (sourceNodeRef.current) { try { sourceNodeRef.current.stop(); } catch(e) {} sourceNodeRef.current = null; }
    setIsPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const togglePlay = useCallback(() => isPlaying ? stop() : play(), [isPlaying, play, stop]);

  const playClick = useCallback((time: number, isDownbeat: boolean) => {
    if (!isFinite(time)) return;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.type = 'square'; osc.frequency.value = isDownbeat ? 1500 : 1000;
    const startTime = Math.max(audioContext.currentTime, time);
    gain.gain.setValueAtTime(isDownbeat ? 0.5 : 0.3, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.1);
    osc.start(startTime); osc.stop(startTime + 0.1);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }, [audioContext]);

  useEffect(() => {
    if (!isPlaying) return;
    const loop = () => {
        const currentAudioTime = audioContext.currentTime;
        const newTime = startOffsetRef.current + (currentAudioTime - startTimeRef.current);
        if (newTime >= audioDuration) { setCurrentTime(audioDuration); stop(); }
        else {
            setCurrentTime(newTime);
            if (isMetronomeOn) {
                const lookahead = 0.1;
                const horizonTime = newTime + lookahead;
                let nextBeatIndex = lastScheduledIndexRef.current + 1;
                const { point } = getPointAtTime(newTime, timingPoints);
                const currentBeatEstimate = point.beatIndex + (newTime - point.time) / (60 / point.bpm);
                if (nextBeatIndex < currentBeatEstimate - 1) nextBeatIndex = Math.floor(currentBeatEstimate);
                let iters = 0;
                while (iters < 50) { 
                   const beatTime = getTimeAtBeatIndex(nextBeatIndex, timingPoints);
                   if (beatTime > horizonTime) break;
                   const scheduleTime = startTimeRef.current + (beatTime - startOffsetRef.current);
                   if (scheduleTime >= currentAudioTime - 0.05) {
                       const isSectionStart = timingPoints.some(p => Math.abs(p.beatIndex - nextBeatIndex) < 0.001);
                       playClick(scheduleTime, isSectionStart || nextBeatIndex === 0);
                   }
                   lastScheduledIndexRef.current = nextBeatIndex;
                   nextBeatIndex++; iters++;
                }
            }
            rafRef.current = requestAnimationFrame(loop);
        }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, audioContext, audioDuration, stop, isMetronomeOn, timingPoints, playClick]);

  const handleSeek = (time: number) => {
    setCurrentTime(Math.max(0, Math.min(audioDuration, time)));
    if (isPlaying) stop();
  };

  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape' && showHelp) {
              setShowHelp(false);
              return;
          }
          if (showHelp || e.repeat) return;
          if (e.code === 'Space' && !(e.target as HTMLElement).closest('input, button, textarea, select, [contenteditable="true"]')) {
              e.preventDefault(); togglePlay();
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, showHelp]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) setIsDraggingFile(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    const dropped = e.dataTransfer.files;
    let file: File | undefined;
    for (let i = 0; i < dropped.length; i++) {
      const candidate = dropped.item(i);
      if (candidate && (candidate.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(candidate.name))) {
        file = candidate;
        break;
      }
    }
    if (file) await loadAudioFile(file);
  }, [loadAudioFile]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
      if (!hasAudio) return;
      // Mutate the live view and repaint imperatively: a trackpad can deliver a
      // dozen events per frame and none of them should cost a React render.
      const current = viewRef.current;
      const maxScroll = Math.max(0, audioDuration * current.zoom - containerWidth);
      // Guard against non-finite deltas (they would poison scrollLeft for good).
      const deltaX = Number.isFinite(e.deltaX) ? e.deltaX : 0;
      const deltaY = Number.isFinite(e.deltaY) ? e.deltaY : 0;

      if (e.shiftKey) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          const mouseX = e.clientX - rect.left;
          const timeAtMouse = (mouseX + current.scrollLeft) / current.zoom;
          const zoomFactor = deltaY < 0 ? 1.1 : 0.9;
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * zoomFactor));
          const newScrollLeft = timeAtMouse * newZoom - mouseX;
          if (newZoom !== current.zoom) scheduleZoomLabel();
          current.zoom = newZoom;
          current.scrollLeft = Math.max(0, Math.min(newScrollLeft, Math.max(0, audioDuration * newZoom - containerWidth)));
          // Zooming re-anchors the view instantly; drop any pending glide.
          stopScrollAnimation();
          scrollTargetRef.current = current.scrollLeft;
          requestRedraw();
          return;
      } else {
          const next = Math.max(0, Math.min(scrollTargetRef.current + deltaY + deltaX, maxScroll));
          scrollTargetRef.current = next;
      }
      animateScroll();
  }, [hasAudio, audioDuration, containerWidth, requestRedraw, scheduleZoomLabel, animateScroll, stopScrollAnimation]);

  const activePoint = getPointAtTime(currentTime, timingPoints).point;
  const activeBeat = Math.floor(activePoint.beatIndex + (currentTime - activePoint.time) * activePoint.bpm / 60);
  const formatTime = (time: number) => `${Math.floor(time / 60).toString().padStart(2, '0')}:${Math.floor(time % 60).toString().padStart(2, '0')}`;
  const fitAudio = () => {
    if (!audioDuration) return;
    stopScrollAnimation();
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerWidth / audioDuration));
    viewRef.current = { zoom: next, scrollLeft: 0 };
    scrollTargetRef.current = 0;
    setZoom(next);
    requestRedraw();
  };

  return (
    <div
      className="studio-shell flex h-screen w-screen text-ink font-sans overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <header className="studio-header bg-paper-soft/90 backdrop-blur-md border-b border-paper-line flex items-center justify-between px-5 z-30 shrink-0">
            <div className="flex items-center gap-4 min-w-0">
                <div className="flex items-center gap-2.5 text-teal shrink-0">
                    <div className="brand-mark w-9 h-9 rounded-xl bg-teal-mist border border-teal/25 flex items-center justify-center">
                        <AudioLines size={20} strokeWidth={1.75} />
                    </div>
                    <div><span className="brand-name font-semibold text-ink">BPM 测速助手</span><span className="brand-subtitle">PRECISION TIMING STUDIO</span></div>
                </div>
                <label className="header-import flex items-center gap-2 px-3.5 py-2 rounded-lg cursor-pointer transition font-semibold active:scale-[0.98] shrink-0" title="导入音频">
                    <Upload size={16} />
                    <span>导入音频</span>
                    <input aria-label="导入音频" type="file" accept="audio/*" onChange={handleFileUpload} disabled={isLoadingAudio} />
                </label>
                {fileName && (
                    <span className="header-filename text-xs text-ink-soft truncate max-w-[220px] font-mono bg-paper px-2.5 py-1 rounded-md border border-paper-line" title={fileName}>
                        {fileName}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
                <button 
                  onClick={() => setShowHelp(true)}
                  className={`p-2 rounded-lg transition-all ${showHelp ? 'bg-teal text-paper' : 'text-ink-soft hover:text-ink hover:bg-paper'}`}
                  title="使用说明"
                >
                    <HelpCircle size={20} />
                </button>
                <span className="header-time text-sm font-mono font-medium text-ink-soft bg-paper px-3 py-1.5 rounded-lg border border-paper-line tabular-nums">
                    {currentTime.toFixed(3)}s
                </span>
                <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} aria-expanded={isSidebarOpen} aria-controls="studio-sidebar" className="text-ink-soft hover:text-ink transition p-2 hover:bg-paper rounded-lg" title={isSidebarOpen ? '收起侧栏' : '展开侧栏'}>
                    {isSidebarOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
                </button>
            </div>
        </header>

        <div className="studio-toolbar">
            <div className="workspace-label"><AudioLines size={14} /><span>音频工作台</span><small>WAVEFORM / SPECTRUM</small></div>
            <div className="toolbar-right">
                {hasAudio && <div className="zoom-presets" aria-label="时间轴缩放预设">
                    <button onClick={fitAudio} title="显示完整音频"><Maximize2 size={12} /></button>
                    {[100, 250, 500].map(value => <button key={value} aria-pressed={Math.abs(zoom - value) < 1} onClick={() => applyZoomFactor(value / viewRef.current.zoom)}>{value === 100 ? '概览' : value === 250 ? '标准' : '精细'}</button>)}
                </div>}
                <span className="status-label"><i className="status-dot" />{isLoadingAudio ? '读取音频中' : hasAudio ? '音频已就绪' : '等待导入音频'}</span>
            </div>
        </div>

        <main className={`studio-main flex-1 relative overflow-hidden ${hasAudio ? 'bg-[var(--canvas)]' : 'bg-transparent'} ${isDraggingFile ? 'drop-zone-active' : ''}`}>
            {hasAudio ? (
                <div ref={containerRef} className="absolute inset-0 w-full h-full" onWheel={handleWheel}>
                    {containerWidth > 0 && containerHeight > 0 && (
                        <Visualizer 
                            audioDataRef={audioDataRef} audioVersion={audioVersion} currentTime={currentTime}
                            viewRef={viewRef} zoom={zoom} redrawRef={visualizerRedrawRef}
                            timingPoints={timingPoints} onUpdateBpm={(idx, bpm) => handleUpdatePoint(timingPoints.find(p => p.beatIndex === idx)?.id || '', 'bpm', bpm)}
                            onUpdateOffset={setGlobalOffset} onSeek={handleSeek}
                            width={containerWidth} height={containerHeight}
                            specLogBase={specLogBase}
                        />
                    )}
                    {spectrogramStatus.state === 'computing' && (
                        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-3 py-2 rounded-full bg-paper-soft/95 border border-paper-line shadow-panel text-xs font-medium text-ink-soft animate-fade-up">
                            <Loader2 size={14} className="text-teal animate-spin" />
                            <span>频谱图计算中</span>
                            <div className="w-24 h-1.5 rounded-full bg-paper-line overflow-hidden">
                                <div className="h-full bg-teal rounded-full transition-all duration-200" style={{ width: `${Math.round(spectrogramStatus.progress * 100)}%` }} />
                            </div>
                            <span className="font-mono text-teal w-8 text-right">{Math.round(spectrogramStatus.progress * 100)}%</span>
                        </div>
                    )}
                </div>
            ) : (
                <Welcome dragging={isDraggingFile} loading={isLoadingAudio} onUpload={handleFileUpload} onDemo={loadDemo} />
            )}
            {isLoadingAudio && hasAudio && <div className="audio-loading"><span><Loader2 size={17} className="animate-spin" />正在读取音频…</span></div>}
            
            {showHelp && (
                <div
                    className="absolute inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-fade-up"
                    onClick={() => setShowHelp(false)}
                >
                    <div
                        className="bg-paper-soft border border-paper-line w-full max-w-xl rounded-2xl shadow-float overflow-hidden flex flex-col max-h-[min(90vh,640px)]"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-6 py-4 border-b border-paper-line flex justify-between items-center bg-paper/60">
                            <div className="flex items-center gap-2.5 text-teal font-bold">
                                <HelpCircle size={20} />
                                <span>使用指南</span>
                            </div>
                            <button onClick={() => setShowHelp(false)} className="text-ink-faint hover:text-ink text-sm font-medium px-2 py-1 rounded-md hover:bg-paper transition" title="Esc 关闭">
                                关闭
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6 space-y-7">
                            <section className="space-y-3">
                                <h4 className="flex items-center gap-2 text-ink font-semibold text-sm"><MousePointer2 size={16} className="text-teal"/> 交互技巧</h4>
                                <ul className="space-y-2.5 text-sm text-ink-soft">
                                    <li><b className="text-ink font-medium">缩放：</b> 按住 <kbd className="bg-paper border border-paper-line px-1.5 py-0.5 rounded text-ink text-xs">Shift</kbd> 滚动滚轮</li>
                                    <li><b className="text-ink font-medium">平移：</b> 直接滚动滚轮</li>
                                    <li><b className="text-ink font-medium">定位：</b> 点击波形/频谱区域跳转播放头</li>
                                    <li><b className="text-ink font-medium">调拍：</b> 拖动底部三角形指示器微调时间点</li>
                                </ul>
                            </section>

                            <section className="space-y-3">
                                <h4 className="flex items-center gap-2 text-ink font-semibold text-sm"><Keyboard size={16} className="text-teal"/> 快捷键</h4>
                                <div className="grid grid-cols-2 gap-2.5">
                                    <div className="flex justify-between items-center bg-paper px-3 py-2.5 rounded-xl border border-paper-line">
                                        <span className="text-xs text-ink-soft font-medium">播放 / 暂停</span>
                                        <kbd className="bg-paper-soft border border-paper-line px-2 py-0.5 rounded text-ink font-mono text-xs">Space</kbd>
                                    </div>
                                    <div className="flex justify-between items-center bg-paper px-3 py-2.5 rounded-xl border border-paper-line">
                                        <span className="text-xs text-ink-soft font-medium">关闭帮助</span>
                                        <kbd className="bg-paper-soft border border-paper-line px-2 py-0.5 rounded text-ink font-mono text-xs">Esc</kbd>
                                    </div>
                                </div>
                            </section>

                            <section className="space-y-3">
                                <h4 className="flex items-center gap-2 text-ink font-semibold text-sm"><Info size={16} className="text-teal"/> 测速流程</h4>
                                <ol className="space-y-2 text-sm text-ink-soft list-decimal list-inside leading-relaxed">
                                    <li>导入音频，观察波形或频谱低频亮线定位重音。</li>
                                    <li>缩放到合适比例，将红色 <b className="text-rose font-medium">起点锚点</b> 对齐第一拍。</li>
                                    <li>添加变速段落，拖动青色指示器对齐后续拍点以计算 BPM。</li>
                                    <li>中途变节奏时继续「添加」分段。</li>
                                    <li>开启节拍器核对对齐情况。</li>
                                </ol>
                            </section>
                        </div>
                    </div>
                </div>
            )}
        </main>

        <footer className="transport bg-paper-soft/95 border-t border-paper-line flex justify-center items-center z-30 shrink-0">
          <div className="transport-seek">
            <span>{formatTime(currentTime)}</span>
            <input aria-label="播放进度" type="range" min="0" max={audioDuration || 1} step="0.01" value={currentTime} disabled={!hasAudio} onChange={e => handleSeek(Number(e.target.value))} style={{ background: `linear-gradient(to right, #59cbb8 ${audioDuration ? currentTime / audioDuration * 100 : 0}%, #263544 ${audioDuration ? currentTime / audioDuration * 100 : 0}%)` }} />
            <span>{formatTime(audioDuration)}</span>
          </div>
          <div className="transport-row">
            <div className="transport-meta">
                <div className={`level-bars ${isPlaying ? 'is-playing' : ''}`} aria-hidden="true"><i /><i /><i /><i /></div>
                <div className="transport-state"><span>{isPlaying ? '正在播放' : hasAudio ? '准备就绪' : '开启你的节奏'}</span><small>SPACE 播放 / 暂停</small></div>
            </div>
            <div className="transport-controls">
            <button onClick={() => { stop(); handleSeek(0); }} disabled={!hasAudio} className="text-ink-faint hover:text-ink disabled:opacity-30 p-1" title="回到开头"><SkipBack size={17} /></button>
            <button
                onClick={() => { stop(); handleSeek(0); }}
                disabled={!hasAudio}
                className="text-ink-faint hover:text-rose disabled:opacity-30 disabled:pointer-events-none transition-all hover:scale-105 active:scale-95 p-2"
                title="停止"
            >
                <Square size={22} fill="currentColor"/>
            </button>
            <button
                onClick={togglePlay}
                disabled={!hasAudio}
                className="play-control rounded-full text-paper active:scale-95 transition-all disabled:opacity-40 disabled:pointer-events-none"
                title={isPlaying ? '暂停' : '播放'}
            >
                {isPlaying ? <Pause size={26} fill="currentColor"/> : <Play size={26} fill="currentColor" className="ml-0.5"/>}
            </button>
            <button
                onClick={() => setIsMetronomeOn(p => !p)}
                disabled={!hasAudio}
                className={`p-2 transition-all hover:scale-105 active:scale-95 disabled:opacity-30 disabled:pointer-events-none ${isMetronomeOn ? 'text-teal' : 'text-ink-faint hover:text-ink-soft'}`}
                title="节拍器"
                aria-pressed={isMetronomeOn}
            >
                {isMetronomeOn ? <Volume2 size={24}/> : <VolumeX size={24}/>}
            </button>
            </div>
            <div className="zoom-control flex items-center bg-paper px-3 py-1.5 rounded-xl border border-paper-line">
                <button onClick={() => applyZoomFactor(0.8)} disabled={!hasAudio} className="text-ink-faint hover:text-ink disabled:opacity-30 transition-colors p-1" title="缩小"><ZoomOut size={18}/></button>
                <span className="text-xs text-ink-soft font-mono w-[4.5rem] text-center font-semibold tabular-nums" title="缩放比例">{Math.round(zoom)} px/s</span>
                <button onClick={() => applyZoomFactor(1.2)} disabled={!hasAudio} className="text-ink-faint hover:text-ink disabled:opacity-30 transition-colors p-1" title="放大"><ZoomIn size={18}/></button>
            </div>
          </div>
        </footer>
      </div>

      <aside id="studio-sidebar" aria-label="节奏配置" aria-hidden={!isSidebarOpen} inert={!isSidebarOpen} className={`studio-sidebar bg-paper-soft border-l border-paper-line flex flex-col z-40 transition-[width] duration-300 ease-out shrink-0 overflow-hidden ${isSidebarOpen ? 'w-[300px]' : 'w-0'}`}>
        <div className="w-[300px] h-full flex flex-col">
        <div className="sidebar-heading px-5 py-4 border-b border-paper-line bg-paper/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
                <Settings size={17} className="text-teal" />
                <div><h2 className="font-semibold text-ink">节奏配置</h2><small>TIMING INSPECTOR</small></div>
            </div>
            <div className="flex items-center gap-1">
                <label className="p-2 text-ink-faint hover:text-teal hover:bg-teal-mist rounded-lg cursor-pointer transition-all" title="导入 JSON">
                    <FileUp size={16} />
                    <input aria-label="导入 JSON 配置" type="file" accept=".json" onChange={handleImportJson} className="sr-only" />
                </label>
                <button onClick={handleExportJson} className="p-2 text-ink-faint hover:text-teal hover:bg-teal-mist rounded-lg transition-all" title="导出 JSON">
                    <Download size={16} />
                </button>
            </div>
        </div>
        <div className="sidebar-scroll">
        <section className="tempo-dashboard" aria-label="当前节奏">
            <div className="section-caption"><span>当前节奏</span><small>BEATS PER MINUTE</small></div>
            <div className="tempo-value"><strong>{activePoint.bpm.toFixed(2)}</strong><span>BPM</span></div>
            <div className="beat-indicators" aria-hidden="true">{[0, 1, 2, 3].map(beat => <i key={beat} className={isPlaying && currentTime >= timingPoints[0].time && ((activeBeat % 4) + 4) % 4 === beat ? 'active' : ''} />)}</div>
            <div className="tempo-details"><span>{(60000 / activePoint.bpm).toFixed(1)} ms / 拍</span><span>{timingPoints.length} 个节奏段落</span></div>
        </section>
        <div className="px-5 py-4 border-b border-paper-line space-y-4">
             <div>
                <label className="text-[11px] text-ink-soft block mb-1.5 font-medium flex items-center gap-1.5">
                    全局起始偏移 (Offset)
                    <div className="group relative">
                        <Info size={12} className="text-ink-faint" />
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-44 p-2 bg-paper border border-paper-line text-[10px] text-ink rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-float z-50 leading-relaxed">音乐第一拍对应的绝对时间（秒）。</div>
                    </div>
                </label>
                <OffsetInput value={globalOffset} onChange={setGlobalOffset} />
             </div>
             
             <div>
                <div className="flex justify-between items-center mb-1.5">
                    <label className="text-[11px] text-ink-soft font-medium">频谱对数比例</label>
                    <span className="text-xs font-mono text-teal font-semibold">{specLogBase.toFixed(0)}</span>
                </div>
                <div className="flex items-center gap-2.5">
                    <Sliders size={15} className="text-ink-faint shrink-0" />
                    <input 
                        type="range" aria-label="频谱对数比例" min="1" max="200" step="1"
                        value={specLogBase}
                        onChange={(e) => setSpecLogBase(parseInt(e.target.value))}
                        className="flex-1 cursor-pointer"
                    />
                </div>
             </div>

             {spectrogramStatus.state !== 'idle' && (
                <div className="flex items-center gap-2 text-[11px] font-medium">
                    {spectrogramStatus.state === 'computing' && (
                        <>
                            <Loader2 size={12} className="text-teal animate-spin" />
                            <span className="text-ink-soft">频谱计算中 {Math.round(spectrogramStatus.progress * 100)}%</span>
                        </>
                    )}
                    {spectrogramStatus.state === 'ready' && (
                        <>
                            <CheckCircle2 size={12} className="text-teal" />
                            <span className="text-teal">频谱图已就绪</span>
                        </>
                    )}
                    {spectrogramStatus.state === 'error' && (
                        <>
                            <AlertTriangle size={12} className="text-amber-400" />
                            <span className="text-amber-400">频谱图计算失败</span>
                        </>
                    )}
                </div>
             )}
        </div>

        <div className="timing-list px-5 py-4 space-y-3 bg-paper/40">
            <div className="flex justify-between items-center mb-1">
                <span className="text-xs text-ink-soft font-semibold">变速段落</span>
                <button onClick={handleAddPoint} className="px-2.5 py-1.5 bg-teal-mist hover:bg-teal-soft text-teal rounded-lg transition-all flex items-center gap-1.5 text-xs font-semibold border border-teal/20">
                    <Plus size={13} /> 添加
                </button>
            </div>
            
            {timingPoints.length === 1 && (
                <div className="p-3 bg-teal-mist/70 rounded-xl border border-teal/10 text-[11px] text-ink-soft leading-relaxed">
                    BPM 恒定只需调起点与首段 BPM；有变速时点击「添加」分段。
                </div>
            )}

            {[...timingPoints].reverse().map((point, revIdx) => {
                const originalIdx = timingPoints.length - 1 - revIdx;
                return (
                    <TimingRow 
                        key={point.id} 
                        point={point} 
                        index={originalIdx} 
                        totalCount={timingPoints.length}
                        onUpdate={handleUpdatePoint} 
                        onRemove={handleRemovePoint} 
                    />
                );
            })}
        </div>
        <TapTempo onApply={bpm => { handleUpdatePoint(activePoint.id, 'bpm', bpm); setToast({ message: `当前段落已设为 ${bpm.toFixed(2)} BPM` }); }} />
        </div>
        <div className="sidebar-footer"><span><i className="status-dot" /> LOCAL AUDIO ENGINE</span><span>精确到每一拍</span></div>
        </div>
      </aside>
      {toast && <div className={`studio-toast ${toast.error ? 'error' : ''}`} role="status">{toast.error ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}<span>{toast.message}</span><button onClick={() => setToast(null)} aria-label="关闭提示"><X size={14} /></button></div>}
    </div>
  );
}

export default App;
