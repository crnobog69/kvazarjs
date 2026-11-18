import { test, expect, spyOn } from 'bun:test';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Collection, Events } from 'discord.js';
import { KvazarBot } from '../src/bot/client';

test('leaving, disconnecting the bot, and /stop terminate a looping voice session', async () => {
  const bot = new KvazarBot({token: 'unused'});
  bot.client.user = {id: 'bot'};
  const guild = {id: 'guild'};
  const channel = {id: 'voice', members: new Collection()};
  const player = bot.getPlayer(guild.id);
  const join = () => {
    const conn = {
      joinConfig: {channelId: channel.id}, state: {status: 'ready'},
      destroy() { this.state.status = 'destroyed'; },
    };
    player.connection = conn;
    player.current = {title: 'song'};
    player.queue = [player.current];
    player.loop = true;
    return conn;
  };
  const leave = (id) => bot.client.emit(Events.VoiceStateUpdate,
    {id, guild, channelId: channel.id, channel}, {id, guild, channelId: null, channel: null});
  const first = join();
  channel.members.set('other', {user: {bot: false}});
  leave('requester');
  expect(player.loop).toBe(true);
  channel.members.delete('other');
  channel.members.set('bot', {user: {bot: true}});
  leave('other');
  expect(first.state.status).toBe('destroyed');
  expect(player.loop).toBe(false);
  expect(player.queue).toEqual([]);
  expect(player.current).toBeNull();
  const second = join();
  expect(() => player.enqueue({title: 'late result'}, first)).toThrow();
  leave('bot');
  expect(second.state.status).toBe('destroyed');
  const third = join();
  await bot.handleStop({guildId: guild.id, reply: async () => {}});
  expect(third.state.status).toBe('destroyed');
  expect(player.disconnectTimer).toBeNull();
});

test('an FFmpeg startup failure clears repeat and leaves the player available', async () => {
  const bot = new KvazarBot({ token: 'unused', ffmpegPath: 'kvazar-missing-ffmpeg-test' });
  const player = bot.getPlayer('guild');
  const connection = {
    joinConfig: { channelId: 'voice' },
    state: { status: 'ready' },
    destroy() { this.state.status = 'destroyed'; },
  };
  player.connection = connection;

  const track = { title: 'Track', streamUrl: 'https://audio.example.test/stream', source: 'Unknown' };
  try {
    for (let i = 0; i < 2; i++) {
      player.loop = true;
      player.enqueue(track, connection);
      const deadline = Date.now() + 1500;
      while (player.audioPlayer.state.status !== AudioPlayerStatus.Idle && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(player.audioPlayer.state.status).toBe(AudioPlayerStatus.Idle);
      expect(player.current).toBeNull();
      expect(player.loop).toBe(false);
      expect(player.queue).toEqual([]);
      expect(player.activeStreamProcess).toBeNull();
    }
  } finally {
    await bot.stop();
  }
});

test('Discord voice errors during connection are handled and stopping cancels the connection wait', async () => {
  const bot = new KvazarBot({ token: 'unused' });
  const player = bot.getPlayer('guild-with-network-error');
  const channel = {
    id: 'voice',
    guild: { voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} }) },
  };
  const connecting = player.ensureConnected(channel).catch(error => error);
  try {
    expect(() => player.connection.emit('error', new Error('simulated network error'))).not.toThrow();
  } finally {
    await bot.stop();
  }
  expect(await connecting).toBeInstanceOf(Error);
});

test('/play starts lookup while Discord voice is still connecting', async () => {
  const bot = new KvazarBot({ token: 'unused' });
  const player = bot.getPlayer('guild');
  const voice = { id: 'voice' };
  const connection = {};
  const track = { title: 'Track', duration: 240, source: 'YouTube' };
  const messages = [];
  const ready = Promise.withResolvers();
  spyOn(player, 'ensureConnected').mockReturnValue(ready.promise);
  const enqueued = spyOn(player, 'enqueue').mockReturnValue(1);
  const lookup = spyOn(bot.resolver, 'resolve').mockResolvedValue(track);

  try {
    const request = bot.handlePlay({
      user: { id: 'member' },
      guild: { id: 'guild', voiceStates: { cache: new Map([
        ['member', { channel: voice, channelId: voice.id }],
      ]) } },
      channelId: 'channel',
      options: { getString: () => 'track' },
      async deferReply() {},
      async editReply(message) { messages.push(message); },
    });
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(enqueued).not.toHaveBeenCalled();
    ready.resolve(connection);
    await request;
    expect(enqueued).toHaveBeenCalledWith(track, connection);
    expect(messages[0].content).toContain('Track');
  } finally {
    await bot.stop();
  }
});
