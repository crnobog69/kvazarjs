import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from 'discord.js';
import { formatDuration, type Track } from '../types';

export function buildQueuedEmbed(track: Track, position: number): EmbedBuilder {
  const title = position === 1 ? `Следеће • ${track.title}` : `У реду • ${track.title}`;

  const fields: APIEmbedField[] = [
    { name: 'Трајање', value: formatDuration(track.duration), inline: true },
    { name: 'Извор', value: track.source, inline: true },
  ];

  if (track.requestedBy) {
    fields.push({ name: 'Захтевао', value: track.requestedBy, inline: true });
  }

  fields.push({ name: 'Позиција', value: `#${position}`, inline: true });

  const embed = new EmbedBuilder()
    .setTitle(title.slice(0, 256))
    .setColor(0x5865f2)
    .setTimestamp()
    .addFields(fields);

  if (track.webUrl) {
    embed.setURL(track.webUrl);
  }
  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

export function buildNowPlayingEmbed(
  track: Track,
  loop: boolean,
  options?: { paused?: boolean; queueLength?: number }
): EmbedBuilder {
  const status = loop ? 'Понавља' : 'Сада';
  const color = options?.paused ? 0xffa500 : 0x1abc9c;

  const fields: APIEmbedField[] = [
    { name: 'Трајање', value: formatDuration(track.duration), inline: true },
    { name: 'Извор', value: track.source, inline: true },
  ];

  if (options?.queueLength && options.queueLength > 0) {
    fields.push({
      name: 'У реду',
      value: `${options.queueLength} песама`,
      inline: true,
    });
  }

  if (options?.paused) {
    fields.push({
      name: 'Статус',
      value: '⏸️ Паузирано',
      inline: true,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`${status} • ${track.title}`.slice(0, 256))
    .setColor(color)
    .setTimestamp()
    .addFields(fields);

  if (track.webUrl) {
    embed.setURL(track.webUrl);
  }
  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
}

export function buildControlRow(loop: boolean, paused: boolean): ActionRowBuilder<ButtonBuilder> {
  const pauseButton = new ButtonBuilder()
    .setCustomId('pause_button')
    .setLabel(paused ? 'Настави' : 'Пауза')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji(paused ? '▶️' : '⏸️');

  const stopButton = new ButtonBuilder()
    .setCustomId('stop_button')
    .setLabel('Заустави')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('⏹️');

  const skipButton = new ButtonBuilder()
    .setCustomId('skip_button')
    .setLabel('Прескочи')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('⏭️');

  const loopButton = new ButtonBuilder()
    .setCustomId('loop_button')
    .setLabel(loop ? 'Искључи понављање' : 'Понови')
    .setStyle(loop ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setEmoji('🔁');

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    pauseButton,
    stopButton,
    skipButton,
    loopButton
  );
}
