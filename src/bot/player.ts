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
import type { TextBasedChannel, VoiceBasedChannel } from 'discord.js';
import type { ChildProcess } from 'node:child_process';
import { createStream } from '../media/stream';
import type { Track } from '../types';
import { buildControlRow, buildNowPlayingEmbed } from './ui';

const DISCONNECT_DELAY_MS = 90_000;

export class GuildPlayer {
  public readonly guildId: string;
  public queue: Track[] = [];
  public current: Track | null = null;
  public loop = false;
  public isPaused = false;

  private connection: VoiceConnection | null = null;
  private audioPlayer: AudioPlayer;
  private activeStreamProcess: ChildProcess | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isAdvancing = false;

  constructor(guildId: string) {
    this.guildId = guildId;

    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (!this.connection) return;
      this.cleanStreamProcess();
      this.playNext().catch((err) => {
        console.error(`[GuildPlayer:${this.guildId}] Error playing next track:`, err);
      });
    });

    this.audioPlayer.on('error', (error) => {
      if (!this.connection) return;
      console.error(`[GuildPlayer:${this.guildId}] Audio player error:`, error.message);
      // The player transitions to Idle after a resource error.
      this.loop = false;
    });
  }

  get channelId() {
    return this.connection?.joinConfig.channelId;
  }

  async ensureConnected(voiceChannel: VoiceBasedChannel): Promise<VoiceConnection> {
    this.cancelDisconnectTimer();

    if (this.connection && this.channelId === voiceChannel.id) {
      return await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    }

    if (this.connection) {
      this.destroy();
    }

    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection = conn;
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      if (this.connection !== conn) throw new Error('Veza je zatvorena.');
      conn.subscribe(this.audioPlayer);

      conn.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          if (this.connection === conn) this.destroy();
        }
      });
      return conn;
    } catch (err) {
      if (this.connection === conn) this.destroy();
      throw new Error(`Neuspelo povezivanje na glasovni kanal: ${(err as Error).message}`);
    }
  }

  enqueue(track: Track, connection: VoiceConnection): number {
    if (this.connection !== connection) throw new Error('Glasovna sesija je završena.');
    this.cancelDisconnectTimer();
    this.queue.push(track);
    const position = this.queue.length;

    if (!this.current && this.audioPlayer.state.status === AudioPlayerStatus.Idle) {
      this.playNext().catch((err) => {
        console.error(`[GuildPlayer:${this.guildId}] Play error:`, err);
      });
    }

    return position;
  }

  private async playNext(): Promise<void> {
    if (this.isAdvancing) return;
    this.isAdvancing = true;

    try {
      if (this.loop && this.current) {
        this.queue.push(this.current);
      }

      if (this.queue.length === 0) {
        this.current = null;
        this.isPaused = false;
        this.cleanStreamProcess();
        this.scheduleDisconnect();
        return;
      }

      const nextTrack = this.queue.shift()!;
      this.current = nextTrack;
      this.isPaused = false;
      this.cancelDisconnectTimer();

      this.cleanStreamProcess();

      const { resource, process } = createStream(nextTrack);
      this.activeStreamProcess = process;

      this.audioPlayer.play(resource);

      // Announce now playing in the request channel
      this.announceTrack(nextTrack).catch((err) => {
        console.error(`[GuildPlayer:${this.guildId}] Announce error:`, err);
      });
    } finally {
      this.isAdvancing = false;
    }
  }

  private async announceTrack(track: Track): Promise<void> {
    if (!track.requestChannelId) return;

    try {
      const channel = await this.resolveChannel(track.requestChannelId);
      if (channel && channel.isTextBased() && 'send' in channel) {
        const embed = buildNowPlayingEmbed(track, this.loop);
        const components = [buildControlRow(this.loop, false)];
        await (channel as any).send({ embeds: [embed], components });
      }
    } catch (err) {
      console.warn(`[GuildPlayer:${this.guildId}] Could not send now playing card:`, err);
    }
  }

  private async resolveChannel(channelId: string): Promise<TextBasedChannel | null> {
    if (!this.connection) return null;
    try {
      const guild = this.connection.joinConfig.guildId;
      // We'll store a getter or fetch via client
      return (globalThis as any).kvazarClient?.channels?.cache?.get(channelId) ?? null;
    } catch {
      return null;
    }
  }

  skip(): boolean {
    if (!this.current && this.queue.length === 0) {
      return false;
    }
    this.loop = false; // Turn off loop on manual skip
    this.audioPlayer.stop(true);
    return true;
  }

  pause(): boolean {
    if (!this.current) return false;

    if (this.isPaused) {
      this.audioPlayer.unpause();
      this.isPaused = false;
    } else {
      this.audioPlayer.pause();
      this.isPaused = true;
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
    if (this.activeStreamProcess) {
      try {
        this.activeStreamProcess.kill();
      } catch {}
      this.activeStreamProcess = null;
    }
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
