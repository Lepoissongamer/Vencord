/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin, { PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.FastDownload as PluginNative<typeof import("./native")> | undefined;

const downloadLabelRegex = /download|t[ée]l[ée]charger|herunterladen|descargar|scarica|baixar|pobierz|downloaden/i;
const attachmentPathRegex = /\/(?:attachments|ephemeral-attachments)\//;

function isDiscordAttachmentUrl(url: URL) {
    return (url.protocol === "https:" || url.protocol === "http:")
        && (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net")
        && attachmentPathRegex.test(url.pathname);
}

function getLabel(element: Element, anchor: HTMLAnchorElement) {
    const labelledElement = element.closest("[aria-label], [title]");

    return [
        anchor.getAttribute("aria-label"),
        anchor.getAttribute("title"),
        anchor.getAttribute("download"),
        anchor.textContent,
        labelledElement?.getAttribute("aria-label"),
        labelledElement?.getAttribute("title")
    ].filter(Boolean).join(" ");
}

function getFilename(anchor: HTMLAnchorElement, url: URL) {
    const downloadName = anchor.getAttribute("download");
    if (downloadName) return downloadName;

    const lastPathPart = url.pathname.split("/").filter(Boolean).at(-1);
    if (!lastPathPart) return "download";

    try {
        return decodeURIComponent(lastPathPart);
    } catch {
        return lastPathPart;
    }
}

async function downloadInVesktop(url: string, filename: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);

    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

function handleClick(event: MouseEvent) {
    if (!IS_DISCORD_DESKTOP && !IS_VESKTOP) return;

    const { target } = event;
    if (!(target instanceof Element)) return;

    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;

    let url: URL;
    try {
        url = new URL(anchor.href);
    } catch {
        return;
    }

    if (!isDiscordAttachmentUrl(url)) return;

    const hasDownloadIntent = anchor.hasAttribute("download") || downloadLabelRegex.test(getLabel(target, anchor));
    if (!hasDownloadIntent) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const filename = getFilename(anchor, url);
    const downloadPromise = Native
        ? Native.downloadFile(url.toString(), filename)
        : downloadInVesktop(url.toString(), filename);

    downloadPromise.catch(err => {
        console.error("[FastDownload] Failed to download attachment", err);
    });
}

export default definePlugin({
    name: "FastDownload",
    description: "Ultra fast download like very super fast",
    tags: ["Utility"],
    authors: [Devs.Lepoissongamer],
    requiresRestart: true,

    start() {
        document.addEventListener("click", handleClick, true);
    },

    stop() {
        document.removeEventListener("click", handleClick, true);
    }
});
