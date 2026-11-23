// Adaptador main-thread do PPSSPP/Emscripten para o contrato de core do Emmu.
//
// O core EmulatorJS/PPSSPP é uma aplicação Emscripten completa (DOM + WebGL2 +
// pthreads), não um módulo de Web Worker. Por isso o PSP é o único console que
// roda fora do snes.worker.js, inclusive no desktop. A API exposta aqui imita
// o EmulationWorkerClient usado por useEmulator.js.
import { gunzipSync, gzipSync, unzipSync, zipSync } from "fflate";

const FRAME_WIDTH = 480;
const FRAME_HEIGHT = 272;
const AUDIO_SAMPLE_RATE = 44100;
const SAVE_MAGIC = "EMMUPSP1";
const SAVE_VERSION = 1;
const SAVE_FLAG_GZIP_STATE = 1;
const RUNTIME_BASE = (
  globalThis.__EMMU_PSP_BASE__ ||
  (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) ||
  "/"
).replace(/\/?$/, "/") + "wasm/psp/";

// Configuração validada na POC com ULUS-10036. Não adicionar opções de
// vsync/fast-forward: elas mudam o caminho de save state do RetroArch.
const RETROARCH_CFG = `autosave_interval = 60
screenshot_directory = "/"
block_sram_overwrite = false
video_smooth = false
audio_latency = 64
savefile_directory = "/data/saves"
savestate_directory = "/data/saves"
`;

// RetroArch/PPSSPP button indices usados pelo core EmulatorJS.
// Ver: EmulatorJS/emulator.js, getControlScheme() === "psp".
const PSP_BUTTONS = {
  A: 0, // × (Cross)
  X: 1, // □ (Square)
  B: 8, // ○ (Circle)
  Y: 9, // △ (Triangle)
  Select: 2,
  Start: 3,
  Up: 4,
  Down: 5,
  Left: 6,
  Right: 7,
  L: 10,
  R: 11,
  // EJS usa 16..19 para o analógico e espera 0x7fff quando pressionado.
  AnalogRight: 16,
  AnalogLeft: 17,
  AnalogDown: 18,
  AnalogUp: 19,
};
const ANALOG_BUTTONS = new Set([
  "AnalogUp",
  "AnalogDown",
  "AnalogLeft",
  "AnalogRight",
]);

let runtimeLoadPromise = null;

// WKWebView no macOS (esquema tauri://) esconde o global SharedArrayBuffer e
// reporta crossOriginIsolated=false, mesmo com pthreads disponíveis. O construtor
// nativo continua acessível pelo buffer de uma WebAssembly.Memory compartilhada;
// recuperá-lo aqui evita rejeitar um WebView que suporta threads via WASM.
function ensureSharedArrayBuffer() {
  if (typeof SharedArrayBuffer === "function") return true;
  try {
    const sharedMemory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    globalThis.SharedArrayBuffer = sharedMemory.buffer.constructor;
    return typeof SharedArrayBuffer === "function";
  } catch {
    return false;
  }
}

