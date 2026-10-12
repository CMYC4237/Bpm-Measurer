// FFT/window helpers live in `utils/fft.ts` so the Web Worker can share them.
export { computeFFT, getHannWindow } from './fft';

export const extractPeaks = (buffer: AudioBuffer, samplesPerPixel: number = 100): Float32Array => {
  const data = buffer.getChannelData(0);
  const dataLength = data.length;
  const peakLength = Math.ceil(dataLength / samplesPerPixel);
  const peaks = new Float32Array(peakLength * 2);

  for (let i = 0; i < peakLength; i++) {
    const start = i * samplesPerPixel;
    const end = Math.min(start + samplesPerPixel, dataLength);
    let min = 0;
    let max = 0;

    for (let j = start; j < end; j++) {
      const val = data[j];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }
  return peaks;
};

// Robust color map
export const getSpectrogramColor = (magnitude: number): [number, number, number] => {
  if (!Number.isFinite(magnitude)) return [0, 0, 0];
  
  // -80dB floor
  const db = 20 * Math.log10(magnitude + 1e-9); 
  const val = Math.max(0, Math.min(1, (db + 80) / 80)); 

  let r, g, b;

  if (val < 0.25) {
    const t = val / 0.25;
    r = t * 128; g = 0; b = t * 128;
  } else if (val < 0.5) {
    const t = (val - 0.25) / 0.25;
    r = 128 + t * 127; g = 0; b = 128 * (1 - t);
  } else if (val < 0.75) {
    const t = (val - 0.5) / 0.25;
    r = 255; g = t * 255; b = 0;
  } else {
    const t = (val - 0.75) / 0.25;
    r = 255; g = 255; b = t * 255;
  }
  
  return [Math.floor(r), Math.floor(g), Math.floor(b)];
};

// Precompute ABGR color palette (for direct Uint32Array writes to ImageData)
export const getSpectrogramPalette = (maxMagnitude: number): Uint32Array => {
  const palette = new Uint32Array(256);
  if (maxMagnitude <= 0) {
    palette.fill(0xFF000000);
    return palette;
  }
  for (let i = 0; i < 256; i++) {
    const magnitude = (i / 255) * maxMagnitude;
    const [r, g, b] = getSpectrogramColor(magnitude);
    palette[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return palette;
};
