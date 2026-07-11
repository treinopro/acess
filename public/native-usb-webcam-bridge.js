// Ponte entre o plugin nativo Android "UsbWebcam" (ver android-native-plugin/
// UsbWebcamPlugin.java no scaffold do totem-app) e o terminal.js existente.
// Feita pra ser um substituto direto do fluxo MJPEG (app "USB Camera" de
// terceiros + proxy Python via Termux, ver scripts/totem/proxy_webcam.py)
// usado hoje na versão navegador do totem — o resto do terminal.js (leitura
// de QR, reconhecimento facial) não precisa saber a diferença, porque os
// quadros chegam no mesmo <img> via data:image/jpeg;base64,...
//
// Rodando fora do app nativo (ex.: Chrome comum, sem Capacitor), disponivel()
// simplesmente retorna false e terminal.js usa o fluxo MJPEG de sempre — este
// arquivo é seguro de incluir em qualquer contexto.
(function () {
  function disponivel() {
    return Boolean(
      window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform() &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.UsbWebcam
    );
  }

  let listenerHandle = null;

  async function iniciar(onFrame) {
    const { UsbWebcam } = window.Capacitor.Plugins;
    if (listenerHandle) {
      await listenerHandle.remove();
      listenerHandle = null;
    }
    listenerHandle = await UsbWebcam.addListener('frame', (dados) => {
      if (dados && dados.base64) onFrame(dados.base64);
    });
    await UsbWebcam.startPreview();
  }

  async function parar() {
    if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.UsbWebcam) return;
    const { UsbWebcam } = window.Capacitor.Plugins;
    if (listenerHandle) {
      await listenerHandle.remove();
      listenerHandle = null;
    }
    try {
      await UsbWebcam.stopPreview();
    } catch {
      // ignora — pode já estar parada
    }
  }

  window.NativeUsbWebcam = { disponivel, iniciar, parar };
})();