function loadRuntime() {
  if (typeof globalThis.EJS_Runtime === "function") return Promise.resolve();
  if (!runtimeLoadPromise) {
    runtimeLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${RUNTIME_BASE}ppsspp_libretro.js`;
      script.onload = () => {
        if (typeof globalThis.EJS_Runtime === "function") resolve();
        else reject(new Error("O runtime PPSSPP não expôs EJS_Runtime."));
      };
      script.onerror = () =>
        reject(new Error("Não foi possível carregar o runtime PPSSPP."));
      document.head.appendChild(script);
    }).catch((error) => {
      runtimeLoadPromise = null;
      throw error;
    });
  }
  return runtimeLoadPromise;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function concat(chunks) {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function listFiles(FS, dir, prefix = "") {
  const result = {};
  let entries;
  try {
    entries = FS.readdir(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry === "." || entry === "..") continue;
    const path = `${dir}/${entry}`;
    const stat = FS.stat(path);
    if (FS.isDir(stat.mode)) {
      Object.assign(result, listFiles(FS, path, `${prefix}${entry}/`));
    } else {
      result[`${prefix}${entry}`] = FS.readFile(path);
    }
  }
  return result;
}

function removeTree(FS, path) {
  if (!FS.analyzePath(path).exists) return;
  for (const entry of FS.readdir(path)) {
    if (entry === "." || entry === "..") continue;
    const child = `${path}/${entry}`;
    const stat = FS.stat(child);
    if (FS.isDir(stat.mode)) removeTree(FS, child);
    else FS.unlink(child);
  }
  FS.rmdir(path);
}

export class PspAdapter {
  constructor(romBytes) {
    this.romBytes = romBytes instanceof Uint8Array
      ? romBytes
      : new Uint8Array(romBytes || []);
    this.module = null;
    this.functions = null;
    this.host = null;
    this.canvas = null;
    this.captureCanvas = null;
    this.captureContext = null;
    this.wasmUrl = null;
    this.disposed = false;
    this.volume = 1;
  }

  async initialize() {
    if (this.disposed) throw new Error("O emulador PSP já foi encerrado.");
    if (typeof window === "undefined" || typeof document === "undefined") {
      throw new Error("O runtime PSP precisa de um DOM (window/document).");
    }
    if (!ensureSharedArrayBuffer()) {
      throw new Error(
        "PSP exige SharedArrayBuffer/pthreads (COOP same-origin + COEP require-corp no web) " +
          `(crossOriginIsolated=${globalThis.crossOriginIsolated}, SharedArrayBuffer=${typeof SharedArrayBuffer}, secure=${globalThis.isSecureContext}).`,
      );
    }
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2")) {
      throw new Error("PSP exige WebGL2.");
    }

    await loadRuntime();

    this.host = document.createElement("div");
    this.host.setAttribute("aria-hidden", "true");
    this.host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:480px;height:272px;opacity:0;pointer-events:none;";
    this.canvas = document.createElement("canvas");
    this.canvas.width = FRAME_WIDTH;
    this.canvas.height = FRAME_HEIGHT;
    this.host.appendChild(this.canvas);
    document.body.appendChild(this.host);

    const nativeGetContext = this.canvas.getContext.bind(this.canvas);
    this.canvas.getContext = (type, attributes) =>
      nativeGetContext(
        type,
        String(type).includes("webgl")
          ? { ...(attributes || {}), preserveDrawingBuffer: true }
          : attributes,
      );

    this.captureCanvas = document.createElement("canvas");
    this.captureCanvas.width = FRAME_WIDTH;
    this.captureCanvas.height = FRAME_HEIGHT;
    this.captureContext = this.captureCanvas.getContext("2d", {
      willReadFrequently: true,
    });

    const wasmBytes = await this.fetchBytes(`${RUNTIME_BASE}ppsspp_libretro.wasm`);
    this.wasmUrl = URL.createObjectURL(
      new Blob([wasmBytes], { type: "application/wasm" }),
    );
    this.module = await globalThis.EJS_Runtime({
      noInitialRun: true,
      arguments: [],
      canvas: this.canvas,
      parent: this.host,
      print: () => {},
      printErr: (message) => {
        if (globalThis.__emmuPspVerboseLogs) console.warn("[psp]", message);
      },
      locateFile: (name) => (name.endsWith(".wasm") ? this.wasmUrl : name),
      getSavExt: () => ".srm",
    });

    this.prepareFileSystem();
    await this.installAssets();

    const FS = this.module.FS;
    FS.writeFile("/game.iso", new Uint8Array(this.romBytes), { canOwn: true });
    this.module.callMain(["/game.iso"]);
    this.module.resumeMainLoop?.();

    this.functions = {
      simulateInput: this.module.cwrap("simulate_input", "null", [
        "number",
        "number",
        "number",
      ]),
      saveStateInfo: this.module.cwrap("save_state_info", "string", []),
      cmdSaveState: this.module.cwrap("cmd_save_state", "null", []),
      loadState: this.module.cwrap("load_state", "number", [
        "string",
        "number",
      ]),
      restart: this.module.cwrap("system_restart", "null", []),
      toggleMainLoop: this.module.cwrap("toggleMainLoop", "null", ["number"]),
      frameCount: this.module.cwrap("get_current_frame_count", "number", []),
      dimensions: this.module.cwrap("get_video_dimensions", "number", [
        "string",
      ]),
    };

    await this.waitForFirstFrame();
    return this;
  }

  async fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Falha ao carregar ${url}: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  }

  prepareFileSystem() {
    const FS = this.module.FS;
    const mkdir = (path) => {
      try {
        FS.mkdir(path);
      } catch (error) {
        if (!FS.analyzePath(path).exists) throw error;
      }
    };
    for (const path of [
      "/home",
      "/home/web_user",
      "/home/web_user/.config",
      "/home/web_user/.config/retroarch",
      "/data",
      "/data/saves",
      "/data/saves/PPSSPP",
      "/data/saves/PPSSPP/PSP",
      "/data/saves/PPSSPP/PSP/SAVEDATA",
      "/data/saves/PPSSPP/PSP/PPSSPP_STATE",
      "/PPSSPP",
    ]) {
      mkdir(path);
    }
    FS.writeFile(
      "/home/web_user/.config/retroarch/retroarch.cfg",
      RETROARCH_CFG,
    );
  }

  async installAssets() {
    const zipBytes = await this.fetchBytes(`${RUNTIME_BASE}ppsspp-assets.zip`);
    const files = unzipSync(new Uint8Array(zipBytes));
    const FS = this.module.FS;
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith("/")) continue;
      const path = `/PPSSPP/${name}`;
      const parts = path.split("/");
      let current = "";
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (!parts[index]) continue;
        current += `/${parts[index]}`;
        try {
          FS.mkdir(current);
        } catch {
          // diretório já existe
        }
      }
      FS.writeFile(path, data, { canOwn: true });
    }
  }

  async waitForFirstFrame() {
    if (!this.functions) return;
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline && !this.disposed) {
      try {
        if (this.functions.frameCount() > 0) return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  capturePixels() {
    if (!this.captureContext || !this.canvas) {
      return new Uint8ClampedArray(0);
    }
    this.captureContext.drawImage(this.canvas, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    return this.captureContext.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT)
      .data;
  }

  async runFrame(renderGraphics = true) {
    if (this.disposed || !this.module) {
      throw new Error("O emulador PSP já foi encerrado.");
    }
    const startedAt = performance.now();
    const frame = renderGraphics ? this.capturePixels() : new Uint8ClampedArray(0);
    return {
      frame,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      // O áudio é reproduzido pelo OpenAL/WebAudio do próprio Emscripten.
      audioSamples: new Float32Array(0),
      audioSampleRate: AUDIO_SAMPLE_RATE,
      audioChannels: 2,
      processingTimeMs: performance.now() - startedAt,
    };
  }

  setButton(button, pressed, player = 1) {
    if (this.disposed || !this.functions) return Promise.resolve();
    const index = PSP_BUTTONS[button];
    if (index === undefined) return Promise.resolve();
    const slot = Math.max(0, Math.min(3, (player | 0) - 1 || 0));
    const value = pressed ? (ANALOG_BUTTONS.has(button) ? 0x7fff : 1) : 0;
    try {
      this.functions.simulateInput(slot, index, value);
    } catch (error) {
      console.warn("[psp] simulate_input falhou", error);
    }
    return Promise.resolve();
  }

  setVolume(volume) {
    this.volume = Math.min(1, Math.max(0, Number(volume) || 0));
    if (!this.module?.AL?.currentCtx?.sources) return Promise.resolve();
    for (const source of this.module.AL.currentCtx.sources) {
      try {
        if (source?.gain?.gain) source.gain.gain.value = this.volume;
      } catch {
        // fonte já liberada
      }
    }
    return Promise.resolve();
  }

  async saveState() {
    if (this.disposed || !this.functions) {
      throw new Error("O emulador PSP já foi encerrado.");
    }
    // O RetroArch só registra o caminho do save state depois que o core já
    // processou pelo menos um ciclo. No autosave que acontece junto com o
    // primeiro frame isso ainda não aconteceu; repetir cmd_save_state cobre a
    // inicialização sem afetar saves feitos durante a partida.
    let info = "";
    const deadline = performance.now() + 1500;
    while (performance.now() < deadline && !this.disposed) {
      this.functions.cmdSaveState();
      info = this.functions.saveStateInfo() || "";
      if (/^\d+\|\d+/.test(info)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [sizeText, pointerText] = info.split("|");
    const size = Number(sizeText);
    const pointer = Number(pointerText);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(pointer)) {
      throw new Error(`O PPSSPP não retornou um save state válido: ${info}`);
    }
    const raw = this.module.HEAPU8.subarray(pointer, pointer + size).slice();
    const compressed = gzipSync(raw, { level: 6 });
    const saveData = zipSync(
      listFiles(
        this.module.FS,
        "/data/saves/PPSSPP/PSP/SAVEDATA",
      ),
    );
    const encoder = new TextEncoder();
    return concat([
      encoder.encode(SAVE_MAGIC),
      u32(SAVE_VERSION),
      u32(SAVE_FLAG_GZIP_STATE),
      u32(compressed.length),
      compressed,
      u32(saveData.length),
      saveData,
    ]);
  }

  loadState(state) {
    if (this.disposed || !this.functions) {
      throw new Error("O emulador PSP já foi encerrado.");
    }
    const bytes = state instanceof Uint8Array ? state : new Uint8Array(state || []);
    if (bytes.length < 28) throw new Error("Save state PSP inválido.");
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (magic !== SAVE_MAGIC) throw new Error("Save state PSP com magic desconhecido.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(8, true);
    if (version !== SAVE_VERSION) {
      throw new Error(`Save state PSP versão ${version} não suportado.`);
    }
    const flags = view.getUint32(12, true);
    const stateLength = view.getUint32(16, true);
    let offset = 20;
    if (offset + stateLength + 4 > bytes.length) {
      throw new Error("Save state PSP truncado.");
    }
    let raw = bytes.subarray(offset, offset + stateLength);
    if (flags & SAVE_FLAG_GZIP_STATE) raw = gunzipSync(raw);
    offset += stateLength;
    const saveLength = view.getUint32(offset, true);
    offset += 4;
    if (offset + saveLength > bytes.length) {
      throw new Error("Save data PSP truncado.");
    }

    const FS = this.module.FS;
    FS.writeFile("/game.state", raw, { canOwn: true });
    const saveRoot = "/data/saves/PPSSPP/PSP/SAVEDATA";
    removeTree(FS, saveRoot);
    FS.mkdir(saveRoot);
    const saveFiles = unzipSync(bytes.subarray(offset, offset + saveLength));
    for (const [name, data] of Object.entries(saveFiles)) {
      if (name.endsWith("/")) continue;
      const parts = name.split("/");
      let current = saveRoot;
      for (let index = 0; index < parts.length - 1; index += 1) {
        current += `/${parts[index]}`;
        try {
          FS.mkdir(current);
        } catch {
          // diretório já existe
        }
      }
      FS.writeFile(`${current}/${parts.at(-1)}`, data, { canOwn: true });
    }

    this.functions.loadState("game.state", 0);
    setTimeout(() => {
      try {
        FS.unlink("/game.state");
      } catch {
        // já removido pelo core
      }
    }, 1000);
    return Promise.resolve();
  }

  async restart() {
    if (this.disposed || !this.functions) {
      throw new Error("O emulador PSP já foi encerrado.");
    }
    this.functions.restart();
    this.module.resumeMainLoop?.();
    this.setVolume(this.volume);
    await this.waitForFirstFrame();
  }

  async capturePreview() {
    const pixels = this.capturePixels();
    if (!pixels.length) return new Uint8Array(0);
    this.captureContext.putImageData(
      new ImageData(pixels, FRAME_WIDTH, FRAME_HEIGHT),
      0,
      0,
    );
    const dataUrl = this.captureCanvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1] || "";
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      out[index] = binary.charCodeAt(index);
    }
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.functions?.toggleMainLoop(0);
      this.module?.pauseMainLoop?.();
    } catch {
      // core já parou
    }
    try {
      this.module?.abort?.();
    } catch {
      // abort lança string quando o runtime já foi finalizado
    }
    if (this.host?.parentNode) this.host.parentNode.removeChild(this.host);
    if (this.wasmUrl) URL.revokeObjectURL(this.wasmUrl);
    this.functions = null;
    this.module = null;
    this.canvas = null;
    this.captureCanvas = null;
    this.captureContext = null;
    this.host = null;
    this.wasmUrl = null;
  }
}

export function createPspAdapter(romBytes) {
  return new PspAdapter(romBytes);
}
