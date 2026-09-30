// Pure DSP helpers: no DOM dependencies, safe to use in a Web Worker.

// Buffers for FFT reuse to reduce GC pressure
let fftRealCache: Float32Array | null = null;
let fftImagCache: Float32Array | null = null;

// Exported window function
export const getHannWindow = (length: number): Float32Array => {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  }
  return win;
};

/**
 * Radix-2 FFT magnitude spectrum.
 * `out` can be reused between calls to avoid allocating a new array per frame.
 */
export const computeFFT = (input: Float32Array, out?: Float32Array): Float32Array => {
  const n = input.length;
  if (n < 2 || (n & (n - 1)) !== 0) {
    throw new RangeError(`FFT input length must be a power of two (received ${n})`);
  }

  // Reuse buffers if size matches
  if (!fftRealCache || fftRealCache.length !== n) {
      fftRealCache = new Float32Array(n);
      fftImagCache = new Float32Array(n);
  }

  const real = fftRealCache;
  const imag = fftImagCache;

  // Initialize
  for(let i=0; i<n; i++) {
      real[i] = input[i];
      imag[i] = 0;
  }

  // Bit reversal
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tr = real[i];
      const ti = imag[i];
      real[i] = real[j];
      imag[i] = imag[j];
      real[j] = tr;
      imag[j] = ti;
    }
    let k = n / 2;
    while (k <= j) {
      j -= k;
      k /= 2;
    }
    j += k;
  }

  // Butterfly updates
  for (let len = 2; len <= n; len *= 2) {
    const angle = (2 * Math.PI) / len;
    const wlen_r = Math.cos(angle);
    const wlen_i = -Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let w_r = 1;
      let w_i = 0;
      for (let j = 0; j < len / 2; j++) {
        const u_r = real[i + j];
        const u_i = imag[i + j];
        const v_r = real[i + j + len / 2] * w_r - imag[i + j + len / 2] * w_i;
        const v_i = real[i + j + len / 2] * w_i + imag[i + j + len / 2] * w_r;

        real[i + j] = u_r + v_r;
        imag[i + j] = u_i + v_i;
        real[i + j + len / 2] = u_r - v_r;
        imag[i + j + len / 2] = u_i - v_i;

        const temp_w_r = w_r * wlen_r - w_i * wlen_i;
        w_i = w_r * wlen_i + w_i * wlen_r;
        w_r = temp_w_r;
      }
    }
  }

  const magnitudes = out && out.length === n / 2 ? out : new Float32Array(n / 2);
  const scale = 2.0 / n;
  for (let i = 0; i < n / 2; i++) {
    // Safety against NaN
    const r = real[i] || 0;
    const im = imag[i] || 0;
    magnitudes[i] = Math.sqrt(r * r + im * im) * scale;
  }
  return magnitudes;
};
