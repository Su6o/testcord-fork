/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { showNotification } from "@api/Notifications";
import { getCurrentChannel, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, Constants, GuildStore, RestAPI, showToast, Toasts, UserStore } from "@webpack/common";

import { getProfiles, type OwoProfile,pickActiveProfile, resolveChannels, upsertProfile } from "./accounts";
import { settings } from "./settings";

const MessageActions = findByPropsLazy("deleteMessage", "startEditMessage");

export const logger = new Logger("OwoSelf");

const STATS_KEY = "OwoSelf_stats";
const DAILY_KEY = "OwoSelf_daily";
const REACTION_BOT_ID = "519287796549156864";
const MIN_SEND_INTERVAL = 2.2;

export interface LogEntry {
    time: string;
    ts: number;
    type: string;
    message: string;
}

export interface QuestItem {
    description: string;
    current: number;
    total: number;
    completed: boolean;
}

export interface GamblingStats {
    totalWins: number;
    totalLosses: number;
    totalWagered: number;
    netProfit: number;
    currentStreak: number;
    bestStreak: number;
    worstStreak: number;
    biggestWin: number;
    lastOutcome: string | null;
}

export interface CaptchaAlert {
    url: string;
    detail: string;
    time: number;
}

interface CmdState {
    content: string | (() => string | null);
    priority: number;
    delay: number;
    lastRan: number;
    inQueue: boolean;
}

interface QueueItem {
    priority: number;
    ts: number;
    content: string;
    cmdId: string | null;
}

export interface OwoEmbed {
    title?: string;
    description?: string;
    footer?: { text?: string; };
    author?: { name?: string; };
    fields?: { name: string; value: string; }[];
}

export interface OwoMessage {
    id: string;
    channel_id: string;
    guild_id?: string;
    content: string;
    author: { id: string; username?: string; bot?: boolean; };
    mentions?: { id: string; }[];
    embeds?: OwoEmbed[];
    attachments?: { url: string; }[];
    buttonUrls?: string[];
}

interface PersistedStats {
    hunt: number;
    battle: number;
    owo: number;
    other: number;
    gemsUsed: number;
    captchas: number;
    bans: number;
    warnings: number;
    cash: number;
    questData: QuestItem[];
    nextQuestTimer: string | null;
    gambling: GamblingStats;
    lastDailyRun: number;
    lastCookieRun: number;
}

const emptyGambling = (): GamblingStats => ({
    totalWins: 0, totalLosses: 0, totalWagered: 0, netProfit: 0,
    currentStreak: 0, bestStreak: 0, worstStreak: 0, biggestWin: 0, lastOutcome: null
});

const logs: LogEntry[] = [];
const listeners = new Set<() => void>();

export const runtime = {
    startedAt: Date.now(),
    paused: false,
    generation: 0,
    throttleUntil: 0,
    warmupUntil: 0,
    lastSentAt: 0,
    lastSentCommand: "",
    grindActiveSec: 0,
    lastBreakAt: 0,
    onBreakUntil: 0,
    checkingGems: false,
    checkingGemsAt: 0,
    missingGemTypes: [] as string[],
    forceLuckyGems: false,
    pendingCaptcha: null as CaptchaAlert | null,
    channelIndex: 0,
    profiles: [] as OwoProfile[],
    activeProfile: null as OwoProfile | null,
    hunt: 0, battle: 0, owo: 0, other: 0, gemsUsed: 0,
    captchas: 0, bans: 0, warnings: 0, cash: 0,
    cashHistory: [] as [number, number][],
    questData: [] as QuestItem[],
    nextQuestTimer: null as string | null,
    gambling: emptyGambling(),
    martingale: {} as Record<string, { bet: number; base: number; }>,
    rppBlocked: {} as Record<string, number>,
    huntbotDelay: 900,
    lastDailyRun: 0,
    lastDailySent: 0,
    lastCookieRun: 0,
    lastCookieSent: 0,
    lastSellSent: 0,
    lastSacSent: 0,
    crateCooldownUntil: 0,
    lootboxCooldownUntil: 0,
    shopCashPendingAt: 0,
    zooPending: false,
    altWarned: false,
    lastQuestSolverRun: 0,
    lastQueuedQuest: {} as Record<string, number>,
    lastSuccessAt: {} as Record<string, number>,
    playedBlackjack: [] as string[],
    cmdStates: new Map<string, CmdState>(),
    queue: [] as QueueItem[]
};

let tickId: ReturnType<typeof setInterval> | null = null;
let saveId: ReturnType<typeof setInterval> | null = null;

export function subscribeLogs(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function notify(): void {
    for (const fn of listeners) {
        try { fn(); } catch { /* dashboard listener must never break the engine */ }
    }
}

export function log(type: string, message: string): void {
    logs.unshift({
        time: new Date().toLocaleTimeString(),
        ts: Date.now(),
        type,
        message
    });
    if (logs.length > 300) logs.length = 300;
    if (type === "CMD") {
        const cmd = commandNameOf(message);
        if (cmd === "hunt") runtime.hunt++;
        else if (cmd === "battle") runtime.battle++;
        else if (cmd === "owo") runtime.owo++;
        else runtime.other++;
    }
    if (type === "SUCCESS" && /captcha solved|verified|resuming/i.test(message)) runtime.captchas++;
    if (type === "ALARM" && /ban detected/i.test(message)) runtime.bans++;
    if (type === "ALARM" && /captcha/i.test(message)) runtime.warnings++;
    notify();
}

export function getLogs(): LogEntry[] {
    return logs;
}

function commandNameOf(message: string): string {
    const m = /sent:\s*(?:owo\s+)?(\S+)/i.exec(message);
    const raw = (m?.[1] ?? "").toLowerCase();
    if (raw === "h") return "hunt";
    if (raw === "b") return "battle";
    if (raw === "cf" || raw === "coinflip") return "coinflip";
    if (raw === "s" || raw === "slots") return "slots";
    if (raw === "bj" || raw === "blackjack") return "blackjack";
    return raw;
}

function rand(min: number, max: number): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + Math.random() * (hi - lo);
}

function currentUser(): { id: string; username: string; } | null {
    try {
        const u = UserStore.getCurrentUser();
        if (!u) return null;
        return { id: String(u.id), username: String(u.username ?? "") };
    } catch {
        return null;
    }
}

export function getChannels(): string[] {
    return resolveChannels(runtime.activeProfile, settings.store.fallbackChannels);
}

export function getChannelId(): string | null {
    const channels = getChannels();
    if (channels.length === 0) return null;
    const channel = channels[runtime.channelIndex % channels.length];
    return channel ?? null;
}

export function rotateChannel(): void {
    const channels = getChannels();
    if (channels.length <= 1) return;
    runtime.channelIndex = (runtime.channelIndex + 1) % channels.length;
    log("SYS", `Channel rotated to ${channelLabel(channels[runtime.channelIndex] ?? "")}.`);
    notify();
}

export function channelLabel(id: string): string {
    if (!/^\d{10,25}$/.test(id)) return id;
    try {
        const channel = ChannelStore.getChannel(id) as { name?: string; guild_id?: string; } | undefined;
        const name = channel?.name ?? "DM";
        const guildId = channel?.guild_id;
        if (guildId) {
            const guild = GuildStore.getGuild(guildId) as { name?: string; } | undefined;
            return guild?.name ? `#${name} (${guild.name})` : `#${name}`;
        }
        return `#${name}`;
    } catch {
        return id;
    }
}

export interface ChannelOption {
    id: string;
    label: string;
    active: boolean;
}

export function getChannelOptions(): ChannelOption[] {
    const channels = getChannels();
    const active = getChannelId();
    const seen = new Set<string>();
    const options: ChannelOption[] = [];
    for (const id of channels) {
        if (seen.has(id)) continue;
        seen.add(id);
        options.push({ id, label: channelLabel(id), active: id === active });
    }
    try {
        const current = getCurrentChannel();
        const currentId = current ? String(current.id) : "";
        if (currentId !== "" && !seen.has(currentId)) {
            options.push({ id: currentId, label: `${channelLabel(currentId)} (open now)`, active: false });
        }
    } catch { /* channel lookup must never break the engine */ }
    return options;
}

export function setActiveChannel(id: string): void {
    let channels = getChannels();
    if (!channels.includes(id)) channels = [...channels, id];
    runtime.channelIndex = channels.indexOf(id);
    if (runtime.activeProfile) {
        runtime.activeProfile.channels = channels;
        void upsertProfile({ ...runtime.activeProfile }).then(() => { void reloadProfiles(); });
    } else {
        settings.store.fallbackChannels = channels.join(", ");
    }
    log("SYS", `Grind channel set to ${channelLabel(id)}.`);
    notify();
}

export async function addGrindChannel(id: string): Promise<void> {
    if (!/^\d{10,25}$/.test(id)) return;
    const channels = getChannels();
    if (channels.includes(id)) {
        setActiveChannel(id);
        return;
    }
    const next = [...channels, id];
    if (runtime.activeProfile) {
        runtime.activeProfile.channels = next;
        await upsertProfile({ ...runtime.activeProfile });
        await reloadProfiles();
    } else {
        settings.store.fallbackChannels = next.join(", ");
    }
    setActiveChannel(id);
}

export async function removeGrindChannel(id: string): Promise<void> {
    const next = getChannels().filter(c => c !== id);
    if (runtime.activeProfile) {
        runtime.activeProfile.channels = next;
        await upsertProfile({ ...runtime.activeProfile });
        await reloadProfiles();
    } else {
        settings.store.fallbackChannels = next.join(", ");
    }
    runtime.channelIndex = 0;
    log("SYS", `Removed grind channel ${channelLabel(id)}.`);
    notify();
}

