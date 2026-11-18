export type Source = 'YouTube' | 'SoundCloud' | 'Unknown';

export interface Track {
  id: string;
  title: string;
  author: string;
  webUrl: string;
  streamUrl: string;
  formatId?: string;
  thumbnail?: string;
  duration: number; // in seconds
  source: Source;
  requestedBy: string;
  requestChannelId: string;
  httpHeaders?: Record<string, string>;
  queuedAt: Date;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) {
    return 'live';
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function trackLabel(track: Track): string {
  const source = track.source || 'Unknown';
  return `${track.title.trim()} — ${source}`;
}
