import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
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
    '-rw_timeout', '12000000',
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

  const child = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Hold EOF until FFmpeg exits so playback can distinguish failure from a finished song.
  const audio = new PassThrough();
  audio.on('error', () => {}); // The audio resource also handles this once attached.
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stderr.on('error', (error) => audio.destroy(error));
  child.stdout.on('error', (error) => audio.destroy(error));
  child.on('error', (error) => audio.destroy(error));
  child.once('close', (code, signal) => {
    if (code === 0) {
      audio.end();
    } else if (!audio.destroyed) {
      const status = /HTTP error (\d{3})/i.exec(stderr)?.[1];
      audio.destroy(new Error(status ? `FFmpeg received HTTP ${status}` : `FFmpeg exited (${signal ?? code})`));
    }
  });
  child.stdout.pipe(audio, { end: false });

  try {
    const resource = createAudioResource(audio, {
      inputType: StreamType.OggOpus,
    });
    return { resource, process: child };
  } catch (error) {
    audio.destroy();
    child.kill();
    throw error;
  }
}
