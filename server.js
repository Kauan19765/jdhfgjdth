// server.js
// Scraper + API para página SHOUTcast (corrigido com streamGenre limpo)
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const SCRAPE_URL = process.env.SCRAPE_URL || 'http://sonicpanel.oficialserver.com:8342/index.html';
const CACHE_DURATION = parseInt(process.env.CACHE_MS || '1000', 10); // ms
const AXIOS_TIMEOUT = parseInt(process.env.AXIOS_TIMEOUT || '8000', 10);
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; Scraper/1.0)';

let cachedData = {
  serverStatus: "",
  isServerUp: false,
  streamStatus: "",
  currentListeners: 0,
  maxListeners: 0,
  uniqueListeners: 0,
  bitrate: "",
  isStreamUp: false,
  listenerPeak: "",
  avgListenTime: "",
  streamTitle: "",
  streamGenre: "",
  contentType: "",
  streamUrl: "",
  currentSong: "",
  audioStreamUrl: "",
  lastUpdated: new Date().toISOString()
};
let lastFetch = 0;
let isFetching = false;

// util: parse int seguro
function parseIntSafe(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(/\./g, '');
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// remove <script>…</script>
function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
}

// limpa HTML/JS/labels extras
function sanitize(value) {
  if (!value) return '';
  let s = String(value);
  s = s.replace(/<[^>]+>/g, ' '); // remove tags
  s = s.replace(/(Stream URL:|Stream ICQ:|Stream AIM:|Stream IRC:|Current Song:|Content Type:|Server Status:|Stream Status:)/gi, ' ');
  s = s.replace(/var\s+[a-zA-Z0-9_]+\s*=\s*[^;]+;/g, ' ');
  s = s.replace(/['"`]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function scrapeShoutcastData() {
  try {
    const res = await axios.get(SCRAPE_URL, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: AXIOS_TIMEOUT
    });
    const html = res.data;

    // removendo scripts antes de carregar
    const htmlNoScripts = stripScripts(html);
    const $ = cheerio.load(htmlNoScripts);

    const out = {
      serverStatus: "",
      isServerUp: false,
      streamStatus: "",
      currentListeners: 0,
      maxListeners: 0,
      uniqueListeners: 0,
      bitrate: "",
      isStreamUp: false,
      listenerPeak: "",
      avgListenTime: "",
      streamTitle: "",
      streamGenre: "",
      contentType: "",
      streamUrl: "",
      currentSong: "",
      audioStreamUrl: "",
      lastUpdated: new Date().toISOString()
    };

    // tabela
    $('table tr').each((i, el) => {
      const label = $(el).find('td:first-child').text().trim().replace(':', '');
      const valueRaw = $(el).find('td:last-child').text().trim();
      if (!label) return;
      const value = valueRaw || "";
      const L = label.toLowerCase();

      if (L.includes('server status')) {
        out.serverStatus = value;
        out.isServerUp = /up/i.test(value);
      } else if (L.includes('stream status')) {
        out.streamStatus = value;
        out.isStreamUp = /stream|up/i.test(value);
        const bMatch = value.match(/(\d+)\s*kbps/i);
        if (bMatch) out.bitrate = String(parseIntSafe(bMatch[1]));
        const listenersMatch = value.match(/with\s+(\d+)\s+of\s+(\d+)/i);
        if (listenersMatch) {
          out.currentListeners = parseIntSafe(listenersMatch[1]);
          out.maxListeners = parseIntSafe(listenersMatch[2]);
        }
        const uniqueMatch = value.match(/\((\d+)\s*unique\)/i);
        if (uniqueMatch) out.uniqueListeners = parseIntSafe(uniqueMatch[1]);
      } else if (L.includes('current listeners')) {
        out.currentListeners = parseIntSafe(value);
      } else if (L.includes('max listeners')) {
        out.maxListeners = parseIntSafe(value);
      } else if (L.includes('current song') || L.includes('now playing')) {
        out.currentSong = value;
      } else if (L.includes('stream title') || L.includes('station name')) {
        out.streamTitle = value;
      } else if (L.includes('content type')) {
        out.contentType = value;
      } else if (L.includes('stream url') || L.includes('streamurl')) {
        out.streamUrl = value;
      } else if (L.includes('audio stream') || L.includes('audio stream url')) {
        out.audioStreamUrl = value;
      } else if (L.includes('listener peak') || L.includes('peak listeners')) {
        out.listenerPeak = String(parseIntSafe(value));
      } else if (L.includes('average listen time') || L.includes('avg listen time')) {
        out.avgListenTime = value;
      } else if (L.includes('stream genre') || L.includes('genre')) {
        out.streamGenre = value;
      }
    });

    const text = $.root().text();

    // stream title
    if (!out.streamTitle) {
      const m = text.match(/(?:Stream Title|Station Name|Stream:)\s*[:\-]?\s*([^\n\r]+)/i);
      if (m) out.streamTitle = m[1].trim();
    }

    // current song
    if (!out.currentSong) {
      const m = text.match(/(?:Current Song|Now Playing)\s*[:\-]?\s*([^\n\r]+)/i);
      if (m) out.currentSong = m[1].trim();
    }

    // audio stream url
    if (!out.audioStreamUrl) {
      const m = html.match(/(https?:\/\/[^\s"'<>]+\/;?)/i);
      if (m) out.audioStreamUrl = m[1];
    }

    if (!out.bitrate) {
      const m = text.match(/(\d+)\s*kbps/i);
      if (m) out.bitrate = String(parseIntSafe(m[1]));
    }

    if ((!out.currentListeners || !out.maxListeners) && text) {
      const m = text.match(/(\d+)\s+of\s+(\d+)\s+listeners/i);
      if (m) {
        out.currentListeners = parseIntSafe(m[1]);
        out.maxListeners = parseIntSafe(m[2]);
      } else {
        const m2 = text.match(/(\d+)\s+listeners/i);
        if (m2) out.currentListeners = parseIntSafe(m2[1]);
      }
    }

    if (!out.uniqueListeners) {
      const m = text.match(/\((\d+)\s*unique\)/i);
      if (m) out.uniqueListeners = parseIntSafe(m[1]);
    }

    if (!out.listenerPeak) {
      const m = text.match(/(listener peak|peak listeners|peak)\s*[:\-]?\s*(\d+)/i);
      if (m) out.listenerPeak = String(parseIntSafe(m[2]));
    }

    if (!out.avgListenTime) {
      const m = text.match(/(?:avg(?:erage)? listen time|avg listen time)\s*[:\-]?\s*([^\n\r]+)/i);
      if (m) out.avgListenTime = m[1].trim();
    }

    if (!out.contentType) {
      const m = text.match(/audio\/[a-z0-9.+-]+/i);
      if (m) out.contentType = m[0];
    }

    if (!out.streamUrl && out.audioStreamUrl) {
      try {
        const url = new URL(out.audioStreamUrl);
        out.streamUrl = url.hostname.replace(/^www\./, '');
      } catch {}
    }

    // ======== streamGenre seguro ========
    if (!out.streamGenre) {
      const genreRegex = /(?:Stream Genre|Genre)\s*[:\-]?\s*([\s\S]*?)(?=(?:Stream URL:|Stream ICQ:|Stream AIM:|Stream IRC:|Current Song:|Content Type:|Server Status:|Stream Status:|$))/i;
      const gm = htmlNoScripts.match(genreRegex);
      if (gm && gm[1]) {
        out.streamGenre = sanitize(gm[1]);
      } else {
        const gm2 = text.match(/(?:Stream Genre|Genre)\s*[:\-]?\s*([^\n\r]*)/i);
        out.streamGenre = sanitize(gm2 ? gm2[1] : '');
      }
    }

    if (!out.serverStatus) {
      const m = text.match(/Server is currently (up|down)/i);
      if (m) {
        out.serverStatus = `Server is currently ${m[1]}.`;
        out.isServerUp = /up/i.test(m[1]);
      }
    }
    if (!out.streamStatus) {
      const m = text.match(/Stream (is|:)\s*([^\n\r]+)/i);
      if (m) out.streamStatus = m[0].trim();
    }
    if (!out.isStreamUp) out.isStreamUp = !!(out.streamStatus && /up|stream/i.test(out.streamStatus));

    return out;
  } catch (err) {
    console.error('[scrape] erro:', err.message);
    return null;
  }
}

function normalizeData(src) {
  return {
    serverStatus: src.serverStatus ?? "",
    isServerUp: src.isServerUp ?? false,
    streamStatus: src.streamStatus ?? "",
    currentListeners: src.currentListeners ?? 0,
    maxListeners: src.maxListeners ?? 0,
    uniqueListeners: src.uniqueListeners ?? 0,
    bitrate: src.bitrate ?? "",
    isStreamUp: src.isStreamUp ?? false,
    listenerPeak: src.listenerPeak ?? "",
    avgListenTime: src.avgListenTime ?? "",
    streamTitle: src.streamTitle ?? "",
    streamGenre: src.streamGenre ?? "",
    contentType: src.contentType ?? "",
    streamUrl: src.streamUrl ?? "",
    currentSong: src.currentSong ?? "",
    audioStreamUrl: src.audioStreamUrl ?? "",
    lastUpdated: src.lastUpdated ?? new Date().toISOString()
  };
}

// root
app.get('/', async (req, res) => {
  const now = Date.now();
  if (!cachedData.lastUpdated || (now - lastFetch) > CACHE_DURATION) {
    try {
      const data = await scrapeShoutcastData();
      if (data) {
        cachedData = data;
        lastFetch = Date.now();
      }
    } catch (e) {
      console.error('[api] erro scrape:', e.message);
    }
  }
  res.json(normalizeData(cachedData));
});

// opcional alias
app.get('/api/status', (req, res) => {
  res.json({ ok: true, lastUpdated: cachedData.lastUpdated });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  (async () => {
    const data = await scrapeShoutcastData();
    if (data) {
      cachedData = data;
      lastFetch = Date.now();
      console.log('✅ Dados iniciais carregados');
    }
  })();
  setInterval(async () => {
    const now = Date.now();
    if (isFetching) return;
    if ((now - lastFetch) < CACHE_DURATION) return;
    isFetching = true;
    try {
      const data = await scrapeShoutcastData();
      if (data) {
        cachedData = data;
        lastFetch = Date.now();
      }
    } catch (e) {
      console.error('[background] erro:', e.message);
    } finally {
      isFetching = false;
    }
  }, Math.max(500, CACHE_DURATION));
});

const axios = require('axios'); // se ainda não tiver no projeto, npm install axios
const streamTarget = 'http://sonicpanel.oficialserver.com:8342/;'; // upstream (original)

// Rota que serve o HTML idêntico (acessível em /;)
app.get('/;', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width"><meta charset="utf-8"><title>Player</title></head>
<body>
  <!-- uso <audio> que é mais apropriado para áudio; mantém o ';' -->
  <audio controls autoplay crossorigin="anonymous">
    <source src="/stream/;" type="audio/mpeg">
    Seu navegador não suporta este player.
  </audio>
</body></html>`);
});

// Proxy streaming para o upstream (responde em /stream/;)
app.get('/stream/;', async (req, res) => {
  try {
    // solicita o stream upstream como stream
    const upstream = await axios.get(streamTarget, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'StreamProxy/1.0',
        'Icy-MetaData': '1'
      },
      timeout: 20000,
      validateStatus: null
    });

    // se upstream retornou erro, propaga
    if (!upstream || upstream.status >= 400) {
      res.status(upstream.status || 502).send('Erro no upstream');
      return;
    }

    // copia headers úteis e força CORS
    const allowed = ['content-type','icy-metaint','icy-br','icy-name','content-length'];
    allowed.forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    // HEADERS CORS importantes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'icy-metaint,icy-name,Content-Length');

    // pipe do stream
    upstream.data.pipe(res);

    // quando o cliente desconectar, mata o upstream
    req.on('close', () => {
      try { upstream.data.destroy(); } catch(e){}
    });
  } catch (err) {
    console.error('proxy stream error', err && err.message);
    if (!res.headersSent) res.status(500).send('Erro no proxy');
  }
});


process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

module.exports = server;
