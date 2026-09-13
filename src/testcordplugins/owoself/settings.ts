/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    masterSwitch: {
        type: OptionType.BOOLEAN,
        description: "Master switch for all OwoSelf automation. The plugin always boots stopped, turn this on (or press Start) to grind.",
        default: false
    },
    owoBotId: {
        type: OptionType.STRING,
        description: "User ID of the OwO bot to listen to.",
        default: "408785106942164992"
    },
    prefix: {
        type: OptionType.STRING,
        description: "Command prefix for OwO. Default owo sends spaced commands like owo hunt. A custom prefix joins directly, so w sends whunt and wcash.",
        default: "owo "
    },
    fallbackChannels: {
        type: OptionType.STRING,
        description: "Channel IDs to grind in when no account profile matches. Comma separated.",
        default: "",
        multiline: true
    },
    useShortform: {
        type: OptionType.BOOLEAN,
        description: "Send short forms (h, b, cf, s) instead of full command names.",
        default: true
    },

    huntEnabled: { type: OptionType.BOOLEAN, description: "Auto hunt.", default: true },
    huntCooldownMin: { type: OptionType.NUMBER, description: "Hunt cooldown range minimum (seconds).", default: 15 },
    huntCooldownMax: { type: OptionType.NUMBER, description: "Hunt cooldown range maximum (seconds).", default: 18 },
    battleEnabled: { type: OptionType.BOOLEAN, description: "Auto battle.", default: true },
    battleCooldownMin: { type: OptionType.NUMBER, description: "Battle cooldown range minimum (seconds).", default: 15 },
    battleCooldownMax: { type: OptionType.NUMBER, description: "Battle cooldown range maximum (seconds).", default: 18 },
    owoEnabled: { type: OptionType.BOOLEAN, description: "Send periodic owo for lootboxes.", default: true },
    owoCooldownMin: { type: OptionType.NUMBER, description: "Owo cooldown range minimum (seconds).", default: 10 },
    owoCooldownMax: { type: OptionType.NUMBER, description: "Owo cooldown range maximum (seconds).", default: 13 },

    prayEnabled: { type: OptionType.BOOLEAN, description: "Auto pray on a timer.", default: true },
    prayTargets: {
        type: OptionType.STRING,
        description: "Pray target user IDs, comma separated. Empty means pray yourself.",
        default: ""
    },
    prayPing: { type: OptionType.BOOLEAN, description: "Ping pray targets with a mention.", default: true },
    curseEnabled: { type: OptionType.BOOLEAN, description: "Auto curse on a timer.", default: false },
    curseTargets: {
        type: OptionType.STRING,
        description: "Curse target user IDs, comma separated.",
        default: ""
    },
    cursePing: { type: OptionType.BOOLEAN, description: "Ping curse targets with a mention.", default: true },
    cursePrayCooldownMin: { type: OptionType.NUMBER, description: "Curse and pray shared cooldown minimum (seconds).", default: 310 },
    cursePrayCooldownMax: { type: OptionType.NUMBER, description: "Curse and pray shared cooldown maximum (seconds).", default: 400 },

    dailyEnabled: { type: OptionType.BOOLEAN, description: "Claim daily automatically.", default: true },
    cookieEnabled: { type: OptionType.BOOLEAN, description: "Send cookies automatically.", default: false },
    cookieTarget: { type: OptionType.STRING, description: "User ID to send cookies to.", default: "" },
    rppEnabled: { type: OptionType.BOOLEAN, description: "Run rpp commands (run, pup, piku) on a timer.", default: true },
    rppInterval: { type: OptionType.NUMBER, description: "Seconds between rpp commands.", default: 60 },

    questEnabled: { type: OptionType.BOOLEAN, description: "Poll quests and track progress.", default: true },
    questAutoSolve: { type: OptionType.BOOLEAN, description: "Auto solve easy quests (gamble 1, emotes, say owo).", default: true },
    questIntervalH: { type: OptionType.NUMBER, description: "Hours between quest polls.", default: 6 },

    huntbotEnabled: { type: OptionType.BOOLEAN, description: "Run autohunt and manage huntbot.", default: true },
    huntbotCash: { type: OptionType.NUMBER, description: "Cowoncy to spend per huntbot run.", default: 3000 },
    huntbotUpgradeEnabled: { type: OptionType.BOOLEAN, description: "Auto spend essence on huntbot upgrades.", default: true },
    huntbotPrioEfficiency: { type: OptionType.NUMBER, description: "Upgrade priority for efficiency.", default: 4 },
    huntbotPrioDuration: { type: OptionType.NUMBER, description: "Upgrade priority for duration.", default: 2 },
    huntbotPrioCost: { type: OptionType.NUMBER, description: "Upgrade priority for cost.", default: 5 },
    huntbotPrioGain: { type: OptionType.NUMBER, description: "Upgrade priority for gain.", default: 4 },
    huntbotPrioExp: { type: OptionType.NUMBER, description: "Upgrade priority for experience.", default: 3 },
    huntbotPrioRadar: { type: OptionType.NUMBER, description: "Upgrade priority for radar.", default: 1 },

    gemsEnabled: { type: OptionType.BOOLEAN, description: "Auto equip gems when hunts run unempowered.", default: true },
    gemsLowestFirst: { type: OptionType.BOOLEAN, description: "Use lowest tier gems first instead of highest.", default: false },
    gemsUseSet: { type: OptionType.BOOLEAN, description: "Only equip full same-tier gem sets.", default: false },
    gemsAllowFabled: { type: OptionType.BOOLEAN, description: "Allow using fabled gems.", default: false },
    gemsAllowLegendary: { type: OptionType.BOOLEAN, description: "Allow using legendary gems.", default: false },
    gemsAllowSpecial: { type: OptionType.BOOLEAN, description: "Allow using special (star) gems.", default: false },

    coinflipEnabled: { type: OptionType.BOOLEAN, description: "Auto gamble coinflip.", default: false },
    coinflipAmount: { type: OptionType.NUMBER, description: "Base coinflip bet.", default: 400 },
    coinflipSide: {
        type: OptionType.SELECT,
        description: "Coinflip side.",
        options: [
            { label: "Heads", value: "h", default: true },
            { label: "Tails", value: "t" }
        ]
    },
    slotsEnabled: { type: OptionType.BOOLEAN, description: "Auto gamble slots.", default: false },
    slotsAmount: { type: OptionType.NUMBER, description: "Base slots bet.", default: 1 },
    blackjackEnabled: { type: OptionType.BOOLEAN, description: "Auto gamble blackjack.", default: false },
    blackjackAmount: { type: OptionType.NUMBER, description: "Base blackjack bet.", default: 100 },
    gambleStrategy: {
        type: OptionType.SELECT,
        description: "Bet sizing strategy.",
        options: [
            { label: "Martingale (double on loss)", value: "martingale", default: true },
            { label: "Flat (same bet always)", value: "flat" }
        ]
    },
    gambleMinBalance: { type: OptionType.NUMBER, description: "Stop betting below this balance (stop loss).", default: 40000 },
    gambleMaxBalance: { type: OptionType.NUMBER, description: "Stop betting above this balance (take profit).", default: 1000000 },
    gambleMaxBet: { type: OptionType.NUMBER, description: "Never bet more than this per round.", default: 10000 },

    sellEnabled: { type: OptionType.BOOLEAN, description: "Auto sell animals on a timer.", default: false },
    sellIntervalMin: { type: OptionType.NUMBER, description: "Minutes between auto sells.", default: 20 },
    sellType: { type: OptionType.STRING, description: "What to sell (all or an animal name).", default: "all" },
    sacrificeEnabled: { type: OptionType.BOOLEAN, description: "Auto sacrifice animals on a timer.", default: false },
    sacrificeIntervalMin: { type: OptionType.NUMBER, description: "Minutes between auto sacrifices.", default: 60 },
    sacrificeType: { type: OptionType.STRING, description: "What to sacrifice (all or an animal name).", default: "all" },

    shopEnabled: { type: OptionType.BOOLEAN, description: "Auto buy weapons from the shop.", default: true },
    shopItems: { type: OptionType.NUMBER, description: "Weapon tier to buy (1 to 7).", default: 1 },
    shopCooldown: { type: OptionType.NUMBER, description: "Seconds between shop buys.", default: 3600 },

    crateEnabled: { type: OptionType.BOOLEAN, description: "Auto open weapon crates when found.", default: false },
    crateType: { type: OptionType.STRING, description: "How many crates to open (all or a number).", default: "all" },
    lootboxEnabled: { type: OptionType.BOOLEAN, description: "Auto open lootboxes when found.", default: false },
    lootboxType: { type: OptionType.STRING, description: "How many lootboxes to open (all or a number).", default: "all" },

    giveawayEnabled: { type: OptionType.BOOLEAN, description: "Detect OwO giveaways and notify you.", default: true },

    levelGrindEnabled: { type: OptionType.BOOLEAN, description: "Send random chat messages to grind levels.", default: false },
    levelGrindMin: { type: OptionType.NUMBER, description: "Level grind cooldown minimum (seconds).", default: 60 },
    levelGrindMax: { type: OptionType.NUMBER, description: "Level grind cooldown maximum (seconds).", default: 90 },

    autochannelEnabled: { type: OptionType.BOOLEAN, description: "Rotate between grind channels automatically.", default: true },
    autochannelMin: { type: OptionType.NUMBER, description: "Channel rotation cooldown minimum (seconds).", default: 500 },
    autochannelMax: { type: OptionType.NUMBER, description: "Channel rotation cooldown maximum (seconds).", default: 650 },

    typingEnabled: { type: OptionType.BOOLEAN, description: "Simulate human typing delays before sends.", default: true },
    reactionDelayMin: {
        type: OptionType.SLIDER,
        description: "Minimum reaction delay before answering OwO (seconds).",
        markers: [0, 1, 2, 5, 10],
        default: 1,
        stickToMarkers: false
    },
    reactionDelayMax: {
        type: OptionType.SLIDER,
        description: "Maximum reaction delay before answering OwO (seconds).",
        markers: [0, 1, 3, 8, 15],
        default: 3,
        stickToMarkers: false
    },
    humanBreakEnabled: { type: OptionType.BOOLEAN, description: "Take random breaks to look human.", default: true },
    humanBreakEveryMin: { type: OptionType.NUMBER, description: "Minutes of grinding between breaks.", default: 45 },
    humanBreakDurationMin: { type: OptionType.NUMBER, description: "Break length in minutes.", default: 14 },

    reactionBotEnabled: { type: OptionType.BOOLEAN, description: "Mirror ReactionBot prompts (hunt, battle, owo, pray).", default: false },

    securityEnabled: { type: OptionType.BOOLEAN, description: "Pause everything on captcha or ban detection.", default: true },
    captchaSolverEnabled: { type: OptionType.BOOLEAN, description: "Attempt hCaptcha auto solve with a solving service.", default: false },
    captchaService: {
        type: OptionType.SELECT,
        description: "Captcha solving service.",
        options: [
            { label: "YesCaptcha", value: "yescaptcha", default: true },
            { label: "NopeCHA", value: "nopecha" },
            { label: "AntiCaptcha", value: "anticaptcha" }
        ]
    },
    yescaptchaKey: { type: OptionType.STRING, description: "YesCaptcha API key.", default: "" },
    nopechaKey: { type: OptionType.STRING, description: "NopeCHA API key.", default: "" },
    anticaptchaKey: { type: OptionType.STRING, description: "AntiCaptcha API key.", default: "" },
    webhookEnabled: { type: OptionType.BOOLEAN, description: "Send security alerts to a Discord webhook.", default: false },
    webhookUrl: { type: OptionType.STRING, description: "Discord webhook URL for security alerts.", default: "" },

    bossEnabled: { type: OptionType.BOOLEAN, description: "Detect guild boss spawns and notify you.", default: true }
});

