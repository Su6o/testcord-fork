/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyWithToast, getCurrentChannel } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal, type RenderModalProps } from "@utils/modal";
import { OptionType } from "@utils/types";
import { Button, Forms, Text, TextInput, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { decodeTokenUserId, deleteProfile, getProfiles, newProfileId, type OwoProfile,parseChannelList, saveProfiles, upsertProfile } from "./accounts";
import { addGrindChannel, channelLabel, fireNow, getChannelOptions, getChannels, getLogs, pauseEngine, refreshScheduler, reloadProfiles, removeGrindChannel, resumeEngine, runtime, sendManual, setActiveChannel, setMasterOn, snapshot, solveQuest } from "./engine";
import { type OwoSelectKey, type OwoSettings, type OwoStoreKey,SELECT_KEYS, SETTING_GROUPS, settings } from "./settings";

export function openDashboard(): void {
    openModal(props => <OwoDashboardModal rootProps={props} />);
}

type Tab = "overview" | "accounts" | "commands" | "quests" | "security" | "settings" | "logs";

const TABS: { id: Tab; label: string; }[] = [
    { id: "overview", label: "Overview" },
    { id: "accounts", label: "Accounts" },
    { id: "commands", label: "Commands" },
    { id: "quests", label: "Quests" },
    { id: "security", label: "Security" },
    { id: "settings", label: "Settings" },
    { id: "logs", label: "Logs" }
];

function openExternal(url: string): void {
    try {
        VencordNative.native.openExternal(url);
    } catch {
        copyWithToast(url);
    }
}

function statusOf(snap: ReturnType<typeof snapshot>): { label: string; color: string; } {
    if (!snap.masterOn) return { label: "Stopped", color: "var(--status-danger)" };
    if (snap.paused) return { label: "Paused", color: "var(--status-warning)" };
    if (snap.onBreak) return { label: "On human break", color: "var(--status-warning)" };
    if (snap.throttled) return { label: "Cooling down", color: "var(--status-warning)" };
    return { label: "Running", color: "var(--status-positive)" };
}

function Card({ children }: { children: ReactNode; }) {
    return (
        <div style={{ background: "var(--background-secondary)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {children}
        </div>
    );
}

function Section({ title, right, children, defaultOpen = true }: { title: string; right?: ReactNode; children: ReactNode; defaultOpen?: boolean; }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div style={{ background: "var(--background-secondary)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Text variant="heading-md/semibold" style={{ flex: 1 }}>{title}</Text>
                {right}
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => setOpen(o => !o)}>
                    {open ? "▾" : "▸"}
                </Button>
            </div>
            {open && children}
        </div>
    );
}

function CashSparkline() {
    const hist = runtime.cashHistory;
    if (hist.length < 2) return <Forms.FormText>Balance history appears here once OwO reports your cowoncy.</Forms.FormText>;
    const w = 260;
    const h = 48;
    const vals = hist.map(p => p[1]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const pts = hist.map((p, i) => `${(i / (hist.length - 1)) * w},${h - ((p[1] - min) / span) * (h - 6) - 3}`).join(" ");
    const first = vals[0] ?? 0;
    const last = vals[vals.length - 1] ?? 0;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ background: "var(--background-tertiary)", borderRadius: 8 }}>
                <polyline points={pts} fill="none" stroke={last >= first ? "var(--status-positive)" : "var(--status-danger)"} strokeWidth={2} />
            </svg>
            <Forms.FormText>{first.toLocaleString()} → {last.toLocaleString()} cowoncy</Forms.FormText>
        </div>
    );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string; }) {
    return (
        <div style={{ background: "var(--background-secondary)", borderRadius: 10, padding: "10px 12px", minWidth: 105, flex: "1 1 105px", borderTop: accent ? `3px solid ${accent}` : undefined }}>
            <Forms.FormText style={{ fontSize: 11, textTransform: "uppercase" }}>{label}</Forms.FormText>
            <Text variant="heading-lg/semibold" style={{ fontSize: 19 }}>{value}</Text>
        </div>
    );
}

