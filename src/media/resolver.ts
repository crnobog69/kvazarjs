import { spawn } from 'node:child_process';
import type { Track, Source } from '../types';

export interface ResolverOptions {
  executable?: string;
  timeoutMs?: number;
}

type Metadata = Record<string, unknown>;

const SEARCH_RESULTS = 5;
const MAX_STREAM_ATTEMPTS = 3;
const MAX_OUTPUT_LENGTH = 2 * 1024 * 1024;
const MAX_CONCURRENT_LOOKUPS = 4;
const CACHE_SIZE = 100;
const CACHE_TTL_MS = 10 * 60_000;
const AUDIO_FORMATS = ['bestaudio[ext=m4a]', 'bestaudio[ext=webm]', 'bestaudio', 'best'];
const FORMAT_SELECTOR = AUDIO_FORMATS.join('/');
const ALTERNATE_VERSIONS = [
  'cover', 'karaoke', 'instrumental', 'remix', 'mix', 'dub', 'live',
  'reaction', 'tutorial', 'slowed', 'sped', 'nightcore',
];

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function httpUrl(value: unknown): string | undefined {
  const parsed = URL.parse(asText(value));
  if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
    return parsed.href;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function rankCandidates(entries: Metadata[], query: string): Metadata[] {
  const phrase = normalize(query);
  if (!phrase) return entries;
  const words = new Set(phrase.split(' '));

  return entries.map(entry => {
    const title = normalize(asText(entry.track) || asText(entry.title));
    const titleWords = new Set(title.split(' '));
    const artistWords = new Set(normalize(
      [entry.artist, entry.uploader, entry.channel].map(asText).join(' ')
    ).split(' '));

    let score = title === phrase ? 16 : (' ' + title + ' ').includes(' ' + phrase + ' ') ? 10 : 0;
    for (const word of words) {
      if (titleWords.has(word)) score += 8;
      else if (artistWords.has(word)) score += 7;
    }
    if (score > 0 && titleWords.has('official') && (titleWords.has('audio') || titleWords.has('video'))) score += 12;
    for (const version of ALTERNATE_VERSIONS) {
      if (titleWords.has(version) && !words.has(version)) score -= 12;
    }
    if (typeof entry.duration === 'number' && entry.duration > 0 && entry.duration <= 45) score -= 8;

    return { entry, score };
  }).sort((a, b) => b.score - a.score).map(({ entry }) => entry);
}

export class Resolver {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private activeLookups = 0;
  private readonly matches = new Map<string, { url: string; expiresAt: number }>();

  constructor(options?: ResolverOptions) {
    this.executable = options?.executable || process.env.KVZ_YTDLP_PATH || 'yt-dlp';
    this.timeoutMs = options?.timeoutMs ?? 25_000;
  }

  async refreshForPlayback(track: Track, signal: AbortSignal): Promise<Track> {
    const url = httpUrl(track.webUrl);
    if (!url) throw new Error('Недостаје адреса песме за поновни покушај.');
    if (this.activeLookups >= MAX_CONCURRENT_LOOKUPS) {
      throw new Error('Превише активних претрага.');
    }

    const formatId = track.formatId;
    const selector = formatId && /^[\w.-]+$/.test(formatId)
      ? [...AUDIO_FORMATS.map(format => `${format}[format_id!="${formatId}"]`), FORMAT_SELECTOR].join('/')
      : FORMAT_SELECTOR;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    this.activeLookups++;
    try {
      const refreshed = await this.getTrack(url, track.requestedBy, track.requestChannelId, deadline, [
        '--check-formats', '-f', selector,
      ]);
      return {
        ...track,
        streamUrl: refreshed.streamUrl,
        formatId: refreshed.formatId,
        httpHeaders: refreshed.httpHeaders,
      };
    } finally {
      this.activeLookups--;
    }
  }

  async resolve(query: string, requestedBy: string, channelId: string, signal?: AbortSignal): Promise<Track> {
    if (this.activeLookups >= MAX_CONCURRENT_LOOKUPS) {
      throw new Error('Превише активних претрага. Покушај поново за тренутак.');
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const lookupSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    this.activeLookups++;
    try {
      const trimmed = query.trim();
      const direct = httpUrl(trimmed);
      if (direct) return await this.getTrack(direct, requestedBy, channelId, lookupSignal);

      const soundCloud = /^sc\s+/i.test(trimmed);
      const terms = soundCloud ? trimmed.replace(/^sc\s+/i, '') : trimmed;
      if (!terms) throw new Error('Унеси назив песме или извођача.');

      const prefix = soundCloud ? 'scsearch' : 'ytsearch';
      const queryKey = prefix + ':' + terms.toLowerCase();
      const cached = this.matches.get(queryKey);
      let failedUrl: string | undefined;
      let lastError: unknown;
      if (cached) {
        this.matches.delete(queryKey);
        if (cached.expiresAt > Date.now()) {
          try {
            const track = await this.getTrack(cached.url, requestedBy, channelId, lookupSignal);
            this.rememberMatch(queryKey, cached);
            return track;
          } catch (err) {
            lookupSignal.throwIfAborted();
            failedUrl = cached.url;
            lastError = err;
          }
        }
      }

      const results = await this.extract(prefix + SEARCH_RESULTS + ':' + terms, ['--flat-playlist'], lookupSignal);
      const candidates = rankCandidates(results, terms);
      const urls = [...new Set(candidates.map(entry => httpUrl(entry.webpage_url) ?? httpUrl(entry.url))
        .filter((url): url is string => url !== undefined && url !== failedUrl))];
      for (const url of urls.slice(0, MAX_STREAM_ATTEMPTS)) {
        try {
          const track = await this.getTrack(url, requestedBy, channelId, lookupSignal);
          this.rememberMatch(queryKey, { url, expiresAt: Date.now() + CACHE_TTL_MS });
          return track;
        } catch (err) {
          lookupSignal.throwIfAborted();
          lastError = err;
        }
      }
      throw lastError ?? new Error('Нису пронађени резултати.');
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) {
        throw new Error('Претрага је истекла после ' + this.timeoutMs / 1000 + ' секунди.');
      }
      throw err;
    } finally {
      this.activeLookups--;
    }
  }

  private rememberMatch(query: string, match: { url: string; expiresAt: number }): void {
    this.matches.delete(query);
    if (this.matches.size >= CACHE_SIZE) {
      const oldest = this.matches.keys().next().value;
      if (oldest !== undefined) this.matches.delete(oldest);
    }
    this.matches.set(query, match);
  }

  private async getTrack(
    url: string,
    requestedBy: string,
    channelId: string,
    signal: AbortSignal,
    options = ['-f', FORMAT_SELECTOR],
  ): Promise<Track> {
    const [entry] = await this.extract(url, options, signal);
    const streamUrl = httpUrl(entry?.url);
    if (!entry || !streamUrl) throw new Error('За овај резултат нема доступног аудио стрима.');

    const extractor = asText(entry.extractor_key || entry.extractor).toLowerCase();
    let source: Source = 'Unknown';
    if (extractor.includes('youtube')) source = 'YouTube';
    else if (extractor.includes('soundcloud')) source = 'SoundCloud';

    const headers = entry.http_headers;
    return {
      id: asText(entry.id),
      title: asText(entry.title) || 'Непознат наслов',
      author: asText(entry.artist || entry.uploader || entry.channel) || 'Непознат аутор',
      webUrl: httpUrl(entry.webpage_url) ?? url,
      streamUrl,
      formatId: asText(entry.format_id) || undefined,
      thumbnail: httpUrl(entry.thumbnail),
      duration: typeof entry.duration === 'number' ? entry.duration : 0,
      source,
      requestedBy,
      requestChannelId: channelId,
      httpHeaders: headers && typeof headers === 'object'
        ? Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === 'string'))
        : undefined,
      queuedAt: new Date(),
    };
  }

  private extract(input: string, options: string[], signal: AbortSignal): Promise<Metadata[]> {
    signal.throwIfAborted();
    const child = spawn(this.executable, [
      '--no-playlist', '--skip-download', '--dump-json', '--no-warnings',
      '--js-runtimes', 'node', '--socket-timeout', '8', '--extractor-retries', '0',
      ...options, '--', input,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    return new Promise((resolve, reject) => {
      let output = '';
      let stderr = '';
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else {
          const entries: Metadata[] = [];
          for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
            } catch {
              // Other output from local yt-dlp configuration isn't a media result.
            }
          }
          resolve(entries);
        }
      };
      const abort = () => {
        finish(signal.reason);
        child.kill();
      };

      child.on('error', err => finish(new Error('Не могу да покренем yt-dlp (' + err.message + ').')));
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (done) return;
        output += chunk;
        if (output.length > MAX_OUTPUT_LENGTH) {
          finish(new Error('Претрага је вратила превише података.'));
          child.kill();
        }
      });
      child.stdout.on('error', finish);
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4096);
      });
      child.stderr.on('error', finish);
      child.once('close', code => {
        if (code === 0 || output.trim()) finish();
        else {
          const status = /HTTP Error (\d{3})/.exec(stderr)?.[1];
          const reason = status ? 'HTTP ' + status : 'yt-dlp: ' + code;
          finish(new Error('Извор тренутно не даје приступ аудио запису (' + reason + ').'));
        }
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
