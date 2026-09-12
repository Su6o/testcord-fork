/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Theme stable-ID helpers.
 *
 * Each theme file may declare a stable id via a header comment:
 *   / * @id my-stable-theme * /
 *   / * id: my-stable-theme * /
 * If absent, the id falls back to the file's basename (lower-cased),
 * which is at least stable against display-name changes inside the file.
 *
 * `enabledThemes` and `themeNames` are migrated from raw filenames to
 * stable ids on first run so a rename of the underlying file (detected
 * by scanning the themes folder for a file whose declared @id matches)
 * does not orphan the enabled flag.
 */

const ID_COMMENT_RE = /(?:^|\n)\s*(?:\*\s*)?(?:@id[:\s]+|id:\s*)([a-z0-9_.-]+)/i;

export function parseThemeIdFromCss(css: string, fallbackFileName: string): string {
    const m = ID_COMMENT_RE.exec(css);
    const declared = m?.[1];
    if (declared) return declared.toLowerCase();
    return fallbackFileName.replace(/\.theme\.css$/i, "").replace(/\.css$/i, "").toLowerCase();
}

export function themeFileToId(fileName: string): string {
    return fileName.replace(/\.theme\.css$/i, "").replace(/\.css$/i, "").toLowerCase();
}

export function isThemeId(value: string): boolean {
    return /^[a-z0-9_.-]+$/i.test(value) && !value.includes("/") && !value.endsWith(".css");
}
