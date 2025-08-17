// server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SCRAPE_URL = process.env.SCRAPE_URL || 'http://sonicpanel.oficialserver.com:8342/index.html';
const CACHE_DURATION = parseInt(process.env.CACHE_MS || '1000', 10);
const AXIOS_TIMEOUT = parseInt(process.env.AXIOS_TIMEOUT || '8000', 10);
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; Scraper/1.0)';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let cachedData = {
  serverStatus: null,
  isServerUp: false,
  streamStatus: null,
  currentListeners: 0,
  maxListeners: 0,
  uniqueListeners: 0,
  bitrate: null,
  isStreamUp: false,
  listenerPeak: null,
  avgListenTime: null,
  streamTitle: null,
  contentType: null,
  streamUrl: null,
  currentSong: null,
  audioStreamUrl: null,
  lastUpdated: null
};
let lastFetch = 0;
let isFetching = false;

function parseIntSafe(v) {
  if (!v) return 0;
  const m = v.toString().replace(/\./g, '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

async function scrapeShoutcastData() {
  try {
    const res = await axios.get(SCRAPE_URL, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: AXIOS_TIMEOUT
    });
    const html = res.data;
    const $ = cheerio.load(html);

    const out = {
      serverStatus: null,
      isServerUp: false,
      streamStatus: null,
      currentListeners: 0,
      maxListeners: 0,
      uniqueListeners: 0,
      bitrate: null,
      isStreamUp: false,
      listenerPeak: null,
      avgListenTime: null,
      streamTitle: null,
      contentType: null,
      streamUrl: null,
      currentSong: null,
      audioStreamUrl: null,
      lastUpdated: new Date().toISOString()
    };

    $('table tr').each((i, el) => {
      const label = $(el).find('td:first-child').text().trim().replace(':', '');
      const value = $(el).find('td:last-child').text().trim();
      if (!label || !value) return;
      const L = label.toLowerCase();
      if (L.includes('server status')) {
        out.serverStatus = value;
        out.isServerUp = /up/i.test(value);
      } else if (L.includes('stream status')) {
        out.streamStatus = value;
        out.isStreamUp = /stream|up/i.test(value);
        const bMatch = value.match(/(\d+)\s*kbps/i);
        if (bMatch) out.bitrate = parseInt(bMatch[1], 10);
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
        out.listenerPeak = parseIntSafe(value);
      } else if (L.includes('average listen time') || L.includes('avg listen time')) {
        out.avgListenTime = value;
      }
    });

    const text = $.root().text();

    if (!out.streamTitle) {
      const m = text.match(/(?:Stream Title|Station Name|Stream:)\s*[:\-]?\s*([^\n\r]+)/i);
      if (m) out.streamTitle = m[1].trim();
    }

    if (!out.currentSong) {
      const m = text.match(/(?:Current Song|Now Playing)\s*[:\-]?\s*([^\n\r]+)/i);
      if (m) out.currentSong = m[1].trim();
    }

    if (!out.audioStreamUrl) {
      const m = html.match(/(http[s]?:\/\/[^\s"'<>]+\/;?)/i);
      if (m) out.audioStreamUrl = m[1];
    }

    if (!out.bitrate) {
      const m = text.match(/(\d+)\s*kbps/i);
      if (m) out.bitrate = parseIntSafe(m[1]);
    }
    if (!out.currentListeners || !out.maxListeners) {
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
      if (m) out.listenerPeak = parseIntSafe(m[2]);
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
      } catch (e) { /* ignore */ }
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

// ROTA PRINCIPAL: serve o JSON direto em "/"
app.get(['/', '/api/stream-info'], async (req, res) => {
  const now = Date.now();
  if (!cachedData.lastUpdated || now - lastFetch > CACHE_DURATION) {
    try {
      const data = await scrapeShoutcastData();
      if (data) {
        cachedData = data;
        lastFetch = Date.now();
      }
    } catch (e) {
      // ignore
    }
  }
  return res.json(cachedData);
});

app.get('/api/status', (req, res) => {
  return res.json({ ok: true, lastUpdated: cachedData.lastUpdated });
});

// Se você quiser servir arquivos estáticos (ex: frontend), coloque-os em "public"
app.use(express.static(path.join(__dirname, 'public')));

// fallback simples para rotas não-API (opcional)
// Observação: se você usar SPA, remova/ajuste esse fallback para enviar index.html
app.get('*', (req, res) => {
  // se a rota é /api/... devolve 404 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  // caso contrário, devolve uma página simples (pode ser index.html na pasta public)
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) {
      // se não existir index.html, retorna uma resposta simples
      res.send('<h1>Shoutcast Scraper</h1><p>Use <a href="/api/stream-info">/api/stream-info</a> ou abra / para ver o JSON.</p>');
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  (async () => {
    const data = await scrapeShoutcastData();
    if (data) {
      cachedData = data;
      lastFetch = Date.now();
      console.log('✅ Dados iniciais carregados com sucesso');
    } else {
      console.log('⚠️ Falha ao carregar dados iniciais (mantendo cache padrão)');
    }
  })();

  setInterval(async () => {
    const now = Date.now();
    if (isFetching) return;
    if (now - lastFetch < CACHE_DURATION) return;
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

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

module.exports = server;
