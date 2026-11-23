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
const RETROARCH_CFG = `autosave_interval = 0
screenshot_directory = "/"
block_sram_overwrite = false
video_gpu_screenshot = false
audio_latency = 128
audio_out_rate = 44100
video_top_portrait_viewport = true
video_vsync = true
video_smooth = false
fastforward_ratio = 3.0
slowmotion_ratio = 3.0
# O core resolve flash0: como <system_directory>/PPSSPP/flash0. Travar a raiz
# garante que as fontes PGF instaladas em /PPSSPP/flash0/font sejam encontradas.
system_directory = "/"
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

// WebKit/Safari 26.2+ não consegue clonar WebAssembly.Memory compartilhada via
// postMessage (DataCloneError), o que quebra o pool de pthreads do Emscripten.
// Nesses ambientes o runtime é carregado com o pool zerado: o core roda na main
// thread, sem paralelismo, mas inicializa e joga. O teste é síncrono — o mesmo
// DataCloneError é lançado por worker.postMessage dentro do executor da Promise
// do Emscripten e aparece como "Unhandled Promise Rejection" no console.
const PTHREAD_POOL_NEEDLE = "var pthreadPoolSize=32;";
const THREADING_SUPPORT_NEEDLE =
  'var _emscripten_has_threading_support=()=>typeof SharedArrayBuffer!="undefined";';

let sharedMemoryCloneable = null;

function canCloneSharedMemory() {
  if (sharedMemoryCloneable !== null) return sharedMemoryCloneable;
  try {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const module = new WebAssembly.Module(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    const workerUrl = URL.createObjectURL(
      new Blob(["self.onmessage=function(){}"], { type: "text/javascript" }),
    );
    const worker = new Worker(workerUrl);
    let ok = true;
    try {
      worker.postMessage({ wasmMemory: memory });
    } catch {
      ok = false;
    }
    if (ok) {
      try {
        worker.postMessage({ wasmModule: module });
      } catch {
        ok = false;
      }
    }
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    sharedMemoryCloneable = ok;
    return ok;
  } catch {
    sharedMemoryCloneable = false;
    return false;
  }
}

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
    runtimeLoadPromise = (async () => {
      let scriptUrl = `${RUNTIME_BASE}ppsspp_libretro.js`;
      if (!canCloneSharedMemory()) {
        if (globalThis.__emmuPspVerboseLogs) {
          console.warn(
            "[emmu-psp] clone de SharedArrayBuffer indisponível; carregando runtime sem pthreads",
          );
        }
        // WebKit sem clone de SharedArrayBuffer: o Emscripten não consegue
        // inicializar os pthreads, então carregamos um runtime sem pool e sem
        // suporte a threads. O blob permanece vivo porque o Emscripten guarda
        // _scriptName e pode acessá-lo depois do onload.
        const response = await fetch(scriptUrl);
        if (!response.ok) {
          throw new Error(
            `Não foi possível carregar o runtime PPSSPP (${response.status}).`,
          );
        }
        let source = await response.text();
        if (!source.includes(PTHREAD_POOL_NEEDLE)) {
          throw new Error(
            "O runtime PPSSPP não expõe o pool de pthreads esperado.",
          );
        }
        source = source.replace(PTHREAD_POOL_NEEDLE, "var pthreadPoolSize=0;");
        if (!source.includes(THREADING_SUPPORT_NEEDLE)) {
          throw new Error(
            "O runtime PPSSPP não expõe a verificação de threading esperada.",
          );
        }
        source = source.replace(
          THREADING_SUPPORT_NEEDLE,
          "var _emscripten_has_threading_support=()=>false;",
        );
        scriptUrl = URL.createObjectURL(
          new Blob([source], { type: "text/javascript" }),
        );
      }
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = scriptUrl;
        script.onload = () => resolve();
        script.onerror = () =>
          reject(new Error("Não foi possível carregar o runtime PPSSPP."));
        document.head.appendChild(script);
      });
      if (typeof globalThis.EJS_Runtime !== "function") {
        throw new Error("O runtime PPSSPP não expôs EJS_Runtime.");
      }
    })().catch((error) => {
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
  constructor(romBytes, options = {}) {
    this.romBytes = romBytes instanceof Uint8Array
      ? romBytes
      : new Uint8Array(romBytes || []);
    // O core sempre usa um canvas próprio e fresco (um canvas já usado por
    // 2D não aceita webgl2). Quando a UI fornece o palco, esse canvas é
    // acoplado sobre o canvas da UI, que fica oculto. O compositor apresenta
    // direto o drawing buffer do PPSSPP: sem tearing e sem cópia por frame.
    this.stage = options?.stage || null;
    this.module = null;
    this.functions = null;
    this.host = null;
    this.canvas = null;
    this.captureCanvas = null;
    this.captureContext = null;
    this.wasmUrl = null;
    this.disposed = false;
    this.volume = 1;
    this.saveWorker = null;
    this.saveWorkerSeq = 0;
    this.saveWorkerPending = new Map();
  }

  createSaveWorker() {
    if (this.saveWorker || this.disposed || typeof Worker === "undefined") {
      return;
    }
    try {
      const worker = new Worker(new URL("./save.worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event) => {
        const { id, error, ...result } = event.data || {};
        const pending = this.saveWorkerPending.get(id);
        if (!pending) return;
        this.saveWorkerPending.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      };
      worker.onerror = (event) => {
        if (globalThis.__emmuPspVerboseLogs) {
          console.warn("[emmu-psp] worker de save falhou", event.message);
        }
        this.disableSaveWorker();
      };
      this.saveWorker = worker;
    } catch (error) {
      if (globalThis.__emmuPspVerboseLogs) {
        console.warn("[emmu-psp] worker de save indisponível", error);
      }
    }
  }

  disableSaveWorker() {
    const worker = this.saveWorker;
    this.saveWorker = null;
    for (const pending of this.saveWorkerPending.values()) {
      pending.reject(new Error("worker de save encerrado"));
    }
    this.saveWorkerPending.clear();
    try {
      worker?.terminate();
    } catch {
      // worker já morto
    }
  }

  async callSaveWorker(payload, transfer = []) {
    this.createSaveWorker();
    if (!this.saveWorker) return null;
    const id = ++this.saveWorkerSeq;
    try {
      return await new Promise((resolve, reject) => {
        this.saveWorkerPending.set(id, { resolve, reject });
        this.saveWorker.postMessage({ id, ...payload }, transfer);
      });
    } catch {
      return null;
    }
  }

  async initialize() {
    if (globalThis.__emmuPspVerboseLogs) {
      console.log("[emmu-psp] environment", {
        href: location.href,
        coi: globalThis.crossOriginIsolated,
        sab: typeof SharedArrayBuffer,
        secure: globalThis.isSecureContext,
        clone: canCloneSharedMemory(),
        base: RUNTIME_BASE,
      });
    }
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
    if (this.stage) {
      // Overlay acoplado ao palco. O layout fica em 480/dpr × 272/dpr para o
      // ResizeObserver do PPSSPP reportar exatamente 480×272; o preenchimento
      // visual é feito com transform: scale(), que não altera contentRect. O
      // wrapper também impede que o Emscripten confunda o palco em fullscreen
      // com o parente do canvas e redimensione o buffer para a tela inteira.
      this.host.className = "psp-canvas-layer";
      this.stage.classList.add("psp-active");
      this.stage.appendChild(this.host);
    } else {
      // Fallback fora da UI: host oculto.
      this.host.setAttribute("aria-hidden", "true");
      this.host.style.cssText =
        "position:fixed;left:-10000px;top:0;width:480px;height:272px;opacity:0;pointer-events:none;";
      document.body.appendChild(this.host);
    }
    this.canvas = document.createElement("canvas");
    this.canvas.width = FRAME_WIDTH;
    this.canvas.height = FRAME_HEIGHT;
    this.host.appendChild(this.canvas);

    const nativeGetContext = this.canvas.getContext.bind(this.canvas);
    this.canvas.getContext = (type, attributes) => {
      const context = nativeGetContext(
        type,
        String(type).includes("webgl")
          ? { ...(attributes || {}), preserveDrawingBuffer: true }
          : attributes,
      );
      if (String(type).includes("webgl") && context) this.gl = context;
      return context;
    };

    this.captureCanvas = document.createElement("canvas");
    this.captureCanvas.width = FRAME_WIDTH;
    this.captureCanvas.height = FRAME_HEIGHT;
    this.captureContext = this.captureCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    this.captureContext.imageSmoothingEnabled = false;
    this.rawBuffer = null;
    this.flippedPixels = null;
    this.rawCanvas = null;
    this.rawContext = null;

    const wasmBytes = await this.fetchBytes(`${RUNTIME_BASE}ppsspp_libretro.wasm`);
    this.wasmUrl = URL.createObjectURL(
      new Blob([wasmBytes], { type: "application/wasm" }),
    );
    this.module = await globalThis.EJS_Runtime({
      noInitialRun: true,
      arguments: [],
      canvas: this.canvas,
      parent: this.host || this.canvas.parentElement || document.body,
      print: (message) => {
        if (globalThis.__emmuPspVerboseLogs) console.log("[psp]", message);
      },
      printErr: (message) => {
        if (globalThis.__emmuPspVerboseLogs) console.warn("[psp]", message);
      },
      onAbort: (reason) => {
        console.error("[emmu-psp] onAbort", reason, new Error().stack);
      },
      locateFile: (name) => (name.endsWith(".wasm") ? this.wasmUrl : name),
      getSavExt: () => ".srm",
    });

    // WebAssembly não tem JIT nativo: "IR JIT" é o modo rápido do PPSSPP neste
    // alvo. O padrão do runtime EmulatorJS é "Interpreter", bem mais lento em
    // jogos 3D como Need for Speed.
    try {
      const setVariable = this.module.cwrap("ejs_set_variable", "null", [
        "string",
        "string",
      ]);
      setVariable("ppsspp_cpu_core", "IR JIT");
      // A ISO já vive no MEMFS. Manter bCacheFullIsoInRam faria o core copiar
      // mais ~0,9 GB (NFS) para outro buffer, pressionando GC/heap na web.
      setVariable("ppsspp_cache_iso", "disabled");
    } catch (error) {
      if (globalThis.__emmuPspVerboseLogs) {
        console.warn("[emmu-psp] falha ao definir opções do core", error);
      }
    }

    this.prepareFileSystem();
    await this.installAssets();

    const FS = this.module.FS;
    if (globalThis.__emmuPspVerboseLogs) {
      console.log(
        "[emmu-psp] font paths",
        [
          "/PPSSPP/flash0/font/ltn0.pgf",
          "/home/web_user/PPSSPP/flash0/font/ltn0.pgf",
          "/data/PPSSPP/flash0/font/ltn0.pgf",
          "/data/saves/PPSSPP/flash0/font/ltn0.pgf",
          "/data/saves/PPSSPP/PSP/flash0/font/ltn0.pgf",
        ].map((path) => [path, FS.analyzePath(path).exists]),
      );
    }
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
    };
    if (globalThis.__emmuPspVerboseLogs) {
      const options = this.module.cwrap("get_core_options", "string", [])();
      console.log(
        "[emmu-psp] cpu core option",
        options
          .split("\n")
          .find((line) => line.startsWith("ppsspp_cpu_core")) ?? "(ausente)",
      );
    }

    // resumeMainLoop() já foi chamado após callMain; o toggle garante que o
    // loop do RetroArch esteja ativo mesmo se o core tiver pausado no boot.
    try {
      this.functions.toggleMainLoop(1);
    } catch {
      // loop já ativo
    }
    for (const ctx of Object.values(this.module.AL?.contexts || {})) {
      try {
        await (ctx.audioCtx || ctx.gain?.context)?.resume();
      } catch {
        // áudio ainda não inicializado nesta fase
      }
    }
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

    // O libretro resolve a pasta base como <system_directory>/PPSSPP. O
    // retroarch.cfg acima força "/", mas alguns frontends Emscripten reportam
    // outro diretório. Links simbólicos baratos cobrem as alternativas sem
    // duplicar os ~6 MB das fontes no heap do MEMFS.
    for (const path of [
      "/home/web_user/PPSSPP",
      "/data/PPSSPP",
      "/data/saves/PPSSPP",
    ]) {
      if (FS.analyzePath(path).exists) continue;
      try {
        FS.symlink("/PPSSPP", path);
      } catch {
        // diretório pai ausente (frontend não criou) — caminho não usado
      }
    }
    // Caminho alternativo que o core tenta para fontes: ms0:/PSP/flash0/font/.
    try {
      if (!FS.analyzePath("/data/saves/PPSSPP/PSP/flash0").exists) {
        FS.symlink("/PPSSPP/flash0", "/data/saves/PPSSPP/PSP/flash0");
      }
    } catch {
      // MEMFS sem suporte a symlink neste ponto
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
    const gl = this.gl;
    if (!gl || !this.captureContext) return new Uint8ClampedArray(0);
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!width || !height) return new Uint8ClampedArray(0);

    // Buffers reaproveitados: alocar ~0,5 MB por frame (raw + ImageData) gerava
    // GC constante e deixava o jogo com solavancos mesmo com 60 fps estáveis.
    const length = width * height * 4;
    if (!this.rawBuffer || this.rawBuffer.length !== length) {
      this.rawBuffer = new Uint8Array(length);
      this.flippedPixels = new Uint8ClampedArray(length);
      this.rawCanvas = null;
    }
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(
      0,
      0,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.rawBuffer,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);

    const rowBytes = width * 4;
    const flipped = this.flippedPixels;
    for (let y = 0; y < height; y += 1) {
      flipped.set(
        this.rawBuffer.subarray(
          (height - 1 - y) * rowBytes,
          (height - y) * rowBytes,
        ),
        y * rowBytes,
      );
    }

    // Com o CSS travado em 480/dpr × 272/dpr o drawingBuffer já é nativo:
    // devolver o buffer invertido evita drawImage + getImageData por frame.
    if (width === FRAME_WIDTH && height === FRAME_HEIGHT) return flipped;

    // Fallback para configurações que ainda entregam outro tamanho.
    if (!this.rawCanvas) {
      this.rawCanvas = document.createElement("canvas");
      this.rawContext = this.rawCanvas.getContext("2d");
    }
    if (this.rawCanvas.width !== width || this.rawCanvas.height !== height) {
      this.rawCanvas.width = width;
      this.rawCanvas.height = height;
    }
    this.rawContext.putImageData(new ImageData(flipped, width, height), 0, 0);
    this.captureContext.drawImage(
      this.rawCanvas,
      0,
      0,
      FRAME_WIDTH,
      FRAME_HEIGHT,
    );
    return this.captureContext.getImageData(
      0,
      0,
      FRAME_WIDTH,
      FRAME_HEIGHT,
    ).data;
  }

  async runFrame(renderGraphics = true) {
    if (this.disposed || !this.module) {
      throw new Error("O emulador PSP já foi encerrado.");
    }
    const startedAt = performance.now();
    if (globalThis.__emmuPspVerboseLogs && this.gl && renderGraphics) {
      const width = this.gl.drawingBufferWidth;
      const height = this.gl.drawingBufferHeight;
      if (width !== FRAME_WIDTH || height !== FRAME_HEIGHT) {
        console.warn("[emmu-psp] drawingBuffer divergente", {
          width,
          height,
          canvas: `${this.canvas.width}x${this.canvas.height}`,
        });
      }
    }
    // O PPSSPP desenha direto no canvas do overlay. O compositor do
    // navegador apresenta o drawing buffer completo (swap chain), sem o tearing
    // que o drawImage causava ao capturar o meio do desenho do thread de GPU.
    // Também não há readPixels + flip + putImageData por frame: era isso que
    // deixava a web lenta com áudio/vídeo travando.
    //
    // Frame vazio => drawFrame() da UI não mexe neste canvas (um canvas só
    // aceita um tipo de contexto; getContext("2d") aqui retornaria null).
    const frame = new Uint8ClampedArray(0);
    if (globalThis.__emmuPspVerboseLogs) {
      this.perfFrames = (this.perfFrames || 0) + 1;
      if (this.perfFrames % 60 === 0) {
        const now = performance.now();
        console.log("[emmu-psp] perf", {
          uiFrames: this.perfFrames,
          wallMs: Math.round(now - (this.perfSince ?? now)),
          coreFrames: this.functions?.frameCount?.() ?? -1,
        });
        this.perfSince = now;
      }
    }
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
    this.saveStartedAt = performance.now();
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
    const rawSize = raw.length;
    const saveFiles = listFiles(
      this.module.FS,
      "/data/saves/PPSSPP/PSP/SAVEDATA",
    );
    // gzip/zip rodam no worker de save: na main thread eles bloqueavam o
    // WebView por centenas de ms e o vídeo/áudio engasgavam no autosave.
    // Transferir o buffer evita clonar ~40 MiB só para entregar ao worker.
    const result = await this.callSaveWorker(
      { raw, saveFiles },
      [raw.buffer],
    );
    let compressed;
    let saveData;
    if (result?.compressed && result?.saveData) {
      compressed = result.compressed;
      saveData = result.saveData;
    } else {
      // O buffer original foi transferido ao worker; se ele falhou, relê o
      // estado da HEAP antes de comprimir no fallback síncrono.
      const [retrySizeText, retryPointerText] = (
        this.functions.saveStateInfo() || info
      ).split("|");
      const retrySize = Number(retrySizeText);
      const retryPointer = Number(retryPointerText);
      const fallbackRaw =
        Number.isFinite(retrySize) && retrySize > 0 &&
        Number.isFinite(retryPointer)
          ? this.module.HEAPU8
              .subarray(retryPointer, retryPointer + retrySize)
              .slice()
          : new Uint8Array(0);
      compressed = gzipSync(fallbackRaw, { level: 1 });
      saveData = zipSync(saveFiles, { level: 1 });
    }
    if (globalThis.__emmuPspVerboseLogs) {
      console.log("[emmu-psp] save", {
        coreMs: Math.round(performance.now() - this.saveStartedAt),
        rawBytes: rawSize,
        compressedBytes: compressed.length,
        saveDataBytes: saveData.length,
        worker: Boolean(result),
      });
    }
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
    // A codificação PNG também sai da main thread. O readPixels é rápido, mas
    // toDataURL(ImageData) de 480×272 custava alguns ms a cada autosave.
    const result = await this.callSaveWorker({
      pixels,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    });
    if (result?.preview) return result.preview;

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
    this.disableSaveWorker();
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
    this.stage?.classList.remove("psp-active");
    if (this.wasmUrl) URL.revokeObjectURL(this.wasmUrl);
    this.functions = null;
    this.module = null;
    this.canvas = null;
    this.captureCanvas = null;
    this.captureContext = null;
    this.rawBuffer = null;
    this.flippedPixels = null;
    this.rawCanvas = null;
    this.rawContext = null;
    this.host = null;
    this.wasmUrl = null;
  }
}

export function createPspAdapter(romBytes, options) {
  return new PspAdapter(romBytes, options);
}