function fixCommand(command: string): string {
    const rawPrefix = (settings.store.prefix || "owo ").trim() || "owo";
    const custom = rawPrefix.toLowerCase() !== "owo";
    const prefix = custom ? rawPrefix : "owo ";
    let cmd = command.trim();
    // Internal strings are written with the default prefix. Strip it first so a
    // custom prefix never stacks into "wowo daily".
    if (custom && /^owo\s+/i.test(cmd)) {
        cmd = cmd.replace(/^owo\s+/i, "");
    }
    if (cmd.toLowerCase() === "owo") return "owo";
    if (settings.store.useShortform) {
        const short: Record<string, string> = {
            hunt: "h", battle: "b", coinflip: "cf", slots: "s",
            blackjack: "bj", sacrifice: "sc", inventory: "inv", lootbox: "lb", crate: "wc", huntbot: "hb"
        };
        const parts = cmd.split(/\s+/);
        const base = (parts[0] ?? "").toLowerCase();
        const hit = short[base];
        if (hit && parts[0]) {
            parts[0] = hit;
            cmd = parts.join(" ");
        }
    }
    const known = ["hunt", "battle", "curse", "pray", "daily", "cookie", "quest", "checklist",
        "cf", "slots", "bj", "autohunt", "upgrade", "sacrifice", "sc", "zoo", "use", "inv",
        "sell", "crate", "lootbox", "run", "pup", "piku", "h", "b", "s", "lb", "wc", "hb", "huntbot", "owo", "cash", "ab"];
    // OwO reads the prefix as a raw string prefix, so custom prefixes join with
    // no space ("wcash", not "w cash"). Collapse a spaced custom prefix too.
    if (custom && cmd.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
        const rest = cmd.slice(prefix.length + 1);
        const restFirst = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
        if (known.includes(restFirst)) cmd = `${prefix}${rest}`;
    }
    const first = cmd.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (known.includes(first) && !cmd.toLowerCase().startsWith(prefix.toLowerCase())) {
        return `${prefix}${cmd}`;
    }
    return cmd;
}

function cursePrayCommand(choice: string, raw: string, ping: boolean): string {
    const ids = raw.split(/[\s,]+/).map(t => t.trim()).filter(t => /^\d{10,25}$/.test(t));
    if (ids.length === 0) return choice;
    const target = ids[Math.floor(Math.random() * ids.length)] ?? "";
    return ping ? `${choice} <@${target}>` : `${choice} ${target}`;
}

export function questEmoteTarget(): string {
    const ids = settings.store.prayTargets.split(/[\s,]+/).map(t => t.trim()).filter(t => /^\d{10,25}$/.test(t));
    if (ids.length > 0) return ids[Math.floor(Math.random() * ids.length)] ?? settings.store.owoBotId;
    return settings.store.owoBotId;
}

async function persist(): Promise<void> {
    const data: PersistedStats = {
        hunt: runtime.hunt, battle: runtime.battle, owo: runtime.owo, other: runtime.other,
        gemsUsed: runtime.gemsUsed, captchas: runtime.captchas, bans: runtime.bans,
        warnings: runtime.warnings, cash: runtime.cash, questData: runtime.questData,
        nextQuestTimer: runtime.nextQuestTimer, gambling: runtime.gambling, lastDailyRun: runtime.lastDailyRun, lastCookieRun: runtime.lastCookieRun
    };
    try {
        await DataStore.set(STATS_KEY, data);
        await DataStore.set(DAILY_KEY, { lastRun: runtime.lastDailyRun });
    } catch (e) {
        logger.warn("Failed to persist stats", e);
    }
}

async function restore(): Promise<void> {
    try {
        const data = await DataStore.get<PersistedStats>(STATS_KEY);
        if (data) {
            runtime.hunt = data.hunt ?? 0;
            runtime.battle = data.battle ?? 0;
            runtime.owo = data.owo ?? 0;
            runtime.other = data.other ?? 0;
            runtime.gemsUsed = data.gemsUsed ?? 0;
            runtime.captchas = data.captchas ?? 0;
            runtime.bans = data.bans ?? 0;
            runtime.warnings = data.warnings ?? 0;
            runtime.cash = data.cash ?? 0;
            runtime.questData = Array.isArray(data.questData) ? data.questData : [];
            runtime.nextQuestTimer = data.nextQuestTimer ?? null;
            if (data.gambling) runtime.gambling = { ...emptyGambling(), ...data.gambling };
            runtime.lastDailyRun = data.lastDailyRun ?? 0;
            runtime.lastCookieRun = data.lastCookieRun ?? 0;
        }
        const daily = await DataStore.get<{ lastRun: number; }>(DAILY_KEY);
        if (daily && typeof daily.lastRun === "number") runtime.lastDailyRun = daily.lastRun;
    } catch (e) {
        logger.warn("Failed to restore stats", e);
    }
}

function register(cmdId: string, content: string | (() => string | null), priority: number, delay: number, offsetSec: number): void {
    const existing = runtime.cmdStates.get(cmdId);
    const now = Date.now() / 1000;
    runtime.cmdStates.set(cmdId, {
        content,
        priority,
        delay,
        lastRan: existing ? existing.lastRan : now - delay + offsetSec,
        inQueue: existing?.inQueue ?? false
    });
}

function unregister(cmdId: string): void {
    runtime.cmdStates.delete(cmdId);
}

function shopBuyContent(): string | null {
    const s = settings.store;
    const tier = Math.min(7, Math.max(1, Math.floor(s.shopItems)));
    const price = SHOP_PRICES[tier] ?? 0;
    if (runtime.cash <= 0) {
        if (Date.now() - runtime.shopCashPendingAt > 60000) {
            runtime.shopCashPendingAt = Date.now();
            log("SYS", "Shop: balance unknown, syncing via cash check.");
            enqueue("owo cash", 3, null);
        }
        return null;
    }
    if (runtime.cash >= price) {
        log("SYS", `Shop: buying tier ${tier} for ${price.toLocaleString()} (balance ${runtime.cash.toLocaleString()}).`);
        return `buy ${tier}`;
    }
    log("SYS", `Shop: cannot afford tier ${tier} (need ${price.toLocaleString()}, have ${runtime.cash.toLocaleString()}).`);
    return null;
}

function allocateHuntbotUpgrades(essence: number, levels: Record<string, number>, invested: Record<string, number>, enabled: string[]): Record<string, number> {
    const s = settings.store;
    const prios: Record<string, number> = {
        efficiency: s.huntbotPrioEfficiency, duration: s.huntbotPrioDuration, cost: s.huntbotPrioCost,
        gain: s.huntbotPrioGain, exp: s.huntbotPrioExp, radar: s.huntbotPrioRadar
    };
    const dyn = (t: string, lvls: Record<string, number>): number => {
        if (t === "efficiency" || t === "gain") {
            const o = t === "efficiency" ? "gain" : "efficiency";
            if ((lvls[t] ?? 0) < (lvls[o] ?? 0)) return (prios[t] ?? 0) + 2;
        }
        if (t === "duration" && (lvls[t] ?? 0) < 125) return (prios[t] ?? 0) + 3;
        if (t === "exp" && (lvls.efficiency ?? 0) >= 215 && (lvls.gain ?? 0) >= 200) return 10;
        return prios[t] ?? 0;
    };
    const allocation: Record<string, number> = {};
    for (const t of enabled) allocation[t] = 0;
    let remaining = essence;
    const currLvls = { ...levels };
    const currInv = { ...invested };
    let guard = 0;
    while (remaining > 0 && guard++ < 10000) {
        let best: string | null = null;
        let bestRatio = -1;
        let bestCost = 0;
        for (const t of enabled) {
            const spec = HUNTBOT_SPECS[t];
            if (!spec) continue;
            const lvl = currLvls[t] ?? 0;
            if (lvl >= spec.max) continue;
            const cost = Math.floor(spec.inc * Math.pow(lvl + 1, spec.power));
            const required = Math.max(0, cost - (currInv[t] ?? 0));
            if (required <= 0) {
                currLvls[t] = lvl + 1;
                currInv[t] = 0;
                continue;
            }
            const ratio = dyn(t, currLvls) / required;
            if (required <= remaining && ratio > bestRatio) {
                bestRatio = ratio;
                best = t;
                bestCost = required;
            }
        }
        if (best) {
            allocation[best] = (allocation[best] ?? 0) + bestCost;
            remaining -= bestCost;
            currLvls[best] = (currLvls[best] ?? 0) + 1;
            currInv[best] = 0;
        } else {
            let target = "";
            let targetScore = -1;
            for (const t of enabled) {
                const spec = HUNTBOT_SPECS[t];
                if (!spec) continue;
                const cost = Math.max(1, Math.floor(spec.inc * Math.pow((currLvls[t] ?? 0) + 1, spec.power)) - (currInv[t] ?? 0));
                const score = dyn(t, currLvls) / cost;
                if (score > targetScore) {
                    targetScore = score;
                    target = t;
                }
            }
            if (target === "") break;
            allocation[target] = (allocation[target] ?? 0) + remaining;
            break;
        }
    }
    const out: Record<string, number> = {};
    for (const [t, amt] of Object.entries(allocation)) {
        if (amt > 0) out[t] = amt;
    }
    return out;
}

let lastUpgradeEssence = 0;
let lastUpgradeTime = 0;

export function trackQuestProgress(descContains: string, count = 1, exclude?: string): void {
    let updated = false;
    for (const q of runtime.questData) {
        if (q.completed) continue;
        const d = q.description.toLowerCase();
        if (!d.includes(descContains.toLowerCase())) continue;
        if (exclude && d.includes(exclude.toLowerCase())) continue;
        q.current = Math.min(q.total, q.current + count);
        if (q.current >= q.total) {
            q.completed = true;
            log("SUCCESS", `Quest completed: ${q.description}`);
        }
        updated = true;
    }
    if (updated) {
        void persist();
        notify();
    }
}

function isAltQuest(desc: string): boolean {
    return [
        "have a friend use an action command on you",
        "have a friend use an emote command on you",
        "have a friend pray to you",
        "have a friend curse you",
        "receive a cookie from",
        "battle with a friend"
    ].some(t => desc.includes(t));
}

function queueQuestCommand(cmd: string, cooldown: number): void {
    const now = Date.now() / 1000;
    if (now - (runtime.lastQueuedQuest[cmd] ?? 0) < cooldown) return;
    runtime.lastQueuedQuest[cmd] = now;
    log("SYS", `Quest engine: queueing ${cmd}.`);
    enqueue(cmd, 5, null);
}

