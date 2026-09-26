import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

export const slashCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Пусти музику са YouTube-а или SoundCloud-а, или претражи.')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription("URL адреса или упит за претрагу (префикс 'sc' за SoundCloud)")
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('player')
    .setDescription('Прикажи тренутно стање плејера.')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Паузирај или настави репродукцију.')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Заустави репродукцију и испразни ред.')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Прескочи тренутну песму.')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Промени понављање реда.')
    .addBooleanOption((opt) =>
      opt
        .setName('enabled')
        .setDescription('Експлицитно постави понављање реда (изостави за промену).')
        .setRequired(false)
    )
    .toJSON(),
];
