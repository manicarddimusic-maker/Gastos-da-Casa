'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { criarArmazenamento } = require('./storage');

const PORT = process.env.PORT || 3000;
/* Senhas que abrem o app: APP_PASSWORDS="Ana,Guilherme" (separadas por vírgula). APP_PASSWORD (uma só) continua funcionando. */
const SENHAS = (process.env.APP_PASSWORDS || process.env.APP_PASSWORD || '')
  .split(',').map((x) => x.trim()).filter(Boolean);
if (!SENHAS.length || SENHAS.some((x) => x.length < 3)) {
  console.error('Defina a variável APP_PASSWORDS com as senhas separadas por vírgula (cada uma com pelo menos 3 caracteres). Exemplo: Ana,Guilherme');
  process.exit(1);
}
const SEGREDO = process.env.SESSION_SECRET || crypto.createHash('sha256').update('gastos|' + SENHAS.join('|')).digest('hex');
const COOKIE = 'gc_sessao';
const HORAS = 12; /* a senha não fica salva: o acesso vale no máximo 12h */
/* O acesso só se mantém enquanto o app está em uso: o cookie vale por alguns minutos e é renovado a cada requisição.
   Assim dá para abrir o PDF, voltar, compartilhar (WhatsApp, e-mail...) e continuar no app sem digitar a senha de novo;
   ficando mais que isso fora do app, a senha é pedida outra vez. */
const SESSAO_MIN = Math.min(240, Math.max(1, Number(process.env.SESSAO_MINUTOS) || 15));

/* ---------- sessão por cookie assinado ---------- */
function assinar(valor) {
  return crypto.createHmac('sha256', SEGREDO).update(valor).digest('hex');
}
function criarToken() {
  const exp = String(Date.now() + HORAS * 3600000);
  return exp + '.' + assinar(exp);
}
function tokenValido(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i < 1) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  const esperado = assinar(exp);
  if (sig.length !== esperado.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return false;
  return Number(exp) > Date.now();
}
function lerCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function autenticado(req) {
  return tokenValido(lerCookies(req)[COOKIE]);
}
function gravarCookie(req, res, token, maxAge) {
  const partes = [COOKIE + '=' + encodeURIComponent(token), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge === 0) partes.push('Max-Age=0');
  else partes.push('Max-Age=' + (maxAge > 0 ? maxAge : SESSAO_MIN * 60));
  if (req.secure) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}
function senhaCorreta(tentativa) {
  const a = crypto.createHash('sha256').update(String(tentativa).trim()).digest();
  let ok = false;
  SENHAS.forEach((senha) => {
    const b = crypto.createHash('sha256').update(senha).digest();
    if (crypto.timingSafeEqual(a, b)) ok = true;
  });
  return ok;
}

/* limite simples de tentativas de senha por IP */
const tentativas = new Map();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return false;
  if (Date.now() > t.ate) { tentativas.delete(ip); return false; }
  return t.n >= 8;
}
function falhou(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() > t.ate) tentativas.set(ip, { n: 1, ate: Date.now() + 10 * 60000 });
  else t.n++;
}

/* ---------- validação ---------- */
const GRUPOS = ['fixo', 'variavel'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_LINHAS = 20000;
const MAX_VALOR = 100000000000;
const MAX_ANEXO = 40 * 1024 * 1024;   // 40 MB por arquivo
const MAX_ANEXOS_LINHA = 30;

/* anexos: nome e tipo seguros; só imagem, PDF, vídeo, áudio e texto simples abrem direto no navegador, o resto baixa */
const EXT_TIPO = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', txt: 'text/plain' };
const ABRE_DIRETO = /^(image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif)|application\/pdf|video\/(mp4|quicktime|webm|x-m4v)|audio\/[a-z0-9.+-]+|text\/plain)$/;
function nomeSeguro(n) {
  let x = String(n || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (x.length > 120) { const m = /(\.[A-Za-z0-9]{1,8})$/.exec(x); x = x.slice(0, 120 - (m ? m[1].length : 0)) + (m ? m[1] : ''); }
  return x || 'arquivo';
}
function tipoSeguro(t, nome) {
  let x = String(t || '').split(';')[0].trim().toLowerCase();
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(nome) || [])[1];
  if ((!x || x === 'application/octet-stream') && ext && EXT_TIPO[ext.toLowerCase()]) x = EXT_TIPO[ext.toLowerCase()];
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(x) && x.length <= 100 ? x : 'application/octet-stream';
}