function questSolverTick(): void {
    if (!settings.store.questEnabled || !settings.store.questAutoSolve) return;
    const now = Date.now() / 1000;
    if (now - runtime.lastQuestSolverRun < 20) return;
    runtime.lastQuestSolverRun = now;
    const quests = runtime.questData;
    if (!quests.some(q => !q.completed && q.description.toLowerCase().includes("hunt 3 animals that are")) && runtime.forceLuckyGems) {
        runtime.forceLuckyGems = false;
        log("SYS", "Quest engine: rarity quest done, lucky gem force off.");
    }
    for (const q of quests) {
        if (q.completed) continue;
        const desc = q.description.toLowerCase();
        const remaining = q.total - q.current;
        if (isAltQuest(desc)) {
            if (now - (runtime.lastQueuedQuest[desc] ?? 0) < 60) break;
            runtime.lastQueuedQuest[desc] = now;
            if (!runtime.altWarned) {
                runtime.altWarned = true;
                log("WARN", `Quest engine: social quest needs a friend: '${q.description}'. Do it by hand, progress is tracked.`);
            }
            break;
        }
        if (desc.includes("gamble")) {
            queueQuestCommand("owo cf 1", 12);
            break;
        }
        if (desc.includes("use an action command on someone") || desc.includes("use an emote command on someone")) {
            const emote = EMOTE_COMMANDS[Math.floor(Math.random() * EMOTE_COMMANDS.length)] ?? "hug";
            queueQuestCommand(`owo ${emote} <@${questEmoteTarget()}>`, 8);
            break;
        }
        if (desc.includes("hunt 3 animals that are") && !runtime.forceLuckyGems) {
            runtime.forceLuckyGems = true;
            log("SYS", "Quest engine: rarity quest, forcing lucky gems.");
        }
        if ((desc.includes("say 'owo'") || desc.includes('say "owo"')) && remaining > 5) {
            queueQuestCommand("owo", 6);
            break;
        }
    }
}

export function solveQuest(index: number): void {
    const q = runtime.questData[index];
    if (!q || q.completed) return;
    const desc = q.description.toLowerCase();
    if (desc.includes("gamble")) {
        void sendManual("owo cf 1");
        return;
    }
    if (desc.includes("say 'owo'") || desc.includes('say "owo"')) {
        void sendManual("owo");
        return;
    }
    if (desc.includes("use an action command on someone") || desc.includes("use an emote command on someone")) {
        const emote = EMOTE_COMMANDS[Math.floor(Math.random() * EMOTE_COMMANDS.length)] ?? "hug";
        void sendManual(`owo ${emote} <@${questEmoteTarget()}>`);
        return;
    }
    if (desc.includes("hunt 3 animals that are")) {
        runtime.forceLuckyGems = true;
        log("SYS", "Quest engine: rarity quest, forcing lucky gems.");
        notify();
        return;
    }
    showToast("Solve this quest by hand, the engine tracks the progress.", Toasts.Type.MESSAGE);
}

export function fireNow(cmdId: string): void {
    const st = runtime.cmdStates.get(cmdId);
    if (!st) return;
    st.lastRan = 0;
    log("SYS", `Firing ${cmdId} now.`);
    notify();
}

export function refreshScheduler(): void {
    const s = settings.store;
    if (s.huntEnabled) register("hunt", "hunt", 3, rand(s.huntCooldownMin, s.huntCooldownMax), 5);
    else unregister("hunt");
    if (s.battleEnabled) register("battle", "battle", 3, rand(s.battleCooldownMin, s.battleCooldownMax), 10);
    else unregister("battle");
    if (s.owoEnabled) register("owo", "owo", 1, rand(s.owoCooldownMin, s.owoCooldownMax), 15);
    else unregister("owo");
    if (s.prayEnabled || s.curseEnabled) {
        register("cursepray", () => {
            const pool: { cmd: string; min: number; max: number; }[] = [];
            if (s.prayEnabled) {
                pool.push({ cmd: cursePrayCommand("pray", s.prayTargets, s.prayPing), min: s.cursePrayCooldownMin, max: s.cursePrayCooldownMax });
            }
            if (s.curseEnabled) {
                const cmd = cursePrayCommand("curse", s.curseTargets, s.cursePing);
                if (cmd !== "curse") pool.push({ cmd, min: s.cursePrayCooldownMin, max: s.cursePrayCooldownMax });
            }
            if (pool.length === 0) return null;
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (!pick) return null;
            const st = runtime.cmdStates.get("cursepray");
            if (st) st.delay = rand(pick.min, pick.max);
            return pick.cmd;
        }, 3, rand(s.cursePrayCooldownMin, s.cursePrayCooldownMax), 30);
    } else unregister("cursepray");
    if (s.dailyEnabled) {
        const remaining = runtime.lastDailyRun + 86400 - Date.now() / 1000;
        register("daily", "daily", 4, 86400, 0);
        const st = runtime.cmdStates.get("daily");
        if (st) st.lastRan = remaining > 0 ? Date.now() / 1000 - 86400 + remaining : Date.now() / 1000 - 86400;
    } else unregister("daily");
    if (s.cookieEnabled && s.cookieTarget.trim() !== "") {
        const remaining = runtime.lastCookieRun + 86400 - Date.now() / 1000;
        register("cookie", `cookie ${s.cookieTarget.trim()}`, 4, 86400, 60);
        const st = runtime.cmdStates.get("cookie");
        if (st && remaining > 0) st.lastRan = Date.now() / 1000 - 86400 + remaining;
    } else unregister("cookie");
    if (s.rppEnabled) {
        register("rpp", () => {
            const now = Date.now() / 1000;
            const avail = ["run", "pup", "piku"].filter(c => (runtime.rppBlocked[c] ?? 0) < now);
            if (avail.length === 0) return null;
            return avail[Math.floor(Math.random() * avail.length)] ?? null;
        }, 3, Math.max(15, s.rppInterval), 15);
    } else unregister("rpp");
    if (s.questEnabled) register("quest", "quest", 4, Math.max(1, s.questIntervalH) * 3600, 10);
    else unregister("quest");
    if (s.huntbotEnabled) register("huntbot", `huntbot ${Math.max(1, s.huntbotCash)}`, 4, runtime.huntbotDelay, 20);
    else unregister("huntbot");
    if (s.coinflipEnabled) register("coinflip", () => `cf ${s.coinflipSide} ${currentBet("coinflip", s.coinflipAmount)}`, 3, rand(30, 60), 15);
    else unregister("coinflip");
    if (s.slotsEnabled) register("slots", () => `slots ${currentBet("slots", s.slotsAmount)}`, 3, rand(25, 50), 20);
    else unregister("slots");
    if (s.blackjackEnabled) register("blackjack", () => `bj ${currentBet("blackjack", s.blackjackAmount)}`, 3, rand(40, 70), 25);
    else unregister("blackjack");
    const sellType = (s.sellType || "all").trim() || "all";
    if (s.sellEnabled) register("sell", `sell ${sellType}`, 4, Math.max(1, s.sellIntervalMin) * 60, 60);
    else unregister("sell");
    const sacType = (s.sacrificeType || "all").trim() || "all";
    if (s.sacrificeEnabled) register("sacrifice", `sacrifice ${sacType}`, 4, Math.max(1, s.sacrificeIntervalMin) * 60, 120);
    else unregister("sacrifice");
    if (s.shopEnabled) {
        register("shop_buy", () => shopBuyContent(), 3, Math.max(60, s.shopCooldown), 90);
        register("shop_cash_sync", () => "owo cash", 3, 7200, 30);
    } else {
        unregister("shop_buy");
        unregister("shop_cash_sync");
    }
    if (s.levelGrindEnabled) {
        register("level_quotes", () => QUOTES[Math.floor(Math.random() * QUOTES.length)] ?? null, 4,
            rand(s.levelGrindMin, s.levelGrindMax), 45);
    } else unregister("level_quotes");
    if (s.autochannelEnabled) register("channelswitch", "", 5, rand(s.autochannelMin, s.autochannelMax), 60);
    else unregister("channelswitch");
}

const QUOTES = [
    "Your heart is the size of an ocean. Go find yourself in its hidden depths.",
    "The Bay of Bengal is hit frequently by cyclones. The months of November and May, in particular, are dangerous in this regard.",
    "Thinking is the capital, Enterprise is the way, Hard Work is the solution.",
    "If You Can'T Make It Good, At Least Make It Look Good.",
    "Heart be brave. If you cannot be brave, just go. Love's glory is not a small thing.",
    "It is bad for a young man to sin; but it is worse for an old man to sin.",
    "If You Are Out To Describe The Truth, Leave Elegance To The Tailor.",
    "O man you are busy working for the world, and the world is busy trying to turn you out.",
    "While children are struggling to be unique, the world around them is trying all means to make them look like everybody else.",
    "These Capitalists Generally Act Harmoniously And In Concert, To Fleece The People.",
    "I Don'T Believe In Failure. It Is Not Failure If You Enjoyed The Process.",
    "Do not get elated at any victory, for all such victory is subject to the will of God.",
    "Wear gratitude like a cloak and it will feed every corner of your life.",
    "If you even dream of beating me you'd better wake up and apologize.",
    "I Will Praise Any Man That Will Praise Me.",
    "One Of The Greatest Diseases Is To Be Nobody To Anybody.",
    "I'm so fast that last night I turned off the light switch in my hotel room and was in bed before the room was dark.",
    "People Must Learn To Hate And If They Can Learn To Hate, They Can Be Taught To Love.",
    "Everyone has been made for some particular work, and the desire for that work has been put in every heart.",
    "The less of the World, the freer you live.",
    "Respond to every call that excites your spirit.",
    "The Way To Get Started Is To Quit Talking And Begin Doing.",
    "God Doesn'T Require Us To Succeed, He Only Requires That You Try.",
    "Speak any language, Turkish, Greek, Persian, Arabic, but always speak with love.",
    "Happiness comes towards those which believe in him.",
    "Knowledge is of two kinds: that which is absorbed and that which is heard. And that which is heard does not profit if it is not absorbed.",
    "When I am silent, I have thunder hidden inside.",
    "Technological Progress Is Like An Axe In The Hands Of A Pathological Criminal.",
    "No One Would Choose A Friendless Existence On Condition Of Having All The Other Things In The World.",
    "Life is a gamble. You can get hurt, but people die in plane crashes, lose their arms and legs in car accidents; people die every day. Same with fighters: some die, some get hurt, some go on. You just don't let yourself believe it will happen to you."
];

