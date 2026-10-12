import type { SpectrogramRequest } from './spectrogram';
import { runSpectrogramJob } from './spectrogram';

// Minimal scope typing so this file compiles without pulling in the WebWorker lib
// (which conflicts with the DOM lib used by the rest of the app).
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SpectrogramRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

scope.onmessage = (event: MessageEvent<SpectrogramRequest>) => {
  void runSpectrogramJob(event.data, (message, transfer) => {
    scope.postMessage(message, transfer ?? []);
  }).catch((error: unknown) => {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
