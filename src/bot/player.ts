import {
  AudioPlayerStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import type { ChildProcess } from 'node:child_process';
import { createStream } from '../media/stream';
import type { Track } from '../types';
import { buildControlRow, buildNowPlayingEmbed } from './ui';

const DISCONNECT_DELAY_MS = 90_000;
const RECONNECT_TIMEOUT_MS = 15_000;
const PLAYBACK_START_TIMEOUT_MS = 15_000;

export class GuildPlayer {
  public readonly guildId: string;
  public queue: Track[] = [];
  public current: Track | null = null;
  public loop = false;
  public isPaused = false;

  private connection: VoiceConnection | null = null;
  private connectionLifetime: AbortController | null = null;
  private audioPlayer: AudioPlayer;
  private activeStreamProcess: ChildProcess | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackStartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(guildId: string, private readonly client: Client, private readonly ffmpegPath?: string) {
    this.guildId = guildId;

    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, (previous) => {
      this.cleanStreamProcess();
      if (!this.connection) return;
      if (previous.status !== AudioPlayerStatus.Idle && previous.resource.playbackDuration === 0) {
        this.failCurrent(new Error('FFmpeg finished before producing audio'));
      }
      this.playNext();
    });

    this.audioPlayer.on(AudioPlayerStatus.Playing, (previous) => {
      this.cancelPlaybackStartTimer();
      if (previous.status === AudioPlayerStatus.Buffering && this.current) {
        void this.announceTrack(this.current);
      }
    });

    this.audioPlayer.on('error', (error) => this.failCurrent(error));
  }

  get channelId() {
    return this.connection?.joinConfig.channelId;
  }

  async ensureConnected(voiceChannel: VoiceBasedChannel): Promise<VoiceConnection> {
    let conn = this.connection;
    if (!conn || this.channelId !== voiceChannel.id) {
      this.destroy();
      const joined = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: this.guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });
      conn = joined;
      this.connection = joined;
      this.connectionLifetime = new AbortController();
      joined.on('error', error => {
        if (this.connection === joined) console.warn(`[GuildPlayer:${this.guildId}] Voice connection:`, error);
      });
      joined.on('stateChange', (previous, state) => {
        if (this.connection !== joined || previous.status === state.status) return;
        if (state.status === VoiceConnectionStatus.Destroyed) {
          this.destroy();
        } else if (state.status === VoiceConnectionStatus.Ready) {
          this.cancelReconnectTimer();
        } else {
          this.reconnectTimer ??= setTimeout(() => {
            if (this.connection === joined) {
              console.warn(`[GuildPlayer:${this.guildId}] Voice reconnection timed out`);
              this.destroy();
            }
          }, RECONNECT_TIMEOUT_MS);
        }
      });
      joined.subscribe(this.audioPlayer);
    }

    try {
      const timeout = AbortSignal.timeout(20_000);
      const lifetime = this.connectionLifetime?.signal;
      await entersState(conn, VoiceConnectionStatus.Ready, lifetime ? AbortSignal.any([timeout, lifetime]) : timeout);
      if (this.connection !== conn) throw new Error('Veza je zatvorena.');
      if (!this.current) this.scheduleDisconnect();
      return conn;
    } catch (err) {
      if (this.connection === conn) this.destroy();
      throw new Error('Не могу да се повежем на гласовни канал.', { cause: err });
    }
  }

  enqueue(track: Track, connection: VoiceConnection): number {
    if (this.connection !== connection) throw new Error('Glasovna sesija je završena.');
    this.cancelDisconnectTimer();
    this.queue.push(track);
    const position = this.queue.length;

    if (this.audioPlayer.state.status === AudioPlayerStatus.Idle) this.playNext();

    return position;
  }

  private playNext(): void {
    if (!this.connection) return;
    if (this.loop && this.current) this.queue.push(this.current);
    this.current = null;
    this.isPaused = false;

    for (let track = this.queue.shift(); track; track = this.queue.shift()) {
      this.current = track;
      try {
        const stream = createStream(track, this.ffmpegPath);
        this.activeStreamProcess = stream.process;
        this.audioPlayer.play(stream.resource);
        if (this.audioPlayer.state.status === AudioPlayerStatus.Buffering) {
          this.playbackStartTimer = setTimeout(() => {
            if (this.activeStreamProcess !== stream.process) return;
            this.failCurrent(new Error('Timed out while waiting for the first audio'));
            this.audioPlayer.stop(true);
          }, PLAYBACK_START_TIMEOUT_MS);
        }
        return;
      } catch (error) {
        this.failCurrent(error);
        this.cleanStreamProcess();
      }
    }
    this.scheduleDisconnect();
  }

  private failCurrent(error: unknown): void {
    if (!this.current) return;
    const track = this.current;
    this.current = null;
    this.loop = false;
    const message = error instanceof Error ? error.message : 'Unknown playback error';
    console.warn(`[GuildPlayer:${this.guildId}] Playback failed (${track.source}): ${message}`);
    void this.announceTrack(track, true);
  }

  private async announceTrack(track: Track, failed = false): Promise<void> {
    if (!track.requestChannelId) return;

    try {
      const channel = this.client.channels.cache.get(track.requestChannelId);
      if (!channel?.isSendable()) return;
      if (failed) {
        await channel.send({
          content: `Не могу да пустим **${track.title.slice(0, 200)}**.`,
          allowedMentions: { parse: [] },
        });
      } else {
        const embed = buildNowPlayingEmbed(track, this.loop);
        const components = [buildControlRow(this.loop, false)];
        await channel.send({ embeds: [embed], components });
      }
    } catch (err) {
      console.warn(`[GuildPlayer:${this.guildId}] Could not send now playing card:`, err);
    }
  }

  skip(): boolean {
    if (!this.current && this.queue.length === 0) {
      return false;
    }
    this.loop = false; // Turn off loop on manual skip
    this.current = null;
    if (!this.audioPlayer.stop(true)) this.playNext();
    return true;
  }

  pause(): boolean {
    if (!this.current) return false;

    if (this.isPaused) {
      if (this.audioPlayer.unpause()) this.isPaused = false;
    } else {
      this.isPaused = this.audioPlayer.pause();
    }
    return this.isPaused;
  }

  toggleLoop(explicit?: boolean): boolean {
    if (explicit !== undefined) {
      this.loop = explicit && !!this.current;
    } else if (this.current) {
      this.loop = !this.loop;
    }
    return this.loop;
  }

  destroy(): void {
    const conn = this.connection;
    this.connection = null;
    this.connectionLifetime?.abort();
    this.connectionLifetime = null;
    this.cancelReconnectTimer();
    this.cancelDisconnectTimer();
    this.queue = [];
    this.current = null;
    this.loop = false;
    this.isPaused = false;
    this.audioPlayer.stop(true);
    this.cleanStreamProcess();
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  }

  private cleanStreamProcess(): void {
    this.cancelPlaybackStartTimer();
    this.activeStreamProcess?.kill();
    this.activeStreamProcess = null;
  }

  private cancelPlaybackStartTimer(): void {
    if (this.playbackStartTimer) clearTimeout(this.playbackStartTimer);
    this.playbackStartTimer = null;
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleDisconnect(): void {
    this.cancelDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      console.log(`[GuildPlayer:${this.guildId}] Inactive for ${DISCONNECT_DELAY_MS / 1000}s, disconnecting.`);
      this.destroy();
    }, DISCONNECT_DELAY_MS);
  }

  private cancelDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }
}