const EMOTE_TRIGGERS = [" hugs ", " kisses ", " slaps ", " punches ", " cuddles ", " pats ", " pokes ", " bites ", " blushes at ", " stares at ", " cries to ", " pouts at "];
const EMOTE_COMMANDS = ["hug", "poke", "pat", "cuddle", "kiss"];

const EMOJI_NAMES: Record<string, string> = {
    "<a:hlizard:459203643732918283>": "hlizard", "<a:hsnake:459203694878130177>": "hsnake",
    "<a:hsquid:459204137264087061>": "hsquid", "<a:hmonkey:459203661407453184>": "hmonkey",
    "<a:hkoala:459203626766958612>": "hkoala", "<a:dwolf:435592220758769684>": "dwolf",
    "<a:dgorilla:438842240865927180>": "dgorilla", "<a:dfrog:435592209883070474>": "dfrog",
    "<a:deagle:438844624887480320>": "deagle", "<a:dboar:438847718459179018>": "dboar",
    "<a:gsquid:417968419984375808>": "gsquid", "<a:gowl:418284974593277954>": "gowl",
    "<a:gfox:418291892376305664>": "gfox", "<a:glion:418289164736528404>": "glion",
    "<a:gdeer:418290217989046274>": "gdeer", "<a:gspider:510023576775032844>": "gspider",
    "<a:gshrimp:510023577295388672>": "gshrimp", "<a:gpanda:510023577320292353>": "gpanda",
    "<a:gfish:510023576892473364>": "gfish",
    "<a:gcamel:510023576573837322>": "gcamel",
    ":dove:": "dove", ":ghost:": "ghost", ":snowman2:": "snowman", ":unicorn:": "unicorn",
    ":dragon:": "dragon", ":whale:": "whale", ":elephant:": "elephant", ":penguin:": "penguin",
    ":tiger2:": "tiger", ":crocodile:": "crocodile", ":cat2:": "cat", ":dog2:": "dog",
    ":cow2:": "cow", ":pig2:": "pig", ":sheep:": "sheep", ":chipmunk:": "chipmunk",
    ":rabbit2:": "rabbit", ":rooster:": "rooster", ":mouse:": "mouse", ":baby_chick:": "baby_chick",
    ":butterfly:": "butterfly", ":lady_beetle:": "lady_beetle", ":bug:": "bug", ":bee:": "bee",
    ":snail:": "snail"
};

const SHOP_PRICES: Record<number, number> = { 1: 10, 2: 100, 3: 1000, 4: 10000, 5: 100000, 6: 1000000, 7: 10000000 };

interface HuntbotSpec { inc: number; power: number; max: number; }
const HUNTBOT_SPECS: Record<string, HuntbotSpec> = {
    efficiency: { inc: 10, power: 1.748, max: 215 },
    duration: { inc: 10, power: 1.7, max: 235 },
    cost: { inc: 1000, power: 3.4, max: 5 },
    gain: { inc: 10, power: 1.8, max: 200 },
    exp: { inc: 10, power: 1.8, max: 200 },
    radar: { inc: 50, power: 2.5, max: 999 }
};

function currentBet(game: string, base: number): number {
    const max = Math.max(1, settings.store.gambleMaxBet);
    if (settings.store.gambleStrategy !== "martingale") return Math.min(base, max);
    const st = runtime.martingale[game] ?? { bet: base, base };
    st.base = base;
    runtime.martingale[game] = st;
    return Math.min(st.bet, max);
}

function settleBet(game: string, won: boolean, amount: number): void {
    const g = runtime.gambling;
    g.totalWagered += amount;
    g.lastOutcome = won ? "win" : "loss";
    if (won) {
        g.totalWins++;
        g.netProfit += amount;
        g.currentStreak = g.currentStreak >= 0 ? g.currentStreak + 1 : 1;
        g.bestStreak = Math.max(g.bestStreak, g.currentStreak);
        g.biggestWin = Math.max(g.biggestWin, amount);
    } else {
        g.totalLosses++;
        g.netProfit -= amount;
        g.currentStreak = g.currentStreak <= 0 ? g.currentStreak - 1 : -1;
        g.worstStreak = Math.min(g.worstStreak, g.currentStreak);
    }
    const st = runtime.martingale[game];
    if (st) st.bet = won ? st.base : Math.min(st.bet * 2, Math.max(1, settings.store.gambleMaxBet));
    log("GAMBLING", `${game} ${won ? "won" : "lost"} (bet ${amount.toLocaleString()}, net ${g.netProfit.toLocaleString()}).`);
    notify();
}

function gamblingAllowed(): boolean {
    if (runtime.cash <= 0) {
        log("GAMBLING", "Cash unknown, skipping bet until balance syncs.");
        return false;
    }
    if (runtime.cash < settings.store.gambleMinBalance) {
        log("GAMBLING", `Stop loss hit at ${runtime.cash.toLocaleString()}, suspending bets.`);
        return false;
    }
    if (runtime.cash > settings.store.gambleMaxBalance) {
        log("GAMBLING", `Take profit hit at ${runtime.cash.toLocaleString()}, suspending bets.`);
        return false;
    }
    return true;
}

function enqueue(content: string, priority: number, cmdId: string | null, force = false): boolean {
    if (!force && (!settings.store.masterSwitch || runtime.paused)) return false;
    runtime.queue.push({ priority, ts: Date.now(), content, cmdId });
    const st = cmdId ? runtime.cmdStates.get(cmdId) : undefined;
    if (st) st.inQueue = true;
    return true;
}

function clearQueue(): void {
    runtime.queue.length = 0;
    runtime.generation++;
    for (const st of runtime.cmdStates.values()) st.inQueue = false;
}

export async function sendManual(content: string): Promise<boolean> {
    const channelId = getChannelId();
    if (!channelId) {
        showToast("OwoSelf has no grind channel configured.", Toasts.Type.FAILURE);
        return false;
    }
    return sendNow(channelId, content, true);
}

async function sendNow(channelId: string, content: string, force = false): Promise<boolean> {
    const fixed = fixCommand(content);
    const gen = runtime.generation;
    try {
        if (settings.store.typingEnabled) {
            await sleep(rand(settings.store.reactionDelayMin, settings.store.reactionDelayMax) * 1000);
        }
        if (!force && (gen !== runtime.generation || runtime.paused || !settings.store.masterSwitch)) {
            return false;
        }
        await sendMessage(channelId, { content: fixed });
        runtime.lastSentAt = Date.now();
        runtime.lastSentCommand = fixed;
        log("CMD", `Sent: ${fixed.length > 60 ? `${fixed.slice(0, 60)}...` : fixed}`);
        return true;
    } catch (e) {
        logger.warn("Send failed", e);
        log("ERROR", `Send failed: ${fixed}`);
        return false;
    }
}

function onBreak(): boolean {
    return runtime.onBreakUntil > Date.now();
}

async function tick(): Promise<void> {
    if (!settings.store.masterSwitch || runtime.paused) return;
    if (runtime.throttleUntil > Date.now()) return;
    if (onBreak()) return;

    const nowSec = Date.now() / 1000;
    runtime.grindActiveSec++;
    if (settings.store.humanBreakEnabled) {
        const every = Math.max(5, settings.store.humanBreakEveryMin) * 60;
        if (runtime.grindActiveSec - runtime.lastBreakAt > every) {
            runtime.lastBreakAt = runtime.grindActiveSec;
            runtime.onBreakUntil = Date.now() + Math.max(1, settings.store.humanBreakDurationMin) * 60000;
            log("SYS", `Human break started for ${settings.store.humanBreakDurationMin} minutes.`);
            notify();
            return;
        }
    }

    for (const [cmdId, st] of runtime.cmdStates) {
        if (st.inQueue) continue;
        if (nowSec - st.lastRan < st.delay) continue;
        let content = typeof st.content === "function" ? st.content() : st.content;
        if (content === null) {
            st.lastRan = nowSec;
            continue;
        }
        if (content === "") {
            if (cmdId === "channelswitch") rotateChannel();
            st.lastRan = nowSec;
            continue;
        }
        if ((cmdId === "coinflip" || cmdId === "slots" || cmdId === "blackjack") && !gamblingAllowed()) {
            st.lastRan = nowSec;
            continue;
        }
        if (runtime.checkingGems && /hunt|battle/.test(content.toLowerCase()) && !/huntbot|autohunt/.test(content.toLowerCase())) {
            continue;
        }
        if (Date.now() - runtime.checkingGemsAt > 20000) runtime.checkingGems = false;
        content = fixCommand(content);
        enqueue(content, st.priority, cmdId);
    }

    questSolverTick();

    if (runtime.queue.length === 0) return;
    if (Date.now() - runtime.lastSentAt < MIN_SEND_INTERVAL * 1000) return;
    if (Date.now() < runtime.warmupUntil) return;

    runtime.queue.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
    const item = runtime.queue.shift();
    if (!item) return;
    const channelId = getChannelId();
    if (!channelId) {
        const st = item.cmdId ? runtime.cmdStates.get(item.cmdId) : undefined;
        if (st) { st.lastRan = nowSec; st.inQueue = false; }
        return;
    }
    const ok = await sendNow(channelId, item.content);
    const state = item.cmdId ? runtime.cmdStates.get(item.cmdId) : undefined;
    if (state) {
        state.lastRan = nowSec;
        state.inQueue = false;
        if (item.cmdId === "daily") {
            runtime.lastDailyRun = nowSec;
            runtime.lastDailySent = Date.now();
        }
        if (item.cmdId === "cookie") runtime.lastCookieSent = Date.now();
        if (item.cmdId === "sell") runtime.lastSellSent = Date.now();
        if (item.cmdId === "sacrifice") runtime.lastSacSent = Date.now();
    }
    void ok;
}

