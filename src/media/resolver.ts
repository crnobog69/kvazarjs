import { spawn } from 'node:child_process';
import type { Track, Source } from '../types';

export interface ResolverOptions {
  executable?: string;
  timeoutMs?: number;
}

export class Resolver {
  private executable: string;
  private timeoutMs: number;

  constructor(options?: ResolverOptions) {
    this.executable = options?.executable || process.env.KVZ_YTDLP_PATH || 'yt-dlp';
    this.timeoutMs = options?.timeoutMs || 25_000;
  }

  async resolve(query: string, requestedBy: string, channelId: string): Promise<Track> {
    const prepared = this.prepareQuery(query);
    const args = [
      '--no-playlist',
      '--ignore-errors',
      '--dump-json',
      '--no-warnings',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '--audio-quality', '0',
      prepared,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Pretraga je istekla nakon ${this.timeoutMs / 1000}s.`));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Neuspelo pokretanje yt-dlp: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          return reject(new Error(stderr.trim() || `yt-dlp process exited with code ${code}`));
        }

        try {
          const firstLine = stdout.trim().split('\n')[0];
          if (!firstLine) {
            return reject(new Error('Nisu pronađeni rezultati.'));
          }

          const raw = JSON.parse(firstLine);
          const track = this.mapPayloadToTrack(raw, requestedBy, channelId);
          resolve(track);
        } catch (err) {
          reject(new Error(`Greška pri obradi metapodataka: ${(err as Error).message}`));
        }
      });
    });
  }

  private prepareQuery(q: string): string {
    const trimmed = q.trim();
    if (!trimmed) return trimmed;
    if (this.looksLikeUrl(trimmed)) {
      return trimmed;
    }
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('sc ')) {
      return `scsearch:${trimmed.slice(3).trim()}`;
    }
    return `ytsearch:${trimmed}`;
  }

  private looksLikeUrl(value: string): boolean {
    if (!value.includes('://')) return false;
    try {
      const parsed = new URL(value);
      return !!parsed.protocol && !!parsed.host;
    } catch {
      return false;
    }
  }

  private mapPayloadToTrack(raw: any, requestedBy: string, channelId: string): Track {
    const duration = typeof raw.duration === 'number' ? raw.duration : 0;
    const extractor = String(raw.extractor_key || raw.extractor || '').toLowerCase();

    let source: Source = 'Unknown';
    if (extractor.includes('youtube')) {
      source = 'YouTube';
    } else if (extractor.includes('soundcloud')) {
      source = 'SoundCloud';
    }

    return {
      id: String(raw.id || ''),
      title: String(raw.title || 'Nepoznat naslov'),
      author: String(raw.uploader || raw.channel || 'Nepoznat autor'),
      webUrl: raw.webpage_url || raw.url || '',
      streamUrl: raw.url || raw.webpage_url || '',
      thumbnail: raw.thumbnail || undefined,
      duration,
      source,
      requestedBy,
      requestChannelId: channelId,
      httpHeaders: raw.http_headers || undefined,
      queuedAt: new Date(),
    };
  }
}
