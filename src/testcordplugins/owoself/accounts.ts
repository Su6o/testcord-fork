/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";

export interface OwoProfile {
    id: string;
    name: string;
    token: string;
    userId: string;
    channels: string[];
    enabled: boolean;
}

const PROFILES_KEY = "OwoSelf_profiles";

export function decodeTokenUserId(token: string): string {
    const clean = token.trim();
    if (!clean || clean.includes(" ") || clean.includes("\n")) return "";
    if (clean.startsWith("mfa.")) return "";
    const first = clean.split(".")[0];
    if (!first) return "";
    try {
        const padded = first + "=".repeat((4 - (first.length % 4)) % 4);
        const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
        return /^\d{15,25}$/.test(decoded) ? decoded : "";
    } catch {
        return "";
    }
}

export function parseChannelList(raw: string): string[] {
    return raw
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(s => /^\d{10,25}$/.test(s));
}

export function newProfileId(): string {
    return `px_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

export async function getProfiles(): Promise<OwoProfile[]> {
    const stored = await DataStore.get<OwoProfile[]>(PROFILES_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.filter(p => p && typeof p.id === "string");
}

export async function saveProfiles(profiles: OwoProfile[]): Promise<void> {
    const seen = new Set<string>();
    const deduped = profiles.filter(p => {
        if (!p || seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
    });
    await DataStore.set(PROFILES_KEY, deduped);
}

export async function upsertProfile(profile: OwoProfile): Promise<OwoProfile[]> {
    const profiles = await getProfiles();
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) profiles[idx] = profile;
    else profiles.push(profile);
    await saveProfiles(profiles);
    return profiles;
}

export async function deleteProfile(id: string): Promise<OwoProfile[]> {
    const profiles = (await getProfiles()).filter(p => p.id !== id);
    await saveProfiles(profiles);
    return profiles;
}

export function pickActiveProfile(profiles: OwoProfile[], currentUserId: string): OwoProfile | null {
    const enabled = profiles.filter(p => p.enabled);
    if (enabled.length === 0) return null;
    const match = enabled.find(p => p.userId !== "" && p.userId === currentUserId);
    if (match) return match;
    return enabled[0] ?? null;
}

export function resolveChannels(profile: OwoProfile | null, fallbackRaw: string): string[] {
    if (profile && profile.channels.length > 0) return profile.channels;
    return parseChannelList(fallbackRaw);
}