export async function reloadProfiles(): Promise<void> {
    runtime.profiles = await getProfiles();
    const me = currentUser();
    runtime.activeProfile = pickActiveProfile(runtime.profiles, me?.id ?? "");
}

export async function startEngine(): Promise<void> {
    if (tickId) return;
    await restore();
    await reloadProfiles();
    runtime.startedAt = Date.now();
    runtime.warmupUntil = Date.now() + 10000;
    settings.store.masterSwitch = false;
    runtime.paused = false;
    refreshScheduler();
    tickId = setInterval(() => { void tick(); }, 1000);
    saveId = setInterval(() => { void persist(); }, 30000);
    log("SYS", `OwoSelf standing by${runtime.activeProfile ? ` for profile ${runtime.activeProfile.name}` : ""}. Press Start to grind.`);
}

export function stopEngine(): void {
    if (tickId) clearInterval(tickId);
    if (saveId) clearInterval(saveId);
    tickId = null;
    saveId = null;
    runtime.queue.length = 0;
    void persist();
    log("SYS", "OwoSelf engine stopped.");
}

export function pauseEngine(reason: string): void {
    runtime.paused = true;
    clearQueue();
    log("ALARM", `Paused: ${reason}`);
    showToast(`OwoSelf paused. ${reason}`, Toasts.Type.FAILURE);
    notify();
}

export function resumeEngine(): void {
    runtime.paused = false;
    runtime.throttleUntil = 0;
    runtime.pendingCaptcha = null;
    runtime.warmupUntil = 0;
    log("SUCCESS", "Resumed by user. Cooldowns keep their remaining time.");
    showToast("OwoSelf resumed.", Toasts.Type.SUCCESS);
    notify();
}

export function setMasterOn(on: boolean): void {
    settings.store.masterSwitch = on;
    if (on) {
        runtime.paused = false;
        runtime.throttleUntil = 0;
        runtime.onBreakUntil = 0;
        runtime.warmupUntil = Date.now() + 3000;
        refreshScheduler();
        log("SUCCESS", "OwoSelf started. Scheduler rebuilt.");
        showToast("OwoSelf started.", Toasts.Type.SUCCESS);
    } else {
        clearQueue();
        log("SYS", "OwoSelf stopped. All loops halted, stats kept.");
        showToast("OwoSelf stopped.", Toasts.Type.MESSAGE);
    }
    notify();
}

function sendWebhook(title: string, message: string): void {
    if (!settings.store.webhookEnabled) return;
    const url = settings.store.webhookUrl.trim();
    if (!url.startsWith("https://")) return;
    void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: "@everyone",
            embeds: [{ title: `OwoSelf Security: ${title}`, description: message.slice(0, 1500), color: 0xff3b3b }]
        })
    }).catch(() => { /* webhook failures must never break the engine */ });
}

function raiseAlert(kind: string, detail: string, captchaUrl?: string): void {
    runtime.paused = true;
    clearQueue();
    runtime.throttleUntil = Number.POSITIVE_INFINITY;
    if (captchaUrl) runtime.pendingCaptcha = { url: captchaUrl, detail, time: Date.now() };
    log("ALARM", `${kind}: ${detail}`);
    showToast(`OwoSelf security: ${kind}. Automation paused.`, Toasts.Type.FAILURE);
    try {
        showNotification({ title: `OwoSelf: ${kind}`, body: detail.slice(0, 200) });
    } catch { /* notifications unavailable */ }
    sendWebhook(kind, detail);
    notify();
}

function fullTextOf(message: OwoMessage): string {
    const parts = [message.content ?? ""];
    for (const e of message.embeds ?? []) {
        if (e.title) parts.push(e.title);
        if (e.author?.name) parts.push(e.author.name);
        if (e.description) parts.push(e.description);
        if (e.footer?.text) parts.push(e.footer.text);
        for (const f of e.fields ?? []) parts.push(`${f.name} ${f.value}`);
    }
    return parts.join("\n").toLowerCase();
}