function limparLinha(b, parcial) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Corpo inválido.');
  const out = {};
  if (!parcial || 'nome' in b) {
    if (typeof b.nome !== 'string' || !b.nome.trim() || b.nome.trim().length > 120) throw new Error('Nome inválido.');
    out.nome = b.nome.trim();
  }
  if (!parcial || 'grupo' in b) {
    if (!GRUPOS.includes(b.grupo)) throw new Error('Grupo inválido.');
    out.grupo = b.grupo;
  }
  if (!parcial || 'mes' in b) {
    if (typeof b.mes !== 'string' || !MES_RE.test(b.mes)) throw new Error('Mês inválido.');
    out.mes = b.mes;
  }
  if (!parcial || 'valorCentavos' in b) {
    if (!Number.isInteger(b.valorCentavos) || b.valorCentavos < 0 || b.valorCentavos > MAX_VALOR) throw new Error('Valor inválido.');
    out.valorCentavos = b.valorCentavos;
  }
  if ('pago' in b) {
    if (typeof b.pago !== 'boolean') throw new Error('Campo pago inválido.');
    out.pago = b.pago;
  } else if (!parcial) {
    out.pago = false;
  }
  if ('fixa' in b) {
    if (typeof b.fixa !== 'boolean') throw new Error('Campo fixa inválido.');
    out.fixa = b.fixa;
  }
  if ('pagoEm' in b) {
    if (typeof b.pagoEm !== 'string' || (b.pagoEm !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(b.pagoEm))) throw new Error('Data de pagamento inválida.');
    out.pagoEm = b.pagoEm;
  }
  if ('itens' in b) {
    if (!Array.isArray(b.itens) || b.itens.length > 300) throw new Error('Gastos inválidos.');
    const vistos = new Set();
    out.itens = b.itens.map((x) => {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ID_RE.test(x.id) || vistos.has(x.id)) throw new Error('Gasto inválido.');
      vistos.add(x.id);
      if (typeof x.data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.data)) throw new Error('Data inválida.');
      if (!Number.isInteger(x.valorCentavos) || x.valorCentavos < 0 || x.valorCentavos > MAX_VALOR) throw new Error('Valor do gasto inválido.');
      const nota = x.nota === undefined || x.nota === null ? '' : x.nota;
      if (typeof nota !== 'string' || nota.length > 60) throw new Error('Descrição inválida.');
      return { id: x.id, data: x.data, valorCentavos: x.valorCentavos, nota: nota };
    });
  }
  if ('criado' in b) {
    if (typeof b.criado !== 'number' || !Number.isFinite(b.criado)) throw new Error('Campo criado inválido.');
    out.criado = b.criado;
  } else if (!parcial) {
    out.criado = Date.now();
  }
  return out;
}