function ProgressBar({ pct, color }: { pct: number; color?: string; }) {
    const clamped = Math.min(100, Math.max(0, Math.round(pct)));
    return (
        <div style={{ height: 6, borderRadius: 3, background: "var(--background-tertiary)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${clamped}%`, borderRadius: 3, background: color ?? "var(--brand-500)", transition: "width 0.5s" }} />
        </div>
    );
}

function ControlsRow({ snap }: { snap: ReturnType<typeof snapshot>; }) {
    return (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {snap.masterOn
                ? <Button color={Button.Colors.RED} onClick={() => setMasterOn(false)}>Stop</Button>
                : <Button color={Button.Colors.GREEN} onClick={() => setMasterOn(true)}>Start</Button>}
            {snap.paused
                ? <Button color={Button.Colors.GREEN} onClick={() => resumeEngine()}>Resume</Button>
                : <Button color={Button.Colors.PRIMARY} onClick={() => pauseEngine("Paused from dashboard.")} disabled={!snap.masterOn}>Pause</Button>}
            <Button color={Button.Colors.BRAND} onClick={() => { refreshScheduler(); }}>Rebuild scheduler</Button>
        </div>
    );
}

function ChannelsCard({ bump }: { bump: () => void; }) {
    const [draft, setDraft] = useState("");
    const options = getChannelOptions();
    return (
        <Section
            title="Grind channels"
            right={(
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.BRAND}
                    onClick={() => {
                        try {
                            const current = getCurrentChannel();
                            if (current) {
                                void addGrindChannel(String(current.id)).then(() => bump());
                                return;
                            }
                        } catch { /* fall through to hint */ }
                        copyWithToast("Open a channel first, then press this button.");
                    }}
                >
                    Add open channel
                </Button>
            )}
        >
            {options.length === 0 && <Forms.FormText>No channels yet. Add one below or press Add open channel.</Forms.FormText>}
            {options.map(o => (
                <div key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", background: "var(--background-tertiary)", borderRadius: 8, padding: "6px 10px" }}>
                    <span
                        style={{
                            width: 9, height: 9, borderRadius: "50%", flexShrink: 0,
                            background: o.active ? "var(--status-positive)" : "var(--interactive-muted)"
                        }}
                    />
                    <Text variant="text-md/normal" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</Text>
                    {!o.active && (
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => { setActiveChannel(o.id); bump(); }}>
                            Grind here
                        </Button>
                    )}
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => { void removeGrindChannel(o.id).then(() => bump()); }}>
                        Remove
                    </Button>
                </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <TextInput value={draft} onChange={setDraft} placeholder="Channel ID to add" />
                </div>
                <Button
                    color={Button.Colors.PRIMARY}
                    onClick={() => {
                        const id = draft.trim();
                        if (/^\d{10,25}$/.test(id)) {
                            void addGrindChannel(id).then(() => bump());
                            setDraft("");
                        }
                    }}
                >
                    Add
                </Button>
            </div>
        </Section>
    );
}

function OverviewTab({ refreshKey, bump }: { refreshKey: number; bump: () => void; }) {
    void refreshKey;
    const snap = snapshot();
    const status = statusOf(snap);
    const total = snap.hunts + snap.battles + snap.owos;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 12, height: 12, borderRadius: "50%", background: status.color, flexShrink: 0 }} />
                    <Text variant="heading-md/semibold" style={{ flex: 1 }}>{status.label}</Text>
                    <Forms.FormText>{snap.profileName ?? "No profile"} | {snap.uptimeMin}m uptime</Forms.FormText>
                </div>
                <ControlsRow snap={snap} />
            </Card>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Stat label="Cowoncy" value={snap.cash > 0 ? snap.cash.toLocaleString() : "Unknown"} accent="var(--status-positive)" />
                <Stat label="Total grinds" value={String(total)} accent="var(--brand-500)" />
                <Stat label="Queued" value={String(snap.queue)} accent="var(--status-warning)" />
                <Stat label="Net gamble" value={snap.gambling.netProfit.toLocaleString()} accent={snap.gambling.netProfit >= 0 ? "var(--status-positive)" : "var(--status-danger)"} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Stat label="Hunts" value={String(snap.hunts)} />
                <Stat label="Battles" value={String(snap.battles)} />
                <Stat label="Owos" value={String(snap.owos)} />
                <Stat label="Gems used" value={String(snap.gemsUsed)} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Stat label="Captchas" value={String(snap.captchas)} />
                <Stat label="Warnings" value={String(snap.warnings)} />
                <Stat label="Next quest" value={snap.nextQuestTimer ?? "Unknown"} />
            </div>
            <Section title="Cowoncy history">
                <CashSparkline />
            </Section>
            <ChannelsCard bump={bump} />
            <Forms.FormText>
                Tip: type owoself start, stop, status or dashboard in any channel. The trigger message deletes itself.
            </Forms.FormText>
        </div>
    );
}