function normalized(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForMe(message: OwoMessage, text: string): boolean {
    const me = currentUser();
    if (!me) return false;
    for (const m of message.mentions ?? []) {
        if (String(m.id) === me.id) return true;
    }
    const channels = getChannels();
    const inMyChannel = channels.includes(message.channel_id);
    const nameHit = me.username !== "" && new RegExp(`\\b${me.username.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
    if (nameHit) return true;
    if (inMyChannel && Date.now() - runtime.lastSentAt < 60000) return true;
    return false;
}

function syncCash(text: string): void {
    const m = /you currently have[^\d]*([\d,]+)/i.exec(text)
        ?? /(?:now have|balance[^\d]*)([\d,]+)/i.exec(text);
    if (!m?.[1]) return;
    const value = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(value)) return;
    runtime.cash = value;
    runtime.cashHistory.push([Date.now(), value]);
    if (runtime.cashHistory.length > 100) runtime.cashHistory.shift();
    notify();
}

function syncCooldownTimer(text: string, recentCmds: string[]): void {
    const until = /<t:(\d+):r>/i.exec(text);
    if (until?.[1]) {
        const waitMs = Number(until[1]) * 1000 - Date.now();
        if (waitMs > 0 && waitMs < 3600000) {
            runtime.throttleUntil = Number(until[1]) * 1000;
            log("COOLDOWN", `OwO asked to wait, throttling ${Math.round(waitMs / 1000)}s.`);
            notify();
        }
        return;
    }
    if (/slow down|too fast|hold on/i.test(text)) {
        const secs = /(\d+)\s*second/i.exec(text);
        const wait = secs?.[1] ? Number(secs[1]) : 5;
        runtime.throttleUntil = Date.now() + Math.min(wait, 120) * 1000;
        const st = recentCmds.length > 0 ? runtime.cmdStates.get(recentCmds[0] ?? "") : undefined;
        if (st && wait <= 60) {
            st.delay = Math.max(st.delay, wait + 2);
            st.lastRan = Date.now() / 1000;
        }
        log("COOLDOWN", `Slow down detected, throttling ${wait}s.`);
        notify();
    }
}

const GEM_TIERS: Record<string, string[]> = {
    fabled: ["057", "071", "078", "085"],
    legendary: ["056", "070", "077", "084"],
    mythical: ["055", "069", "076", "083"],
    epic: ["054", "068", "075", "082"],
    rare: ["053", "067", "074", "081"],
    uncommon: ["052", "066", "073", "080"],
    common: ["051", "065", "072", "079"]
};

function convertSmallNumbers(text: string): number {
    const map: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };
    const digits = text.split("").map(c => map[c] ?? (/[0-9]/.test(c) ? c : "")).join("");
    return digits === "" ? 0 : Number(digits);
}

function gemsAvailable(content: string): Record<string, number> {
    const out: Record<string, number> = {};
    const re = /(?:`|\*\*)?(\d{2,3})(?:`|\*\*)?.*?([⁰¹²³⁴⁵⁶⁷⁸⁹0-9]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const gid = m[1] ?? "";
        const count = convertSmallNumbers(m[2] ?? "");
        if (/^\d{2,3}$/.test(gid)) out[gid] = count;
    }
    return out;
}

function pickGemsToUse(available: Record<string, number>, wanted: string[]): string[] | null {
    const s = settings.store;
    const tiers = ["fabled", "legendary", "mythical", "epic", "rare", "uncommon", "common"]
        .filter(t => t !== "fabled" || s.gemsAllowFabled)
        .filter(t => t !== "legendary" || s.gemsAllowLegendary);
    const order = s.gemsLowestFirst ? [...tiers].reverse() : tiers;
    const typeIdx: Record<string, number> = { huntGem: 0, empoweredGem: 1, luckyGem: 2, specialGem: 3 };
    const desired = wanted.filter(t => t !== "specialGem" || s.gemsAllowSpecial);

    if (s.gemsUseSet) {
        for (const tier of order) {
            const ids = GEM_TIERS[tier];
            if (!ids) continue;
            const pick: string[] = [];
            let complete = true;
            for (const t of desired) {
                const idx = typeIdx[t] ?? -1;
                const gid = idx >= 0 ? ids[idx] : undefined;
                if (!gid || (available[gid] ?? 0) < 1) { complete = false; break; }
                pick.push(gid);
            }
            if (complete && pick.length > 0) return pick;
        }
        return null;
    }

    const result: string[] = [];
    for (const t of desired) {
        const idx = typeIdx[t] ?? -1;
        if (idx < 0) continue;
        for (const tier of order) {
            const ids = GEM_TIERS[tier];
            const gid = ids?.[idx];
            if (gid && (available[gid] ?? 0) > 0) {
                result.push(gid);
                available[gid] = (available[gid] ?? 1) - 1;
                break;
            }
        }
    }
    return result.length > 0 ? result : null;
}

function handleGems(text: string, rawContent: string): void {
    if (!settings.store.gemsEnabled) return;
    const s = settings.store;
    const wantedAll: string[] = ["huntGem", "empoweredGem", "luckyGem"];
    if (s.gemsAllowSpecial) wantedAll.push("specialGem");

    if (/hunt is empowered by/i.test(text)) {
        const active: string[] = [];
        if (text.includes("gem1")) active.push("huntGem");
        if (text.includes("gem3")) active.push("empoweredGem");
        if (text.includes("gem4")) active.push("luckyGem");
        if (text.includes("star")) active.push("specialGem");
        const missing = wantedAll.filter(t => !active.includes(t) && !runtime.missingGemTypes.includes(t));
        if (missing.length > 0 && !runtime.checkingGems) {
            runtime.checkingGems = true;
            runtime.checkingGemsAt = Date.now();
            runtime.missingGemTypes = missing;
            log("SYS", `Gems missing (${missing.join(", ")}), checking inventory.`);
            enqueue("owo inv", 2, null);
        }
        return;
    }

    if (/caught/i.test(text) && /spent/i.test(text) && !/hunt is empowered by/i.test(text)) {
        if (!runtime.checkingGems && Date.now() - runtime.checkingGemsAt > 15000) {
            const missing = wantedAll.filter(t => !runtime.missingGemTypes.includes(t));
            if (missing.length > 0) {
                runtime.checkingGems = true;
                runtime.checkingGemsAt = Date.now();
                runtime.missingGemTypes = missing;
                log("SYS", "Hunt ran with no gems, checking inventory.");
                enqueue("owo inv", 2, null);
            }
        }
        return;
    }

    if ((text.includes("'s inventory") || text.includes("'s gems")) && runtime.checkingGems) {
        runtime.checkingGems = false;
        const available = gemsAvailable(rawContent);
        const toUse = pickGemsToUse({ ...available }, runtime.missingGemTypes.length > 0 ? runtime.missingGemTypes : wantedAll);
        const typeIdx: Record<string, number> = { huntGem: 0, empoweredGem: 1, luckyGem: 2, specialGem: 3 };
        for (const t of wantedAll) {
            const idx = typeIdx[t] ?? -1;
            if (idx < 0) continue;
            const hasAny = Object.keys(GEM_TIERS).some(tier => {
                const gid = GEM_TIERS[tier]?.[idx];
                return gid !== undefined && (available[gid] ?? 0) > 0;
            });
            runtime.missingGemTypes = runtime.missingGemTypes.filter(x => x !== t || !hasAny);
            if (!hasAny && !runtime.missingGemTypes.includes(t)) {
                runtime.missingGemTypes.push(t);
                log("WARN", `No ${t} in inventory, will not ask again until one appears.`);
            }
        }
        if (toUse) {
            const ids = toUse.map(g => g.replace(/^0/, ""));
            runtime.gemsUsed += toUse.length;
            enqueue(`owo use ${ids.join(" ")}`, 2, null);
            log("SUCCESS", `Equipped gems: ${ids.join(" ")}.`);
        } else {
            log("WARN", "Inventory checked, no matching gems to equip.");
        }
        runtime.missingGemTypes = [];
        notify();
    }
}

function handleGambling(text: string): void {
    const cf = /chose heads|chose tails/i.test(text);
    const slots = /___slots___/i.test(text);
    const bj = !cf && !slots && /blackjack/i.test(text) && /you won|you lost|you tied|you both bust/i.test(text);
    if (!cf && !slots && !bj) return;
    if (bj) {
        if (/you tied|you both bust/i.test(text)) {
            syncCash(text);
            log("GAMBLING", "Blackjack tied, no win or loss recorded.");
            return;
        }
        const won = /you won/i.test(text);
        settleBet("blackjack", won, currentBet("blackjack", settings.store.blackjackAmount));
        trackQuestProgress("Gamble");
        const st = runtime.cmdStates.get("blackjack");
        if (st) st.delay = rand(40, 70);
        syncCash(text);
        return;
    }
    const won = /\bwon\b|\bwin\b/i.test(text) && !/\blost\b|\blose\b/i.test(text);
    const game = cf ? "coinflip" : "slots";
    const base = game === "coinflip" ? settings.store.coinflipAmount : settings.store.slotsAmount;
    settleBet(game, won, currentBet(game, base));
    trackQuestProgress("Gamble");
    if (game === "coinflip") {
        const st = runtime.cmdStates.get("coinflip");
        if (st) st.delay = rand(30, 60);
    } else {
        const st = runtime.cmdStates.get("slots");
        if (st) st.delay = rand(25, 50);
    }
    syncCash(text);
}

function handleHuntbot(message: OwoMessage, text: string): void {
    if (!settings.store.huntbotEnabled) return;
    const st = runtime.cmdStates.get("huntbot");
    if (settings.store.huntbotUpgradeEnabled && message.embeds) {
        for (const embed of message.embeds) {
            if (!embed.fields || embed.fields.length === 0) continue;
            if (!headerMentionsMe(message)) continue;
            const keywords: Record<string, string> = {
                efficiency: "efficiency", duration: "duration", cost: "cost",
                gain: "gain", exp: "experience", radar: "radar"
            };
            let essence = 0;
            const levels: Record<string, number> = {};
            const invested: Record<string, number> = {};
            const enabled: string[] = [];
            for (const field of embed.fields) {
                const fname = (field.name ?? "").toLowerCase();
                const fval = field.value ?? "";
                if (fname.includes("animal essence")) {
                    const backticked = /`([\d,]+)`/.exec(field.name ?? "")?.[1];
                    const plain = /[\d,]+/.exec(field.name ?? "")?.[0];
                    essence = Number((backticked ?? plain ?? "0").replace(/,/g, ""));
                    continue;
                }
                for (const [trait, keyword] of Object.entries(keywords)) {
                    if (!fname.includes(keyword)) continue;
                    if (fval.includes("[MAX]")) {
                        levels[trait] = 1000;
                        invested[trait] = 0;
                        enabled.push(trait);
                    } else {
                        const lvl = /Lvl (\d+) \[(\d+)\/\d+\]/.exec(fval);
                        if (lvl?.[1] && lvl[2]) {
                            levels[trait] = Number(lvl[1]);
                            invested[trait] = Number(lvl[2]);
                            enabled.push(trait);
                        }
                    }
                    break;
                }
            }
            if (enabled.length > 0 && essence > 0) {
                if (essence !== lastUpgradeEssence || Date.now() - lastUpgradeTime >= 30000) {
                    const allocations = allocateHuntbotUpgrades(essence, levels, invested, enabled);
                    if (Object.keys(allocations).length > 0) {
                        lastUpgradeEssence = essence;
                        lastUpgradeTime = Date.now();
                        for (const [trait, amount] of Object.entries(allocations)) {
                            enqueue(`upgrade ${trait} ${amount}`, 2, null);
                            log("SUCCESS", `Huntbot: upgrading ${trait} with ${amount.toLocaleString()} essence.`);
                        }
                    }
                }
            } else if (enabled.length > 0) {
                log("SYS", "Huntbot: no essence to spend, skipping upgrade.");
            }
            break;
        }
    }
    if (/i will be back in/i.test(text)) {
        let total = 0;
        let found = false;
        for (const m of text.toUpperCase().matchAll(/(\d+)([DHM])/g)) {
            found = true;
            const n = Number(m[1]);
            if (m[2] === "M") total += n * 60;
            else if (m[2] === "H") total += n * 3600;
            else if (m[2] === "D") total += n * 86400;
        }
        if (found) {
            runtime.huntbotDelay = total + 30;
            if (st) { st.delay = runtime.huntbotDelay; st.lastRan = Date.now() / 1000; }
            log("SYS", `Huntbot busy, resyncing for ${Math.round(total / 60)}m.`);
            notify();
        }
        return;
    }
    if (/i am back with|beep boop\. i am back with/i.test(text)) {
        runtime.huntbotDelay = 900;
        if (st) { st.delay = 20; st.lastRan = Date.now() / 1000; }
        log("SUCCESS", "Huntbot returned, checking again soon.");
        notify();
        return;
    }
    if (/here is your password|confirm your identity|please include your password/i.test(text)) {
        runtime.huntbotDelay = 660;
        if (st) { st.delay = runtime.huntbotDelay; st.lastRan = Date.now() / 1000; }
        log("WARN", "Huntbot asks for a password image. Open the channel and solve it, automation waits.");
        showToast("OwoSelf: huntbot password required, check the channel.", Toasts.Type.MESSAGE);
        notify();
        return;
    }
    if (/wrong password|incorrect password/i.test(text)) {
        runtime.huntbotDelay = 630;
        if (st) { st.delay = runtime.huntbotDelay; st.lastRan = Date.now() / 1000; }
        log("WARN", "Huntbot: wrong password, waiting for reset.");
        notify();
    }
}

function handleQuest(text: string): void {
    if (!settings.store.questEnabled) return;
    if (!/quest log|checklist/.test(text)) return;
    const clean = text.replace(/:blank:/g, "").replace(/\*/g, "");
    const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
    const quests: QuestItem[] = [];
    let current: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (/reward:/i.test(line)) {
            const desc = line.split(/reward:/i)[0]?.replace(/‣/g, "").replace(/^\d+[).]\s*/, "").replace(/<[^>]*>/g, "").replace(/`/g, "").trim() ?? "";
            if (desc && !/quest log|quests belong/i.test(desc)) current = desc;
            else if (i > 0) current = (lines[i - 1] ?? "").replace(/^\d+[).]\s*/, "").trim();
        }
        const prog = /progress:\s*\[(\d+)\/(\d+)\]/i.exec(line) ?? /\b(\d+)\/(\d+)\b/.exec(line);
        if (prog?.[1] && prog[2] && current) {
            const cur = Number(prog[1]);
            const total = Number(prog[2]);
            quests.push({ description: current, current: cur, total, completed: cur >= total });
            current = null;
        }
    }
    if (quests.length > 0) {
        for (const q of quests) {
            const was = runtime.questData.find(o => o.description === q.description)?.completed;
            if (q.completed && !was) log("SUCCESS", `Quest completed: ${q.description}`);
        }
        runtime.questData = quests;
    }
    const timer = /next quest in:\s*(\d+h \d+m \d+s)|next quest.*?in\s*(\d+\w+(?:\s*\d+\w+)*)/i.exec(text);
    runtime.nextQuestTimer = (timer?.[1] ?? timer?.[2] ?? "").toUpperCase() || runtime.nextQuestTimer;

    if (settings.store.questAutoSolve) {
        for (const q of quests) {
            if (q.completed) continue;
            const d = q.description.toLowerCase();
            if (/gamble/i.test(d)) {
                enqueue("owo cf 1 t", 4, null);
                log("SYS", "Quest solver: gambling 1 cowoncy.");
                break;
            }
            if (/say 'owo'|say owo/i.test(d)) {
                enqueue("owo", 4, null);
                log("SYS", "Quest solver: saying owo.");
                break;
            }
            if (/animal.*that is|rarity/i.test(d)) {
                runtime.forceLuckyGems = true;
                log("SYS", "Quest solver: rarity quest, forcing lucky gems.");
                break;
            }
        }
    }
    notify();
}

