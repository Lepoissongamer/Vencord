/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { checkedFetch } from "@main/utils/http";
import { app, IpcMainInvokeEvent } from "electron";
import { access, mkdir } from "fs/promises";
import { createWriteStream } from "original-fs";
import { basename, extname, join } from "path";
import { Readable } from "stream";
import { finished } from "stream/promises";

const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitizeFilename(filename: string) {
    const cleaned = basename(filename)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);

    if (!cleaned || cleaned === "." || cleaned === "..") return "download";
    if (reservedWindowsNames.test(cleaned)) return `_${cleaned}`;

    return cleaned;
}

async function pathExists(path: string) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function getAvailableDownloadPath(filename: string) {
    const downloadsPath = app.getPath("downloads");
    await mkdir(downloadsPath, { recursive: true });

    const safeFilename = sanitizeFilename(filename);
    const extension = extname(safeFilename);
    const baseName = extension ? safeFilename.slice(0, -extension.length) : safeFilename;

    let candidate = join(downloadsPath, safeFilename);
    for (let i = 1; await pathExists(candidate); i++) {
        candidate = join(downloadsPath, `${baseName} (${i})${extension}`);
    }

    return candidate;
}

export async function downloadFile(_: IpcMainInvokeEvent, rawUrl: string, filename = "download") {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`Unsupported download protocol: ${url.protocol}`);
    }

    const response = await checkedFetch(url);
    if (!response.body) throw new Error("Download response body is empty");

    const downloadPath = await getAvailableDownloadPath(filename);

    // @ts-expect-error Node and DOM ReadableStream types disagree here.
    const body = Readable.fromWeb(response.body);
    await finished(body.pipe(createWriteStream(downloadPath, { flags: "wx" })));

    return downloadPath;
}
