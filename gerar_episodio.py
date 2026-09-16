#!/usr/bin/env python3
"""
Gera um episódio do podcast "Resumo Matinal":
  payload (agenda + notícias, vindo do Apps Script)
    → Gemini escreve o roteiro de rádio
    → Gemini TTS fala o roteiro (PCM 24 kHz)
    → ffmpeg converte para MP3 128 kbps (exigência do Spotify)
    → atualiza site/ (feed.xml, ep/*.mp3, index.html) que vai para o GitHub Pages
"""
import base64, datetime as dt, html, json, os, re, subprocess, sys, wave, zoneinfo
from pathlib import Path
import requests

# ---------- configuração (via env; tudo tem padrão) ----------
API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
VOZ = os.environ.get("VOZ", "").strip() or "Charon"
MODELO_TEXTO = os.environ.get("MODELO_TEXTO", "").strip() or "gemini-3.5-flash-lite"
MODELO_TTS = os.environ.get("MODELO_TTS", "").strip() or "gemini-2.5-flash-preview-tts"
MANTER = int(os.environ.get("MANTER_EPISODIOS") or 14)
EMAIL_DONO = os.environ.get("OWNER_EMAIL", "").strip()  # Spotify manda o código de verificação para cá
TZ = zoneinfo.ZoneInfo("America/Sao_Paulo")

TITULO_PODCAST = "Resumo Matinal"
DESCRICAO_PODCAST = "Manchetes do dia sobre Brasil, meio ambiente e tecnologia, geradas automaticamente todas as manhãs."
AUTOR = "Resumo Matinal"

SITE = Path("site")
EP = SITE / "ep"
DB = SITE / "episodios.json"

PAYLOAD_EXEMPLO = {
    "data": dt.datetime.now(TZ).strftime("%Y-%m-%d"),
    "data_extenso": "teste, dia de hoje",
    "agenda": [],
    "noticias": [
        {"tema": "Brasil", "titulo": "Episódio de teste gerado manualmente", "resumo": "Este é um episódio de teste para verificar se o pipeline de áudio está funcionando.", "fonte": "Teste"},
        {"tema": "Tecnologia e IA", "titulo": "Pipeline de podcast configurado com sucesso", "resumo": "Se você está ouvindo isto, o Gemini, o ffmpeg e o GitHub Pages estão conversando direitinho.", "fonte": "Teste"},
    ],
}


def die(msg):
    print("ERRO:", msg, file=sys.stderr)
    sys.exit(1)


# ---------- Gemini ----------
BASE = "https://generativelanguage.googleapis.com/v1beta"
HDR = {"x-goog-api-key": API_KEY, "Content-Type": "application/json"}


def _achar(obj, pred):
    """Procura recursivamente o primeiro dict que satisfaz pred (a resposta REST pode variar de formato)."""
    if isinstance(obj, dict):
        if pred(obj):
            return obj
        for v in obj.values():
            r = _achar(v, pred)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _achar(v, pred)
            if r is not None:
                return r
    return None


def gemini_texto(prompt):
    # 1) API "interactions" (atual)
    r = requests.post(f"{BASE}/interactions", headers=HDR, timeout=120,
                      json={"model": MODELO_TEXTO, "input": prompt})
    if r.ok:
        j = r.json()
        if j.get("output_text"):
            return j["output_text"]
        t = _achar(j, lambda d: d.get("type") == "text" and isinstance(d.get("text"), str))
        if t:
            return t["text"]
    print(f"interactions(texto) falhou ({r.status_code}); tentando generateContent…")
    # 2) fallback: generateContent
    r = requests.post(f"{BASE}/models/{MODELO_TEXTO}:generateContent", headers=HDR, timeout=120,
                      json={"contents": [{"parts": [{"text": prompt}]}]})
    if not r.ok:
        die(f"Gemini texto: {r.status_code} {r.text[:400]}")
    p = _achar(r.json(), lambda d: isinstance(d.get("text"), str))
    return p["text"] if p else die("Gemini texto: resposta sem texto")


def gemini_tts(texto):
    """Retorna bytes PCM 16-bit mono 24 kHz."""
    r = requests.post(f"{BASE}/interactions", headers=HDR, timeout=300, json={
        "model": MODELO_TTS, "input": texto,
        "response_format": {"type": "audio"},
        "generation_config": {"speech_config": [{"voice": VOZ}]},
    })
    if r.ok:
        j = r.json()
        d = (j.get("output_audio") or {}).get("data") if isinstance(j.get("output_audio"), dict) else None
        if not d:
            a = _achar(j, lambda x: x.get("type") == "audio" and isinstance(x.get("data"), str))
            d = a["data"] if a else None
        if d:
            return base64.b64decode(d)
    print(f"interactions(tts) falhou ({r.status_code}); tentando generateContent…")
    r = requests.post(f"{BASE}/models/{MODELO_TTS}:generateContent", headers=HDR, timeout=300, json={
        "contents": [{"parts": [{"text": texto}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOZ}}},
        },
    })
    if not r.ok:
        die(f"Gemini TTS: {r.status_code} {r.text[:400]}")
    a = _achar(r.json(), lambda x: isinstance(x.get("inlineData"), dict))
    if not a:
        die("Gemini TTS: resposta sem áudio")
    return base64.b64decode(a["inlineData"]["data"])


