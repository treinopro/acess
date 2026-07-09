#!/usr/bin/env python3
"""
Proxy local da webcam USB do totem — roda no PROPRIO TABLET, via Termux.

O QUE ISSO RESOLVE
-------------------
O totem usa uma webcam USB conectada ao tablet via um app chamado
"USB Camera", que publica o video como um stream MJPEG em
http://127.0.0.1:8081/video — mas exige login (usuario/senha) e nao tem
opcao de desativar isso.

A pagina do totem (terminal.html/terminal.js) nao consegue usar esse
endereco direto por dois motivos, os dois regras de seguranca do
NAVEGADOR (nao tem solucao "so ajustando a URL"):

  1. O navegador bloqueia URLs com "usuario:senha@" quando o recurso e
     carregado sozinho pela pagina (tipo uma tag <img>) vindo de um
     endereco diferente do da propria pagina.
  2. Mesmo que a imagem carregasse, a leitura de pixels via <canvas>
     (usada pra ler QR code e reconhecimento facial) e bloqueada quando a
     imagem vem de outro endereco sem cabecalho CORS — e esse app de
     camera nao envia esse cabecalho.

Um script (este aqui) NAO tem essas restricoes, porque elas sao do
navegador, nao do protocolo HTTP. Entao este proxy:

  - conecta em http://127.0.0.1:8081/video usando o usuario/senha por
    tras dos panos;
  - republica o mesmo video, sem exigir senha nenhuma, num outro
    endereco local (http://127.0.0.1:9000/video);
  - adiciona o cabecalho "Access-Control-Allow-Origin: *", liberando a
    leitura de pixels.

E' esse endereco novo (porta 9000) que o terminal.js realmente usa
(constante USB_WEBCAM_URL).

COMO USAR (dentro do Termux, no tablet)
----------------------------------------
  pkg update -y && pkg install python -y
  python proxy_webcam.py

Deixe essa janela do Termux rodando (pode minimizar, nao feche o app).
Se um dia a senha do app "USB Camera" mudar, atualize UPSTREAM_USER /
UPSTREAM_PASS abaixo.

Para o proxy iniciar sozinho quando o tablet ligar (sem precisar abrir o
Termux manualmente todo dia), veja o pacote "termux-boot" — pergunte pro
Claude quando estiver pronto pra configurar isso.
"""
import base64
import http.server
import socketserver
import urllib.request
import urllib.error

UPSTREAM_URL = "http://127.0.0.1:8081/video"
UPSTREAM_USER = "admin"
UPSTREAM_PASS = "admin123"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 9000
CHUNK_SIZE = 4096


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/video":
            self.send_response(404)
            self.end_headers()
            return

        credenciais = base64.b64encode(
            f"{UPSTREAM_USER}:{UPSTREAM_PASS}".encode()
        ).decode()
        pedido = urllib.request.Request(
            UPSTREAM_URL,
            headers={"Authorization": f"Basic {credenciais}"},
        )

        try:
            upstream = urllib.request.urlopen(pedido, timeout=10)
        except (urllib.error.URLError, TimeoutError) as erro:
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                f"Nao foi possivel conectar na webcam (app USB Camera "
                f"esta aberto, com o servidor de rede ligado?): {erro}".encode()
            )
            return

        self.send_response(200)
        content_type = upstream.headers.get(
            "Content-Type", "multipart/x-mixed-replace"
        )
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()

        try:
            while True:
                pedaco = upstream.read(CHUNK_SIZE)
                if not pedaco:
                    break
                self.wfile.write(pedaco)
        except (BrokenPipeError, ConnectionResetError):
            # A pagina do totem trocou de tela ou fechou a conexao — normal,
            # nao e' erro.
            pass
        finally:
            upstream.close()

    def log_message(self, formato, *args):
        # Silencia o log padrao (uma linha por pedaco de video seria
        # barulho demais no terminal) — mantem so os prints abaixo.
        pass


class ServidorProxy(socketserver.ThreadingTCPServer):
    # Permite reiniciar o script rapido sem esperar a porta liberar sozinha.
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with ServidorProxy((LISTEN_HOST, LISTEN_PORT), ProxyHandler) as servidor:
        print(f"Proxy da webcam do totem rodando.")
        print(f"Origem (com senha, so o proxy usa): {UPSTREAM_URL}")
        print(f"Endereco que o totem usa (sem senha): http://{LISTEN_HOST}:{LISTEN_PORT}/video")
        print("Deixe esta janela aberta. Ctrl+C para parar.")
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            print("\nProxy encerrado.")
