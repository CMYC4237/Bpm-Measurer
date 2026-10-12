export interface SpectrogramData {
  timeBins: number;
  freqBins: number;
  timeResolution: number;
  data: Uint8Array;
  maxMagnitude: number;
}

export interface AudioData {
  buffer: AudioBuffer;
  peaks: Float32Array;
  duration: number;
  /** Full-resolution spectrogram; null while it is still being computed. */
  spectrogram: SpectrogramData | null;
  /** Cheap low-resolution stand-in shown until the full one is ready. */
  spectrogramPreview: SpectrogramData | null;
}

export interface TimingPoint {
  id: string;
  beatIndex: number; // The global beat count where this section starts
  bpm: number;       // The tempo of this section
  time: number;      // Calculated absolute time (seconds)
}

export interface ViewState {
  zoom: number; // Pixels per second
  scrollLeft: number; // Pixels
}
