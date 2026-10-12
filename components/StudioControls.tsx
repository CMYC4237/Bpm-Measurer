import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, AudioLines, Crosshair, Fingerprint, RotateCcw, Upload } from 'lucide-react';

export function Welcome({ dragging, loading, onUpload, onDemo }: {
  dragging: boolean;
  loading: boolean;
  onUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onDemo: () => void;
}) {
  return (
    <div className="welcome-scroll">
      <div className="welcome-content">
        <div className="eyebrow"><span className="status-dot" /> YOUR RHYTHM, IN FOCUS</div>
        <h1>让每一拍，<span>精准落位。</span></h1>
        <p className="welcome-description">从第一拍到每一次变速，让声音与谱面严丝合缝。</p>
        <label className={`audio-drop ${dragging ? 'is-dragging' : ''} ${loading ? 'is-loading' : ''}`}>
          <div className="preview-wave" aria-hidden="true">
            {Array.from({ length: 65 }, (_, i) => (
              <i key={i} style={{ '--bar-height': `${12 + Math.pow(Math.sin(i * 1.73), 2) * 62 * Math.sin((i + 1) / 66 * Math.PI)}px`, '--delay': `${i * -0.11}s` } as React.CSSProperties} />
            ))}
            <div className="preview-playhead"><span>第一拍</span></div>
          </div>
          <span className="upload-symbol"><Upload size={21} /></span>
          <strong>{loading ? '正在读取音频…' : dragging ? '松开，让节奏开始' : '将音频拖放至此'}</strong>
          <span className="drop-description">或点击选择本地文件</span>
          <span className="format-tags"><span>MP3</span><span>WAV</span><span>FLAC</span><span>OGG</span></span>
          <input aria-label="选择音频文件" type="file" accept="audio/*" onChange={onUpload} disabled={loading} />
        </label>
        <button className="demo-button" onClick={onDemo} disabled={loading}>先体验一下 <span>120 BPM 示例节奏</span><ArrowRight size={14} /></button>
        <div className="workflow-cards">
          <div><span className="workflow-icon"><AudioLines size={18} /></span><small>01 / IMPORT</small><strong>看见声音</strong><p>导入音频，展开波形与频谱</p></div>
          <div><span className="workflow-icon rose"><Crosshair size={18} /></span><small>02 / ALIGN</small><strong>对齐第一拍</strong><p>拖动起点锚点，精确定位</p></div>
          <div><span className="workflow-icon sky"><ArrowDownToLine size={18} /></span><small>03 / REFINE</small><strong>雕琢每段节奏</strong><p>调整 BPM，导出变速配置</p></div>
        </div>
        <div className="local-note"><span className="status-dot" /> 本地音频处理 <span>·</span> 为音游谱面制作而生</div>
      </div>
    </div>
  );
}

export function TapTempo({ onApply }: { onApply: (bpm: number) => void }) {
  const taps = useRef<number[]>([]);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(false);
  const [applied, setApplied] = useState(false);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  const tap = () => {
    const now = performance.now();
    if (taps.current.length && now - taps.current[taps.current.length - 1] > 2500) taps.current = [];
    taps.current = [...taps.current, now].slice(-9);
    setCount(taps.current.length);
    setApplied(false);
    setBpm(taps.current.length > 1 ? Math.round(60000 * (taps.current.length - 1) / (now - taps.current[0]) * 100) / 100 : null);
    setActive(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setActive(false), 120);
  };

  return (
    <section className="tap-panel" aria-label="点击测速">
      <div className="section-caption"><span>点击测速</span><button title="重置点击测速" aria-label="重置点击测速" onClick={() => { taps.current = []; setBpm(null); setCount(0); setApplied(false); }}><RotateCcw size={13} /></button></div>
      <div className="tap-content">
        <button className={`tap-button ${active ? 'is-tapped' : ''}`} onClick={tap} title="跟随音乐连续点击，估算 BPM"><Fingerprint size={21} /><span>TAP</span></button>
        <div className="tap-reading"><strong>{bpm?.toFixed(1) ?? '— —'}</strong><span>BPM · {count < 2 ? '跟随节拍连续点击' : `${count} 次采样`}</span></div>
      </div>
      <button className="apply-tempo" disabled={!bpm || applied} onClick={() => { if (bpm) { onApply(bpm); setApplied(true); } }}>{applied ? '已应用到当前段落' : '应用到当前段落'}<ArrowRight size={12} /></button>
    </section>
  );
}
