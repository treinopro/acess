#!/usr/bin/env python3
"""
Servidor da webcam do totem — roda num RASPBERRY PI (ou qualquer Linux com
Python) posicionado FISICAMENTE perto da catraca, com a webcam USB plugada
direto nele.

POR QUE ISSO EXISTE (2026-07-19)
---------------------------------
O totem precisava trocar de dispositivo (a tela foi trocada por uma TV sem
câmera embutida e sem toque), mas o notebook que processaria o vídeo fica
longe demais da catraca pra ligar a webcam nele por cabo. A solução: um
computador pequeno e barato (Raspberry Pi) fica junto da webcam, perto da
catraca, e publica o vídeo pela rede — qualquer tela em qualquer lugar da
academia (a TV, o notebook, um navegador comum) só precisa carregar
terminal.html apontando pra esse endereço de rede.

Isso é PARENTE do scripts/totem/proxy_webcam.py (o proxy que rodava no
tablet via Termux), mas não é a mesma coisa: aquele script REPUBLICAVA um
stream que já existia (vindo do app "USB Camera" no Android, que exigia
senha e não tinha CORS). Este aqui CAPTURA a webcam direto — no Linux do
Raspberry Pi, ao contrário do Android, o sistema já enxerga uma webcam USB
comum (padrão UVC) sem precisar de nenhum app terceiro nem plugin nativo.

IMPORTANTE — histórico de 11/07/2026: uma tentativa anterior de usar webcam
USB (no tablet Android) foi abandonada porque a porta USB-OTG do tablet não
sustentava a energia que a webcam pedia, e a câmera caía sozinha a cada
poucos segundos (visto como "no-power" no log do Android). Isso é uma
limitação do tablet, não da ideia em si — a porta USB de um Raspberry Pi
fornece energia de verdade (assim como a de um PC/notebook comum), então
esse problema específico não é esperado aqui. Se mesmo assim a câmera cair
sozinha, o primeiro suspeito é sempre a fonte de alimentação do Pi (use a
fonte oficial, 5V/3A pros modelos maiores — um carregador de celular
qualquer costuma não dar conta).

O QUE ESTE SCRIPT FAZ
----------------------
  - Abre a webcam USB via OpenCV (que por baixo usa V4L2, o driver de
    câmera padrão do Linux — não precisa de nenhum app extra);
  - Reduz pra 640x480 de propósito (mesmo motivo do resto do totem: nem
    reconhecimento facial nem leitura de QR precisam de resolução alta, e
    isso deixa o processamento mais leve — importante num Pi, que é bem
    mais fraco que um notebook);
  - Publica o vídeo como stream MJPEG em http://<ip-do-pi>:9000/video, já
    com o cabeçalho "Access-Control-Allow-Origin: *" — sem esse cabeçalho,
    a leitura de pixels no navegador (usada pra reconhecimento facial e
    QR) trava com erro de segurança mesmo com a imagem aparecendo normal
    na tela (mesmo motivo documentado em proxy_webcam.py);
  - Se a câmera desconectar (cabo solto, queda de energia), tenta
    reconectar sozinho a cada poucos segundos, em vez de travar pra sempre.

INSTALAÇÃO NO RASPBERRY PI (Raspberry Pi OS)
----------------------------------------------
  sudo apt update
  sudo apt install -y python3-opencv
  python3 webcam_raspberry.py

Deixe rodando. Pra testar rapidinho se está funcionando, abra
http://<ip-do-pi>:9000/video num navegador de qualquer computador na mesma
rede — deve aparecer a imagem ao vivo da câmera (atualizando sozinha).

Pra descobrir o IP do Pi: rode "hostname -I" no próprio Pi.

DEIXAR RODANDO SOZINHO QUANDO O PI LIGAR (systemd)
-----------------------------------------------------
Crie o arquivo /etc/systemd/system/totem-webcam.service com este conteúdo
(ajuste o caminho do script se você colocou em outro lugar):

  [Unit]
  Description=Servidor da webcam do totem
  After=network.target

  [Service]
  ExecStart=/usr/bin/python3 /home/pi/webcam_raspberry.py
  Restart=always
  RestartSec=3
  User=pi

  [Install]
  WantedBy=multi-user.target

Depois:
  sudo systemctl daemon-reload
  sudo systemctl enable totem-webcam
  sudo systemctl start totem-webcam

Assim, se faltar luz e voltar, ou o Pi reiniciar sozinho, o servidor sobe
de novo sem precisar ninguém abrir um terminal.

IP FIXO — MUITO IMPORTANTE
-----------------------------
A tela que consome esse vídeo (terminal.js, constante USB_WEBCAM_URL) usa
um endereço fixo. Se o IP do Pi mudar (ex.: o roteador reiniciou e
distribuiu outro IP por DHCP), o totem para de achar a câmera. Configure
uma RESERVA DE IP no roteador pro endereço MAC do Raspberry Pi (toda
interface de administração de roteador doméstico tem essa opção, geralmente
em "DHCP" ou "Rede local") — isso garante que o Pi sempre recebe o mesmo IP,
sem precisar mexer no roteador nem no terminal.js de novo depois.

CÂMERA DE CABEÇA PRA BAIXO OU DE LADO?
------------------------------------------
Se a webcam ficar montada em algum ângulo estranho perto da catraca, ajuste
ROTACIONAR_GRAUS abaixo (0, 90, 180 ou 270) em vez de mexer fisicamente na
webcam.

SE O DESEMPENHO FICAR RUIM NUM RASPBERRY PI ZERO
-----------------------------------------------------
O Pi Zero 2 W é bem mais fraco que um Pi 3/4. Se o vídeo ficar engasgado:
  - baixe QUALIDADE_JPEG (ex.: 60);
  - aumente INTERVALO_MIN_ENTRE_QUADROS (ex.: 1/8 pra ~8 quadros por
    segundo em vez de ~15) — reconhecimento facial funciona bem mesmo com
    poucos quadros por segundo, a pessoa fica parada em frente à câmera por
    um instante de qualquer forma;
  - como alternativa mais avançada (fora do escopo deste script), existe o
    programa "mjpg-streamer" (via apt ou compilado), que é mais leve que
    Python+OpenCV por ser escrito em C — pergunte pro Claude se quiser
    trocar pra essa opção depois.
"""
import threading
import time

