'use strict';
// Relatório em PDF dos gastos: resumo, gráficos, tabelas de custos fixos e variáveis (com lançamentos),
// parcelas em andamento e anexos/comprovantes. Tudo calculado em centavos (inteiros).

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const FONTES = path.join(__dirname, 'fonts');
const FOTO = path.join(__dirname, 'public', 'casal.jpg');

const C = {
  dark: '#080C09', ink: '#0B120C', lime: '#C6FF1A', limeDk: '#5E8F00', limeSoft: '#EEF9C9',
  pink: '#E5248B', pinkSoft: '#FCE4F1', muted: '#5C6B61', dim: '#8A978E', line: '#DDE4DE', soft: '#F4F7F4',
  amber: '#B7791F', amberSoft: '#FBF1DC', green: '#1E9E4A', coral: '#D64550', white: '#FFFFFF'
};
const W = 595.28, H = 841.89, ML = 40, MR = 40, CW = W - ML - MR, TOP = 52, BOT = 56;

/* ---------- utilidades ---------- */
function milhar(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function brl(c) { const a = Math.abs(c); return (c < 0 ? '−' : '') + 'R$ ' + milhar(Math.floor(a / 100)) + ',' + String(a % 100).padStart(2, '0'); }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }
function mesNome(m) { return MESES[+m.slice(5, 7) - 1] + ' de ' + m.slice(0, 4); }
function mesAbrev(m) { return MESES[+m.slice(5, 7) - 1].slice(0, 3); }
function dataBR(iso) { return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : ''; }
function dataHora(ms) { const d = new Date(ms || 0); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function addMes(key, n) {
  let y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + String(m + 1).padStart(2, '0');
}
function difMes(a, b) { return (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7)); }
function tamanhoTxt(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toFixed(b < 10485760 ? 1 : 0).replace('.', ',') + ' MB';
}
function caber(doc, txt, larg) {
  txt = String(txt || '');
  if (doc.widthOfString(txt) <= larg) return txt;
  while (txt.length > 1 && doc.widthOfString(txt + '…') > larg) txt = txt.slice(0, -1);
  return txt.trimEnd() + '…';
}

function curto(c) {
  const r = c / 100;
  if (r >= 1000) return (r / 1000).toFixed(1).replace('.', ',').replace(',0', '') + ' mil';
  return String(Math.round(r));
}

/* parcelas: o período vem do nome, ex.: "Parcela cirurgia - Agosto/26 até Dezembro/26" (mesma regra do app) */
const MESES3 = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
function fimParcela(nome) {
  const txt = String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const re = /([a-z]{3,9})\.?\s*\/\s*(\d{4}|\d{2})\b/g;
  const achados = [];
  let m;
  while ((m = re.exec(txt))) {
    const n = MESES3[m[1].slice(0, 3)];
    if (!n) continue;
    let ano = +m[2]; if (ano < 100) ano += 2000;
    achados.push(ano + '-' + String(n).padStart(2, '0'));
  }
  if (achados.length < 2) return null;
  const ini = achados[0], fim = achados[achados.length - 1];
  if (fim < ini) return null;
  const rotulo = String(nome).replace(/\([^)]*\)/g, '').split(/\s[-–]\s/)[0].replace(/\s+/g, ' ').trim() || String(nome);
  return { ini, fim, rotulo };
}

function calcMes(estado, m) {
  const linhas = Object.keys(estado.linhas).map((id) => Object.assign({ id }, estado.linhas[id]))
    .filter((l) => l.mes === m).sort((a, b) => (a.criado || 0) - (b.criado || 0));
  const soma = (a) => a.reduce((t, l) => t + (l.valorCentavos || 0), 0);
  const fixos = linhas.filter((l) => l.grupo === 'fixo'), vars = linhas.filter((l) => l.grupo === 'variavel');
  const pagos = (a) => soma(a.filter((l) => l.pago));
  const prev = soma(linhas), pago = pagos(linhas), renda = estado.renda || 0;
  return {
    m, linhas, fixos, vars, tem: linhas.length > 0, renda,
    fixosTot: soma(fixos), varsTot: soma(vars), fixosPago: pagos(fixos), varsPago: pagos(vars),
    prev, pago, aPagar: prev - pago, disponivel: renda - pago
  };
}

function parcelasDoMes(dm) {
  const out = [];
  dm.linhas.forEach((l) => {
    const f = fimParcela(l.nome); if (!f) return;
    const n = difMes(f.ini, dm.m) + 1, total = difMes(f.ini, f.fim) + 1, falta = difMes(dm.m, f.fim);
    if (n < 1 || falta < 0) return;
    out.push({ l, f, n, total, falta });
  });
  return out;
}

