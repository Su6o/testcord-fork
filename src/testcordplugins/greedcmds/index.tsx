/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { TestcordDevs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { UserStore } from "@webpack/common";

const logger = new Logger("GreedCmds");

const settings = definePluginSettings({
    enableProtectReadd: {
        type: OptionType.BOOLEAN,
        description: "Automatically re-add uwulock protect when someone removes it from you or protected users. Triggers on ,uwulock protect remove and sends ,uwulock protect add instantly.",
        default: true
    },
    enableUwulockRemove: {
        type: OptionType.BOOLEAN,
        description: "Automatically remove uwulock when someone applies it to you or protected users. Triggers on ,uwulock <@user> and sends ,uwulock remove <@user>.",
        default: true
    },
    enableCounterTo: {
        type: OptionType.BOOLEAN,
        description: "Counter attacks that target you or protected users with timeout. When someone uses ,uwulock, ,to, ,kick, ,ban or ,mute on you, automatically send ,to <@attacker> 60s.",
        default: false
    },
    counterDuration: {
        type: OptionType.NUMBER,
        description: "Duration in seconds for the counter ,to command.",
        default: 60
    },
    protectedUserIds: {
        type: OptionType.STRING,
        description: "Additional user IDs to protect (comma separated). Example: 123456789012345678, 987654321098765432",
        default: ""
    },
    allowedGuildIds: {
        type: OptionType.STRING,
        description: "Only run in these servers (comma separated guild IDs). Leave empty to run in all servers.",
        default: ""
    },
    enableCounterLock: {
        type: OptionType.BOOLEAN,
        description: "Counter lock attackers. When someone tries to remove your protection or uwulock you, instantly strip their protection and uwulock them back with two fast messages.",
        default: false
    },
    enableAutoUwulock: {
        type: OptionType.BOOLEAN,
        description: "Keep watched users uwulocked. When someone removes their uwulock via prefix or slash command, instantly send ,uwulock add to re-lock them. Manage the list with /autouwulock.",
        default: true
    },
    autoUwulockUserIds: {
        type: OptionType.STRING,
        description: "User IDs to keep uwulocked (comma separated). Managed by /autouwulock, you can also edit manually.",
        default: ""
    }
});

function parseIdList(value: string): Set<string> {
    const ids = new Set<string>();
    if (!value) return ids;
    for (const part of value.split(/[,\s]+/)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (/^\d{5,22}$/.test(trimmed)) ids.add(trimmed);
    }
    return ids;
}

function getProtectedIds(): Set<string> {
    const ids = new Set<string>();
    const current = UserStore.getCurrentUser?.()?.id;
    if (current) ids.add(current);
    const extra = parseIdList(settings.store.protectedUserIds);
    for (const id of extra) ids.add(id);
    return ids;
}

function getAutoUwulockIds(): Set<string> {
    return parseIdList(settings.store.autoUwulockUserIds);
}

function getAllowedGuildIds(): Set<string> | null {
    const raw = settings.store.allowedGuildIds?.trim();
    if (!raw) return null;
    const set = parseIdList(raw);
    if (set.size === 0) return null;
    return set;
}

function getSearchableText(message: any): string {
    const parts: string[] = [];
    if (typeof message?.content === "string" && message.content) parts.push(message.content);
    const embeds = message?.embeds;
    if (Array.isArray(embeds)) {
        for (const e of embeds) {
            if (!e || typeof e !== "object") continue;
            if (typeof e.title === "string") parts.push(e.title);
            if (typeof e.description === "string") parts.push(e.description);
            if (Array.isArray(e.fields)) {
                for (const f of e.fields) {
                    if (typeof f?.name === "string") parts.push(f.name);
                    if (typeof f?.value === "string") parts.push(f.value);
                }
            }
            if (typeof e.footer?.text === "string") parts.push(e.footer.text);
            if (typeof e.author?.name === "string") parts.push(e.author.name);
        }
    }
    return parts.join("\n");
}

function isTargeted(message: any, targetId: string): boolean {
    if (Array.isArray(message?.mentions) && message.mentions.some((m: any) => m?.id === targetId)) return true;
    const text = getSearchableText(message);
    if (!text) return false;
    if (text.includes(`<@${targetId}>`) || text.includes(`<@!${targetId}>`)) return true;
    if (text.includes(targetId) && new RegExp(`\\b${targetId}\\b`).test(text)) return true;
    return false;
}

function getTargetedIds(message: any, protectedIds: Set<string>): string[] {
    const out: string[] = [];
    for (const id of protectedIds) {
        if (isTargeted(message, id)) out.push(id);
    }
    return out;
}

function isGuildAllowed(guildId: string | undefined, allowed: Set<string> | null): boolean {
    if (!allowed) return true;
    if (!guildId) return false;
    return allowed.has(guildId);
}

function sendBotCommand(channelId: string, content: string) {
    if (!channelId || !content) return;
    try {
        logger.info(`Sending: ${content} in ${channelId}`);
        sendMessage(channelId, { content });
    } catch (e) {
        logger.error("Failed to send bot command", e);
    }
}

const PROTECT_REMOVE_RE = /^\s*,uwulock\s+protect\s+remove\b/i;
const UWULOCK_REMOVE_RE = /^\s*,uwulock\s+remove\b/i;
const ATTACK_PREFIXES = [
    /^\s*,uwulock\b/i,
    /^\s*,to\b/i,
    /^\s*,kick\b/i,
    /^\s*,ban\b/i,
    /^\s*,mute\b/i,
];

function isPlainUwulock(content: string): boolean {
    if (!/^\s*,uwulock\b/i.test(content)) return false;
    if (/protect/i.test(content)) return false;
    if (UWULOCK_REMOVE_RE.test(content)) return false;
    return true;
}

const SLASH_UNLOCK_RE = /\/uwulock\b.{0,80}\bremov/i;
const BOT_UNLOCK_SIGNAL_RE = /remov|unlock|un[\s-]*uwu/i;

function getInteractionName(message: any): string {
    const name = message?.interaction?.name ?? message?.interactionMetadata?.name ?? message?.interaction_metadata?.name ?? message?.interaction?.commandName;
    return typeof name === "string" ? name : "";
}

function isUnlockEvent(message: any): boolean {
    const text = getSearchableText(message);
    if (text && UWULOCK_REMOVE_RE.test(text)) return true;
    if (text && SLASH_UNLOCK_RE.test(text)) return true;
    const interactionName = getInteractionName(message);
    if (/uwulock/i.test(interactionName)) {
        if (/remov|unlock/i.test(interactionName) || (text && /remov|unlock/i.test(text))) return true;
        const raw = JSON.stringify(message.interaction ?? message.interactionMetadata ?? message.interaction_metadata ?? {}).slice(0, 1000);
        if (/remov/i.test(raw)) return true;
    }
    if (message?.author?.bot && text && /uwulock/i.test(text) && BOT_UNLOCK_SIGNAL_RE.test(text)) return true;
    return false;
}

function handleMessage(message: any) {
    if (!message?.author?.id) return;
    if (!message.channel_id) return;

    const currentUserId = UserStore.getCurrentUser?.()?.id;
    if (!currentUserId) return;
    if (message.author.id === currentUserId) return;

    const allowed = getAllowedGuildIds();
    if (!isGuildAllowed(message.guild_id, allowed)) return;

    const content = typeof message.content === "string" ? message.content : "";
    const isBot = message.author.bot === true;

    // Existing defenses watch attacker prefix commands only.
    if (!isBot && content) {
        const protectedIds = getProtectedIds();
        const targeted = getTargetedIds(message, protectedIds);

        if (targeted.length > 0) {
            const attackerId = message.author.id;
            const attackerMention = `<@${attackerId}>`;

            // 1. Protect re-add: ,uwulock protect remove <@target> -> ,uwulock protect add <@target>
            if (settings.store.enableProtectReadd && PROTECT_REMOVE_RE.test(content)) {
                for (const tid of targeted) {
                    sendBotCommand(message.channel_id, `,uwulock protect add <@${tid}>`);
                }
            }

            // 2. Uwulock remove: ,uwulock <@target> -> ,uwulock remove <@target>
            if (settings.store.enableUwulockRemove && isPlainUwulock(content)) {
                for (const tid of targeted) {
                    sendBotCommand(message.channel_id, `,uwulock remove <@${tid}>`);
                }
            }

            // 3. Counter timeout: ,uwulock/,to/,kick/,ban/,mute on protected -> ,to <@attacker> 60s
            if (settings.store.enableCounterTo) {
                const isAttack = ATTACK_PREFIXES.some(re => re.test(content));
                if (isAttack) {
                    const duration = Math.max(1, Number(settings.store.counterDuration) || 60);
                    // avoid sending multiple counters for same message
                    sendBotCommand(message.channel_id, `,to ${attackerMention} ${duration}s`);
                }
            }

            // 4. Counter lock: remove attacker protection then uwulock them
            if (settings.store.enableCounterLock && (PROTECT_REMOVE_RE.test(content) || isPlainUwulock(content))) {
                sendBotCommand(message.channel_id, `,uwulock protect remove ${attackerMention}`);
                sendBotCommand(message.channel_id, `,uwulock add ${attackerMention}`);
            }
        }
    }

    // 5. Auto uwulock: re-lock watched users when someone unlocks them via prefix, slash, or bot confirmation.
    if (settings.store.enableAutoUwulock) {
        const watched = getAutoUwulockIds();
        if (watched.size === 0) return;
        if (!isUnlockEvent(message)) return;
        const targeted = getTargetedIds(message, watched);
        if (targeted.length === 0) return;
        for (const tid of targeted) {
            sendBotCommand(message.channel_id, `,uwulock add <@${tid}>`);
        }
    }
}

export default definePlugin({
    name: "GreedCmds",
    description: "Greed bot auto defense. Re-adds uwulock protect, removes uwulock, counters kick/ban/mute/to attacks, and keeps /autouwulock users locked. Supports protected users and allowed servers filtering.",
    authors: [TestcordDevs.x2b],
    settings,

    commands: [
        {
            name: "autouwulock",
            description: "Keep a user uwulocked. Toggles watch; re-sends ,uwulock add when they get unlocked.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "user",
                    description: "User to keep uwulocked. Leave empty to list watched users.",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            execute(args, ctx) {
                const userId = findOption<string>(args, "user", "");
                const watched = getAutoUwulockIds();
                if (!userId) {
                    if (watched.size === 0) {
                        sendBotMessage(ctx.channel.id, { content: "Autouwulock list is empty. Use `/autouwulock @user` to watch someone." });
                    } else {
                        const list = [...watched].map(id => `<@${id}>`).join(", ");
                        sendBotMessage(ctx.channel.id, { content: `Autouwulock watching (${watched.size}): ${list}` });
                    }
                    return;
                }
                if (!/^\d{5,22}$/.test(userId)) {
                    sendBotMessage(ctx.channel.id, { content: "Invalid user. Pick someone with `/autouwulock @user`." });
                    return;
                }
                if (watched.has(userId)) {
                    watched.delete(userId);
                    settings.store.autoUwulockUserIds = [...watched].join(", ");
                    sendBotMessage(ctx.channel.id, { content: `Removed <@${userId}> from autouwulock. Watching ${watched.size}.` });
                } else {
                    watched.add(userId);
                    settings.store.autoUwulockUserIds = [...watched].join(", ");
                    sendBotMessage(ctx.channel.id, { content: `Added <@${userId}> to autouwulock. They will be re-locked with \`,uwulock add\` when unlocked.` });
                }
            }
        }
    ],

    flux: {
        MESSAGE_CREATE(data: any) {
            const message = data?.message ?? data;
            if (message) handleMessage(message);
        }
    }
});