export type OwoSettings = typeof settings.store;
export type OwoStoreKey = keyof OwoSettings;

export const SELECT_KEYS = ["coinflipSide", "gambleStrategy", "captchaService"] as const;
export type OwoSelectKey = typeof SELECT_KEYS[number];

export interface OwoSettingGroup {
    title: string;
    keys: readonly OwoStoreKey[];
}

export const SETTING_GROUPS: readonly OwoSettingGroup[] = [
    { title: "General", keys: ["masterSwitch", "owoBotId", "prefix", "fallbackChannels", "useShortform"] },
    { title: "Grind", keys: ["huntEnabled", "huntCooldownMin", "huntCooldownMax", "battleEnabled", "battleCooldownMin", "battleCooldownMax", "owoEnabled", "owoCooldownMin", "owoCooldownMax"] },
    { title: "Curse and Pray", keys: ["prayEnabled", "prayTargets", "prayPing", "curseEnabled", "curseTargets", "cursePing", "cursePrayCooldownMin", "cursePrayCooldownMax"] },
    { title: "Daily and Cookie", keys: ["dailyEnabled", "cookieEnabled", "cookieTarget"] },
    { title: "Run Pup Piku", keys: ["rppEnabled", "rppInterval"] },
    { title: "Quests", keys: ["questEnabled", "questAutoSolve", "questIntervalH"] },
    { title: "Huntbot", keys: ["huntbotEnabled", "huntbotCash", "huntbotUpgradeEnabled", "huntbotPrioEfficiency", "huntbotPrioDuration", "huntbotPrioCost", "huntbotPrioGain", "huntbotPrioExp", "huntbotPrioRadar"] },
    { title: "Gems", keys: ["gemsEnabled", "gemsLowestFirst", "gemsUseSet", "gemsAllowFabled", "gemsAllowLegendary", "gemsAllowSpecial"] },
    { title: "Gambling", keys: ["coinflipEnabled", "coinflipAmount", "coinflipSide", "slotsEnabled", "slotsAmount", "blackjackEnabled", "blackjackAmount", "gambleStrategy", "gambleMinBalance", "gambleMaxBalance", "gambleMaxBet"] },
    { title: "Sell and Sacrifice", keys: ["sellEnabled", "sellIntervalMin", "sellType", "sacrificeEnabled", "sacrificeIntervalMin", "sacrificeType"] },
    { title: "Shop and Loot", keys: ["shopEnabled", "shopItems", "shopCooldown", "crateEnabled", "crateType", "lootboxEnabled", "lootboxType"] },
    { title: "Giveaway and Boss", keys: ["giveawayEnabled", "bossEnabled"] },
    { title: "Level Grind", keys: ["levelGrindEnabled", "levelGrindMin", "levelGrindMax"] },
    { title: "Channel Rotation", keys: ["autochannelEnabled", "autochannelMin", "autochannelMax"] },
    { title: "Stealth", keys: ["typingEnabled", "reactionDelayMin", "reactionDelayMax", "humanBreakEnabled", "humanBreakEveryMin", "humanBreakDurationMin"] },
    { title: "ReactionBot", keys: ["reactionBotEnabled"] },
    { title: "Security", keys: ["securityEnabled", "captchaSolverEnabled", "captchaService", "yescaptchaKey", "nopechaKey", "anticaptchaKey", "webhookEnabled", "webhookUrl"] }
];