import cv2

# ---------------------------------------------------------------------------
# Configuração — ajuste aqui, não precisa mexer no resto do script.
# ---------------------------------------------------------------------------
DISPOSITIVO_CAMERA = 0  # /dev/video0 — troque pra 1, 2... se houver mais de uma câmera plugada
LARGURA = 640
ALTURA = 480
ROTACIONAR_GRAUS = 0  # 0, 90, 180 ou 270 — se a câmera estiver montada torta
QUALIDADE_JPEG = 80  # 0-100 (mais alto = imagem melhor, porém mais pesado)
INTERVALO_MIN_ENTRE_QUADROS = 1 / 15  # limita a ~15 quadros/segundo, pra não sobrecarregar o Pi
LISTEN_HOST = "0.0.0.0"  # 0.0.0.0 = aceita conexão de qualquer dispositivo na rede local
LISTEN_PORT = 9000

import http.server
import socketserver

_ROTACAO_CV2 = {
    90: cv2.ROTATE_90_CLOCKWISE,
    180: cv2.ROTATE_180,
    270: cv2.ROTATE_90_COUNTERCLOCKWISE,
}

quadro_atual = None
trava_quadro = threading.Lock()
parar = threading.Event()


def capturar_quadros():
    """Roda numa thread separada: mantém sempre o quadro mais recente da
    câmera pronto em memória (quadro_atual), pra várias pessoas conseguirem
    assistir o mesmo stream ao mesmo tempo sem reabrir a câmera de novo pra
    cada uma."""
    global quadro_atual
    captura = None
    while not parar.is_set():
        if captura is None or not captura.isOpened():
            print("Abrindo a câmera...")
            captura = cv2.VideoCapture(DISPOSITIVO_CAMERA)
            captura.set(cv2.CAP_PROP_FRAME_WIDTH, LARGURA)
            captura.set(cv2.CAP_PROP_FRAME_HEIGHT, ALTURA)
            if not captura.isOpened():
                print("Não consegui abrir a câmera — verifique se está plugada. Tentando de novo em 3s...")
                time.sleep(3)
                continue
            print("Câmera aberta com sucesso.")

        ok, quadro = captura.read()
        if not ok:
            print("Falha ao ler um quadro da câmera (pode ter desconectado) — reabrindo...")
            captura.release()
            captura = None
            time.sleep(1)
            continue

        if ROTACIONAR_GRAUS in _ROTACAO_CV2:
            quadro = cv2.rotate(quadro, _ROTACAO_CV2[ROTACIONAR_GRAUS])

        ok_jpeg, buffer = cv2.imencode(".jpg", quadro, [cv2.IMWRITE_JPEG_QUALITY, QUALIDADE_JPEG])
        if ok_jpeg:
            with trava_quadro:
                quadro_atual = buffer.tobytes()

        time.sleep(INTERVALO_MIN_ENTRE_QUADROS)


class StreamHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/video":
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=quadro")
        # Sem isso, a página do totem consegue MOSTRAR a imagem, mas o
        # navegador bloqueia a LEITURA de pixels (canvas) usada pro
        # reconhecimento facial e leitura de QR — mesmo detalhe documentado
        # em proxy_webcam.py.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()

        try:
            while not parar.is_set():
                with trava_quadro:
                    dados = quadro_atual
                if dados is None:
                    time.sleep(0.1)
                    continue
                self.wfile.write(b"--quadro\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(dados)}\r\n\r\n".encode())
                self.wfile.write(dados)
                self.wfile.write(b"\r\n")
                time.sleep(INTERVALO_MIN_ENTRE_QUADROS)
        except (BrokenPipeError, ConnectionResetError):
            # A pagina do totem trocou de tela ou fechou a conexão — normal, não é erro.
            pass

    def log_message(self, formato, *args):
        # Silencia o log padrão (uma linha por quadro seria barulho demais) — os prints
        # de cima (abrir/reabrir câmera) já avisam do que importa.
        pass


class ServidorStream(socketserver.ThreadingTCPServer):
    # Permite reiniciar o script rápido sem esperar a porta liberar sozinha,
    # e atender vários espectadores ao mesmo tempo (uma thread por conexão).
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    thread_captura = threading.Thread(target=capturar_quadros, daemon=True)
    thread_captura.start()

    with ServidorStream((LISTEN_HOST, LISTEN_PORT), StreamHandler) as servidor:
        print("Servidor da webcam do totem rodando.")
        print(f"Endereço na rede local: http://<ip-do-pi>:{LISTEN_PORT}/video")
        print('Rode "hostname -I" neste Pi pra descobrir o IP dele, se ainda não souber.')
        print("Deixe esta janela aberta (ou configure como serviço — ver instruções no topo do arquivo).")
        print("Ctrl+C para parar.")
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            parar.set()
            print("\nServidor encerrado.")
