const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Habilitar CORS para permitir requisições do seu site
app.use(cors());
app.use(express.json());

// Função para extrair dados do SHOUTcast
async function scrapeShoutcastData() {
    try {
        const response = await axios.get('http://sonicpanel.oficialserver.com:8342/index.html', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Scraper/1.0)'
            },
            timeout: 8000
        });
        const $ = cheerio.load(response.data);

        const streamData = {
            isServerUp: false,
            isStreamUp: false,
            serverStatus: 'unknown',
            streamStatus: 'unknown',
            currentListeners: 0,
            maxListeners: 0,
            currentSong: null,
            lastUpdated: new Date().toISOString()
        };

        // Exemplo de extração — adapte de acordo com o HTML real
        $('table[cellpadding="2"] tr').each((index, element) => {
            const label = $(element).find('td:first-child').text().trim().replace(':', '');
            const value = $(element).find('td:last-child').text().trim();

            if (label && value) {
                switch (label) {
                    case 'Server Status':
                        streamData.serverStatus = value;
                        streamData.isServerUp = value.toLowerCase().includes('up');
                        break;
                    case 'Stream Status':
                        streamData.streamStatus = value;
                        streamData.isStreamUp = value.toLowerCase().includes('streaming') || value.toLowerCase().includes('up');
                        break;
                    case 'Current Listeners':
                        streamData.currentListeners = parseInt(value) || 0;
                        break;
                    case 'Max Listeners':
                        streamData.maxListeners = parseInt(value) || 0;
                        break;
                    case 'Current Song':
                        streamData.currentSong = value;
                        break;
                    default:
                        break;
                }
            }
        });

        streamData.lastUpdated = new Date().toISOString();
        return streamData;
    } catch (error) {
        console.error('Erro ao extrair dados:', error.message);
        return {
            error: 'Erro ao conectar com o servidor SHOUTcast',
            lastUpdated: new Date().toISOString(),
            isServerUp: false,
            isStreamUp: false
        };
    }
}

// Cache dos dados para evitar muitas requisições
let cachedData = null;
let lastFetch = 0;
// Atualiza a cada 1 segundo
const CACHE_DURATION = 1000; // 1 segundo

// Rota principal para obter dados em JSON
app.get('/api/stream-info', async (req, res) => {
    const now = Date.now();

    // Verificar se precisa buscar novos dados (fallback caso background não tenha rodado ainda)
    if (!cachedData || (now - lastFetch) > CACHE_DURATION) {
        console.log('Buscando novos dados do SHOUTcast (request)...');
        cachedData = await scrapeShoutcastData();
        lastFetch = now;
    }

    res.json({
        isOnline: cachedData.isServerUp && cachedData.isStreamUp,
        currentListeners: cachedData.currentListeners || 0,
        maxListeners: cachedData.maxListeners || 0,
        currentSong: cachedData.currentSong || 'N/A',
        lastUpdated: cachedData.lastUpdated
    });
});

// Rota de status simples
app.get('/api/status', async (req, res) => {
    const now = Date.now();
    if (!cachedData || (now - lastFetch) > CACHE_DURATION) {
        cachedData = await scrapeShoutcastData();
        lastFetch = now;
    }
    res.json({ ok: true, lastUpdated: cachedData.lastUpdated });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📡 API disponível em http://localhost:${PORT}/api/stream-info`);
    
    // Fazer primeira busca ao iniciar
    scrapeShoutcastData().then(data => {
        cachedData = data;
        lastFetch = Date.now();
        console.log('✅ Dados iniciais carregados com sucesso');
    });

    // Atualizar em background a cada 1 segundo (evita múltiplas chamadas concorrentes)
    let isFetching = false;
    setInterval(async () => {
        if (isFetching) return;
        isFetching = true;
        try {
            const now = Date.now();
            // proteção redundante: só busca se tiver passado CACHE_DURATION
            if (!cachedData || (now - lastFetch) >= CACHE_DURATION) {
                const data = await scrapeShoutcastData();
                cachedData = data;
                lastFetch = Date.now();
                // console.log('🔄 Dados atualizados (background)');
            }
        } catch (err) {
            console.error('Erro no update background:', err.message);
        } finally {
            isFetching = false;
        }
    }, CACHE_DURATION);
});

module.exports = app;
