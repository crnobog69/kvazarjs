import dotenv from 'dotenv';
import { KvazarBot } from './bot/client';

// Load environment variables (.env)
dotenv.config();

const token = process.env.KVZ_DISCORD_TOKEN || process.env.DISCORD_TOKEN;

if (!token) {
  console.error('❌ Greška: KVZ_DISCORD_TOKEN ili DISCORD_TOKEN nije podešen u .env fajlu!');
  process.exit(1);
}

const bot = new KvazarBot({
  token,
  status: process.env.KVZ_STATUS,
  ffmpegPath: process.env.KVZ_FFMPEG_PATH,
  ytdlpPath: process.env.KVZ_YTDLP_PATH,
});

async function main() {
  console.log('🌌 Pokrećem Kvazar (Bun)...');

  const shutdown = () => {
    console.log('\n🛑 Gašenje Kvazara...');
    bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await bot.start();
  } catch (err) {
    console.error('❌ Neuspelo pokretanje bota:', err);
    process.exit(1);
  }
}

main();
