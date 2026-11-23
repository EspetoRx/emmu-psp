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

- Frame RGBA8888 480×272 (`aspect-ratio: 480 / 272` na UI).
- O core reporta 480×270 internamente; o adaptador devolve 480×272 para manter
  o tamanho nativo do LCD do PSP.
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

## Build

`npm run build:wasm` na UI copia os artefatos deste crate para
`platforms/web/ui/public/wasm/psp/` e o adaptador para
`platforms/web/ui/src/wasm/psp/adapter.js`. `src/wasm/` e `public/wasm/` são
gerados e não devem ser editados.

## Validação

ROM usada no smoke test: `Need for Speed - Most Wanted - 5-1-0 (USA).iso`
(`ULUS-10036`, 926.580.736 bytes). Validar vídeo, áudio, input, restart,
save/load e histórico no web e no desktop.

## Licença

Wrapper/crate: GPL-3.0-or-later. Runtime vendorizado: GPL-2.0-or-later (ver
`vendor/ppsspp-ejs/license.txt` e `UPSTREAM.txt`).
