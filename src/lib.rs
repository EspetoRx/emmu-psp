//! Contrato do módulo PSP do Emmu.
//!
//! Diferente dos outros consoles, não há um crate Rust compilado para WASM:
//! o runtime é o PPSSPP (via Emscripten/RetroArch), vendorizado em
//! `vendor/ppsspp-ejs`. Este crate centraliza as constantes compartilhadas
//! entre o adaptador JS (`js/adapter.js`) e a documentação, além de garantir
//! que o submódulo participe dos checks do workspace.

/// Largura nativa do frame PSP (RGBA8888).
pub const FRAME_WIDTH: u32 = 480;
/// Altura nativa do frame PSP (RGBA8888).
pub const FRAME_HEIGHT: u32 = 272;
/// O áudio é gerado pelo próprio OpenAL/WebAudio do Emscripten.
pub const AUDIO_SAMPLE_RATE: u32 = 44_100;
/// Magic do envelope de save state do Emmu para PSP.
pub const SAVE_MAGIC: &[u8; 8] = b"EMMUPSP1";
/// Versão atual do envelope de save state.
pub const SAVE_VERSION: u32 = 1;
/// Flag: o estado PPSSPP bruto está comprimido com gzip.
pub const SAVE_FLAG_GZIP_STATE: u32 = 1 << 0;
/// Extensões aceitas pelo runtime PPSSPP.
pub const SUPPORTED_EXTENSIONS: &[&str] = &["psp", "iso", "cso", "chd", "pbp", "elf", "prx"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_native_psp_resolution() {
        assert_eq!((FRAME_WIDTH, FRAME_HEIGHT), (480, 272));
        let aspect = FRAME_WIDTH as f32 / FRAME_HEIGHT as f32;
        assert!((aspect - 30.0 / 17.0).abs() < 0.001);
    }

    #[test]
    fn save_envelope_identity() {
        assert_eq!(SAVE_MAGIC, b"EMMUPSP1");
        assert_eq!(SAVE_VERSION, 1);
        assert_eq!(SAVE_FLAG_GZIP_STATE, 1);
    }
}