# ---------- roteiro ----------
def montar_prompt(p):
    linhas = []
    for n in p.get("noticias", []):
        linhas.append(f"- [{n.get('tema','')}] {n.get('titulo','')} — {n.get('resumo','')} (fonte: {n.get('fonte','')})")
    agenda = p.get("agenda") or []
    bloco_agenda = ("\nAGENDA DO OUVINTE HOJE:\n" + "\n".join("- " + a for a in agenda)) if agenda else ""
    return f"""Você é o locutor de um boletim matinal de rádio em português do Brasil, chamado "Resumo Matinal".
Escreva o ROTEIRO FALADO de hoje, {p.get('data_extenso','')}, para ser lido por um sintetizador de voz.

MATERIAL:
{chr(10).join(linhas)}{bloco_agenda}

REGRAS:
- Comece com "Bom dia!" e a data. {"Depois, resuma a agenda do dia em uma ou duas frases." if agenda else ""}
- Depois apresente as notícias agrupadas por tema, na ordem: Brasil, meio ambiente, tecnologia. Anuncie cada bloco com uma frase curta de transição.
- Para cada notícia: 2 a 3 frases, explicando o que aconteceu e por que importa. Cite a fonte de forma natural ("segundo a Agência Brasil").
- Tom: informativo, cordial, ritmo de rádio. Frases curtas. Nada de opinião.
- Escreva números por extenso quando forem curtos, e siglas como se fossem faladas.
- Encerre em uma frase desejando um bom dia.
- Entre 550 e 750 palavras no total.
- SAÍDA: apenas o texto do roteiro, em parágrafos. Sem título, sem markdown, sem asteriscos, sem emojis, sem colchetes, sem URLs, sem indicações de cena."""


def limpar_roteiro(t):
    t = re.sub(r"[*#_`>\[\]]+", "", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def dividir(texto, max_chars=2400):
    """Quebra o roteiro em blocos por parágrafo para o TTS não engasgar com textos longos."""
    blocos, atual = [], ""
    for par in [p.strip() for p in texto.split("\n") if p.strip()]:
        if len(atual) + len(par) + 1 > max_chars and atual:
            blocos.append(atual)
            atual = par
        else:
            atual = (atual + "\n" + par).strip()
    if atual:
        blocos.append(atual)
    return blocos


# ---------- áudio ----------
def sintetizar(roteiro, wav_path):
    instrucao = "Leia o texto a seguir como um locutor de boletim matinal de rádio brasileiro: voz clara, ritmo natural, tom informativo e simpático.\n\n"
    silencio = b"\x00\x00" * int(24000 * 0.45)
    pcm = b""
    blocos = dividir(roteiro)
    for i, b in enumerate(blocos, 1):
        print(f"TTS bloco {i}/{len(blocos)} ({len(b)} chars)")
        pcm += gemini_tts(instrucao + b) + silencio
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(24000); wf.writeframes(pcm)


def converter_mp3(wav_path, mp3_path, titulo, data):
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar", "44100", "-ac", "1", "-b:a", "128k", "-codec:a", "libmp3lame",
        "-id3v2_version", "3",
        "-metadata", f"title={titulo}", "-metadata", f"artist={AUTOR}",
        "-metadata", f"album={TITULO_PODCAST}", "-metadata", f"date={data[:4]}",
        str(mp3_path),
    ], check=True)


def duracao_segundos(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True, check=True).stdout
    return int(float(out.strip()))


def hms(s):
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


