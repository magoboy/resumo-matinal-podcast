/**
 * RESUMO MATINAL — Júlio  (v3, 2026-09-16 — com podcast)
 * Envia todo dia às 4h (America/Sao_Paulo) um e-mail com:
 *  1) Agenda do dia (Google Calendar)
 *  2) Manchetes do dia (feeds RSS/Atom/RDF)
 *
 * O QUE MUDOU NA v2
 *  - Feed da Agência Brasil trocado (o antigo /rss.xml está congelado em 2020).
 *  - Parser entende RSS 1.0/RDF (formato do gov.br/Ibama) e datas dc:date.
 *  - Notícia mais velha que MAX_IDADE_NOTICIA_HORAS é DESCARTADA (antes só ia pro fim da lista).
 *  - Memória de "já enviado" (PropertiesService): uma notícia nunca repete de um dia pro outro.
 *  - E-mail em HTML com layout de cards, compatível com Gmail (tabelas + CSS inline).
 *  - Função diagnosticarFeeds() para ver no log quais feeds respondem e com quantos itens.
 *  - v3: dispara um GitHub Action que gera a versão em ÁUDIO (podcast) e põe o botão "Ouvir" no e-mail.
 *        Requer: CONFIG.PODCAST preenchido + propriedade do script GITHUB_TOKEN. Teste com "testarPodcast".
 *
 * INSTALAÇÃO
 * 1. script.google.com → abra o projeto existente → substitua TODO o código por este arquivo.
 * 2. Selecione "configurarGatilho" e clique em Executar (autorize se pedir).
 * 3. Para testar na hora: "testarAgora". Para checar os feeds: "diagnosticarFeeds" e veja o log (Ctrl+Enter).
 */

// ======================= CONFIGURAÇÃO =======================
var CONFIG = {
  EMAIL_TO: 'magoboy29@gmail.com',
  NOME: 'Júlio',
  TIMEZONE: 'America/Sao_Paulo',

  // Nomes EXATOS dos calendários. O calendário principal é incluído automaticamente.
  CALENDARIOS_TRABALHO: [
    'Análise de Condicionantes.',
    'Processos CONDEMA',
    'Calendário FUNAT - Fiscalização'
  ],

  // Calendários em que eventos de DIA INTEIRO devem ser ignorados.
  CALENDARIOS_IGNORAR_DIA_INTEIRO: [
    'Calendário FUNAT - Fiscalização'
  ],

  // Feeds por tema. { url, nome } — o nome aparece como fonte no e-mail.
  FEEDS: {
    'Brasil': [
      { url: 'https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml', nome: 'Agência Brasil' },
      { url: 'https://www.poder360.com.br/feed/', nome: 'Poder360' }
    ],
    'Meio ambiente e licenciamento': [
      { url: 'https://oeco.org.br/feed/', nome: '((o))eco' },
      { url: 'https://agenciabrasil.ebc.com.br/rss/meio-ambiente/feed.xml', nome: 'Agência Brasil' },
      // Ibama está em defeso eleitoral (sem publicações até as eleições); volta sozinho depois.
      { url: 'https://www.gov.br/ibama/pt-br/assuntos/noticias/2026/RSS', nome: 'Ibama' }
    ],
    'Tecnologia e IA': [
      { url: 'https://olhardigital.com.br/feed/', nome: 'Olhar Digital' },
      { url: 'https://tecnoblog.net/feed/', nome: 'Tecnoblog' }
    ]
  },

  MAX_NOTICIAS_POR_TEMA: 4,
  MAX_POR_FONTE_NO_TEMA: 3,      // evita um feed dominar o tema inteiro
  MAX_IDADE_NOTICIA_HORAS: 48,    // itens mais velhos que isso são descartados
  LEMBRAR_ENVIADOS_DIAS: 7,       // não repete notícia enviada nos últimos N dias

  // Cores do e-mail
  COR_PRIMARIA: '#1f5f4a',
  COR_FUNDO: '#f2f4f3',

  // ---- Podcast (áudio gerado por GitHub Action; ver repositório resumo-matinal-podcast) ----
  PODCAST: {
    ATIVO: true,
    GITHUB_REPO: 'SEU_USUARIO/resumo-matinal-podcast',   // dono/repositório no GitHub
    // Token vem das Propriedades do script (chave GITHUB_TOKEN) — nunca cole aqui.
    SITE_URL: 'https://SEU_USUARIO.github.io/resumo-matinal-podcast',
    SPOTIFY_URL: '',            // opcional: link do programa no Spotify, depois de aprovado
    AGENDA_NO_AUDIO: false      // o podcast é PÚBLICO no Spotify — deixe false para não narrar sua agenda
  }
};
// ==============================================================