function AccountsTab({ refreshKey, bump }: { refreshKey: number; bump: () => void; }) {
    void refreshKey;
    const [profiles, setProfiles] = useState<OwoProfile[]>(runtime.profiles);
    const [name, setName] = useState("");
    const [token, setToken] = useState("");
    const [channels, setChannels] = useState("");
    const [bulk, setBulk] = useState("");

    async function reload(): Promise<void> {
        await reloadProfiles();
        setProfiles([...runtime.profiles]);
        bump();
    }

    async function add(): Promise<void> {
        const clean = token.trim();
        if (!clean) return;
        await upsertProfile({
            id: newProfileId(),
            name: name.trim() || `Account ${profiles.length + 1}`,
            token: clean,
            userId: decodeTokenUserId(clean),
            channels: parseChannelList(channels),
            enabled: true
        });
        setName("");
        setToken("");
        setChannels("");
        await reload();
    }

    async function importBulk(): Promise<void> {
        const lines = bulk.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return;
        const next = [...profiles];
        for (const line of lines) {
            const parts = line.split("|").map(p => p.trim());
            const tok = (parts.length > 1 ? parts[1] : parts[0]) ?? "";
            if (!tok) continue;
            next.push({
                id: newProfileId(),
                name: parts.length > 1 ? (parts[0] || `Account ${next.length + 1}`) : `Account ${next.length + 1}`,
                token: tok,
                userId: decodeTokenUserId(tok),
                channels: parseChannelList(parts[2] ?? ""),
                enabled: true
            });
        }
        await saveProfiles(next);
        setBulk("");
        await reload();
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Forms.FormText>
                Multi account profiles. Only the profile matching your current login grinds here. Extra tokens stay saved and activate when you switch accounts.
            </Forms.FormText>
            {profiles.map(p => {
                const active = runtime.activeProfile?.id === p.id;
                const title = `${p.name}${p.userId === "" ? " (id unknown)" : ""}${active ? " (grinding)" : ""}`;
                return (
                    <Section
                        key={p.id}
                        title={title}
                        right={(
                            <>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    color={p.enabled ? Button.Colors.GREEN : Button.Colors.PRIMARY}
                                    onClick={() => { void upsertProfile({ ...p, enabled: !p.enabled }).then(() => reload()); }}
                                >
                                    {p.enabled ? "On" : "Off"}
                                </Button>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    color={Button.Colors.RED}
                                    onClick={() => { void deleteProfile(p.id).then(() => reload()); }}
                                >
                                    Delete
                                </Button>
                            </>
                        )}
                    >
                        <Forms.FormText>Channels: {p.channels.length > 0 ? p.channels.map(channelLabel).join(" | ") : "none"}</Forms.FormText>
                        <TextInput
                            defaultValue={p.channels.join(", ")}
                            placeholder="Channel IDs, comma separated"
                            onChange={v => { p.channels = parseChannelList(v); }}
                            onBlur={() => { void upsertProfile({ ...p }).then(() => reload()); }}
                        />
                    </Section>
                );
            })}
            <Section title="Add profile" defaultOpen={false}>
                <TextInput value={name} onChange={setName} placeholder="Name (optional)" />
                <TextInput value={token} onChange={setToken} placeholder="Token" />
                <TextInput value={channels} onChange={setChannels} placeholder="Channel IDs, comma separated" />
                <Button color={Button.Colors.BRAND} onClick={() => { void add(); }}>Add profile</Button>
            </Section>
            <Section title="Bulk import and export" defaultOpen={false}>
                <Forms.FormText>One per line: token or name | token | channels</Forms.FormText>
                <TextInput value={bulk} onChange={setBulk} placeholder={"token...\nalt | token... | 123, 456"} />
                <div style={{ display: "flex", gap: 8 }}>
                    <Button color={Button.Colors.PRIMARY} onClick={() => { void importBulk(); }}>Import</Button>
                    <Button
                        color={Button.Colors.PRIMARY}
                        onClick={() => copyWithToast(JSON.stringify(profiles.map(p => ({ name: p.name, token: p.token, channels: p.channels, enabled: p.enabled })), null, 2))}
                    >
                        Export
                    </Button>
                </div>
            </Section>
            <Forms.FormText>Fallback channels (plugin settings): {getChannels().join(", ") || "none"}</Forms.FormText>
        </div>
    );
}

