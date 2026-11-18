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

  let health: ReturnType<typeof Bun.serve> | undefined;
  try {
    health = Bun.serve({
      hostname: '0.0.0.0',
      port: Number(process.env.KVZ_HEALTH_PORT || '8080'),
      fetch(request) {
        if (new URL(request.url).pathname !== '/health') return new Response(null, { status: 404 });
        const ready = bot.client.isReady();
        return Response.json({ status: ready ? 'ok' : 'unavailable', service: 'kvazar' }, { status: ready ? 200 : 503 });
      },
    });

    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      console.log('\n🛑 Gašenje Kvazara...');
      try {
        await health?.stop(true);
        await bot.stop();
      } catch (error) {
        console.error('Грешка при гашењу Квазара:', error);
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await bot.start();
  } catch (err) {
    console.error('❌ Neuspelo pokretanje bota:', err);
    process.exit(1);
  }
}

main();