/* imagens anexadas (PNG/JPEG) para a seção de comprovantes */
async function carregarImagens(estado, meses, lerArquivo) {
  const mapa = {};
  let usado = 0;
  const LIM_UM = 8 * 1048576, LIM_TOTAL = 70 * 1048576;
  for (const m of meses) {
    const linhas = Object.keys(estado.linhas).map((id) => Object.assign({ id }, estado.linhas[id])).filter((l) => l.mes === m);
    for (const l of linhas) {
      for (const a of (l.anexos || [])) {
        if (!/^image\/(png|jpe?g)$/.test(a.tipo || '')) continue;
        if (a.tamanho > LIM_UM || usado + a.tamanho > LIM_TOTAL) continue;
        const buf = await lerArquivo(a.id, 0, a.tamanho);
        if (!buf || !buf.length) continue;
        const png = buf[0] === 0x89 && buf[1] === 0x50, jpg = buf[0] === 0xff && buf[1] === 0xd8;
        if (!png && !jpg) continue;
        mapa[a.id] = buf; usado += buf.length;
      }
    }
  }
  return mapa;
}

/* ---------- gerador ---------- */
async function gerarRelatorio(op, saida) {
  const { estado, de, ate, detalhes, comprovantes, lerArquivo, geradoEm } = op;
  const meses = [];
  for (let m = de; m <= ate && meses.length < 36; m = addMes(m, 1)) meses.push(m);
  const multi = meses.length > 1;
  const temMes = (m) => Object.keys(estado.linhas).some((id) => estado.linhas[id].mes === m);
  const ativos = meses.filter(temMes);
  const ativosOuTodos = ativos.length ? ativos : meses;
  const iA = ativos.length ? meses.indexOf(ativos[0]) : 0, fA = ativos.length ? meses.indexOf(ativos[ativos.length - 1]) : meses.length - 1;
  const faixa = meses.slice(iA, fA + 1);
  const dados = {};
  meses.concat([addMes(de, -1)]).forEach((m) => { dados[m] = calcMes(estado, m); });
  const imagens = comprovantes && lerArquivo ? await carregarImagens(estado, meses, lerArquivo) : {};
  const periodoTxt = multi ? mesNome(meses[0]) + ' a ' + mesNome(meses[meses.length - 1]) : mesNome(meses[0]);
  const renda = estado.renda || 0;

  const doc = new PDFDocument({
    size: 'A4', margins: { top: TOP, bottom: BOT, left: ML, right: MR }, bufferPages: true,
    info: { Title: 'Gastos da Casa — ' + periodoTxt, Author: 'Gastos da Casa', Subject: 'Relatório de gastos', CreationDate: geradoEm || new Date() }
  });
  doc.pipe(saida);
  doc.registerFont('M4', path.join(FONTES, 'manrope-latin-400-normal.woff'));
  doc.registerFont('M6', path.join(FONTES, 'manrope-latin-600-normal.woff'));
  doc.registerFont('M7', path.join(FONTES, 'manrope-latin-700-normal.woff'));
  doc.registerFont('M8', path.join(FONTES, 'manrope-latin-800-normal.woff'));
  doc.registerFont('U5', path.join(FONTES, 'unbounded-latin-500-normal.woff'));
  doc.registerFont('U7', path.join(FONTES, 'unbounded-latin-700-normal.woff'));

  let y = 0;

  /* ---- elementos de página ---- */
  function chrome() {
    doc.save();
    doc.rect(0, 0, W, 28).fill(C.dark);
    doc.rect(0, 28, W, 2).fill(C.lime);
    doc.font('U7').fontSize(7).fillColor(C.lime).text('GASTOS DA CASA', ML, 10.5, { characterSpacing: 1.6, lineBreak: false });
    doc.font('M6').fontSize(8).fillColor('#9FB3A4').text('Relatório · ' + periodoTxt, ML, 10.5, { width: CW, align: 'right', lineBreak: false });
    doc.restore();
  }
  function novaPagina() { doc.addPage(); chrome(); y = TOP; }
  function garantir(h) { if (y + h > H - BOT) { novaPagina(); return true; } return false; }

  function capa() {
    const h = 138;
    doc.rect(0, 0, W, h).fill(C.dark);
    doc.rect(0, h, W, 4).fill(C.lime);
    doc.font('U7').fontSize(7.5).fillColor(C.lime).text('GASTOS DA CASA', ML, 34, { characterSpacing: 2, lineBreak: false });
    doc.font('U7').fontSize(24).fillColor(C.white).text('Relatório de gastos', ML, 52, { width: CW - 110, lineBreak: false });
    doc.rect(ML, 88, 46, 4).fill(C.lime);
    doc.font('M7').fontSize(12.5).fillColor(C.lime).text(periodoTxt, ML, 102, { width: CW - 110, lineBreak: false });
    doc.font('M4').fontSize(8).fillColor('#9FB3A4').text('Gerado em ' + dataHora((geradoEm || new Date()).getTime()), ML, 121, { width: CW - 110, lineBreak: false });
    try {
      const s = 86, fx = W - MR - s, fy = 26;
      doc.save(); doc.roundedRect(fx, fy, s, s, 14).clip(); doc.image(FOTO, fx, fy, { cover: [s, s], align: 'center', valign: 'center' }); doc.restore();
      doc.save(); doc.roundedRect(fx, fy, s, s, 14).lineWidth(1.2).stroke(C.lime); doc.restore();
    } catch (e) { /* sem foto: segue */ }
    y = h + 26;
  }

  function titulo(txt, direita, cor) {
    garantir(40);
    doc.rect(ML, y + 1, 5, 14).fill(cor || C.lime);
    doc.font('U5').fontSize(10.5).fillColor(C.ink).text(txt, ML + 13, y + 2, { lineBreak: false });
    if (direita) doc.font('M6').fontSize(8.5).fillColor(C.muted).text(direita, ML, y + 4, { width: CW, align: 'right', lineBreak: false });
    y += 26;
  }

  function ajustarFonte(fonte, txt, larg, max, min) {
    let s = max;
    doc.font(fonte);
    while (s > min && doc.fontSize(s).widthOfString(txt) > larg) s -= 0.5;
    return s;
  }
  function cartao(x, yy, w, h, rotulo, valor, sub, estilo) {
    const destaque = estilo === 'lime', cor = destaque ? C.ink : C.ink;
    doc.save();
    doc.roundedRect(x, yy, w, h, 9).fill(destaque ? C.lime : C.soft);
    if (!destaque) doc.roundedRect(x + 0.5, yy + 0.5, w - 1, h - 1, 9).lineWidth(0.8).stroke(C.line);
    doc.restore();
    doc.font('M7').fontSize(6.8).fillColor(destaque ? '#26340A' : C.muted).text(String(rotulo).toUpperCase(), x + 11, yy + 10, { width: w - 20, characterSpacing: 0.9, lineBreak: false });
    const fs = ajustarFonte('M8', valor, w - 22, 15, 8);
    doc.font('M8').fontSize(fs).fillColor(estilo === 'coral' ? C.coral : cor).text(valor, x + 11, yy + 24, { width: w - 20, lineBreak: false });
    if (sub) doc.font('M4').fontSize(7.4).fillColor(destaque ? '#26340A' : C.muted).text(caber(doc, sub, w - 20), x + 11, yy + 24 + 17, { width: w - 20 + 4, lineBreak: false });
  }

  function iconePago(cx, cy, pago) {
    doc.save();
    if (pago) {
      doc.circle(cx, cy, 5.2).fill(C.green);
      doc.moveTo(cx - 2.4, cy + 0.1).lineTo(cx - 0.5, cy + 2).lineTo(cx + 2.7, cy - 1.9).lineWidth(1.4).lineCap('round').lineJoin('round').stroke(C.white);
    } else {
      doc.circle(cx, cy, 4.7).lineWidth(1.4).stroke('#E0A21B');
    }
    doc.restore();
  }
  function iconeClipe(cx, cy) {
    doc.save().lineWidth(1).strokeColor(C.muted).lineCap('round').lineJoin('round');
    doc.moveTo(cx + 3.4, cy - 0.6).lineTo(cx - 0.6, cy + 3.4).bezierCurveTo(cx - 2.4, cy + 4.6, cx - 4.6, cy + 2.4, cx - 3.4, cy + 0.6).lineTo(cx + 0.9, cy - 3.8).bezierCurveTo(cx + 2.4, cy - 5, cx + 4.8, cy - 2.6, cx + 3.4, cy - 1.2).stroke();
    doc.restore();
  }

  /* ---- bloco: resumo do mês ---- */
  function resumoMes(dm) {
    const gap = 10, w4 = (CW - 3 * gap) / 4;
    garantir(80);
    cartao(ML, y, w4, 66, 'Salário', renda > 0 ? brl(renda) : '—', 'recebimento mensal');
    cartao(ML + (w4 + gap), y, w4, 66, 'Lançado no mês', brl(dm.prev), dm.linhas.length + (dm.linhas.length === 1 ? ' linha' : ' linhas'));
    cartao(ML + 2 * (w4 + gap), y, w4, 66, 'Pago (ticado)', brl(dm.pago), renda > 0 ? pct(dm.pago, renda) + '% do salário' : '');
    cartao(ML + 3 * (w4 + gap), y, w4, 66, 'Disponível no mês', renda > 0 ? brl(dm.disponivel) : '—', 'salário − pago', 'lime');
    y += 66 + gap;
    const w3 = (CW - 2 * gap) / 3;
    cartao(ML, y, w3, 58, 'Ainda a pagar', brl(dm.aPagar), 'lançado e não ticado');
    cartao(ML + (w3 + gap), y, w3, 58, 'Fixos pagos', brl(dm.fixosPago), 'de ' + brl(dm.fixosTot) + ' lançados');
    cartao(ML + 2 * (w3 + gap), y, w3, 58, 'Variáveis pagos', brl(dm.varsPago), 'de ' + brl(dm.varsTot) + ' lançados');
    y += 58 + 16;

    if (renda > 0) {
      garantir(54);
      doc.font('M7').fontSize(7.5).fillColor(C.muted).text('COMPROMETIMENTO DO SALÁRIO', ML, y, { characterSpacing: 0.9, lineBreak: false });
      y += 14;
      const bw = CW, bh = 12;
      doc.save(); doc.roundedRect(ML, y, bw, bh, 6).clip();
      doc.rect(ML, y, bw, bh).fill('#E7ECE8');
      const wPago = Math.min(bw, bw * dm.pago / renda), wPrev = Math.min(bw, bw * dm.prev / renda);
      doc.rect(ML, y, wPrev, bh).fill('#F0C766');
      doc.rect(ML, y, wPago, bh).fill(C.limeDk);
      doc.restore();
      y += bh + 8;
      const leg = [[C.limeDk, 'Pago ' + pct(dm.pago, renda) + '%'], ['#F0C766', 'A pagar ' + pct(dm.aPagar, renda) + '%'], ['#E7ECE8', 'Livre ' + Math.max(0, 100 - pct(dm.prev, renda)) + '%']];
      let lx = ML;
      leg.forEach((p) => {
        doc.rect(lx, y + 1.5, 8, 8).fill(p[0]);
        doc.font('M6').fontSize(8).fillColor(C.ink).text(p[1], lx + 12, y + 1, { lineBreak: false });
        lx += 12 + doc.widthOfString(p[1]) + 18;
      });
      if (dm.prev > renda) doc.font('M7').fontSize(8).fillColor(C.coral).text('Lançamentos acima do salário em ' + brl(dm.prev - renda), ML, y + 1, { width: CW, align: 'right', lineBreak: false });
      y += 22;
    }

    const ant = dados[addMes(dm.m, -1)];
    if (ant && ant.tem) {
      const d = dm.prev - ant.prev;
      const txt = (d === 0 ? 'Igual ao total lançado em ' : (d > 0 ? '↑ ' : '↓ ') + brl(Math.abs(d)) + (ant.prev > 0 ? ' (' + (d > 0 ? '+' : '−') + (Math.abs(d) / ant.prev * 100).toFixed(1).replace('.', ',') + '%)' : '') + ' em relação ao total lançado em ') + mesNome(ant.m) + ' (' + brl(ant.prev) + ').';
      garantir(26);
      doc.roundedRect(ML, y, CW, 22, 7).fill(C.soft);
      doc.font('M6').fontSize(8.5).fillColor(d > 0 ? C.coral : (d < 0 ? C.green : C.muted)).text(txt, ML + 12, y + 7, { width: CW - 24, lineBreak: false });
      y += 22 + 14;
    }
  }

  function parcelasBloco(dm) {
    const ps = parcelasDoMes(dm); if (!ps.length) return;
    titulo('Parcelas em andamento', ps.length + (ps.length === 1 ? ' parcelamento' : ' parcelamentos'), '#E0A21B');
    ps.forEach((p) => {
      const ult = p.falta === 0;
      const linha1 = p.f.rotulo + (p.l.valorCentavos > 0 ? '  ·  ' + brl(p.l.valorCentavos) : '');
      const linha2 = (ult ? 'Última parcela (' + p.n + ' de ' + p.total + '). Depois dela o gasto termina.' : 'Parcela ' + p.n + ' de ' + p.total + '. Faltam ' + (p.falta + 1) + ' contando esta; a última é em ' + mesNome(p.f.fim) + '.');
      garantir(40);
      doc.roundedRect(ML, y, CW, 36, 8).fill(C.amberSoft);
      doc.rect(ML, y, 4, 36).fill('#E0A21B');
      doc.font('M7').fontSize(9.5).fillColor(C.ink).text(caber(doc, linha1, CW - 28), ML + 14, y + 7, { width: CW - 28 + 4, lineBreak: false });
      doc.font('M4').fontSize(8.5).fillColor(C.amber).text(caber(doc, linha2, CW - 28), ML + 14, y + 21, { width: CW - 28 + 4, lineBreak: false });
      y += 36 + 6;
    });
    y += 8;
  }

  /* ---- tabela de linhas (fixos / variáveis) ---- */
  const XI = ML, XN = ML + 28, WV = 80, WP = 66, WA = 40;
  const XV = ML + CW - WV - WP - WA, XP = ML + CW - WP - WA, XA = ML + CW - WA;
  const WN = XV - XN - 8;
  function cabecalhoColunas() {
    doc.rect(ML, y, CW, 20).fill('#E9EFEA');
    doc.font('M7').fontSize(6.8).fillColor(C.muted);
    doc.text('CONTA', XN, y + 7, { characterSpacing: 0.9, lineBreak: false });
    doc.text('VALOR', XV, y + 7, { width: WV - 8, align: 'right', characterSpacing: 0.9, lineBreak: false });
    doc.text('PAGO EM', XP, y + 7, { width: WP, align: 'center', characterSpacing: 0.9, lineBreak: false });
    doc.text('ANEXOS', XA - 4, y + 7, { width: WA, align: 'center', characterSpacing: 0.9, lineBreak: false });
    y += 20;
  }
  function tabelaLinhas(dm, grupo, itens, rotulo, cor) {
    const lista = itens;
    const tot = grupo === 'fixo' ? dm.fixosTot : dm.varsTot, pg = grupo === 'fixo' ? dm.fixosPago : dm.varsPago;
    garantir(26 + 20 + 60);   // título nunca fica sozinho no fim da página
    titulo(rotulo, lista.length ? 'Pago ' + brl(pg) + '  ·  A pagar ' + brl(tot - pg) : '', cor);
    if (!lista.length) {
      doc.font('M4').fontSize(9).fillColor(C.muted).text('Nenhuma linha neste mês.', ML, y - 6, { lineBreak: false });
      y += 18; return;
    }
    garantir(20 + 34); cabecalhoColunas();
    lista.forEach((l, i) => {
      const subs = [];
      if (l.fixa === true) subs.push('Valor fixo');
      const par = fimParcela(l.nome);
      if (par) { const n = difMes(par.ini, dm.m) + 1, tt = difMes(par.ini, par.fim) + 1; if (n >= 1 && n <= tt) subs.push('Parcela ' + n + ' de ' + tt); }
      const its = Array.isArray(l.itens) ? l.itens : [];
      if (its.length) subs.push(its.length + (its.length === 1 ? ' lançamento' : ' lançamentos'));
      const nomeH = doc.font('M7').fontSize(9.5).heightOfString(l.nome || '', { width: WN });
      const subTxt = subs.join('  ·  ');
      const h = Math.max(26, 9 + nomeH + (subTxt ? 11 : 0) + 6);
      const manter = Math.min(its.length, 8) * 16 + (i === lista.length - 1 ? 30 : 0);   // lançamentos ficam junto da linha; total não fica sozinho
      if (garantir(h + 4 + manter)) cabecalhoColunas();
      if (i % 2 === 1) doc.rect(ML, y, CW, h).fill('#FAFBFA');
      iconePago(XI + 13, y + 14, !!l.pago);
      doc.font('M7').fontSize(9.5).fillColor(C.ink).text(l.nome || '', XN, y + 8, { width: WN });
      if (subTxt) doc.font('M6').fontSize(7.6).fillColor(C.muted).text(subTxt, XN, y + 8 + nomeH + 1.5, { width: WN, lineBreak: false });
      doc.font('M8').fontSize(9.5).fillColor(l.pago ? C.ink : C.ink).text(brl(l.valorCentavos || 0), XV, y + 8, { width: WV - 8, align: 'right', lineBreak: false });
      doc.font('M6').fontSize(8.5).fillColor(l.pago ? C.green : C.amber).text(l.pago ? (dataBR(l.pagoEm) || 'Pago') : 'Pendente', XP, y + 9, { width: WP, align: 'center', lineBreak: false });
      const na = (l.anexos || []).length;
      if (na) { iconeClipe(XA + 6, y + 13); doc.font('M7').fontSize(8.5).fillColor(C.muted).text(String(na), XA + 12, y + 9, { lineBreak: false }); }
      y += h;
      doc.moveTo(ML, y).lineTo(ML + CW, y).lineWidth(0.5).stroke(C.line);
      if (its.length) {
        const ord = its.map((x, k) => ({ x, k })).sort((a, b) => (a.x.data < b.x.data ? -1 : a.x.data > b.x.data ? 1 : a.k - b.k)).map((o) => o.x);
        ord.forEach((it, k) => {
          const nota = it.nota || '—';
          const hn = Math.max(15, doc.font('M4').fontSize(8.2).heightOfString(nota, { width: WN - 70 }) + 7);
          if (garantir(hn + 2)) cabecalhoColunas();
          doc.rect(XN - 4, y, 1.6, hn).fill(C.pink);
          doc.font('M6').fontSize(8.2).fillColor(C.muted).text(dataBR(it.data), XN + 6, y + 4, { width: 58, lineBreak: false });
          doc.font('M4').fontSize(8.2).fillColor(C.ink).text(nota, XN + 70, y + 4, { width: WN - 70 });
          doc.font('M6').fontSize(8.2).fillColor(C.ink).text(brl(it.valorCentavos || 0), XV, y + 4, { width: WV - 8, align: 'right', lineBreak: false });
          y += hn;
        });
        doc.moveTo(ML, y).lineTo(ML + CW, y).lineWidth(0.5).stroke(C.line);
      }
    });
    garantir(30);
    doc.rect(ML, y, CW, 24).fill(grupo === 'fixo' ? C.limeSoft : C.pinkSoft);
    doc.font('M7').fontSize(8.5).fillColor(C.ink).text('Total · ' + rotulo.toLowerCase(), XN, y + 8, { lineBreak: false });
    doc.font('M8').fontSize(10).fillColor(C.ink).text(brl(tot), XV, y + 7, { width: WV - 8, align: 'right', lineBreak: false });
    doc.font('M6').fontSize(7.8).fillColor(C.muted).text('pago ' + brl(pg), XP - 22, y + 8.5, { width: WP + WA + 14, align: 'right', lineBreak: false });
    y += 24 + 20;
  }

  /* ---- maiores gastos do mês (barras horizontais) ---- */
  function maioresGastos(dm) {
    const top = dm.linhas.filter((l) => (l.valorCentavos || 0) > 0).sort((a, b) => b.valorCentavos - a.valorCentavos).slice(0, 7);
    if (!top.length) return;
    titulo('Maiores gastos do mês', 'participação no total lançado', C.limeDk);
    const max = top[0].valorCentavos, lw = 170, vw = 120, bx = ML + lw + 8, bw = CW - lw - vw - 16;
    top.forEach((l) => {
      garantir(22);
      doc.font('M6').fontSize(8.6).fillColor(C.ink).text(caber(doc, l.nome, lw), ML, y + 3, { width: lw + 4, lineBreak: false });
      doc.roundedRect(bx, y + 3, bw, 9, 4.5).fill('#E9EFEA');
      doc.roundedRect(bx, y + 3, Math.max(4, bw * l.valorCentavos / max), 9, 4.5).fill(l.grupo === 'fixo' ? C.limeDk : C.pink);
      doc.font('M7').fontSize(8.6).fillColor(C.ink).text(brl(l.valorCentavos) + '  ' + pct(l.valorCentavos, dm.prev) + '%', bx + bw + 8, y + 3, { width: vw, align: 'right', lineBreak: false });
      y += 19;
    });
    doc.rect(ML, y + 4, 8, 8).fill(C.limeDk); doc.font('M6').fontSize(7.6).fillColor(C.muted).text('Fixos', ML + 12, y + 4.5, { lineBreak: false });
    doc.rect(ML + 56, y + 4, 8, 8).fill(C.pink); doc.font('M6').fontSize(7.6).fillColor(C.muted).text('Variáveis', ML + 68, y + 4.5, { lineBreak: false });
    y += 28;
  }

  /* ---- anexos e comprovantes ---- */
  function anexosBloco(dm) {
    const pares = [];
    dm.linhas.forEach((l) => (l.anexos || []).forEach((a) => pares.push({ l, a })));
    if (!pares.length) return;
    titulo('Anexos e comprovantes', pares.length + (pares.length === 1 ? ' arquivo' : ' arquivos'), '#8A978E');
    garantir(40);
    doc.rect(ML, y, CW, 20).fill('#E9EFEA');
    doc.font('M7').fontSize(6.8).fillColor(C.muted);
    doc.text('PAGAMENTO', ML + 10, y + 7, { characterSpacing: 0.9, lineBreak: false });
    doc.text('ARQUIVO', ML + 175, y + 7, { characterSpacing: 0.9, lineBreak: false });
    doc.text('TAMANHO', ML + CW - 160, y + 7, { characterSpacing: 0.9, lineBreak: false });
    doc.text('ANEXADO EM', ML + CW - 88, y + 7, { characterSpacing: 0.9, lineBreak: false });
    y += 20;
    pares.forEach(({ l, a }, i) => {
      const hn = Math.max(22, doc.font('M6').fontSize(8.4).heightOfString(a.nome || '', { width: CW - 175 - 170 }) + 12);
      if (garantir(hn + 2)) { /* sem repetir cabeçalho: tabela curta */ }
      if (i % 2 === 1) doc.rect(ML, y, CW, hn).fill('#FAFBFA');
      doc.font('M6').fontSize(8.4).fillColor(C.ink).text(caber(doc, l.nome || '', 158), ML + 10, y + 6, { width: 158 + 4, lineBreak: false });
      doc.font('M4').fontSize(8.4).fillColor(C.ink).text(a.nome || '', ML + 175, y + 6, { width: CW - 175 - 170 });
      doc.font('M4').fontSize(8.4).fillColor(C.muted).text(tamanhoTxt(a.tamanho || 0), ML + CW - 160, y + 6, { width: 66, lineBreak: false });
      doc.font('M4').fontSize(8.4).fillColor(C.muted).text(dataHora(a.criado), ML + CW - 88, y + 6, { width: 90, lineBreak: false });
      y += hn;
      doc.moveTo(ML, y).lineTo(ML + CW, y).lineWidth(0.5).stroke(C.line);
    });
    y += 20;

    const imgs = pares.filter((p) => imagens[p.a.id]);
    if (imgs.length) {
      garantir(40 + 150);
      titulo('Comprovantes (imagens anexadas)', imgs.length + (imgs.length === 1 ? ' imagem' : ' imagens'), '#8A978E');
      const cw = (CW - 14) / 2, maxH = 250;
      for (let k = 0; k < imgs.length; k += 2) {
        const par = imgs.slice(k, k + 2), medidas = [];
        par.forEach((p) => {
          try {
            const im = doc.openImage(imagens[p.a.id]);
            const esc = Math.min(cw / im.width, maxH / im.height, 1);
            medidas.push({ w: im.width * esc, h: im.height * esc, ok: true });
          } catch (e) { medidas.push({ w: 0, h: 0, ok: false }); }
        });
        const rowH = Math.max.apply(null, medidas.map((m) => m.h)) + 34;
        garantir(rowH + 6);
        par.forEach((p, j) => {
          const x = ML + j * (cw + 14), md = medidas[j];
          if (!md.ok) return;
          doc.save(); doc.roundedRect(x, y, cw, md.h + 28, 8).lineWidth(0.8).stroke(C.line); doc.restore();
          doc.font('M7').fontSize(8).fillColor(C.ink).text(caber(doc, (p.l.nome || '') + ' · ' + (p.a.nome || ''), cw - 16), x + 8, y + 7, { width: cw - 12, lineBreak: false });
          try { doc.image(imagens[p.a.id], x + (cw - md.w) / 2, y + 22, { width: md.w, height: md.h }); } catch (e) { /* imagem inválida */ }
        });
        y += rowH;
      }
    }
  }

  /* ---- seção completa de um mês ---- */
  function secaoMes(dm, comCapa) {
    if (!comCapa) {
      doc.rect(ML, y, CW, 34).fill(C.dark);
      doc.rect(ML, y + 34, CW, 3).fill(C.lime);
      doc.font('U7').fontSize(14).fillColor(C.white).text(mesNome(dm.m), ML + 16, y + 10, { lineBreak: false });
      y += 34 + 3 + 16;
    }
    if (!dm.tem) {
      doc.roundedRect(ML, y, CW, 50, 9).fill(C.soft);
      doc.font('M6').fontSize(10).fillColor(C.muted).text('Sem lançamentos neste mês.', ML, y + 19, { width: CW, align: 'center', lineBreak: false });
      y += 66; return;
    }
    resumoMes(dm);
    parcelasBloco(dm);
    tabelaLinhas(dm, 'fixo', dm.fixos, 'Custos fixos', C.limeDk);
    tabelaLinhas(dm, 'variavel', dm.vars, 'Custos variáveis', C.pink);
    maioresGastos(dm);
    anexosBloco(dm);
  }

  /* ---- visão de vários meses ---- */
  function graficoMeses() {
    const alt = 105, n = faixa.length;
    titulo('Evolução mês a mês', 'fixos e variáveis lançados', C.limeDk);
    garantir(alt + 60);
    const base = y + alt, bw = Math.min(34, (CW - 20) / n * 0.62), passo = (CW - 20) / n;
    const maxv = Math.max.apply(null, faixa.map((m) => dados[m].prev).concat([renda, 1]));
    doc.moveTo(ML, base).lineTo(ML + CW, base).lineWidth(0.8).stroke(C.line);
    [0.5, 1].forEach((f) => { const yy = base - alt * 0.86 * f; doc.moveTo(ML, yy).lineTo(ML + CW, yy).lineWidth(0.4).dash(2, { space: 3 }).stroke('#E3E9E4').undash(); doc.font('M4').fontSize(6.8).fillColor(C.dim).text(curto(maxv * f), ML, yy - 9, { lineBreak: false }); });
    faixa.forEach((m, i) => {
      const d = dados[m], cx = ML + 10 + passo * i + passo / 2, x = cx - bw / 2;
      const hf = alt * 0.86 * d.fixosTot / maxv, hv = alt * 0.86 * d.varsTot / maxv;
      if (hf > 0) doc.rect(x, base - hf, bw, hf).fill(C.limeDk);
      if (hv > 0) doc.rect(x, base - hf - hv, bw, hv).fill(C.pink);
      if (d.prev > 0 && passo >= 40) doc.font('M7').fontSize(7).fillColor(C.ink).text(curto(d.prev), cx - 22, base - hf - hv - 10, { width: 44, align: 'center', lineBreak: false });
      if (i % Math.max(1, Math.ceil(34 / passo)) === 0) doc.font('M6').fontSize(7.6).fillColor(C.muted).text(mesAbrev(m) + (n > 12 || m.slice(5) === '01' ? ' ' + m.slice(2, 4) : ''), cx - 22, base + 5, { width: 44, align: 'center', lineBreak: false });
    });
    if (renda > 0) {
      const yr = base - alt * 0.86 * renda / maxv;
      doc.moveTo(ML, yr).lineTo(ML + CW, yr).lineWidth(1).dash(4, { space: 3 }).stroke(C.ink).undash();
    }
    y = base + 22;
    let lx = ML;
    [[C.limeDk, 'Fixos'], [C.pink, 'Variáveis']].forEach((p) => { doc.rect(lx, y + 1, 8, 8).fill(p[0]); doc.font('M6').fontSize(7.8).fillColor(C.muted).text(p[1], lx + 12, y + 0.5, { lineBreak: false }); lx += 70; });
    if (renda > 0) { doc.moveTo(lx, y + 5).lineTo(lx + 16, y + 5).lineWidth(1).dash(3, { space: 2 }).stroke(C.ink).undash(); doc.font('M6').fontSize(7.8).fillColor(C.muted).text('Salário', lx + 20, y + 0.5, { lineBreak: false }); }
    y += 28;
  }
  function tabelaMeses() {
    titulo('Resumo por mês', ativosOuTodos.length + ' meses', C.limeDk);
    const cols = [['MÊS', ML + 8, 100, 'left'], ['FIXOS', ML + 100, 70, 'right'], ['VARIÁVEIS', ML + 172, 76, 'right'], ['LANÇADO', ML + 250, 78, 'right'], ['PAGO', ML + 330, 78, 'right'], ['DISPONÍVEL', ML + 410, 105, 'right']];
    const cab = () => { doc.rect(ML, y, CW, 20).fill('#E9EFEA'); doc.font('M7').fontSize(6.8).fillColor(C.muted); cols.forEach((c) => doc.text(c[0], c[1], y + 7, { width: c[2] - 8, align: c[3], characterSpacing: 0.8, lineBreak: false })); y += 20; };
    garantir(60); cab();
    let tF = 0, tV = 0, tP = 0, tG = 0, tD = 0, k = 0;
    ativosOuTodos.forEach((m, i) => {
      const d = dados[m];
      if (garantir(22)) cab();
      if (i % 2 === 1) doc.rect(ML, y, CW, 22).fill('#FAFBFA');
      const vals = [mesNome(m), brl(d.fixosTot), brl(d.varsTot), brl(d.prev), brl(d.pago), renda > 0 ? brl(d.disponivel) : '—'];
      cols.forEach((c, j) => doc.font(j === 0 ? 'M7' : 'M6').fontSize(8.6).fillColor(j === 5 && renda > 0 && d.disponivel < 0 ? C.coral : C.ink).text(vals[j], c[1], y + 7, { width: c[2] - 8, align: c[3], lineBreak: false }));
      y += 22; doc.moveTo(ML, y).lineTo(ML + CW, y).lineWidth(0.5).stroke(C.line);
      tF += d.fixosTot; tV += d.varsTot; tP += d.prev; tG += d.pago; tD += d.disponivel; k++;
    });
    garantir(28);
    doc.rect(ML, y, CW, 26).fill(C.limeSoft);
    const tv = ['TOTAL DO PERÍODO', brl(tF), brl(tV), brl(tP), brl(tG), renda > 0 ? brl(tD) : '—'];
    cols.forEach((c, j) => doc.font('M8').fontSize(j === 0 ? 7.6 : 8.6).fillColor(C.ink).text(tv[j], c[1], y + 9, { width: c[2] - 8 + (j === 0 ? 30 : 0), align: c[3], lineBreak: false }));
    y += 26 + 20;
  }
  function ondeMaisGastou() {
    const agg = {};
    meses.forEach((m) => dados[m].linhas.forEach((l) => {
      const chave = String(l.nome || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const a = agg[chave] || (agg[chave] = { nome: l.nome, total: 0, qtd: 0, grupo: l.grupo });
      a.total += l.valorCentavos || 0; if ((l.valorCentavos || 0) > 0) a.qtd++;
    }));
    const lista = Object.keys(agg).map((k) => agg[k]).filter((a) => a.total > 0).sort((a, b) => b.total - a.total).slice(0, 6);
    if (!lista.length) return;
    const tot = meses.reduce((t, m) => t + dados[m].prev, 0);
    garantir(26 + lista.length * 19 + 40);
    titulo('Onde mais gastou no período', 'soma de todos os meses', C.pink);
    const max = lista[0].total, lw = 190, vw = 140, bx = ML + lw + 8, bw = CW - lw - vw - 16;
    lista.forEach((a) => {
      garantir(22);
      doc.font('M6').fontSize(8.6).fillColor(C.ink).text(caber(doc, a.nome || '', lw), ML, y + 3, { width: lw + 4, lineBreak: false });
      doc.roundedRect(bx, y + 3, bw, 9, 4.5).fill('#E9EFEA');
      doc.roundedRect(bx, y + 3, Math.max(4, bw * a.total / max), 9, 4.5).fill(a.grupo === 'fixo' ? C.limeDk : C.pink);
      doc.font('M7').fontSize(8.6).fillColor(C.ink).text(brl(a.total) + '  ' + pct(a.total, tot) + '%', bx + bw + 8, y + 3, { width: vw, align: 'right', lineBreak: false });
      y += 19;
    });
    y += 14;
  }
  function resumoPeriodo() {
    const lanc = ativosOuTodos.reduce((t, m) => t + dados[m].prev, 0), pago = ativosOuTodos.reduce((t, m) => t + dados[m].pago, 0);
    const comDados = ativosOuTodos.filter((m) => dados[m].tem).length || 1;
    const gap = 10, w4 = (CW - 3 * gap) / 4;
    garantir(80);
    cartao(ML, y, w4, 66, 'Total lançado', brl(lanc), ativosOuTodos.length + ' meses');
    cartao(ML + (w4 + gap), y, w4, 66, 'Total pago', brl(pago), renda > 0 ? pct(pago, renda * ativosOuTodos.length) + '% do salário no período' : '');
    cartao(ML + 2 * (w4 + gap), y, w4, 66, 'Média mensal', brl(Math.round(lanc / comDados)), 'lançado por mês');
    cartao(ML + 3 * (w4 + gap), y, w4, 66, 'Disponível no período', renda > 0 ? brl(renda * ativosOuTodos.length - pago) : '—', 'salário − pago', 'lime');
    y += 66 + 22;
  }

  /* ---- montagem ---- */
  capa();
  if (!multi) {
    secaoMes(dados[meses[0]], true);
  } else {
    resumoPeriodo();
    graficoMeses();
    tabelaMeses();
    ondeMaisGastou();
    if (detalhes) meses.filter((m) => dados[m].tem).forEach((m) => { novaPagina(); secaoMes(dados[m], false); });
  }

  /* ---- rodapé com numeração (depois de saber o total de páginas) ---- */
  const r = doc.bufferedPageRange();
  for (let i = r.start; i < r.start + r.count; i++) {
    doc.switchToPage(i);
    const pg = doc.page, mb = pg.margins.bottom;
    pg.margins.bottom = 0;
    doc.moveTo(ML, H - 40).lineTo(W - MR, H - 40).lineWidth(0.5).stroke(C.line);
    doc.font('M4').fontSize(7.6).fillColor(C.dim).text('Gastos da Casa · documento de uso pessoal · gerado em ' + dataHora((geradoEm || new Date()).getTime()), ML, H - 32, { width: CW - 80, lineBreak: false });
    doc.font('M7').fontSize(7.6).fillColor(C.muted).text('Página ' + (i - r.start + 1) + ' de ' + r.count, W - MR - 80, H - 32, { width: 80, align: 'right', lineBreak: false });
    pg.margins.bottom = mb;
  }
  doc.end();
}

module.exports = { gerarRelatorio, MES_RE: /^\d{4}-(0[1-9]|1[0-2])$/, addMes };