function CommandsTab() {
    const [manual, setManual] = useState("");
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 2000);
        return () => clearInterval(id);
    }, []);
    void tick;
    const snap = snapshot();
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Section title="Send now">
                <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                        <TextInput value={manual} onChange={setManual} placeholder="owo hunt" />
                    </div>
                    <Button
                        color={Button.Colors.BRAND}
                        onClick={() => {
                            const cmd = manual.trim();
                            if (cmd) {
                                void sendManual(cmd);
                                setManual("");
                            }
                        }}
                    >
                        Send
                    </Button>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button size={Button.Sizes.SMALL} onClick={() => { void sendManual("quest"); }}>Quest</Button>
                    <Button size={Button.Sizes.SMALL} onClick={() => { void sendManual("daily"); }}>Daily</Button>
                    <Button size={Button.Sizes.SMALL} onClick={() => { void sendManual("owo cash"); }}>Cash</Button>
                    <Button size={Button.Sizes.SMALL} onClick={() => { void sendManual("owo inv"); }}>Inventory</Button>
                </div>
            </Section>
            <Section title={`Scheduler (${snap.activeCmds.length})`}>
                {snap.activeCmds.map(c => {
                    const pct = c.delay > 0 ? ((c.delay - c.remaining) / c.delay) * 100 : 100;
                    return (
                        <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                <Text variant="text-md/semibold" style={{ flex: 1 }}>{c.id}</Text>
                                <Forms.FormText>due in {c.remaining}s of {c.delay}s</Forms.FormText>
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => fireNow(c.id)}>
                                    Fire now
                                </Button>
                            </div>
                            <ProgressBar pct={pct} />
                        </div>
                    );
                })}
                {snap.activeCmds.length === 0 && <Forms.FormText>No loops registered. Press Start or enable features in plugin settings.</Forms.FormText>}
            </Section>
        </div>
    );
}

function QuestsTab({ refreshKey }: { refreshKey: number; }) {
    void refreshKey;
    const snap = snapshot();
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Forms.FormText>Next quests: {snap.nextQuestTimer ?? "unknown"}</Forms.FormText>
            {snap.questData.map((q, i) => {
                const pct = q.total > 0 ? (q.current / q.total) * 100 : 0;
                return (
                    <Section
                        key={`${i}-${q.description}`}
                        title={`${q.completed ? "Done: " : ""}${q.description}`}
                        right={!q.completed ? (
                            <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => solveQuest(i)}>
                                Solve
                            </Button>
                        ) : undefined}
                    >
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <div style={{ flex: 1 }}>
                                <ProgressBar pct={pct} color={q.completed ? "var(--status-positive)" : undefined} />
                            </div>
                            <Forms.FormText>{q.current}/{q.total}</Forms.FormText>
                        </div>
                    </Section>
                );
            })}
            {snap.questData.length === 0 && <Forms.FormText>No quest data yet. The engine fills this in after the next quest poll.</Forms.FormText>}
            <Button color={Button.Colors.BRAND} onClick={() => { void sendManual("quest"); }}>Poll quests now</Button>
        </div>
    );
}