# ---------- site / feed ----------
def carregar_db():
    if DB.exists():
        try:
            return json.loads(DB.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def rfc2822(data_iso):
    d = dt.datetime.strptime(data_iso, "%Y-%m-%d").replace(hour=4, minute=5, tzinfo=TZ)
    return d.strftime("%a, %d %b %Y %H:%M:%S %z")


def escrever_feed(eps):
    x = html.escape
    itens = []
    for e in eps:
        itens.append(f"""
    <item>
      <title>{x(e['titulo'])}</title>
      <description>{x(e['descricao'])}</description>
      <itunes:summary>{x(e['descricao'])}</itunes:summary>
      <pubDate>{rfc2822(e['data'])}</pubDate>
      <guid isPermaLink="false">resumo-matinal-{e['data']}</guid>
      <link>{SITE_URL}/#{e['data']}</link>
      <enclosure url="{SITE_URL}/ep/{e['data']}.mp3" length="{e['bytes']}" type="audio/mpeg"/>
      <itunes:duration>{hms(e['duracao'])}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
      <itunes:episodeType>full</itunes:episodeType>
    </item>""")
    feed = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>{x(TITULO_PODCAST)}</title>
    <link>{SITE_URL}/</link>
    <atom:link href="{SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
    <language>pt-br</language>
    <description>{x(DESCRICAO_PODCAST)}</description>
    <itunes:summary>{x(DESCRICAO_PODCAST)}</itunes:summary>
    <itunes:author>{x(AUTOR)}</itunes:author>
    <itunes:owner><itunes:name>{x(AUTOR)}</itunes:name>{f"<itunes:email>{x(EMAIL_DONO)}</itunes:email>" if EMAIL_DONO else ""}</itunes:owner>
    <itunes:image href="{SITE_URL}/cover.png"/>
    <image><url>{SITE_URL}/cover.png</url><title>{x(TITULO_PODCAST)}</title><link>{SITE_URL}/</link></image>
    <itunes:category text="News"><itunes:category text="Daily News"/></itunes:category>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <lastBuildDate>{dt.datetime.now(TZ).strftime('%a, %d %b %Y %H:%M:%S %z')}</lastBuildDate>{''.join(itens)}
  </channel>
</rss>
"""
    (SITE / "feed.xml").write_text(feed, encoding="utf-8")


def escrever_index(eps):
    x = html.escape
    cards = "".join(f"""
  <div class="ep" id="{e['data']}">
    <h2>{x(e['titulo'])}</h2>
    <p>{x(e['descricao'])}</p>
    <audio controls preload="none" src="ep/{e['data']}.mp3"></audio>
    <p class="meta">{hms(e['duracao'])} · <a href="ep/{e['data']}.txt">roteiro</a></p>
  </div>""" for e in eps)
    (SITE / "index.html").write_text(f"""<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{x(TITULO_PODCAST)}</title>
<link rel="alternate" type="application/rss+xml" title="{x(TITULO_PODCAST)}" href="feed.xml">
<style>body{{font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;background:#f2f4f3;color:#111827}}
h1{{color:#1f5f4a}}.ep{{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin:16px 0}}
.ep h2{{font-size:17px;margin:0 0 6px}}audio{{width:100%}}.meta{{font-size:12px;color:#6b7280}}a{{color:#1f5f4a}}</style></head>
<body><h1>☀️ {x(TITULO_PODCAST)}</h1><p>{x(DESCRICAO_PODCAST)}<br><a href="feed.xml">Feed RSS</a></p>{cards}</body></html>""", encoding="utf-8")


# ---------- main ----------
def main():
    if not API_KEY:
        die("GEMINI_API_KEY não definido (Settings → Secrets → Actions).")
    if not SITE_URL:
        die("SITE_URL não definido.")

    raw = os.environ.get("PAYLOAD", "").strip()
    p = json.loads(raw) if raw and raw not in ("null", "{}") else PAYLOAD_EXEMPLO
    if not p.get("noticias"):
        p = PAYLOAD_EXEMPLO
    data = p.get("data") or dt.datetime.now(TZ).strftime("%Y-%m-%d")
    print(f"Episódio de {data}: {len(p.get('noticias', []))} notícias, {len(p.get('agenda') or [])} itens de agenda")

    EP.mkdir(parents=True, exist_ok=True)
    (SITE / ".nojekyll").touch()
    if Path("cover.png").exists():
        (SITE / "cover.png").write_bytes(Path("cover.png").read_bytes())

    roteiro = limpar_roteiro(gemini_texto(montar_prompt(p)))
    print(f"Roteiro: {len(roteiro.split())} palavras")
    (EP / f"{data}.txt").write_text(roteiro, encoding="utf-8")

    wav = Path(f"{data}.wav")
    mp3 = EP / f"{data}.mp3"
    titulo = f"Resumo matinal – {p.get('data_extenso') or data}"
    sintetizar(roteiro, wav)
    converter_mp3(wav, mp3, titulo, data)
    wav.unlink(missing_ok=True)

    manchetes = [n.get("titulo", "") for n in p.get("noticias", [])][:3]
    ep = {
        "data": data, "titulo": titulo,
        "descricao": "Nesta edição: " + "; ".join(manchetes) + ".",
        "bytes": mp3.stat().st_size, "duracao": duracao_segundos(mp3),
    }

    eps = [e for e in carregar_db() if e.get("data") != data]
    eps.append(ep)
    eps.sort(key=lambda e: e["data"], reverse=True)
    for velho in eps[MANTER:]:
        for ext in ("mp3", "txt"):
            (EP / f"{velho['data']}.{ext}").unlink(missing_ok=True)
    eps = eps[:MANTER]

    DB.write_text(json.dumps(eps, ensure_ascii=False, indent=1), encoding="utf-8")
    escrever_feed(eps)
    escrever_index(eps)
    print(f"OK: {mp3} ({ep['bytes'] // 1024} KB, {hms(ep['duracao'])})")


if __name__ == "__main__":
    main()
