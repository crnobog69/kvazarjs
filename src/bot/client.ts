import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  type Interaction,
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

    this.setupListeners();
  }

  private setupListeners(): void {
    this.client.on(Events.Error, error => console.error('Грешка Discord клијента:', error));
    this.client.on(Events.ShardError, (error, shard) => console.warn(`Discord gateway (${shard}):`, error));
    this.client.on(Events.GuildDelete, guild => {
      this.players.get(guild.id)?.destroy();
      this.players.delete(guild.id);
    });

    this.client.once(Events.ClientReady, async () => {
      console.log(`🌌 Kvazar povezan kao ${this.client.user?.tag}!`);

      try {
        this.client.user?.setPresence({
          status: 'dnd',
          activities: [{ name: this.config.status || '/play', type: ActivityType.Listening }],
        });
        console.log('Registrujem slash komande...');
        await this.client.application?.commands.set(
          slashCommands as ApplicationCommandDataResolvable[]
        );
        console.log('✅ Slash komande uspešno registrovane!');
      } catch (err) {
        console.error('Greška pri registraciji komandi:', err);
      }
    });

    this.client.on(Events.VoiceStateUpdate, (previous, current) => {
      if (previous.channelId === current.channelId) return;
      const player = this.players.get(current.guild.id);
      if (!player) return;
      if (current.id === this.client.user?.id && !current.channelId) {
        if (!player.channelId || player.channelId === previous.channelId) player.destroy();
        return;
      }
      const channel = current.id === this.client.user?.id ? current.channel : previous.channel;
      if (channel && channel.id === player.channelId && !channel.members.some(member => !member.user.bot)) {
        player.destroy();
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
      player = new GuildPlayer(guildId, this.client, this.config.ffmpegPath);
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

  private async handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
    const { guild, user } = interaction;
    const voiceChannel = guild?.voiceStates.cache.get(user.id)?.channel;

    if (!guild || !voiceChannel) {
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

    const lookup = new AbortController();
    try {
      const player = this.getPlayer(guild.id);
      if (guild.voiceStates.cache.get(user.id)?.channelId !== voiceChannel.id) {
        throw new Error('Напустио си гласовни канал.');
      }
      const [connection, track] = await Promise.all([
        player.ensureConnected(voiceChannel),
        this.resolver.resolve(query, `<@${user.id}>`, interaction.channelId, lookup.signal),
      ]);
      if (guild.voiceStates.cache.get(user.id)?.channelId !== voiceChannel.id) {
        throw new Error('Напустио си гласовни канал.');
      }

      const position = player.enqueue(track, connection);
      const embed = buildQueuedEmbed(track, position);

      await interaction.editReply({
        content: `У реду **${track.title.slice(0, 256)}** — позиција #${position}.`,
        embeds: [embed],
      });
    } catch (err) {
      lookup.abort();
      const message = err instanceof Error ? err.message : 'Непозната грешка.';
      await interaction.editReply({
        content: `Не могу да пустим песму: ${message.slice(0, 400)}`,
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
    if (!player?.channelId) {
      await interaction.reply({
        content: 'Нема ничега за заустављање.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    player.destroy();
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
        player.destroy();
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

  public async stop(): Promise<void> {
    for (const player of this.players.values()) {
      player.destroy();
    }
    this.players.clear();
    await this.client.destroy();
  }
}
