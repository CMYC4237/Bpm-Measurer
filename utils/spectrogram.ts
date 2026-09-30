import type { SpectrogramData } from '../types';
import { computeFFT, getHannWindow } from './fft';

export interface SpectrogramRequest {
  channelData: Float32Array;
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  previewHopSize: number;
}

export type SpectrogramMessage =
  | { type: 'preview'; spectrogram: SpectrogramData }
  | { type: 'progress'; progress: number }
  | { type: 'done'; spectrogram: SpectrogramData }
  | { type: 'error'; message: string };

export type SpectrogramEmit = (message: SpectrogramMessage, transfer?: Transferable[]) => void;

/**
 * A new normalization region starts once the running peak grows by more than
 * this fraction. Merging such frames keeps the region list small; a frame that
 * overshoots its region by 1% can only clip 1% of the top of the range.
 */
const REGION_GROWTH = 1.01;
const PROGRESS_UPDATES = 24;
const YIELD_INTERVAL_FRAMES = 64;

export const countFrames = (sampleCount: number, fftSize: number, hopSize: number): number =>
  sampleCount <= 0 || fftSize <= 0 || hopSize <= 0
    ? 0
    : Math.max(1, Math.floor((sampleCount - fftSize) / hopSize) + 1);

/**
 * Coarse spectrogram used as an instant placeholder while the full-resolution
 * pass runs. A large hop keeps this cheap enough to finish in a few frames.
 */
export const computeCoarseSpectrogram = (
  channelData: Float32Array,
  sampleRate: number,
  fftSize: number,
  hopSize: number
): SpectrogramData => {
  const timeBins = countFrames(channelData.length, fftSize, hopSize);
  if (timeBins === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) {
    return { timeBins: 0, freqBins: fftSize >> 1, timeResolution: 0, data: new Uint8Array(), maxMagnitude: 0 };
  }
  const freqBins = fftSize >> 1;
  const window = getHannWindow(fftSize);
  const input = new Float32Array(fftSize);
  const mags = new Float32Array(freqBins);
  const magnitudes = new Float32Array(timeBins * freqBins);
  let maxMagnitude = 0;

  for (let t = 0; t < timeBins; t++) {
    const offset = t * hopSize;
    for (let i = 0; i < fftSize; i++) {
      const idx = offset + i;
      input[i] = (idx < channelData.length ? channelData[idx] : 0) * window[i];
    }
    computeFFT(input, mags);
    const base = t * freqBins;
    for (let f = 0; f < freqBins; f++) {
      const m = mags[f];
      if (m > maxMagnitude) maxMagnitude = m;
      magnitudes[base + f] = m;
    }
  }

  const data = new Uint8Array(timeBins * freqBins);
  if (maxMagnitude > 0) {
    const scale = 255 / maxMagnitude;
    for (let i = 0; i < magnitudes.length; i++) {
      const v = magnitudes[i] * scale;
      data[i] = v >= 255 ? 255 : v | 0;
    }
  }

  return { timeBins, freqBins, timeResolution: hopSize / sampleRate, data, maxMagnitude };
};

/**
 * Computes the full-resolution spectrogram.
 *
 * The result is quantized to one byte per time/frequency cell, so the peak
 * magnitude has to be known before the bytes can be written. Instead of keeping
 * the whole float magnitude array in memory, the pass records the scale it used
 * for each region and rescales those regions once the true peak is known. This
 * keeps peak memory at `timeBins * freqBins` bytes instead of four times that,
 * at the cost of at most one quantization step of error versus a float pass.
 * The rescale itself is O(buffer size): the regions partition the buffer, so
 * however many of them there are, each byte is touched once.
 *
 * `yieldControl` lets a main-thread caller stay responsive by handing the event
 * loop back between chunks; inside a worker it can be omitted.
 */
export const runSpectrogramJob = async (
  request: SpectrogramRequest,
  emit: SpectrogramEmit,
  yieldControl?: (() => Promise<void>) | null
): Promise<void> => {
  const { channelData, sampleRate, fftSize, hopSize, previewHopSize } = request;
  const freqBins = fftSize >> 1;
  const timeBins = countFrames(channelData.length, fftSize, hopSize);
  if (timeBins === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) {
    emit({ type: 'error', message: '音频数据或频谱参数无效。' });
    return;
  }

  if (previewHopSize > hopSize && timeBins > 400) {
    const preview = computeCoarseSpectrogram(channelData, sampleRate, fftSize, previewHopSize);
    emit({ type: 'preview', spectrogram: preview }, [preview.data.buffer]);
    if (yieldControl) await yieldControl();
  }

  const window = getHannWindow(fftSize);
  const input = new Float32Array(fftSize);
  const mags = new Float32Array(freqBins);
  const data = new Uint8Array(timeBins * freqBins);

  // Byte ranges grouped by the peak they were normalized against.
  const segments: { end: number; max: number }[] = [];
  let segmentPeak = 0;
  let maxMagnitude = 0;

  const progressEvery = Math.max(1, Math.floor(timeBins / PROGRESS_UPDATES));
  let nextProgressAt = progressEvery;

  for (let t = 0; t < timeBins; t++) {
    const offset = t * hopSize;
    for (let i = 0; i < fftSize; i++) {
      const idx = offset + i;
      input[i] = (idx < channelData.length ? channelData[idx] : 0) * window[i];
    }
    computeFFT(input, mags);

    let framePeak = 0;
    for (let f = 0; f < freqBins; f++) {
      const m = mags[f];
      if (m > framePeak) framePeak = m;
    }
    if (framePeak > maxMagnitude) maxMagnitude = framePeak;
    if (segmentPeak <= 0 || framePeak > segmentPeak * REGION_GROWTH) {
      if (segmentPeak > 0) segments.push({ end: t * freqBins, max: segmentPeak });
      segmentPeak = framePeak;
    }

    const scale = segmentPeak > 0 ? 255 / segmentPeak : 0;
    const base = t * freqBins;
    for (let f = 0; f < freqBins; f++) {
      const v = mags[f] * scale;
      data[base + f] = v >= 255 ? 255 : v | 0;
    }

    if (t + 1 >= nextProgressAt) {
      nextProgressAt += progressEvery;
      emit({ type: 'progress', progress: (t + 1) / timeBins });
    }
    if (yieldControl && (t + 1) % YIELD_INTERVAL_FRAMES === 0) await yieldControl();
  }

  if (segmentPeak > 0) segments.push({ end: data.length, max: segmentPeak });

  if (maxMagnitude > 0) {
    const finalScale = 255 / maxMagnitude;
    let start = 0;
    for (let s = 0; s < segments.length; s++) {
      const segment = segments[s];
      // Bytes in this range were written with `255 / segment.max`; bring them
      // onto the final scale. `segment.max <= maxMagnitude`, so this shrinks.
      const usedScale = 255 / segment.max;
      const factor = usedScale > 0 ? finalScale / usedScale : 0;
      if (factor !== 1) {
        for (let i = start; i < segment.end; i++) {
          const v = data[i] * factor;
          data[i] = v > 255 ? 255 : v | 0;
        }
      }
      start = segment.end;
    }
  }

  emit(
    {
      type: 'done',
      spectrogram: {
        timeBins,
        freqBins,
        timeResolution: hopSize / sampleRate,
        data,
        maxMagnitude,
      },
    },
    [data.buffer]
  );
};