function SecurityTab({ refreshKey }: { refreshKey: number; }) {
    void refreshKey;
    const snap = snapshot();
    const pending = snap.pendingCaptcha;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Stat label="State" value={snap.paused ? "Paused" : "Armed"} accent={snap.paused ? "var(--status-warning)" : "var(--status-positive)"} />
                <Stat label="Captchas" value={String(snap.captchas)} />
                <Stat label="Bans" value={String(snap.bans)} />
            </div>
            {pending
                ? (
                    <Section title="Captcha needs you">
                        <Forms.FormText>{pending.detail}</Forms.FormText>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <Button color={Button.Colors.BRAND} onClick={() => openExternal(pending.url)}>Open solve URL</Button>
                            <Button color={Button.Colors.GREEN} onClick={() => resumeEngine()}>I solved it, resume</Button>
                        </div>
                    </Section>
                )
                : <Forms.FormText>No pending captcha. Detection covers link captchas, button captchas, letterword images, warnings and bans.</Forms.FormText>}
            <Forms.FormText>
                Solver: {settings.store.captchaSolverEnabled ? `${settings.store.captchaService} (manual fallback always on)` : "manual only"}.
                Image and huntbot password captchas pause the engine and wait for you.
            </Forms.FormText>
            <ControlsRow snap={snap} />
        </div>
    );
}

type BoolKey = { [K in OwoStoreKey]: OwoSettings[K] extends boolean ? K : never; }[OwoStoreKey];
type NumKey = { [K in OwoStoreKey]: OwoSettings[K] extends number ? K : never; }[OwoStoreKey];
type StrKey = { [K in OwoStoreKey]: OwoSettings[K] extends string ? K : never; }[OwoStoreKey];

function humanize(key: string): string {
    const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function SettingLabel({ name }: { name: OwoStoreKey; }) {
    const def = settings.def[name];
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 140 }}>
            <Text variant="text-md/semibold">{humanize(name)}</Text>
            <Forms.FormText style={{ fontSize: 12 }}>{def.description}</Forms.FormText>
        </div>
    );
}

function BooleanRow({ name, onChanged }: { name: BoolKey; onChanged: () => void; }) {
    const on = settings.store[name];
    return (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <SettingLabel name={name} />
            <Button
                size={Button.Sizes.SMALL}
                color={on ? Button.Colors.GREEN : Button.Colors.PRIMARY}
                onClick={() => {
                    if (name === "masterSwitch") setMasterOn(!on);
                    else settings.store[name] = !on;
                    refreshScheduler();
                    onChanged();
                }}
            >
                {on ? "On" : "Off"}
            </Button>
        </div>
    );
}

function NumberRow({ name, onChanged }: { name: NumKey; onChanged: () => void; }) {
    const current = settings.store[name];
    const [draft, setDraft] = useState(String(current));
    useEffect(() => { setDraft(String(settings.store[name])); }, [name]);
    return (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <SettingLabel name={name} />
            <div style={{ width: 130, flexShrink: 0 }}>
                <TextInput
                    value={draft}
                    onChange={setDraft}
                    onBlur={() => {
                        const value = Number(draft);
                        if (Number.isFinite(value)) {
                            settings.store[name] = value;
                            refreshScheduler();
                            onChanged();
                        } else {
                            setDraft(String(settings.store[name]));
                        }
                    }}
                />
            </div>
        </div>
    );
}

function StringRow({ name, onChanged }: { name: StrKey; onChanged: () => void; }) {
    const [draft, setDraft] = useState(settings.store[name]);
    useEffect(() => { setDraft(settings.store[name]); }, [name]);
    return (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <SettingLabel name={name} />
            <div style={{ width: 220, flexShrink: 0 }}>
                <TextInput
                    value={draft}
                    onChange={setDraft}
                    placeholder={humanize(name)}
                    onBlur={() => {
                        settings.store[name] = draft;
                        refreshScheduler();
                        onChanged();
                    }}
                />
            </div>
        </div>
    );
}

function SelectRow({ name, onChanged }: { name: OwoSelectKey; onChanged: () => void; }) {
    const def = settings.def[name];
    if (def.type !== OptionType.SELECT) return null;
    const current = String(settings.store[name]);
    const idx = Math.max(0, def.options.findIndex(o => String(o.value) === current));
    const active = def.options[idx] ?? def.options[0];
    if (!active) return null;
    return (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <SettingLabel name={name} />
            <Button
                size={Button.Sizes.SMALL}
                color={Button.Colors.BRAND}
                onClick={() => {
                    const next = def.options[(idx + 1) % def.options.length];
                    if (!next) return;
                    settings.store[name] = next.value;
                    refreshScheduler();
                    onChanged();
                }}
            >
                {active.label} ▾
            </Button>
        </div>
    );
}

