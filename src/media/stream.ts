import { spawn, type ChildProcess } from 'node:child_process';
import { createAudioResource, StreamType, type AudioResource } from '@discordjs/voice';
import type { Track } from '../types';

export interface ActiveStream {
  resource: AudioResource;
  process: ChildProcess;
}

export function createStream(
  track: Track,
  ffmpegPath: string = process.env.KVZ_FFMPEG_PATH || 'ffmpeg'
): ActiveStream {
  const args: string[] = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];

  if (track.httpHeaders && Object.keys(track.httpHeaders).length > 0) {
    const headersStr = Object.entries(track.httpHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    args.push('-headers', headersStr + '\r\n');
  }

  const volume = process.env.KVZ_VOLUME || '0.5';

  args.push(
    '-i', track.streamUrl,
    '-analyzeduration', '0',
    '-loglevel', 'warning',
    '-filter:a', `volume=${volume}`,
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'ogg',
    'pipe:1'
  );

  const process = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  process.stderr?.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) {
      // ffmpeg warnings/errors
    }
  });

  const resource = createAudioResource(process.stdout, {
    inputType: StreamType.OggOpus,
    inlineVolume: false,
  });

  return { resource, process };
}