function configurarGatilho() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'enviarResumoMatinal') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('enviarResumoMatinal')
    .timeBased().atHour(4).nearMinute(0).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log('Gatilho diário às 4h criado com sucesso.');
}

function testarAgora() {
  enviarResumoMatinal();
}

/** Mostra no log o estado de cada feed: código HTTP, nº de itens, data do mais novo. */
function diagnosticarFeeds() {
  Object.keys(CONFIG.FEEDS).forEach(function (tema) {
    CONFIG.FEEDS[tema].forEach(function (f) {
      var r = parseFeed_(f, true);
      var maisNovo = r.itens.reduce(function (m, it) { return it.tempo && it.tempo > m ? it.tempo : m; }, 0);
      Logger.log('[%s] %s → HTTP %s | %s itens | mais novo: %s | %s',
        tema, f.nome, r.http, r.itens.length,
        maisNovo ? Utilities.formatDate(new Date(maisNovo), CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm') : '—',
        r.erro || 'ok');
    });
  });
}

/** Limpa a memória de notícias já enviadas (só se quiser forçar repetição). */
function limparMemoria() {
  PropertiesService.getUserProperties().deleteProperty('ENVIADOS');
  Logger.log('Memória limpa.');
}

// ======================= PRINCIPAL =======================

function enviarResumoMatinal() {
  var hoje = new Date();
  var dataExtenso = formatarDataExtenso_(hoje);

  var agenda = montarAgenda_();
  var noticias = montarNoticias_();

  var assunto = 'Resumo matinal – ' + dataExtenso;

  var corpoTexto = 'Bom dia, ' + CONFIG.NOME + '!\n\nHoje é ' + dataExtenso + '.\n\n' +
    'SUA AGENDA DE HOJE\n' + agenda.texto + '\n\n' +
    'NOTÍCIAS DO DIA\n' + noticias.texto;

  var dataIso = Utilities.formatDate(hoje, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  var podcastOk = dispararPodcast_(dataIso, dataExtenso, agenda.linhasTexto, noticias.itens);

  var corpoHtml = construirHtml_(dataExtenso, agenda.html, noticias.html, podcastOk ? dataIso : null);
  if (podcastOk) corpoTexto += '\n\nOUVIR: ' + CONFIG.PODCAST.SITE_URL + '/ep/' + dataIso + '.mp3';

  GmailApp.sendEmail(CONFIG.EMAIL_TO, assunto, corpoTexto, {
    htmlBody: corpoHtml,
    name: 'Resumo Matinal'
  });

  marcarEnviados_(noticias.links);
}

// ======================= PODCAST =======================

/**
 * Dispara o GitHub Action que escreve o roteiro, gera o áudio e publica o feed.
 * Retorna true se o disparo foi aceito (o áudio fica pronto ~2-3 min depois).
 */
function dispararPodcast_(dataIso, dataExtenso, agendaLinhas, noticias) {
  var pc = CONFIG.PODCAST;
  if (!pc || !pc.ATIVO) return false;
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) { Logger.log('Podcast: GITHUB_TOKEN não configurado nas Propriedades do script.'); return false; }
  if (!noticias || !noticias.length) { Logger.log('Podcast: sem notícias, não vou gerar episódio.'); return false; }

  var payload = {
    event_type: 'novo-episodio',
    client_payload: {
      data: dataIso,
      data_extenso: dataExtenso,
      agenda: pc.AGENDA_NO_AUDIO ? agendaLinhas : [],
      noticias: noticias.map(function (n) {
        return { tema: n.tema, titulo: n.title, resumo: truncar_(n.descricaoLimpa, 300), fonte: n.fonte };
      })
    }
  };
  try {
    var resp = UrlFetchApp.fetch('https://api.github.com/repos/' + pc.GITHUB_REPO + '/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code === 204) return true;
    Logger.log('Podcast: GitHub respondeu ' + code + ' — ' + resp.getContentText().slice(0, 300));
  } catch (e) {
    Logger.log('Podcast: erro ao chamar o GitHub: ' + e);
  }
  return false;
}

/** Testa só o disparo do podcast com as notícias de agora (sem enviar e-mail). */
function testarPodcast() {
  var hoje = new Date();
  var n = montarNoticias_();
  var ok = dispararPodcast_(Utilities.formatDate(hoje, CONFIG.TIMEZONE, 'yyyy-MM-dd'), formatarDataExtenso_(hoje), [], n.itens);
  Logger.log(ok ? 'Disparado! Acompanhe em github.com/' + CONFIG.PODCAST.GITHUB_REPO + '/actions' : 'Falhou — veja o log acima.');
}

// ======================= AGENDA =======================

function montarAgenda_() {
  var tz = CONFIG.TIMEZONE;
  var hojeStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var inicio = new Date(hojeStr + 'T00:00:00-03:00');
  var fim = new Date(hojeStr + 'T23:59:59-03:00');

  var linhas = [];
  coletarEventos_(CalendarApp.getDefaultCalendar(), inicio, fim, false, linhas);
  CONFIG.CALENDARIOS_TRABALHO.forEach(function (nome) {
    var ignorarDiaInteiro = CONFIG.CALENDARIOS_IGNORAR_DIA_INTEIRO.indexOf(nome) !== -1;
    CalendarApp.getCalendarsByName(nome).forEach(function (cal) {
      coletarEventos_(cal, inicio, fim, ignorarDiaInteiro, linhas);
    });
  });
  linhas.sort(function (a, b) { return a.inicio - b.inicio; });

  if (linhas.length === 0) {
    return {
      texto: 'Agenda livre hoje — nenhum compromisso encontrado.',
      html: '<tr><td style="padding:14px 20px;color:#6b7280;font-size:14px;">Agenda livre hoje — nenhum compromisso encontrado. 🎉</td></tr>',
      linhasTexto: []
    };
  }
  return {
    texto: linhas.map(function (l) { return '- ' + l.texto; }).join('\n'),
    html: linhas.map(function (l) { return l.html; }).join(''),
    linhasTexto: linhas.map(function (l) { return l.texto; })
  };
}

function coletarEventos_(calendario, inicio, fim, ignorarDiaInteiro, linhas) {
  var eventos;
  try { eventos = calendario.getEvents(inicio, fim); }
  catch (e) { Logger.log('Não foi possível ler o calendário "' + calendario.getName() + '": ' + e); return; }

  var nomeCal = calendario.getName();
  if (nomeCal === CONFIG.EMAIL_TO) nomeCal = 'Pessoal';
  var corCal = '#9ca3af';
  try { corCal = calendario.getColor() || corCal; } catch (e) {}

  eventos.forEach(function (ev) {
    var diaInteiro = ev.isAllDayEvent();
    if (diaInteiro && ignorarDiaInteiro) return;

    var titulo = ev.getTitle();
    var local = ev.getLocation();
    var convidados = ev.getGuestList().map(function (g) { return g.getEmail(); })
      .filter(function (e) { return e !== CONFIG.EMAIL_TO; });

    var horario, chave;
    if (diaInteiro) {
      horario = 'Dia inteiro'; chave = inicio;
    } else {
      horario = Utilities.formatDate(ev.getStartTime(), CONFIG.TIMEZONE, 'HH:mm') + '–' +
                Utilities.formatDate(ev.getEndTime(), CONFIG.TIMEZONE, 'HH:mm');
      chave = ev.getStartTime();
    }

    var detalhes = [];
    if (local) detalhes.push('📍 ' + local);
    if (convidados.length) detalhes.push('👥 ' + convidados.join(', '));

    var texto = horario + ' — ' + titulo + (detalhes.length ? ' (' + detalhes.join(' · ') + ')' : '') + ' [' + nomeCal + ']';

    var html =
      '<tr><td style="padding:0 20px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e5e7eb;">' +
        '<tr>' +
          '<td width="96" valign="top" style="padding:12px 0;font-size:13px;font-weight:bold;color:' + CONFIG.COR_PRIMARIA + ';white-space:nowrap;">' + escapeHtml_(horario) + '</td>' +
          '<td valign="top" style="padding:12px 0 12px 12px;border-left:3px solid ' + escapeHtml_(corCal) + ';">' +
            '<div style="font-size:15px;color:#111827;line-height:1.35;">' + escapeHtml_(titulo) + '</div>' +
            (detalhes.length ? '<div style="font-size:12px;color:#6b7280;margin-top:3px;">' + escapeHtml_(detalhes.join('  ·  ')) + '</div>' : '') +
            '<div style="font-size:11px;color:#9ca3af;margin-top:3px;">' + escapeHtml_(nomeCal) + '</div>' +
          '</td>' +
        '</tr></table>' +
      '</td></tr>';

    linhas.push({ inicio: chave, texto: texto, html: html });
  });
}

// ======================= NOTÍCIAS =======================

function montarNoticias_() {
  var textoPartes = [], htmlPartes = [], linksUsados = [], itensTodos = [];
  var enviados = lerEnviados_();

  Object.keys(CONFIG.FEEDS).forEach(function (tema) {
    var itens = [];
    CONFIG.FEEDS[tema].forEach(function (f) { itens = itens.concat(parseFeed_(f).itens); });

    itens = filtrarERanquear_(itens, enviados).slice(0, CONFIG.MAX_NOTICIAS_POR_TEMA);

    textoPartes.push('\n' + tema.toUpperCase());
    htmlPartes.push(
      '<tr><td style="padding:22px 20px 6px;">' +
        '<div style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;color:' + CONFIG.COR_PRIMARIA + ';">' + escapeHtml_(tema) + '</div>' +
      '</td></tr>'
    );

    if (itens.length === 0) {
      textoPartes.push('  (nada novo nas últimas ' + CONFIG.MAX_IDADE_NOTICIA_HORAS + 'h)');
      htmlPartes.push('<tr><td style="padding:6px 20px 12px;color:#9ca3af;font-size:13px;">Nada novo nas últimas ' + CONFIG.MAX_IDADE_NOTICIA_HORAS + 'h.</td></tr>');
      return;
    }

    itens.forEach(function (item) {
      var resumo = truncar_(item.descricaoLimpa, 200);
      linksUsados.push(item.link);
      item.tema = tema;
      itensTodos.push(item);
      textoPartes.push('  - ' + item.title + (resumo ? ' — ' + resumo : '') + ' (' + item.link + ')');
      htmlPartes.push(
        '<tr><td style="padding:0 20px;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e5e7eb;"><tr><td style="padding:12px 0;">' +
            '<a href="' + escapeHtml_(item.link) + '" style="font-size:15px;font-weight:bold;color:#111827;text-decoration:none;line-height:1.35;">' + escapeHtml_(item.title) + '</a>' +
            (resumo ? '<div style="font-size:13px;color:#4b5563;line-height:1.45;margin-top:4px;">' + escapeHtml_(resumo) + '</div>' : '') +
            '<div style="font-size:11px;color:#9ca3af;margin-top:5px;">' + escapeHtml_(item.fonte) + (item.tempo ? ' · ' + tempoRelativo_(item.tempo) : '') + '</div>' +
          '</td></tr></table>' +
        '</td></tr>'
      );
    });
  });

  return { texto: textoPartes.join('\n'), html: htmlPartes.join(''), links: linksUsados, itens: itensTodos };
}

function filtrarERanquear_(itens, enviados) {
  var agora = Date.now();
  var limiteMs = CONFIG.MAX_IDADE_NOTICIA_HORAS * 3600 * 1000;
  var vistos = {}, porFonte = {};

  return itens
    .filter(function (it) { return it.link && it.title; })
    .filter(function (it) { return it.tempo === null || (agora - it.tempo) <= limiteMs; }) // descarta antigos (sem data passa)
    .filter(function (it) { return !enviados[normalizarLink_(it.link)]; })                // descarta já enviados
    .sort(function (a, b) { return (b.tempo || 0) - (a.tempo || 0); })
    .filter(function (it) {                                                                // dedup + teto por fonte
      var k = normalizarLink_(it.link);
      if (vistos[k]) return false;
      porFonte[it.fonte] = (porFonte[it.fonte] || 0) + 1;
      if (porFonte[it.fonte] > CONFIG.MAX_POR_FONTE_NO_TEMA) return false;
      vistos[k] = true;
      return true;
    });
}

/**
 * Lê um feed (RSS 2.0, RSS 1.0/RDF ou Atom) e devolve { itens, http, erro }.
 * Cada item: { title, link, descricaoLimpa, tempo (ms ou null), fonte }.
 */
function parseFeed_(feed, verboso) {
  var out = { itens: [], http: null, erro: null };
  try {
    var resp = UrlFetchApp.fetch(feed.url, { muteHttpExceptions: true, followRedirects: true });
    out.http = resp.getResponseCode();
    if (out.http !== 200) { out.erro = 'HTTP ' + out.http; Logger.log(out.erro + ': ' + feed.url); return out; }

    var texto = resp.getContentText().replace(/^﻿/, '');
    var root = XmlService.parse(texto).getRootElement();
    var nome = root.getName();
    var dc = XmlService.getNamespace('http://purl.org/dc/elements/1.1/');
    var raw = [];

    if (nome === 'rss') {                                    // RSS 2.0
      var channel = root.getChild('channel');
      (channel ? channel.getChildren('item') : []).forEach(function (it) {
        raw.push({
          title: textoFilho_(it, 'title'), link: textoFilho_(it, 'link'),
          description: textoFilho_(it, 'description'),
          data: textoFilho_(it, 'pubDate') || textoFilhoNs_(it, 'date', dc)
        });
      });
    } else if (nome === 'RDF') {                             // RSS 1.0 (gov.br)
      var rss1 = XmlService.getNamespace('http://purl.org/rss/1.0/');
      root.getChildren('item', rss1).forEach(function (it) {
        raw.push({
          title: textoFilhoNs_(it, 'title', rss1), link: textoFilhoNs_(it, 'link', rss1),
          description: textoFilhoNs_(it, 'description', rss1),
          data: textoFilhoNs_(it, 'date', dc)
        });
      });
    } else {                                                 // Atom
      var atom = XmlService.getNamespace('http://www.w3.org/2005/Atom');
      root.getChildren('entry', atom).forEach(function (en) {
        var link = '';
        var links = en.getChildren('link', atom);
        for (var i = 0; i < links.length; i++) {
          var rel = links[i].getAttribute('rel');
          if (!rel || rel.getValue() === 'alternate') { link = links[i].getAttribute('href').getValue(); break; }
        }
        raw.push({
          title: textoFilhoNs_(en, 'title', atom), link: link,
          description: textoFilhoNs_(en, 'summary', atom) || textoFilhoNs_(en, 'content', atom),
          data: textoFilhoNs_(en, 'published', atom) || textoFilhoNs_(en, 'updated', atom)
        });
      });
    }

    out.itens = raw.map(function (r) {
      var t = r.data ? Date.parse(r.data) : NaN;
      return {
        title: decodificarEntidades_(limparHtml_(r.title)),
        link: (r.link || '').trim(),
        descricaoLimpa: limparDescricao_(r.description),
        tempo: isNaN(t) ? null : t,
        fonte: feed.nome
      };
    });
  } catch (e) {
    out.erro = String(e);
    Logger.log('Erro ao ler feed ' + feed.url + ': ' + e);
  }
  return out;
}

function textoFilho_(pai, nome) { var el = pai.getChild(nome); return el ? el.getText() : ''; }
function textoFilhoNs_(pai, nome, ns) { var el = pai.getChild(nome, ns); return el ? el.getText() : ''; }

// ======================= MEMÓRIA DE ENVIADOS =======================

function lerEnviados_() {
  var raw = PropertiesService.getUserProperties().getProperty('ENVIADOS');
  var mapa = raw ? JSON.parse(raw) : {};
  var corte = Date.now() - CONFIG.LEMBRAR_ENVIADOS_DIAS * 86400 * 1000;
  Object.keys(mapa).forEach(function (k) { if (mapa[k] < corte) delete mapa[k]; });
  return mapa;
}

function marcarEnviados_(links) {
  var mapa = lerEnviados_();
  var agora = Date.now();
  links.forEach(function (l) { mapa[normalizarLink_(l)] = agora; });
  PropertiesService.getUserProperties().setProperty('ENVIADOS', JSON.stringify(mapa));
}

function normalizarLink_(l) {
  return String(l || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

// ======================= UTILITÁRIOS =======================

function limparHtml_(s) {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Limpa descrição: tira HTML, entidades e o rodapé "O post X apareceu primeiro em Y." do WordPress. */
function limparDescricao_(s) {
  var t = decodificarEntidades_(limparHtml_(s));
  t = t.replace(/\s*O post .*? apareceu primeiro em .*$/i, '');
  t = t.replace(/\s*The post .*? appeared first on .*$/i, '');
  t = t.replace(/\s*\[…\]\s*$|\s*\[\.\.\.\]\s*$|\s*Continue lendo.*$/i, '');
  return t.trim();
}

function decodificarEntidades_(s) {
  if (!s) return '';
  var mapa = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
               laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
  return s
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&([a-z]+);/gi, function (m, n) { return mapa[n.toLowerCase()] !== undefined ? mapa[n.toLowerCase()] : m; });
}

function truncar_(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  var corte = s.slice(0, max);
  var ultimoEspaco = corte.lastIndexOf(' ');
  return (ultimoEspaco > max * 0.6 ? corte.slice(0, ultimoEspaco) : corte).replace(/[,;:\-–—\s]+$/, '') + '…';
}

function escapeHtml_(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tempoRelativo_(ms) {
  var min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return 'há ' + min + ' min';
  var h = Math.round(min / 60);
  if (h < 24) return 'há ' + h + ' h';
  var d = Math.round(h / 24);
  return d === 1 ? 'ontem' : 'há ' + d + ' dias';
}

function formatarDataExtenso_(data) {
  var dias = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  var meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var tz = CONFIG.TIMEZONE;
  var diaSemana = dias[Number(Utilities.formatDate(data, tz, 'u')) % 7];
  var dia = Utilities.formatDate(data, tz, 'd');
  var mes = meses[Number(Utilities.formatDate(data, tz, 'M')) - 1];
  var ano = Utilities.formatDate(data, tz, 'yyyy');
  return diaSemana + ', ' + dia + ' de ' + mes + ' de ' + ano;
}

// ======================= TEMPLATE DO E-MAIL =======================

function blocoOuvir_(dataIso) {
  var pc = CONFIG.PODCAST;
  var mp3 = pc.SITE_URL + '/ep/' + dataIso + '.mp3';
  var spotify = pc.SPOTIFY_URL ? ' &nbsp; <a href="' + escapeHtml_(pc.SPOTIFY_URL) + '" style="color:' + CONFIG.COR_PRIMARIA + ';font-size:13px;">abrir no Spotify</a>' : '';
  return '' +
    '<tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 20px;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="background:' + CONFIG.COR_PRIMARIA + ';border-radius:8px;">' +
          '<a href="' + escapeHtml_(mp3) + '" style="display:inline-block;padding:10px 18px;color:#ffffff;font-weight:bold;font-size:14px;text-decoration:none;white-space:nowrap;">▶&nbsp; Ouvir o resumo</a>' +
        '</td>' +
        '<td style="padding-left:14px;font-size:12px;color:#6b7280;">versão em áudio (~5 min), pronta uns minutos depois deste e-mail' + spotify + '</td>' +
      '</tr></table>' +
    '</td></tr>' +
    '<tr><td style="height:16px;line-height:16px;font-size:0;">&nbsp;</td></tr>';
}

function construirHtml_(dataExtenso, agendaHtml, noticiasHtml, dataIsoPodcast) {
  var P = CONFIG.COR_PRIMARIA, F = CONFIG.COR_FUNDO;
  var partes = dataExtenso.split(', ');
  var diaSemana = partes[0].charAt(0).toUpperCase() + partes[0].slice(1);
  var resto = partes.slice(1).join(', ');

  function secao(titulo, emoji, corpo) {
    return '' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;margin-bottom:16px;">' +
        '<tr><td style="padding:16px 20px 4px;">' +
          '<span style="font-size:18px;font-weight:bold;color:#111827;">' + emoji + '&nbsp; ' + escapeHtml_(titulo) + '</span>' +
        '</td></tr>' +
        corpo +
        '<tr><td style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr>' +
      '</table>';
  }

  return '' +
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:' + F + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + F + ';">' +
    '<tr><td align="center" style="padding:24px 12px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +

        // cabeçalho
        '<tr><td style="background:' + P + ';border-radius:12px;padding:26px 24px;margin-bottom:16px;">' +
          '<div style="font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.75);">Resumo matinal</div>' +
          '<div style="font-size:26px;font-weight:bold;color:#ffffff;margin-top:6px;">Bom dia, ' + escapeHtml_(CONFIG.NOME) + '! ☀️</div>' +
          '<div style="font-size:15px;color:rgba(255,255,255,0.9);margin-top:6px;">' + escapeHtml_(diaSemana) + ', ' + escapeHtml_(resto) + '</div>' +
        '</td></tr>' +
        '<tr><td style="height:16px;line-height:16px;font-size:0;">&nbsp;</td></tr>' +

        (dataIsoPodcast ? blocoOuvir_(dataIsoPodcast) : '') +

        '<tr><td>' + secao('Sua agenda de hoje', '📅', agendaHtml) + '</td></tr>' +
        '<tr><td>' + secao('Notícias do dia', '📰', noticiasHtml) + '</td></tr>' +

        // rodapé
        '<tr><td style="padding:8px 12px;text-align:center;font-size:11px;color:#9ca3af;">' +
          'Gerado automaticamente pelo Google Apps Script · fontes: Agência Brasil, Poder360, ((o))eco, Ibama, Olhar Digital, Tecnoblog' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table></body></html>';
}
