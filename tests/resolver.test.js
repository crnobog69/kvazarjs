import { expect, spyOn, test } from 'bun:test';
import { Resolver } from '../src/media/resolver';

const official = 'https://www.youtube.com/watch?v=official123';
const cover = 'https://www.youtube.com/watch?v=cover123456';
const other = 'https://www.youtube.com/watch?v=other123456';

const details = (url) => ({
  title: 'Artist - Pesma',
  webpage_url: url,
  url: 'https://audio.example.test/stream',
  duration: 240,
  extractor_key: 'Youtube',
});

test('a text search skips covers and tries the next candidate when audio is unavailable', async () => {
  const resolver = new Resolver();
  const extract = spyOn(resolver, 'extract').mockImplementation(async (input) => {
    if (input.startsWith('ytsearch')) {
      return [
        { title: 'Artist - Pesma (Cover)', url: cover },
        { title: 'Pesma (Official Audio)', channel: 'Artist', url: official },
        { title: 'Artist - Pesma (Lyrics)', url: other },
      ];
    }
    return input === official ? [] : [details(input)];
  });

  const track = await resolver.resolve('artist pesma', 'requester', 'channel');
  expect(extract.mock.calls.map(([input]) => input)).toEqual([
    'ytsearch5:artist pesma', official, other,
  ]);
  expect(track.webUrl).toBe(other);
  expect(track.requestedBy).toBe('requester');
});

test('SoundCloud queries prefer the requested version and direct URLs go straight to the source', async () => {
  const resolver = new Resolver();
  const original = 'https://soundcloud.com/artist/pesma';
  const remix = 'https://soundcloud.com/artist/pesma-remix';
  const extract = spyOn(resolver, 'extract').mockImplementation(async (input) => {
    if (input.startsWith('scsearch')) {
      return [
        { title: 'Pesma', uploader: 'Artist', webpage_url: original },
        { title: 'Pesma (Remix)', uploader: 'Artist', webpage_url: remix },
      ];
    }
    return [{ ...details(input), extractor_key: 'Soundcloud' }];
  });

  expect((await resolver.resolve('sc pesma remix', '', '')).webUrl).toBe(remix);
  expect((await resolver.resolve('sc pesma remix', 'new requester', '')).requestedBy).toBe('new requester');
  expect((await resolver.resolve(original, '', '')).webUrl).toBe(original);
  expect(extract.mock.calls.map(([input]) => input)).toEqual(['scsearch5:pesma remix', remix, remix, original]);
});

test('a refused stream is refreshed from the same video and checks formats before selecting one', async () => {
  const resolver = new Resolver();
  const fresh = { ...details(official), format_id: '251', http_headers: { 'User-Agent': 'fresh' } };
  const extract = spyOn(resolver, 'extract').mockResolvedValue([fresh]);
  const track = {
    title: 'Requested video',
    webUrl: official,
    streamUrl: 'https://audio.example.test/old',
    formatId: '140',
    queuedAt: new Date(0),
  };

  const recovered = await resolver.refreshForPlayback(track, new AbortController().signal);
  const [[input, flags]] = extract.mock.calls;
  expect(input).toBe(official);
  expect(flags).toContain('--check-formats');
  expect(flags.at(-1)).toStartWith('bestaudio[ext=m4a][format_id!="140"]/');
  expect(recovered).toEqual({
    ...track, streamUrl: fresh.url, formatId: '251', httpHeaders: fresh.http_headers,
  });
});
