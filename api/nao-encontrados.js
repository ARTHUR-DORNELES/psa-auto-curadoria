import { redis, cors } from './_lib.js';

// Ranking dos palestrantes que clientes PEDIRAM e não existem na base (demanda p/ cadastro).
// Protegido por Basic Auth via env NAO_ENCONTRADOS_AUTH = "usuario:senha".
export default async function handler(req, res) {
  if (cors(req, res)) return;

  // padrão PSA:PSA2030 (mesmo esquema dos outros painéis internos); trocável pela env
  const cred = process.env.NAO_ENCONTRADOS_AUTH || 'PSA:PSA2030';
  const auth = String(req.headers.authorization || '');
  const enviado = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
  if (enviado !== cred) {
    res.setHeader('WWW-Authenticate', 'Basic realm="nao-encontrados"');
    return res.status(401).json({ erro: 'não autorizado' });
  }

  try {
    // ZREVRANGE com scores: nome + quantas vezes foi pedido, do mais pedido pro menos
    const flat = await redis().zrevrange('auto-curadoria:nao-encontrados', 0, 499, 'WITHSCORES');
    const metaAll = await redis().hgetall('auto-curadoria:nao-encontrados:meta');
    const itens = [];
    for (let i = 0; i < flat.length; i += 2) {
      const nome = flat[i];
      let meta = {};
      try { meta = JSON.parse(metaAll[nome.toLowerCase()] || '{}'); } catch (e) {}
      itens.push({ nome, pedidos: Number(flat[i + 1]) || 0, ultimaEmpresa: meta.ultimaEmpresa || '', em: meta.em || '' });
    }
    return res.status(200).json({ total: itens.length, itens });
  } catch (e) {
    console.error('nao-encontrados (leitura) falhou:', e.message);
    return res.status(500).json({ erro: 'falha ao ler a lista' });
  }
}