function SettingRow({ name, onChanged }: { name: OwoStoreKey; onChanged: () => void; }) {
    if ((SELECT_KEYS as readonly OwoStoreKey[]).includes(name)) {
        return <SelectRow name={name as OwoSelectKey} onChanged={onChanged} />;
    }
    const value = settings.store[name];
    if (typeof value === "boolean") return <BooleanRow name={name as BoolKey} onChanged={onChanged} />;
    if (typeof value === "number") return <NumberRow name={name as NumKey} onChanged={onChanged} />;
    return <StringRow name={name as StrKey} onChanged={onChanged} />;
}

function SettingsTab({ bump }: { bump: () => void; }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Forms.FormText>Every plugin setting, editable without leaving Discord. Changes apply to the scheduler immediately.</Forms.FormText>
            {SETTING_GROUPS.map(group => (
                <Section key={group.title} title={group.title} defaultOpen={group.title === "General"}>
                    {group.keys.map(key => <SettingRow key={key} name={key} onChanged={bump} />)}
                </Section>
            ))}
        </div>
    );
}

const LOG_COLORS: Record<string, string> = {
    CMD: "var(--text-brand)",
    SUCCESS: "var(--status-positive)",
    ALARM: "var(--status-danger)",
    WARN: "var(--status-warning)",
    SECURITY: "var(--status-danger)",
    COOLDOWN: "var(--status-warning)",
    GAMBLING: "#e0a100",
    SYS: "var(--text-muted)"
};

function LogsTab({ refreshKey }: { refreshKey: number; }) {
    void refreshKey;
    const entries = getLogs();
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 380, overflowY: "auto" }}>
            {entries.map((e, i) => (
                <div key={`${e.ts}-${i}`} style={{ display: "flex", gap: 8, fontSize: 12 }}>
                    <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{e.time}</span>
                    <span style={{ color: LOG_COLORS[e.type] ?? "var(--text-normal)", flexShrink: 0, minWidth: 70, fontWeight: 600 }}>[{e.type}]</span>
                    <span style={{ color: "var(--text-normal)", wordBreak: "break-word" }}>{e.message}</span>
                </div>
            ))}
            {entries.length === 0 && <Forms.FormText>No logs yet.</Forms.FormText>}
        </div>
    );
}

function OwoDashboardModal({ rootProps }: { rootProps: RenderModalProps; }) {
    const [tab, setTab] = useState<Tab>("overview");
    const [refreshKey, setRefreshKey] = useState(0);
    const bump = () => setRefreshKey(k => k + 1);
    useEffect(() => {
        const id = setInterval(bump, 2000);
        return () => clearInterval(id);
    }, []);
    useEffect(() => {
        void getProfiles().then(p => {
            if (runtime.profiles.length === 0 && p.length > 0) {
                void reloadProfiles().then(bump);
            }
        });
    }, []);

    const snap = snapshot();
    const status = statusOf(snap);

    return (
        <ModalRoot {...rootProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: status.color, marginRight: 8 }} />
                <Forms.FormTitle tag="h4" style={{ margin: 0, flex: 1 }}>OwoSelf Dashboard</Forms.FormTitle>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", overflowX: "auto", marginBottom: 12, paddingBottom: 4 }}>
                    {TABS.map(t => (
                        <Button
                            key={t.id}
                            size={Button.Sizes.SMALL}
                            color={tab === t.id ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </Button>
                    ))}
                </div>
                {tab === "overview" && <OverviewTab refreshKey={refreshKey} bump={bump} />}
                {tab === "accounts" && <AccountsTab refreshKey={refreshKey} bump={bump} />}
                {tab === "commands" && <CommandsTab />}
                {tab === "quests" && <QuestsTab refreshKey={refreshKey} />}
                {tab === "security" && <SecurityTab refreshKey={refreshKey} />}
                {tab === "settings" && <SettingsTab bump={bump} />}
                {tab === "logs" && <LogsTab refreshKey={refreshKey} />}
            </ModalContent>
        </ModalRoot>
    );
}
