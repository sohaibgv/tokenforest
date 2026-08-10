//! Tray icons generated from pixel-string maps — no binary assets.
//! 16x16 maps scaled 2x nearest-neighbor to 32x32 RGBA.

use tauri::image::Image;

const SCALE: usize = 2;

fn color(c: char) -> [u8; 4] {
    match c {
        'G' => [46, 134, 66, 255],   // canopy green
        'g' => [72, 168, 90, 255],   // light green
        'T' => [110, 76, 48, 255],   // trunk brown
        'A' => [150, 150, 158, 255], // axe head grey
        'H' => [140, 96, 58, 255],   // axe handle
        'O' => [230, 140, 40, 255],  // warning orange
        'S' => [120, 84, 52, 255],   // stump
        _ => [0, 0, 0, 0],
    }
}

fn render(map: [&str; 16]) -> Image<'static> {
    let size = 16 * SCALE;
    let mut rgba = vec![0u8; size * size * 4];
    for (y, row) in map.iter().enumerate() {
        for (x, c) in row.chars().enumerate() {
            let px = color(c);
            for dy in 0..SCALE {
                for dx in 0..SCALE {
                    let i = ((y * SCALE + dy) * size + x * SCALE + dx) * 4;
                    rgba[i..i + 4].copy_from_slice(&px);
                }
            }
        }
    }
    Image::new_owned(rgba, size as u32, size as u32)
}

/// Calm full tree.
pub fn tray_idle() -> Image<'static> {
    render([
        "................",
        ".....GGGGG......",
        "....GGGGGGG.....",
        "...GGgGGGgGG....",
        "...GGGGgGGGG....",
        "..GGgGGGGGgGG...",
        "..GGGGgGGGGGG...",
        "...GGGGGGgGG....",
        "....GGgGGGG.....",
        ".....GGGGG......",
        "......TT........",
        "......TT........",
        "......TT........",
        ".....TTTT.......",
        "................",
        "................",
    ])
}

/// Tree with an axe leaning on it: actively chopping.
pub fn tray_active() -> Image<'static> {
    render([
        "................",
        ".....GGGGG......",
        "....GGGGGGG.....",
        "...GGgGGGgGG....",
        "...GGGGgGGGG....",
        "..GGgGGGGGgGG...",
        "..GGGGgGGGGGG...",
        "...GGGGGGgGG....",
        "....GGgGGGG.....",
        ".....GGGGG..AA..",
        "......TT...AAA..",
        "......TT..HH....",
        "......TT.HH.....",
        ".....TTTHH......",
        "................",
        "................",
    ])
}

/// Second chop frame: axe swung into the trunk, chips flying.
pub fn tray_active2() -> Image<'static> {
    render([
        "................",
        ".....GGGGG......",
        "....GGGGGGG.....",
        "...GGgGGGgGG....",
        "...GGGGgGGGG....",
        "..GGgGGGGGgGG...",
        "..GGGGgGGGGGG...",
        "...GGGGGGgGG....",
        "....GGgGGGG.....",
        ".....GGGGG......",
        "......TT..t.....",
        "......TTAA.t....",
        "......TTAAHH....",
        ".....TTTT..HH...",
        "................",
        "................",
    ])
}

/// Lone stump on orange: nearly out of tokens.
pub fn tray_warning() -> Image<'static> {
    render([
        "................",
        "................",
        "....OO....OO....",
        ".....OO..OO.....",
        "......OOOO......",
        ".......OO.......",
        "......OOOO......",
        ".....OO..OO.....",
        "....OO....OO....",
        "................",
        ".....SSSSS......",
        "......SSS.......",
        "......SSS.......",
        ".....SSSSS......",
        "................",
        "................",
    ])
}
