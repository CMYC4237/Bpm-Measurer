import { TimingPoint } from '../types';

export const recalculateTiming = (offset: number, points: Omit<TimingPoint, 'time'>[]): TimingPoint[] => {
  // Timing values are user-editable. Drop malformed points before they can
  // poison every calculated timestamp with NaN or an infinite duration.
  const safeOffset = Number.isFinite(offset) ? offset : 0;
  const sorted = points
    .filter(point => Number.isFinite(point.beatIndex) && point.beatIndex >= 0 && Number.isFinite(point.bpm) && point.bpm > 0)
    .map(point => ({ ...point, beatIndex: Math.max(0, point.beatIndex), bpm: Math.max(1, point.bpm) }))
    .sort((a, b) => a.beatIndex - b.beatIndex);
  
  const result: TimingPoint[] = [];

  // The first point always starts at the global offset
  if (sorted.length > 0) {
    result.push({
      ...sorted[0],
      beatIndex: 0, // Force first point to be 0
      time: safeOffset
    });
  } else {
      // Fallback default
      return [{ id: 'default', beatIndex: 0, bpm: 120, time: safeOffset }];
  }

  // Calculate subsequent times based on previous section's duration
  for (let i = 1; i < sorted.length; i++) {
    const prev = result[i - 1];
    const curr = sorted[i];
    
    const beatDiff = curr.beatIndex - prev.beatIndex;
    const duration = beatDiff * (60 / prev.bpm);
    
    result.push({
      ...curr,
      time: prev.time + duration
    });
  }

  return result;
};

export const getPointAtTime = (time: number, points: TimingPoint[]): { point: TimingPoint, index: number } => {
  if (points.length === 0) return { point: { id: 'default', beatIndex: 0, bpm: 120, time: 0 }, index: 0 };
  const query = Number.isFinite(time) ? time : points[0].time;
  // Timing points are sorted. Binary search keeps playback and metronome lookup
  // cheap when a project contains many tempo changes.
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid].time <= query) low = mid;
    else high = mid - 1;
  }
  return { point: points[low], index: low };
};

export const getBeatIndexAtTime = (time: number, points: TimingPoint[]): number => {
    const { point } = getPointAtTime(time, points);
    const timeDiff = time - point.time;
    const secondsPerBeat = 60 / point.bpm;
    return point.beatIndex + (timeDiff / secondsPerBeat);
};

export const getTimeAtBeatIndex = (beatIndex: number, points: TimingPoint[]): number => {
    if (points.length === 0) return 0;
    const query = Number.isFinite(beatIndex) ? beatIndex : 0;
    // Find point where point.beatIndex <= beatIndex
    // We assume points are sorted
    let point = points[0];
    for(let i = points.length - 1; i >= 0; i--) {
        if (query >= points[i].beatIndex) {
            point = points[i];
            break;
        }
    }
    
    const beatDiff = query - point.beatIndex;
    return point.time + beatDiff * (60 / point.bpm);
};
