# emmu-psp

Módulo PSP do Emmu. O runtime é o **PPSSPP** compilado para Emscripten/RetroArch
e distribuído como core do EmulatorJS, vendorizado em `vendor/ppsspp-ejs/`.

## Por que não é um crate WASM como os outros?

O PPSSPP Emscripten é uma aplicação completa: usa `window`, `document`, canvas,
WebGL2, pthreads e `SharedArrayBuffer`. Ele não roda em `Web Worker` e não expõe
`new(rom)/runFrame()/setButton()` nativamente. O adaptador `js/adapter.js`
roda na **main thread**, inclusive no desktop, e traduz o contrato do Emmu para
as funções exportadas pelo RetroArch (`simulate_input`, `cmd_save_state`,
`load_state`, `system_restart`, `toggleMainLoop`).

| Plataforma | Backend |
| --- | --- |
| Web | `PspAdapter` na main thread, com WebGL2 + pthreads |
| Desktop (Tauri) | o mesmo `PspAdapter` dentro do WebView; Mesen rejeita PSP |

## Requisitos obrigatórios

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `SharedArrayBuffer` e WebGL2 disponíveis

O Vite e o `tauri.conf.json` já enviam esses headers. Em hospedagem estática, o
servidor precisa enviá-los; sem isso o core falha com mensagem explícita.

No macOS, o WKWebView no esquema `tauri://` esconde o global `SharedArrayBuffer`
e reporta `crossOriginIsolated === false`, mesmo com pthreads disponíveis. O
adaptador contorna isso recuperando o construtor nativo a partir do buffer de uma
`WebAssembly.Memory({ shared: true })`; o guard só falha se a memória
compartilhada realmente não existir. No navegador (origem `http`/`https`), os
headers COOP/COEP continuam obrigatórios para expor o `SharedArrayBuffer`.

## Frame e áudio

- Frame 480×272. O adaptador cria um canvas próprio e o acopla como overlay
  (`.psp-canvas-layer`) sobre o canvas da UI, que fica oculto. O compositor do
  navegador apresenta o drawing buffer direto: sem `readPixels`/`drawImage` por
  frame. `runFrame()` devolve um frame vazio e `drawFrame()` da UI o ignora.
- **Não** fazer cópia por frame: `drawImage()` do canvas WebGL captura o meio do
  desenho do thread de GPU (texto "DERSPEED"/"MeSEWANTELS") e `readPixels` +
  flip + `putImageData` custa ~0,5 MB a 60 Hz, deixando a web lenta com áudio e
  vídeo travando.
- O overlay mantém o layout em `480/dpr × 272/dpr` e a UI aplica
  `transform: scale()`; assim o `ResizeObserver` do core continua vendo 480×272.
- `capturePixels()` (readPixels) ficou apenas em `capturePreview()`, usado na
  miniatura e no save manual.
- O core reporta 480×270 internamente; o adaptador entrega 480×272 para manter
  o tamanho nativo do LCD do PSP.
- `ppsspp_cpu_core` é forçado para `IR JIT`: o padrão do runtime EmulatorJS é
  `Interpreter`, bem mais lento em WebAssembly.
- Áudio é reproduzido pelo OpenAL/WebAudio do próprio Emscripten. O adaptador
  devolve bloco vazio para o worklet do Emmu e controla o volume via
  `Module.AL.currentCtx.sources`.

### Dimensionamento do canvas (obrigatório)

O runtime PPSSPP observa `contentRect * devicePixelRatio` do canvas e
redimensiona o próprio backing store. O adaptador fixa o CSS do canvas interno
em `480 / dpr × 272 / dpr` para que o core reporte exatamente 480×272.

- Sem CSS, num display DPR=2 o canvas dobra de tamanho a cada callback de
  `ResizeObserver` até virar 62 mil × 35 mil; o `readPixels` passa a ler um
  buffer gigante e preto e o console enche de `ResizeObserver loop completed
  with undelivered notifications`.
- Com CSS em `100%` do host, o core renderiza 960×544 e a redução para 480×272
  degrada o texto (dupla reamostragem).
- A captura reaproveita os buffers raw e invertido entre frames. Alocar ~0,5 MB
  por frame (raw + `ImageData`) provoca GC constante e solavancos mesmo com
  `frameCount` subindo normalmente.

## Controles

| Ação Emmu | Botão RetroArch/PPSSPP |
| --- | --- |
| `A` | × (Cross) |
| `B` | ○ (Circle) |
| `X` | □ (Square) |
| `Y` | △ (Triangle) |
| `Start` / `Select` | Start / Select |
| `Up/Down/Left/Right` | D-pad |
| `L` / `R` | L / R |
| `AnalogUp/Down/Left/Right` | analógico digital (0x7fff) |

`Z` e os C-buttons do N64 não existem no PSP e são ignorados.

## Save state

Envelope próprio, magic `EMMUPSP1`, versão `1`:

```text
"EMMUPSP1" (8 bytes)
u32 LE version = 1
u32 LE flags (bit 0 = estado gzip)
u32 LE tamanho do estado comprimido
bytes do estado gzip (obtido de save_state_info)
u32 LE tamanho do ZIP da save data
ZIP de /data/saves/PPSSPP/PSP/SAVEDATA
```

O estado bruto do PPSSPP tem ~40 MiB e comprime bem; a save data do cartão de
memória é guardada dentro do mesmo envelope porque o `.ppst` não a inclui. O
load rejeita magic/versão desconhecidos e comprimentos inconsistentes.

### Autosave sem travar a emulação

O core roda obrigatoriamente na main thread (WebGL2 + pthreads), mas o
pós-processamento do save roda em `js/save.worker.js`: gzip do estado, ZIP da
save data e codificação PNG do preview. O adaptador copia o estado bruto da
HEAPU8, envia ao worker e monta o envelope com o resultado; se o worker não
carregar, há fallback síncrono com nível de compressão `1`.

O autosave de 5 s não tira mais preview do canvas WebGL — a miniatura existente
é reaproveitada. O save manual continua capturando um novo preview. Com
`globalThis.__emmuPspVerboseLogs = true`, o log `[emmu-psp] save` mostra
`coreMs`, tamanhos e se o worker foi usado.

## Build

`npm run build:wasm` na UI copia os artefatos deste crate para
`platforms/web/ui/public/wasm/psp/` e o adaptador **e o worker** para
`platforms/web/ui/src/wasm/psp/`. `src/wasm/` e `public/wasm/` são gerados e não
devem ser editados. O Vite empacota o worker como `dist/assets/save.worker-*.js`;
o `postbuild` valida que ele está presente.

## Validação

ROM usada no smoke test: `Need for Speed - Most Wanted - 5-1-0 (USA).iso`
(`ULUS-10036`, 926.580.736 bytes). Validar vídeo, áudio, input, restart,
save/load e histórico no web e no desktop.

## Licença

Wrapper/crate: GPL-3.0-or-later. Runtime vendorizado: GPL-2.0-or-later (ver
`vendor/ppsspp-ejs/license.txt` e `UPSTREAM.txt`).