async function iniciar() {
  const armazenamento = await criarArmazenamento();
  let estado = await armazenamento.carregar();
  let fila = Promise.resolve();
  function persistir() {
    estado.rev++;
    const copia = JSON.stringify(estado);
    fila = fila.then(() => armazenamento.salvar(JSON.parse(copia))).catch((e) => console.error('Falha ao salvar:', e));
    return fila;
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
    );
    next();
  });

  app.get('/saude', (req, res) => res.type('text').send('ok'));

  /* login */
  const loginHtml = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8');
  app.get('/login', (req, res) => {
    if (autenticado(req)) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(loginHtml.replace('__ERRO__', req.query.e === '1' ? 'Senha incorreta. Tente de novo.' : req.query.e === '2' ? 'Muitas tentativas. Aguarde alguns minutos.' : ''));
  });
  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const ip = req.ip || 'x';
    if (bloqueado(ip)) return res.redirect('/login?e=2');
    if (senhaCorreta((req.body && (req.body['gc-chave'] || req.body.senha)) || '')) {
      tentativas.delete(ip);
      gravarCookie(req, res, criarToken());
      return res.redirect('/');
    }
    falhou(ip);
    res.redirect('/login?e=1');
  });
  app.post('/sair', (req, res) => {
    gravarCookie(req, res, '', 0);
    res.redirect('/login');
  });

  /* arquivos públicos: manifest, service worker, ícones */
  app.use(
    express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders(res, file) {
        if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
        else if (file.endsWith('.png')) res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    })
  );

  /* a partir daqui, só com senha */
  app.use((req, res, next) => {
    if (autenticado(req)) {
      gravarCookie(req, res, lerCookies(req)[COOKIE]);   // renova a janela de uso (mesmo token, não estende as 12h)
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'login' });
    res.redirect('/login');
  });

  /* fotos da casa e das cachorras: só aparecem depois do login */
  app.use('/fotos', express.static(path.join(__dirname, 'views', 'fotos'), {
    index: false,
    setHeaders(res) { res.setHeader('Cache-Control', 'private, max-age=86400'); }
  }));

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  });

  const api = express.Router();
  api.use(express.json({ limit: '400kb' }));

  api.get('/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      rev: estado.rev,
      renda: estado.renda,
      linhas: Object.keys(estado.linhas).map((id) => Object.assign({ id }, estado.linhas[id]))
    });
  });

  api.put('/renda', async (req, res) => {
    const v = req.body && req.body.salarioCentavos;
    if (!Number.isInteger(v) || v < 0 || v > MAX_VALOR) return res.status(400).json({ erro: 'Valor inválido.' });
    estado.renda = v;
    await persistir();
    res.json({ rev: estado.rev });
  });

  api.put('/linhas/:id', async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ erro: 'Id inválido.' });
    let doc;
    try { doc = limparLinha(req.body, false); } catch (e) { return res.status(400).json({ erro: e.message }); }
    if (!(req.params.id in estado.linhas) && Object.keys(estado.linhas).length >= MAX_LINHAS) return res.status(400).json({ erro: 'Limite de linhas atingido.' });
    const antes = estado.linhas[req.params.id];
    if (antes && Array.isArray(antes.anexos) && antes.anexos.length) doc.anexos = antes.anexos;   // anexos só mudam pelas rotas de anexo
    estado.linhas[req.params.id] = doc;
    await persistir();
    res.json({ rev: estado.rev });
  });

  api.patch('/linhas/:id', async (req, res) => {
    const atual = estado.linhas[req.params.id];
    if (!ID_RE.test(req.params.id) || !atual) return res.status(404).json({ erro: 'Linha não encontrada.' });
    let parte;
    try { parte = limparLinha(req.body, true); } catch (e) { return res.status(400).json({ erro: e.message }); }
    estado.linhas[req.params.id] = Object.assign({}, atual, parte);
    await persistir();
    res.json({ rev: estado.rev });
  });

  api.delete('/linhas/:id', async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ erro: 'Id inválido.' });
    const velha = estado.linhas[req.params.id];
    delete estado.linhas[req.params.id];
    await persistir();
    if (velha && Array.isArray(velha.anexos)) velha.anexos.forEach((a) => armazenamento.apagarArquivo(a.id).catch(() => {}));
    res.json({ rev: estado.rev });
  });

  api.post('/linhas/lote', async (req, res) => {
    const lista = req.body && req.body.linhas;
    if (!Array.isArray(lista) || lista.length < 1 || lista.length > 100) return res.status(400).json({ erro: 'Lote inválido.' });
    const novos = [];
    try {
      lista.forEach((item) => {
        if (!item || !ID_RE.test(item.id)) throw new Error('Id inválido.');
        novos.push([item.id, limparLinha(item, false)]);
      });
    } catch (e) { return res.status(400).json({ erro: e.message }); }
    if (Object.keys(estado.linhas).length + novos.length > MAX_LINHAS) return res.status(400).json({ erro: 'Limite de linhas atingido.' });
    novos.forEach(([id, doc]) => { estado.linhas[id] = doc; });
    await persistir();
    res.json({ rev: estado.rev });
  });

  /* ---------- anexos: prints, PDFs, planilhas, vídeos... de cada pagamento ---------- */
  app.post('/api/linhas/:id/anexos', express.raw({ type: () => true, limit: MAX_ANEXO + 1024 }), async (req, res) => {
    const linha = estado.linhas[req.params.id];
    if (!ID_RE.test(req.params.id) || !linha) return res.status(404).json({ erro: 'Linha não encontrada.' });
    const corpo = req.body;
    if (!Buffer.isBuffer(corpo) || corpo.length === 0) return res.status(400).json({ erro: 'Arquivo vazio.' });
    if (corpo.length > MAX_ANEXO) return res.status(413).json({ erro: 'Arquivo grande demais (limite de 40 MB).' });
    if ((linha.anexos || []).length >= MAX_ANEXOS_LINHA) return res.status(400).json({ erro: 'Limite de ' + MAX_ANEXOS_LINHA + ' arquivos por pagamento.' });
    let nome = 'arquivo';
    try { nome = nomeSeguro(decodeURIComponent(String(req.headers['x-nome'] || ''))); } catch (e) { nome = nomeSeguro(req.headers['x-nome']); }
    const anexo = { id: 'a' + crypto.randomBytes(9).toString('base64url'), nome, tipo: tipoSeguro(req.headers['content-type'], nome), tamanho: corpo.length, criado: Date.now() };
    await armazenamento.guardarArquivo(anexo.id, corpo);
    const atual = estado.linhas[req.params.id];
    if (!atual) { armazenamento.apagarArquivo(anexo.id).catch(() => {}); return res.status(404).json({ erro: 'A linha foi excluída.' }); }
    atual.anexos = (Array.isArray(atual.anexos) ? atual.anexos : []).concat([anexo]);
    await persistir();
    res.json({ anexo, rev: estado.rev });
  });

  app.delete('/api/linhas/:id/anexos/:aid', async (req, res) => {
    const linha = estado.linhas[req.params.id];
    if (!ID_RE.test(req.params.id) || !ID_RE.test(req.params.aid) || !linha) return res.status(404).json({ erro: 'Não encontrado.' });
    const lista = Array.isArray(linha.anexos) ? linha.anexos : [];
    if (!lista.some((a) => a.id === req.params.aid)) return res.status(404).json({ erro: 'Anexo não encontrado.' });
    linha.anexos = lista.filter((a) => a.id !== req.params.aid);
    if (!linha.anexos.length) delete linha.anexos;
    await persistir();
    armazenamento.apagarArquivo(req.params.aid).catch(() => {});
    res.json({ rev: estado.rev });
  });

  app.get('/api/anexos/:aid', async (req, res) => {
    if (!ID_RE.test(req.params.aid)) return res.status(404).end();
    let meta = null;
    for (const id of Object.keys(estado.linhas)) {
      const a = (estado.linhas[id].anexos || []).find((x) => x.id === req.params.aid);
      if (a) { meta = a; break; }
    }
    if (!meta) return res.status(404).type('text').send('Não encontrado.');
    const tam = meta.tamanho;
    let ini = 0, fim = tam - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1] === '') { ini = Math.max(0, tam - Number(m[2])); }
      else { ini = Number(m[1]); if (m[2] !== '') fim = Math.min(fim, Number(m[2])); }
      if (ini > fim || ini >= tam) { res.setHeader('Content-Range', 'bytes */' + tam); return res.status(416).end(); }
      status = 206;
    }
    const dados = await armazenamento.lerArquivo(meta.id, ini, fim - ini + 1);
    if (!dados) return res.status(404).type('text').send('Arquivo não encontrado.');
    const direto = ABRE_DIRETO.test(meta.tipo) && req.query.baixar !== '1';
    res.status(status);
    if (status === 206) res.setHeader('Content-Range', 'bytes ' + ini + '-' + fim + '/' + tam);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', direto ? (meta.tipo === 'text/plain' ? 'text/plain; charset=utf-8' : meta.tipo) : 'application/octet-stream');
    res.setHeader('Content-Length', dados.length);
    res.setHeader('Content-Disposition', (direto ? 'inline' : 'attachment') + "; filename=\"" + meta.nome.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') + "\"; filename*=UTF-8''" + encodeURIComponent(meta.nome));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (direto && !/^text\//.test(meta.tipo)) res.removeHeader('Content-Security-Policy');   // o leitor de PDF/vídeo do navegador precisa disso
    else res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(dados);
  });

  /* relatório em PDF (só com sessão aberta, como o resto de /api) */
  const { gerarRelatorio, addMes } = require('./relatorio');
  app.get('/api/relatorio.pdf', async (req, res) => {
    let de = String(req.query.de || ''), ate = String(req.query.ate || '');
    if (!MES_RE.test(de) || !MES_RE.test(ate)) return res.status(400).type('text').send('Período inválido.');
    if (de > ate) [de, ate] = [ate, de];
    let n = 1, m = de;
    while (m < ate && n < 60) { m = addMes(m, 1); n++; }
    if (n > 36) return res.status(400).type('text').send('Escolha no máximo 36 meses.');
    const baixar = req.query.baixar === '1';
    const nome = 'Relatorio-Gastos-da-Casa-' + (de === ate ? de : de + '_a_' + ate) + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', (baixar ? 'attachment' : 'inline') + '; filename="' + nome + '"');
    res.setHeader('Cache-Control', 'no-store');
    res.removeHeader('Content-Security-Policy');   // o leitor de PDF do navegador precisa disso
    try {
      await gerarRelatorio({
        estado: JSON.parse(JSON.stringify(estado)), de, ate,
        detalhes: req.query.detalhes !== '0', comprovantes: req.query.comp === '1',
        lerArquivo: (id, ini, len) => armazenamento.lerArquivo(id, ini, len), geradoEm: new Date()
      }, res);
    } catch (e) {
      console.error('Falha no relatório:', e);
      if (!res.headersSent) res.status(500).type('text').send('Não foi possível gerar o relatório.');
      else res.destroy();
    }
  });

  app.use('/api', api);

  app.use((req, res) => res.status(404).type('text').send('Não encontrado.'));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo grande demais (limite de 40 MB).' });
    console.error(err);
    res.status(500).json({ erro: 'Erro interno.' });
  });

  app.listen(PORT, () => console.log('Gastos da Casa rodando na porta ' + PORT + ' | dados: ' + armazenamento.tipo));
}

iniciar().catch((e) => {
  console.error('Não foi possível iniciar:', e);
  process.exit(1);
});
