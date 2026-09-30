import type { SpectrogramData } from '../types';
import { getSpectrogramPalette } from './audioUtils';

/**
 * Everything that determines what the spectrogram canvas shows. `deviceOffset`
 * is the pixel column of the song that sits at x = 0, counted in device pixels,
 * which makes panning exact instead of accumulating rounding errors.
 */
export interface SpectrogramView {
  width: number;
  height: number;
  dpr: number;
  zoom: number;
  logBase: number;
  deviceOffset: number;
  spec: SpectrogramData;
}

export interface SpectrogramPaintPlan {
  /** Absolute device column of the first painted pixel. */
  firstColumn: number;
  count: number;
  /** True when the whole view changed and has to be repainted from scratch. */
  full: boolean;
}

export const buildRowToBin = (height: number, freqBins: number, logBase: number): Uint16Array => {
  const rowToBin = new Uint16Array(height);
  for (let y = 0; y < height; y++) {
    const yNorm = y / height;
    const binIdx = logBase <= 1
      ? yNorm * (freqBins - 1)
      : ((Math.pow(logBase, yNorm) - 1) / (logBase - 1)) * (freqBins - 1);
    rowToBin[y] = Math.max(0, Math.min(freqBins - 1, Math.floor(binIdx)));
  }
  return rowToBin;
};

/**
 * Decides what has to be painted for a new view.
 *
 * A pure pan only exposes new columns at one edge, so those are the only pixels
 * that need computing; the caller shifts the previous frame across with a GPU
 * blit. Anything else (zoom, height, scaling, new data) needs a full repaint.
 */
export const planSpectrogramPaint = (
  previous: SpectrogramView | null,
  next: SpectrogramView
): SpectrogramPaintPlan | null => {
  const sameLayout =
    previous !== null &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.zoom === next.zoom &&
    previous.dpr === next.dpr &&
    previous.logBase === next.logBase &&
    previous.spec === next.spec;

  if (!sameLayout) {
    return { firstColumn: next.deviceOffset, count: next.width, full: true };
  }

  const shift = next.deviceOffset - previous!.deviceOffset;
  if (shift === 0) return null; // same device pixel: the frame is still valid

  if (shift >= next.width || shift <= -next.width) {
    // Panned by more than a screen: shifting would touch everything anyway.
    return { firstColumn: next.deviceOffset, count: next.width, full: true };
  }

  const count = Math.abs(shift);
  const firstColumn = shift > 0
    ? next.deviceOffset + next.width - count
    : next.deviceOffset;
  return { firstColumn, count, full: false };
};

/**
 * Renders `count` columns starting at absolute device column `firstColumn` into
 * a buffer (row stride `stride`), writing them at `destColumn`. Passing the
 * bitmap itself with `destColumn = firstColumn - view.deviceOffset` updates a
 * whole frame in place; a strip buffer uses `destColumn = 0`.
 *
 * Analysis frames are ~6ms apart, which is coarser than one device pixel once
 * zoomed in, so neighbouring frames are blended instead of showing steps.
 */
export const renderSpectrogramStrip = (
  dest: Uint32Array,
  stride: number,
  view: SpectrogramView,
  firstColumn: number,
  count: number,
  destColumn: number = 0
): void => {
  const { height, zoom, dpr, logBase, spec } = view;
  const { timeBins, freqBins, timeResolution, data } = spec;
  const rowToBin = buildRowToBin(height, freqBins, logBase);
  const palette = getSpectrogramPalette(spec.maxMagnitude);
  const framesPerDevicePixel = 1 / (zoom * dpr * timeResolution);
  // A non-finite step would make every lookup miss and paint the whole strip
  // black; leaving the previous pixels alone is the safer failure mode.
  if (!Number.isFinite(framesPerDevicePixel) || !Number.isFinite(firstColumn)) return;
  const maxFrame = timeBins - 1;
  const bottomRow = (height - 1) * stride;

  for (let column = 0; column < count; column++) {
    // Absolute device column, so the frame only depends on where the column is
    // on the song's time axis - never on where the repaint happened to start.
    const framePos = (firstColumn + column) * framesPerDevicePixel;
    if (framePos < 0) continue;

    let i0 = Math.floor(framePos);
    let i1 = i0 + 1;
    let frac = framePos - i0;
    if (i0 >= maxFrame) {
      i0 = maxFrame;
      i1 = maxFrame;
      frac = 0;
    }

    const offset0 = i0 * freqBins;
    // Reads come back undefined if the spectrum buffer is gone (for example a
    // detached or discarded buffer). Skip the column instead of painting the
    // "no energy" colour, which would blank the whole spectrogram.
    if (data[offset0] === undefined) continue;

    const offset1 = i1 * freqBins;
    const columnBottom = bottomRow + destColumn + column;

    for (let y = 0; y < height; y++) {
      const bin = rowToBin[y];
      const a = data[offset0 + bin];
      const b = data[offset1 + bin];
      dest[columnBottom - y * stride] = palette[(a + (b - a) * frac) | 0];
    }
  }
};