function handleSecurity(message: OwoMessage, text: string, norm: string): boolean {
    if (!settings.store.securityEnabled) return false;
    const owoId = settings.store.owoBotId;
    if (message.author.id !== owoId) return false;

    const captchaUrl = /https?:\/\/owobot\.com\/captcha\/\S+/i.exec(message.content)?.[0]
        ?? message.buttonUrls?.find(u => /owobot\.com\/captcha/i.test(u));
    const banHit = ["youhavebeenbanned", "bannedforbotting", "bannedformacros"].some(k => norm.includes(k));
    if (banHit) {
        raiseAlert("Ban detected", text.slice(0, 300));
        return true;
    }
    const warning = /\(\s*(\d+)\s*\/\s*(\d+)\s*\)/.exec(text);
    const captchaHit = ["areyouarealhuman", "verifythatyouarehuman", "completeyourcaptcha",
        "pleasecompletethiswithin", "tocheckthatyouareahuman", "pleasecomplete"].some(k => norm.includes(k));
    const imageHit = (message.attachments?.length ?? 0) > 0 &&
        ["letterword", "pleasedmme", "beepboop", "solvingthecaptcha"].some(k => norm.includes(k));

    if (message.guild_id === undefined && /i have verified that you are human/i.test(text)) {
        runtime.captchas++;
        log("SUCCESS", "Verified human detected, resuming automation.");
        resumeEngine();
        return true;
    }

    if (imageHit) {
        const count = /(\d+)\s*letterword/i.exec(text)?.[1] ?? "?";
        const solverOn = settings.store.captchaSolverEnabled;
        const key = settings.store.captchaService === "yescaptcha" ? settings.store.yescaptchaKey
            : settings.store.captchaService === "nopecha" ? settings.store.nopechaKey
                : settings.store.anticaptchaKey;
        if (solverOn && key.trim() !== "") {
            log("SYS", `Letterword captcha (${count} letters) seen, auto solve needs the dashboard flow. Pausing for manual solve.`);
        }
        raiseAlert("Image captcha detected", `Letterword captcha (${count} letters). Solve it in the channel, then press Resume in the dashboard.`);
        return true;
    }

    if (captchaUrl || captchaHit || (warning && /captcha|verify|human|complete/.test(norm))) {
        const label = warning ? `Captcha warning (${warning[1]}/${warning[2]})` : "Captcha detected";
        const solverOn = settings.store.captchaSolverEnabled;
        const key = settings.store.captchaService === "yescaptcha" ? settings.store.yescaptchaKey
            : settings.store.captchaService === "nopecha" ? settings.store.nopechaKey
                : settings.store.anticaptchaKey;
        if (solverOn && key.trim() !== "") {
            log("SYS", `Trying ${settings.store.captchaService} auto solve, falling back to manual if it fails.`);
        }
        raiseAlert(label, `${text.slice(0, 200)}${captchaUrl ? `\nSolve: ${captchaUrl}` : ""}`, captchaUrl);
        return true;
    }
    return false;
}

function handleReactionBot(message: OwoMessage, text: string): void {
    if (!settings.store.reactionBotEnabled) return;
    if (message.author.id !== REACTION_BOT_ID) return;
    if (!isForMe(message, text)) return;
    const kick = (cmdId: string) => {
        const st = runtime.cmdStates.get(cmdId);
        if (st) { st.lastRan = 0; st.delay = rand(0.5, 1); }
    };
    if (text.includes("**owo**")) kick("owo");
    if (text.includes("**hunt") || text.includes("**battle")) { kick("hunt"); kick("battle"); }
    if (text.includes("**pray") || text.includes("**curse")) {
        const st = runtime.cmdStates.get("cursepray");
        if (st) { st.lastRan = 0; st.delay = rand(0.5, 1); }
    }
}

let dashboardOpener: (() => void) | null = null;

export function setDashboardOpener(fn: (() => void) | null): void {
    dashboardOpener = fn;
}

function handleSelfCommand(message: OwoMessage): boolean {
    const me = currentUser();
    if (!me || message.author.id !== me.id) return false;
    const content = (message.content ?? "").trim();
    const lower = content.toLowerCase();
    const prefix = (settings.store.prefix || "owo ").trim().toLowerCase();
    if (lower === "owo" || lower === "uwu" || lower === `${prefix}owo` || lower === `${prefix}uwu`) {
        trackQuestProgress("Say 'owo'");
    }
    let arg: string | null = null;
    if (lower === ".owoself" || lower === "owoself") arg = "";
    else if (lower.startsWith(".owoself ")) arg = content.slice(9).trim().toLowerCase();
    else if (lower.startsWith("owoself ")) arg = content.slice(8).trim().toLowerCase();
    if (arg === null) return false;

    try {
        MessageActions.deleteMessage(message.channel_id, message.id);
    } catch { /* deleting the trigger is best effort */ }

    if (arg === "start" || arg === "go" || arg === "on") setMasterOn(true);
    else if (arg === "stop" || arg === "off") setMasterOn(false);
    else if (arg === "pause") pauseEngine("Paused from chat.");
    else if (arg === "resume") resumeEngine();
    else if (arg === "dashboard" || arg === "dash") {
        if (dashboardOpener) dashboardOpener();
        else showToast("OwoSelf dashboard is not available right now.", Toasts.Type.FAILURE);
    } else if (arg === "status") {
        const snap = snapshot();
        const state = !snap.masterOn ? "stopped" : snap.paused ? "paused" : snap.onBreak ? "on a human break" : "running";
        showToast(`OwoSelf ${state}. ${snap.hunts + snap.battles + snap.owos} grinds, ${snap.cash > 0 ? snap.cash.toLocaleString() : "unknown"} cowoncy, channel ${channelLabel(snap.channel ?? "")}.`, Toasts.Type.MESSAGE);
    } else {
        showToast("OwoSelf: start, stop, pause, resume, status, dashboard.", Toasts.Type.MESSAGE);
    }
    return true;
}

function headerMentionsMe(message: OwoMessage): boolean {
    const me = currentUser();
    const name = me?.username.toLowerCase() ?? "";
    if (name === "") return false;
    for (const e of message.embeds ?? []) {
        if ((e.author?.name?.toLowerCase() ?? "").includes(name)) return true;
        if ((e.title?.toLowerCase() ?? "").includes(name)) return true;
    }
    return false;
}

function parseWaitSeconds(text: string): number {
    const h = /(\d+)\s*h/i.exec(text)?.[1];
    const m = /(\d+)\s*m/i.exec(text)?.[1];
    const sec = /(\d+)\s*s/i.exec(text)?.[1];
    return (h ? Number(h) * 3600 : 0) + (m ? Number(m) * 60 : 0) + (sec ? Number(sec) : 0);
}

function parseBlackjack(fields: { name: string; value: string; }[]): { dealer: number; player: number; soft: boolean; } | null {
    let dealer: number | null = null;
    let player: number | null = null;
    let soft = false;
    for (const field of fields) {
        const name = field.name ?? "";
        const dealerMatch = /Dealer\s*`?\[(\d+)(?:\+\?)?\]`?/.exec(name);
        if (dealerMatch?.[1]) {
            dealer = Number(dealerMatch[1]);
            continue;
        }
        const playerMatch = /`?\[(\d+)\](\*?)`?/.exec(name);
        if (playerMatch?.[1]) {
            player = Number(playerMatch[1]);
            soft = playerMatch[2] === "*";
        }
    }
    if (dealer === null || player === null) return null;
    return { dealer, player, soft };
}

function bestBlackjackMove(dealer: number, player: number, soft: boolean): "HIT" | "STAND" {
    if (soft) {
        if (player <= 17) return "HIT";
        if (player === 18) return dealer >= 9 ? "HIT" : "STAND";
        return "STAND";
    }
    if (player <= 11) return "HIT";
    if (player === 12) return dealer >= 4 && dealer <= 6 ? "STAND" : "HIT";
    if (player >= 13 && player <= 16) return dealer >= 2 && dealer <= 6 ? "STAND" : "HIT";
    return "STAND";
}

async function maybePlayBlackjack(message: OwoMessage): Promise<void> {
    if (!settings.store.blackjackEnabled) return;
    if (!message.embeds || message.embeds.length === 0) return;
    if (runtime.playedBlackjack.includes(message.id)) return;
    const me = currentUser();
    if (!me) return;
    const embed = message.embeds[0];
    if (!embed) return;
    if (!(embed.author?.name?.toLowerCase() ?? "").startsWith(me.username.toLowerCase())) return;
    if (!embed.fields?.some(f => (f.name ?? "").toLowerCase().includes("dealer"))) return;
    const footer = embed.footer?.text ?? "";
    if (/You won|You lost|You tied|You both bust/.test(footer)) return;
    const parsed = parseBlackjack(embed.fields);
    if (!parsed) {
        log("WARN", "Blackjack: could not parse the table embed.");
        return;
    }
    const move = bestBlackjackMove(parsed.dealer, parsed.player, parsed.soft);
    log("INFO", `Blackjack: dealer ${parsed.dealer}, player ${parsed.player}${parsed.soft ? "*" : ""}, playing ${move}.`);
    await sleep(rand(0.8, 2.2));
    if (runtime.paused || !settings.store.masterSwitch) return;
    runtime.playedBlackjack.push(message.id);
    if (runtime.playedBlackjack.length > 20) runtime.playedBlackjack.shift();
    try {
        await RestAPI.put({
            url: Constants.Endpoints.REACTION(message.channel_id, message.id, encodeURIComponent(move === "HIT" ? "👊" : "🛑"), "@me")
        });
        log("SUCCESS", `Blackjack: played ${move}.`);
    } catch (e) {
        logger.warn("Blackjack reaction failed", e);
        log("ERROR", "Blackjack: reaction failed, play by hand if needed.");
    }
    notify();
}

function zooAnimalNames(content: string): string[] {
    const found: string[] = [];
    const pattern = /<a?:[a-zA-Z0-9_]+:\d+>|:[a-zA-Z0-9_]+:|[\u{1F300}-\u{1F6FF}\u{1F700}-\u{1F77F}]/gu;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
        const name = EMOJI_NAMES[m[0] ?? ""];
        if (name) found.push(name);
    }
    return found;
}

