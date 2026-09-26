import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  Interaction,
  MessageFlags,
  type ApplicationCommandDataResolvable,
} from 'discord.js';
import { Resolver } from '../media/resolver';
import { slashCommands } from './commands';
import { GuildPlayer } from './player';
import { buildControlRow, buildNowPlayingEmbed, buildQueuedEmbed } from './ui';

export interface BotConfig {
  token: string;
  status?: string;
  ffmpegPath?: string;
  ytdlpPath?: string;
}

export class KvazarBot {
  public client: Client;
  private config: BotConfig;
  private resolver: Resolver;
  private players: Map<string, GuildPlayer> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
    this.resolver = new Resolver({ executable: config.ytdlpPath });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    (globalThis as any).kvazarClient = this.client;

    this.setupListeners();
  }

  private setupListeners(): void {
    this.client.once(Events.ClientReady, async () => {
      console.log(`🌌 Kvazar povezan kao ${this.client.user?.tag}!`);

      this.client.user?.setPresence({
        status: 'dnd',
        activities: [
          {
            name: this.config.status || '/play',
            type: ActivityType.Listening,
          },
        ],
      });

      try {
        console.log('Registrujem slash komande...');
        await this.client.application?.commands.set(
          slashCommands as ApplicationCommandDataResolvable[]
        );
        console.log('✅ Slash komande uspešno registrovane!');
      } catch (err) {
        console.error('Greška pri registraciji komandi:', err);
      }
    });

    this.client.on('interactionCreate', (interaction) => {
      this.handleInteraction(interaction).catch((err) => {
        console.error('Greška pri obradi interakcije:', err);
      });
    });
  }

  private getPlayer(guildId: string): GuildPlayer {
    let player = this.players.get(guildId);
    if (!player) {
      player = new GuildPlayer(guildId);
      this.players.set(guildId, player);
    }
    return player;
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: 'Ова команда се може користити само на серверу.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'play':
          return this.handlePlay(interaction);
        case 'player':
          return this.handlePlayer(interaction);
        case 'pause':
          return this.handlePause(interaction);
        case 'stop':
          return this.handleStop(interaction);
        case 'skip':
          return this.handleSkip(interaction);
        case 'loop':
          return this.handleLoop(interaction);
      }
    } else if (interaction.isButton()) {
      return this.handleButton(interaction);
    }
  }

  private async handlePlay(interaction: any): Promise<void> {
    const member = interaction.member as GuildMember;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: 'Мораш бити повезан на гласовни канал да би користио /play.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query', true).trim();
    if (!query) {
      await interaction.reply({
        content: 'Молим те унеси упит.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const player = this.getPlayer(interaction.guildId);
      await player.ensureConnected(voiceChannel);

      const track = await this.resolver.resolve(
        query,
        `<@${interaction.user.id}>`,
        interaction.channelId
      );

      const position = player.enqueue(track);
      const embed = buildQueuedEmbed(track, position);

      await interaction.editReply({
        content: `У реду **${track.title}** — позиција #${position}.`,
        embeds: [embed],
      });
    } catch (err: any) {
      await interaction.editReply({
        content: `Не могу да пустим песму: ${err.message || err}`,
        embeds: [],
      });
    }
  }

  private async handlePlayer(interaction: any): Promise<void> {
    const player = this.players.get(interaction.guildId);
    if (!player || !player.current) {
      await interaction.reply({
        content: 'Ништа тренутно не свира.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = buildNowPlayingEmbed(player.current, player.loop, {
      paused: player.isPaused,
      queueLength: player.queue.length,
    });
    const components = [buildControlRow(player.loop, player.isPaused)];

    await interaction.reply({
      embeds: [embed],
      components,
    });
  }

  private async handlePause(interaction: any): Promise<void> {
    const player = this.players.get(interaction.guildId);
    if (!player || !player.current) {
      await interaction.reply({
        content: 'Ништа тренутно не свира.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isPaused = player.pause();
    await interaction.reply({
      content: isPaused ? '⏸️ Репродукција паузирана.' : '▶️ Репродукција настављена.',
    });
  }

  private async handleStop(interaction: any): Promise<void> {
    const player = this.players.get(interaction.guildId);
    if (!player || (!player.current && player.queue.length === 0)) {
      await interaction.reply({
        content: 'Нема ничега за заустављање.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    player.stop();
    await interaction.reply({
      content: '⏹️ Репродукција заустављена и ред испражњен.',
    });
  }

  private async handleSkip(interaction: any): Promise<void> {
    const player = this.players.get(interaction.guildId);
    if (!player || (!player.current && player.queue.length === 0)) {
      await interaction.reply({
        content: 'Нема активне песме за прескакање.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    player.skip();
    await interaction.reply({
      content: '⏭️ Прескочена је тренутна песма.',
    });
  }

  private async handleLoop(interaction: any): Promise<void> {
    const player = this.players.get(interaction.guildId);
    if (!player || !player.current) {
      await interaction.reply({
        content: 'Ништа не свира да би се понављало.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const explicit = interaction.options.getBoolean('enabled');
    const newState = player.toggleLoop(explicit !== null ? explicit : undefined);

    await interaction.reply({
      content: newState ? 'Понављање је укључено.' : 'Понављање је искључено.',
    });
  }

  private async handleButton(interaction: any): Promise<void> {
    const player = this.players.get(interaction.guildId);
    if (!player || (!player.current && player.queue.length === 0)) {
      await interaction.reply({
        content: 'Ништа тренутно не свира.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    switch (interaction.customId) {
      case 'pause_button': {
        const isPaused = player.pause();
        await interaction.followUp({
          content: isPaused ? '⏸️ Репродукција паузирана.' : '▶️ Репродукција настављена.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case 'stop_button': {
        player.stop();
        await interaction.followUp({
          content: '⏹️ Репродукција заустављена и ред испражњен.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case 'skip_button': {
        player.skip();
        await interaction.followUp({
          content: '⏭️ Прескочена је тренутна песма.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case 'loop_button': {
        const newState = player.toggleLoop();
        await interaction.followUp({
          content: `🔁 ${newState ? 'Понављање је укључено.' : 'Понављање је искључено.'}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
    }
  }

  public async start(): Promise<void> {
    await this.client.login(this.config.token);
  }

  public stop(): void {
    for (const player of this.players.values()) {
      player.destroy();
    }
    this.players.clear();
    this.client.destroy();
  }
}
