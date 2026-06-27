// YouTube新着 → Gemini要約 → LINE通知（@ハンドル対応 / ダイジェスト配信）
import { readFile, writeFile } from 'node:fs/promises';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINE_TOKEN     = process.env.LINE_TOKEN;
const LINE_USER_ID   = process.env.LINE_USER_ID;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_VIDEOS_PER_RUN = Number(process.env.MAX_VIDEOS_PER_RUN || 15);

const CHANNELS_PATH = 'channels.json';
const STATE_PATH    = 'seen.json';

const DRY_RUN  = process.argv.includes('--dry-run');
const TEST_IDX = process.argv.indexOf('--test');
const TESTLINE_IDX = process.argv.indexOf('--test-line');

async function main() {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');

  if (TEST_IDX !== -1) {
    const url = process.argv[TEST_IDX + 1];
    if (!url) throw new Error('--test の後ろに動画URLを指定してください');
    console.log(await summarize(url));
    return;
  }
  if (TESTLINE_IDX !== -1) {
    const url = process.argv[TESTLINE_IDX + 1];
    if (!url) throw new Error('--test-line の後ろに動画URLを指定してください');
    if (!LINE_TOKEN || !LINE_USER_ID) throw new Error('LINE_TOKEN / LINE_USER_ID が未設定です');
    await pushLine('🧪 テスト通知\n\n' + await summarize(url));
    console.log('テスト通知を送信しました');
    return;
  }
  if (!DRY_RUN && (!LINE_TOKEN || !LINE_USER_ID)) {
    throw new Error('LINE_TOKEN / LINE_USER_ID が未設定です（確認だけなら --dry-run）');
  }

  const channels = JSON.parse(await readFile(CHANNELS_PATH, 'utf8'));
  const state = await loadState();
  state._ids = state._ids || {};
  const digest = [];
  let count = 0;

  for (const ch of channels) {
    if (count >= MAX_VIDEOS_PER_RUN) break;
    const channelId = await getChannelId(ch, state);
    if (!channelId) { console.error(`[id] 解決失敗: ${ch.name || ch.handle || ch.id}`); continue; }

    const videos = await fetchFeed(channelId);
    if (!videos.length) continue;

    const seen = state[channelId];
    if (!seen) {
      state[channelId] = videos.map(v => v.id);
      console.log(`[init] ${ch.name || channelId}: 既読登録のみ`);
      continue;
    }

    const seenSet = new Set(seen);
    const fresh = videos.filter(v => !seenSet.has(v.id)).reverse();

    for (const v of fresh) {
      if (count >= MAX_VIDEOS_PER_RUN) break;
      if (await isShort(v.id)) { console.log(`[short] skip ${v.id}`); continue; }
      try {
        const summary = await summarize(v.url);
        digest.push(`🎬 ${ch.name || v.author}\n${v.title}\n${v.url}\n\n${summary}`);
        count++;
      } catch (e) { console.error(`[error] ${v.id}: ${e.message}`); }
    }

    if (!DRY_RUN) {
      state[channelId] = [...videos.map(v => v.id), ...seen]
        .filter((id, i, a) => a.indexOf(id) === i).slice(0, 50);
    }
  }

  if (digest.length) {
    const messages = buildMessages(digest, 4900);
    if (DRY_RUN) console.log('\n===== DIGEST =====\n' + messages.join('\n\n') + '\n==================\n');
    else for (const m of messages) await pushLine(m);
  }

  if (!DRY_RUN) await saveState(state);
  console.log(`完了: ${count}本を通知`);
}

function buildMessages(blocks, max) {
  const sep = '\n\n────────\n\n';
  const msgs = [];
  let cur = '';
  for (const b of blocks) {
    const piece = cur ? cur + sep + b : b;
    if (piece.length > max && cur) { msgs.push(cur); cur = b; }
    else cur = piece;
  }
  if (cur) msgs.push(cur);
  return msgs.map(m => m.slice(0, max));
}

async function getChannelId(ch, state) {
  if (ch.id && /^UC[\w-]{22}$/.test(ch.id)) return ch.id;
  const handle = (ch.handle || ch.id || '').replace(/^@?/, '@');
  if (handle === '@') return null;
  if (state._ids[handle]) return state._ids[handle];
  const id = await resolveId(handle);
  if (id) state._ids[handle] = id;
  return id;
}

async function resolveId(handle) {
  try {
    const res = await fetch(`https://www.youtube.com/${handle}`, { headers: { 'accept-language': 'en-US' } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function fetchFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) { console.error(`[rss] ${channelId}: HTTP ${res.status}`); return []; }
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const id = (block.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1];
    if (!id) continue;
    const title  = decode((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const author = decode((block.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '');
    out.push({ id, title, author, url: `https://www.youtube.com/watch?v=${id}` });
  }
  return out;
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function isShort(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, { redirect: 'manual' });
    return res.status === 200;
  } catch { return false; }
}

async function summarize(videoUrl) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const prompt =
    '次のYouTube動画を日本語で詳しく要約してください。以下のフォーマットで出力:\n' +
    '【要点】全体の結論を1〜2文\n' +
    '【内容】重要ポイントを5〜8個、各1〜2文で具体的に。数字・固有名詞・手順は省略しない\n' +
    '【示唆】視聴者が得られる学びや使いどころを2〜3文\n' +
    '前置きや締めの挨拶は不要。';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ file_data: { file_uri: videoUrl } }, { text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(data)}`);
  return data.candidates[0].content.parts[0].text.trim();
}

async function pushLine(text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] })
  });
  if (!res.ok) throw new Error(`LINE ${res.status}: ${await res.text()}`);
}

main().catch(e => { console.error(e); process.exit(1); });