export function handleMessage(message: OwoMessage): void {
    if (!message || !message.author?.id) return;
    if (handleSelfCommand(message)) return;
    handleReactionBot(message, (message.content ?? "").toLowerCase());
    if (message.author.id !== settings.store.owoBotId) return;

    const text = fullTextOf(message);
    const norm = normalized(text);
    if (handleSecurity(message, text, norm)) return;

    const channels = getChannels();
    const inScope = channels.length === 0 || channels.includes(message.channel_id);
    const mine = isForMe(message, text);
    syncCooldownTimer(text, ["hunt", "battle", "owo"]);
    void maybePlayBlackjack(message);
    if (!mine && !inScope) return;
    if (!mine) return;

    const s = settings.store;
    if (/you found:|caught a|caught an/i.test(text)) {
        const st = runtime.cmdStates.get("hunt");
        if (st) st.delay = rand(s.huntCooldownMin, s.huntCooldownMax);
        trackQuestProgress("Manually hunt");
        for (const q of runtime.questData) {
            if (q.completed) continue;
            const rank = /hunt 3 animals that are\s+(\w+)/i.exec(q.description)?.[1]?.toLowerCase();
            if (rank && (text.includes(rank) || text.includes(`:${rank}:`))) {
                trackQuestProgress(q.description);
            }
        }
    }
    if (/you won|you lost|streak:|wins!/i.test(text)) {
        const st = runtime.cmdStates.get("battle");
        if (st) st.delay = rand(s.battleCooldownMin, s.battleCooldownMax);
        if (/wins!/i.test(text)) trackQuestProgress("battle with a friend");
        else trackQuestProgress("Battle", 1, "friend");
    }
    if (/puts a curse on|is now cursed|is cursed/i.test(text)) {
        log("SUCCESS", "Curse confirmed.");
        trackQuestProgress("Have a friend curse you");
    }
    if (/prays for|prays\.\.\./i.test(text)) {
        log("SUCCESS", "Pray confirmed.");
        trackQuestProgress("Have a friend pray to you");
    }
    if (/gave a cookie to|sent a cookie|got a cookie from/i.test(text)) {
        log("SUCCESS", "Cookie confirmed.");
        trackQuestProgress("Receive a cookie from");
        runtime.lastCookieRun = Date.now() / 1000;
        const st = runtime.cmdStates.get("cookie");
        if (st) {
            st.delay = 86400;
            st.lastRan = Date.now() / 1000;
        }
    }
    if (/collected your daily|daily reward/i.test(text)) {
        log("SUCCESS", "Daily claimed.");
    }
    if (EMOTE_TRIGGERS.some(t => text.includes(t))) {
        const last = runtime.lastSentCommand.toLowerCase();
        if (["hug", "poke", "pat", "cuddle", "kiss"].some(e => last.includes(e))) {
            trackQuestProgress("Use an action command on someone");
        } else {
            trackQuestProgress("Have a friend use an action command on you");
        }
    }
    const xp = /(?:\+|gained\s+)(\d+)\s*xp/i.exec(text)?.[1];
    if (xp) trackQuestProgress("xp from", Number(xp));
    syncCash(text);
    handleGems(text, message.content ?? "");
    handleGambling(text);
    handleHuntbot(message, text);
    handleQuest(text);

    if (/challenges you to a duel/i.test(text)) {
        enqueue("ab", 4, null);
        log("INFO", "Duel challenge seen, accepting via ab.");
    }

    if (/too tired to run/i.test(text)) runtime.rppBlocked.run = Date.now() / 1000 + 86400;
    if (/garden is out of carrots/i.test(text)) runtime.rppBlocked.piku = Date.now() / 1000 + 86400;
    if (/no puppies/i.test(text)) runtime.rppBlocked.pup = Date.now() / 1000 + 86400;

    if (/wait/i.test(text) && Date.now() - runtime.lastDailySent < 20000 && /daily/i.test(text)) {
        const total = parseWaitSeconds(text);
        if (total > 0) {
            const st = runtime.cmdStates.get("daily");
            if (st) { st.delay = total + 20; st.lastRan = Date.now() / 1000; }
            log("COOLDOWN", `Daily resynced, next claim in ${Math.round(total / 3600)}h.`);
        }
        runtime.lastDailySent = 0;
    }
    if (/wait/i.test(text) && (Date.now() - runtime.lastCookieSent < 20000 || /cookie/i.test(text))) {
        const total = parseWaitSeconds(text);
        if (total > 0) {
            const st = runtime.cmdStates.get("cookie");
            if (st) { st.delay = total + 20; st.lastRan = Date.now() / 1000; }
            log("COOLDOWN", "Cookie resynced.");
        }
        runtime.lastCookieSent = 0;
    }

    const sellType = (s.sellType || "all").trim() || "all";
    if ((/you don't have enough cowoncy/i.test(text) || /you do not have enough cowoncy/i.test(text)) && s.sellEnabled && Date.now() - runtime.lastSellSent > 60000) {
        enqueue(`sell ${sellType}`, 2, null);
        log("SYS", "Low cash response, selling animals.");
    }

    if (text.includes("**you must accept these rules to use the bot!**")) {
        log("WARN", "OwO asks to accept its rules. Accept once by hand, buttons cannot be auto clicked here.");
    }

    if (/you do not have an active battle team/i.test(text)) {
        runtime.zooPending = true;
        enqueue("zoo", 2, null);
        log("SYS", "No battle team, checking zoo.");
    }
    if (/zoo!/i.test(text) && runtime.zooPending && headerMentionsMe(message)) {
        runtime.zooPending = false;
        const animals = zooAnimalNames(message.content ?? "").reverse().slice(0, 3);
        for (const animal of animals) {
            enqueue(`team add ${animal}`, 2, null);
        }
        if (animals.length > 0) log("SUCCESS", `Battle team set: ${animals.join(", ")}.`);
        else log("WARN", "Zoo had no known animals, set the team by hand.");
    }

    const bought = /you bought a.*?for \*\*(\d+)\*\*/i.exec(text)?.[1];
    if (bought) {
        runtime.cash = Math.max(0, runtime.cash - Number(bought));
        log("SUCCESS", `Shop: bought item for ${Number(bought).toLocaleString()}, balance now ${runtime.cash.toLocaleString()}.`);
    }

    const now = Date.now();
    const crateSuffix = ((s.crateType || "all").trim() || "all").toLowerCase();
    if (s.crateEnabled && (/received a/i.test(text) || /found a/i.test(text)) && /weapon crate/i.test(text) && now >= runtime.crateCooldownUntil) {
        runtime.crateCooldownUntil = now + 10000;
        enqueue(`crate ${crateSuffix === "" ? "all" : crateSuffix}`, 4, null);
        log("SYS", "Opening weapon crates.");
    }
    const lootboxSuffix = ((s.lootboxType || "all").trim() || "all").toLowerCase();
    if (s.lootboxEnabled && (/received a/i.test(text) || /found a/i.test(text)) && /lootbox/i.test(text) && now >= runtime.lootboxCooldownUntil) {
        runtime.lootboxCooldownUntil = now + 10000;
        enqueue(`lootbox ${lootboxSuffix === "" ? "all" : lootboxSuffix}`, 4, null);
        log("SYS", "Opening lootboxes.");
    }
    if (/you don't have any lootboxes|no lootboxes/i.test(text)) {
        runtime.lootboxCooldownUntil = now + 3600000;
        log("COOLDOWN", "No lootboxes, pausing opens for 1h.");
    }
    if (/you don't have any crates|no weapon crates/i.test(text)) {
        runtime.crateCooldownUntil = now + 86400000;
        log("COOLDOWN", "No crates, pausing opens for 24h.");
    }
    if (/resets in/i.test(text) && /weapon crate/i.test(text)) {
        const total = parseWaitSeconds(text);
        if (total > 0) runtime.crateCooldownUntil = now + total * 1000 + 10000;
    }

    if (s.giveawayEnabled && /giveaway/i.test(text)) {
        log("SYS", "Giveaway spotted in a grind channel, open it before it ends.");
        showToast("OwoSelf: OwO giveaway spotted.", Toasts.Type.MESSAGE);
    }
    if (s.bossEnabled && /guild boss/i.test(text)) {
        log("SYS", "Guild boss event spotted.");
        showToast("OwoSelf: guild boss event spotted.", Toasts.Type.MESSAGE);
    }
    notify();
}

export function snapshot(): {
    running: boolean;
    masterOn: boolean;
    paused: boolean;
    onBreak: boolean;
    throttled: boolean;
    uptimeMin: number;
    cash: number;
    hunts: number;
    battles: number;
    owos: number;
    gemsUsed: number;
    captchas: number;
    bans: number;
    warnings: number;
    queue: number;
    channel: string | null;
    profileName: string | null;
    questData: QuestItem[];
    nextQuestTimer: string | null;
    gambling: GamblingStats;
    pendingCaptcha: CaptchaAlert | null;
    activeCmds: { id: string; delay: number; remaining: number; }[];
} {
    const now = Date.now();
    const activeCmds = [...runtime.cmdStates.entries()].map(([id, st]) => ({
        id,
        delay: Math.round(st.delay),
        remaining: Math.max(0, Math.round(st.delay - (now / 1000 - st.lastRan)))
    }));
    return {
        running: tickId !== null && settings.store.masterSwitch,
        masterOn: settings.store.masterSwitch,
        paused: runtime.paused,
        onBreak: onBreak(),
        throttled: runtime.throttleUntil > now,
        uptimeMin: Math.floor((now - runtime.startedAt) / 60000),
        cash: runtime.cash,
        hunts: runtime.hunt,
        battles: runtime.battle,
        owos: runtime.owo,
        gemsUsed: runtime.gemsUsed,
        captchas: runtime.captchas,
        bans: runtime.bans,
        warnings: runtime.warnings,
        queue: runtime.queue.length,
        channel: getChannelId(),
        profileName: runtime.activeProfile?.name ?? null,
        questData: runtime.questData,
        nextQuestTimer: runtime.nextQuestTimer,
        gambling: runtime.gambling,
        pendingCaptcha: runtime.pendingCaptcha,
        activeCmds
    };
}
