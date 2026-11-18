import { test, expect } from 'bun:test';
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
