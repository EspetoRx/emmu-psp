// Pós-processamento de save state do PSP fora da main thread.
//
// O core PPSSPP precisa ficar na main thread (WebGL2 + pthreads), mas gzip,
// zip e a codificação PNG do preview são puro CPU. Sem este worker o autosave
// de 5 em 5 segundos bloqueava o WebView e o vídeo/áudio engasgavam.
import { gzipSync, zipSync } from "fflate";

self.onmessage = async (event) => {
  const { id, raw, saveFiles, pixels, width, height } = event.data || {};
  try {
    const compressed = raw
      ? gzipSync(raw, { level: 1 })
      : new Uint8Array(0);
    const saveData = saveFiles
      ? zipSync(saveFiles, { level: 1 })
      : new Uint8Array(0);

    let preview = null;
    if (pixels && pixels.length && typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      preview = new Uint8Array(await blob.arrayBuffer());
    }

    const transfer = [compressed.buffer, saveData.buffer];
    if (preview) transfer.push(preview.buffer);
    self.postMessage({ id, compressed, saveData, preview }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
