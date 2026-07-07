/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { themes as shikiThemes } from "@plugins/shikiCodeblocks.desktop/api/themes";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import { wordsFromPascal, wordsToTitle } from "@utils/text";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, ComponentDispatch, DraftType, Forms, i18n, LocaleStore, React, SelectedChannelStore, showToast, Toasts, Tooltip, UploadHandler, useEffect, useRef, useState } from "@webpack/common";
import vscodeOnigurumaJs from "file://../../../node_modules/vscode-oniguruma/release/main.js?minify";
import vscodeOnigurumaWasmBase64 from "file://../../../node_modules/vscode-oniguruma/release/onig.wasm?base64";
import vscodeTextMateJs from "file://../../../node_modules/vscode-textmate/release/main.js?minify";
import deXml from "file://i18n/de.xml";
import enXml from "file://i18n/en.xml";
import frXml from "file://i18n/fr.xml";
import monacoBridgeJs from "file://monacoBridge.js?minify";
import monacoEditorCss from "file://monacoEditor.css";
import monacoEditorHtml from "file://monacoEditor.html?minify";

const MONACO_THEME_AUTO = "auto";
const MONACO_THEME_CUSTOM = "custom";
const MONACO_THEME_VS_DARK = "vs-dark";
const MONACO_THEME_VS_LIGHT = "vs";
const MONACO_THEME_HC_BLACK = "hc-black";
const MONACO_THEME_SHIKI_PREFIX = "shiki:";
const MONACO_BRIDGE_SOURCE = "vencode-monaco";
const BLUELINE_LOG_READER_URL = "https://www.bluelinevibes.com/log-reader";
const LocaleManager = findByPropsLazy("getLocale") as Record<string, unknown>;
const shikiThemeNames = Object.keys(shikiThemes)
    .filter(themeName => themeName !== "MaterialCandy") as Array<keyof typeof shikiThemes>;
const shikiThemeCache = new Map<string, Promise<CustomVsCodeTheme | null>>();

const languageXml = {
    en: enXml,
    fr: frXml,
    de: deXml
};
const translationCache = new Map<keyof typeof languageXml, Record<string, string>>();

function parseLanguageXml(language: keyof typeof languageXml) {
    const cached = translationCache.get(language);
    if (cached) return cached;

    const doc = new DOMParser().parseFromString(languageXml[language], "text/xml");
    const strings: Record<string, string> = {};

    doc.querySelectorAll("string[key]").forEach(node => {
        const key = node.getAttribute("key");
        if (key) strings[key] = node.textContent ?? "";
    });

    translationCache.set(language, strings);
    return strings;
}

function getLocaleCandidates() {
    const candidates: unknown[] = [];

    try {
        const localeStore = LocaleStore as unknown as Record<string, unknown> | undefined;
        candidates.push(
            localeStore?.locale,
            localeStore?.getLocale instanceof Function ? localeStore.getLocale() : undefined,
            localeStore?.getRawLocale instanceof Function ? localeStore.getRawLocale() : undefined
        );
    } catch { }

    try {
        candidates.push(
            LocaleManager?.locale,
            LocaleManager?.getLocale instanceof Function ? LocaleManager.getLocale() : undefined
        );
    } catch { }

    try {
        const intl = i18n?.intl as unknown as Record<string, unknown> | undefined;
        candidates.push(
            intl?.locale,
            intl?.resolvedLocale,
            intl?.initialLocale,
            intl?.defaultLocale,
            intl?.getLocale instanceof Function ? intl.getLocale() : undefined
        );
    } catch { }

    try {
        candidates.push(
            document.documentElement.lang,
            localStorage.getItem("locale"),
            localStorage.getItem("language"),
            localStorage.getItem("i18nextLng"),
            navigator.language,
            ...(navigator.languages ?? [])
        );
    } catch { }

    return candidates.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function getCurrentLanguage(): keyof typeof languageXml {
    for (const locale of getLocaleCandidates()) {
        const lowerLocale = locale.toLowerCase();
        if (lowerLocale === "fr" || lowerLocale.startsWith("fr-") || lowerLocale.startsWith("fr_")) return "fr";
        if (lowerLocale === "de" || lowerLocale.startsWith("de-") || lowerLocale.startsWith("de_")) return "de";
        if (lowerLocale === "en" || lowerLocale.startsWith("en-") || lowerLocale.startsWith("en_")) return "en";
    }

    return "en";
}

function t(key: string, values: Record<string, string | number> = {}) {
    const translations = parseLanguageXml(getCurrentLanguage());
    const fallbackTranslations = parseLanguageXml("en");
    const template = translations[key] ?? fallbackTranslations[key] ?? key;

    return template.replace(/\{(\w+)\}/g, (_, valueKey: string) => String(values[valueKey] ?? ""));
}

function getShikiMonacoThemeValue(themeName: keyof typeof shikiThemes) {
    return `${MONACO_THEME_SHIKI_PREFIX}${themeName}`;
}

const shikiMonacoThemeOptions = shikiThemeNames.map(themeName => ({
    label: wordsToTitle(wordsFromPascal(themeName)),
    value: getShikiMonacoThemeValue(themeName)
}));

const settings = definePluginSettings({
    settingsMenu: {
        type: OptionType.COMPONENT,
        component: OuvrirDocumentSettings
    },
    showEditorLineNumbers: {
        type: OptionType.BOOLEAN,
        description: t("settings.edit.lineNumbers.title"),
        default: true,
        hidden: true
    },
    monacoEditorTheme: {
        type: OptionType.SELECT,
        description: t("settings.edit.monacoTheme.title"),
        options: [
            { label: t("settings.edit.monacoTheme.auto"), value: MONACO_THEME_AUTO, default: true },
            { label: t("settings.edit.monacoTheme.vsDark"), value: MONACO_THEME_VS_DARK },
            { label: t("settings.edit.monacoTheme.vsLight"), value: MONACO_THEME_VS_LIGHT },
            { label: t("settings.edit.monacoTheme.highContrast"), value: MONACO_THEME_HC_BLACK },
            ...shikiMonacoThemeOptions,
            { label: t("settings.edit.monacoTheme.custom"), value: MONACO_THEME_CUSTOM }
        ],
        hidden: true
    },
    customMonacoThemeJson: {
        type: OptionType.STRING,
        description: t("settings.edit.customMonacoTheme.title"),
        default: "",
        hidden: true
    }
});

function SettingTextArea({ title, description, value, onChange }: { title: string; description: string; value: string; onChange(value: string): void; }) {
    return (
        <label style={{ display: "block", padding: "12px 0", borderBottom: "1px solid var(--background-modifier-accent)", color: "var(--text-normal)" }}>
            <Forms.FormTitle tag="h5" style={{ color: "var(--text-normal)" }}>{title}</Forms.FormTitle>
            <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: "8px" }}>{description}</Forms.FormText>
            <textarea
                value={value}
                rows={12}
                spellCheck={false}
                onChange={e => onChange(e.currentTarget.value)}
                style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 10px",
                    border: "1px solid var(--background-modifier-accent)",
                    borderRadius: "6px",
                    background: "var(--input-background)",
                    color: "var(--text-normal)",
                    fontFamily: "var(--font-code)",
                    fontSize: "12px",
                    lineHeight: "1.45",
                    minHeight: "180px",
                    outline: "none",
                    resize: "vertical"
                }}
            />
        </label>
    );
}

function SettingSelect({ title, description, value, options, onChange }: {
    title: string;
    description: string;
    value: string;
    options: Array<{ label: string; value: string; }>;
    onChange(value: string): void;
}) {
    return (
        <label style={{ display: "block", padding: "12px 0", borderBottom: "1px solid var(--background-modifier-accent)", color: "var(--text-normal)" }}>
            <Forms.FormTitle tag="h5" style={{ color: "var(--text-normal)" }}>{title}</Forms.FormTitle>
            <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: "8px" }}>{description}</Forms.FormText>
            <select
                value={value}
                onChange={e => onChange(e.currentTarget.value)}
                style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 10px",
                    border: "1px solid var(--background-modifier-accent)",
                    borderRadius: "6px",
                    background: "var(--input-background)",
                    color: "var(--text-normal)",
                    outline: "none"
                }}
            >
                {options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </label>
    );
}

function OuvrirDocumentSettings() {
    const values = settings.use([
        "customMonacoThemeJson",
        "monacoEditorTheme",
        "showEditorLineNumbers"
    ]);
    const [, rerender] = useState(0);

    const setSetting = <K extends keyof typeof settings.store>(key: K, value: typeof settings.store[K]) => {
        settings.store[key] = value;
        rerender(x => x + 1);
    };
    const monacoThemeMode = normalizeMonacoThemeMode(values.monacoEditorTheme ?? MONACO_THEME_AUTO);
    const customThemeIsSet = Boolean(values.customMonacoThemeJson.trim());
    const customThemeIsValid = customThemeIsSet && Boolean(getCustomMonacoThemeData(values.customMonacoThemeJson, false));

    return (
        <div className="vc-ouvrir-document-settings" style={{ color: "#f2f3f5" }}>
            <style>
                {`
.vc-ouvrir-document-settings,
.vc-ouvrir-document-settings h1,
.vc-ouvrir-document-settings h2,
.vc-ouvrir-document-settings h3,
.vc-ouvrir-document-settings h4,
.vc-ouvrir-document-settings h5,
.vc-ouvrir-document-settings summary,
.vc-ouvrir-document-settings label,
.vc-ouvrir-document-settings span {
    color: #f2f3f5 !important;
}

.vc-ouvrir-document-settings p {
    color: #c9cdd4 !important;
}

.vc-ouvrir-document-settings input,
.vc-ouvrir-document-settings select,
.vc-ouvrir-document-settings textarea {
    color: #f2f3f5 !important;
    background: #1e1f22 !important;
}
`}
            </style>
            <FormSwitch
                title={t("settings.edit.lineNumbers.title")}
                description={t("settings.edit.lineNumbers.description")}
                value={values.showEditorLineNumbers}
                onChange={value => setSetting("showEditorLineNumbers", value)}
            />
            <SettingSelect
                title={t("settings.edit.monacoTheme.title")}
                description={t("settings.edit.monacoTheme.description")}
                value={monacoThemeMode}
                onChange={value => setSetting("monacoEditorTheme", value)}
                options={[
                    { label: t("settings.edit.monacoTheme.auto"), value: MONACO_THEME_AUTO },
                    { label: t("settings.edit.monacoTheme.vsDark"), value: MONACO_THEME_VS_DARK },
                    { label: t("settings.edit.monacoTheme.vsLight"), value: MONACO_THEME_VS_LIGHT },
                    { label: t("settings.edit.monacoTheme.highContrast"), value: MONACO_THEME_HC_BLACK },
                    ...shikiMonacoThemeOptions,
                    { label: t("settings.edit.monacoTheme.custom"), value: MONACO_THEME_CUSTOM }
                ]}
            />
            {monacoThemeMode === MONACO_THEME_CUSTOM && (
                <>
                    <SettingTextArea
                        title={t("settings.edit.customMonacoTheme.title")}
                        description={t("settings.edit.customMonacoTheme.description")}
                        value={values.customMonacoThemeJson}
                        onChange={value => setSetting("customMonacoThemeJson", value)}
                    />
                    <Forms.FormText style={{
                        color: customThemeIsValid
                            ? "var(--text-positive)"
                            : customThemeIsSet
                                ? "var(--text-danger)"
                                : "var(--text-muted)",
                        margin: "-4px 0 10px"
                    }}>
                        {customThemeIsValid
                            ? t("settings.edit.customMonacoTheme.valid")
                            : customThemeIsSet
                                ? t("settings.edit.customMonacoTheme.invalid")
                                : t("settings.edit.customMonacoTheme.empty")}
                    </Forms.FormText>
                </>
            )}
        </div>
    );
}

const TEXT_FILE_EXTENSIONS = new Set([
    "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "adoc", "asc", "asm", "astro", "awk",
    "bash", "bat", "bats", "bib", "blade", "c", "cabal", "cfg", "clj", "cljs", "cmake", "cmd", "conf", "config", "cpp", "cs", "csh", "css", "csv", "cts",
    "dart", "diff", "dockerfile", "dtd", "editorconfig", "env", "erl", "ex", "exs", "fish", "frag", "fs", "fsi", "fsx", "gemspec", "gitconfig", "gitignore", "gleam", "glsl", "gql", "gradle", "graphql", "groovy",
    "h", "handlebars", "hbs", "heex", "hh", "hpp", "hrl", "hs", "htm", "html", "http", "hxx",
    "ics", "ignore", "ini", "java", "jl", "js", "json", "json5", "jsonc", "jsx", "kdl", "kt", "kts", "less", "lhs", "liquid", "lock", "log", "lua",
    "m", "make", "markdown", "md", "mdx", "mjs", "mk", "mkd", "ml", "mli", "mts", "mustache", "nix",
    "patch", "php", "pl", "plist", "pm", "pp", "properties", "proto", "ps1", "psd1", "psm1", "pug", "py", "pyi", "pyw",
    "r", "rb", "rego", "res", "resi", "rs", "rss", "rst", "sass", "scala", "scss", "sh", "sln", "sol", "sql", "srt", "styl", "svelte", "swift",
    "tf", "tfvars", "toml", "ts", "tsx", "txt", "v", "vb", "vbs", "vert", "vim", "vue", "wgsl", "xml", "xsd", "xsl", "xslt", "yaml", "yml", "zig", "zsh"
]);

const TEXT_FILE_NAMES = new Set([
    ".bash_profile", ".bashrc", ".dockerignore", ".editorconfig", ".env", ".eslintignore", ".eslintrc", ".gitattributes", ".gitconfig", ".gitignore", ".gitkeep", ".npmrc", ".prettierrc", ".profile", ".vimrc", ".zprofile", ".zshrc",
    "brewfile", "cmakelists.txt", "dockerfile", "gemfile", "license", "makefile", "podfile", "procfile", "rakefile", "readme", "vagrantfile"
]);

const TEXT_FILE_SUFFIXES = [
    ".babelrc", ".browserslistrc", ".css.map", ".d.ts", ".env.development", ".env.example", ".env.local", ".env.production", ".env.test", ".html.j2", ".js.map", ".module.css", ".module.scss", ".mtsx", ".spec.ts", ".spec.tsx", ".stories.tsx", ".test.ts", ".test.tsx"
];

const BINARY_FILE_EXTENSIONS = new Set([
    "7z", "a", "aac", "apk", "app", "ar", "avi", "bin", "bmp", "bz2",
    "class", "deb", "dll", "dmg", "doc", "docm", "docx", "dylib",
    "eot", "exe", "flac", "gif", "gz", "heic", "heif", "ico", "iso",
    "jar", "jpeg", "jpg", "m4a", "m4v", "mov", "mp3", "mp4", "mpeg",
    "mpg", "msi", "o", "obj", "odf", "ods", "odt", "ogg", "ogv", "otf",
    "pdf", "png", "ppt", "pptx", "pyc", "rar", "rpm", "so", "sqlite",
    "sqlite3", "tar", "tgz", "ttf", "wasm", "wav", "webm", "webp", "woff",
    "woff2", "xls", "xlsm", "xlsx", "xz", "zip"
]);

const TEXT_MIME_TYPES: Record<string, string> = {
    css: "text/css",
    csv: "text/csv",
    htm: "text/html",
    html: "text/html",
    js: "text/javascript",
    json: "application/json",
    json5: "application/json",
    jsonc: "application/json",
    jsx: "text/javascript",
    md: "text/markdown",
    mdx: "text/markdown",
    mjs: "text/javascript",
    toml: "application/toml",
    ts: "text/typescript",
    tsx: "text/typescript",
    txt: "text/plain",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml"
};

function getFileBasename(filename: string) {
    return filename
        .split(/[\\/]/)
        .pop()
        ?.split(/[?#]/)[0]
        ?.toLowerCase()
        ?? "";
}

function getFilenameExtension(filename: string) {
    const name = getFileBasename(filename);
    const dotIndex = name.lastIndexOf(".");
    return dotIndex === -1 ? "" : name.slice(dotIndex + 1);
}

function isSupportedFilename(filename: string) {
    const name = getFileBasename(filename);
    if (!name) return false;
    if (TEXT_FILE_NAMES.has(name) || TEXT_FILE_SUFFIXES.some(suffix => name.endsWith(suffix))) return true;

    const ext = getFilenameExtension(name);
    if (!ext) return true;
    if (TEXT_FILE_EXTENSIONS.has(ext)) return true;

    return !BINARY_FILE_EXTENSIONS.has(ext);
}

function inferLanguage(filename: string, rawText: string) {
    const name = getFileBasename(filename);
    const ext = getFilenameExtension(name);

    const langNameMap: Record<string, string> = {
        ".babelrc": "json",
        ".bash_profile": "bash",
        ".bashrc": "bash",
        ".dockerignore": "gitignore",
        ".editorconfig": "ini",
        ".env": "dotenv",
        ".eslintignore": "gitignore",
        ".eslintrc": "json",
        ".gitattributes": "git-attributes",
        ".gitconfig": "ini",
        ".gitignore": "gitignore",
        ".npmrc": "ini",
        ".prettierrc": "json",
        ".profile": "bash",
        ".vimrc": "vim",
        ".zprofile": "zsh",
        ".zshrc": "zsh",
        "brewfile": "ruby",
        "cmakelists.txt": "cmake",
        "dockerfile": "dockerfile",
        "gemfile": "ruby",
        "makefile": "make",
        "podfile": "ruby",
        "procfile": "bash",
        "rakefile": "ruby",
        "vagrantfile": "ruby"
    };

    const fromName = langNameMap[name];
    if (fromName) return fromName;
    if (name.endsWith(".d.ts")) return "typescript";
    if (name.endsWith(".css.map") || name.endsWith(".js.map")) return "json";
    if (name.endsWith(".env.local") || name.endsWith(".env.development") || name.endsWith(".env.production") || name.endsWith(".env.test") || name.endsWith(".env.example")) return "dotenv";

    const langMap: Record<string, string> = {
        "1": "man",
        "2": "man",
        "3": "man",
        "4": "man",
        "5": "man",
        "6": "man",
        "7": "man",
        "8": "man",
        "9": "man",
        adoc: "asciidoc",
        asc: "text",
        asm: "asm",
        astro: "astro",
        awk: "awk",
        bash: "bash",
        bat: "batch",
        bats: "bash",
        bib: "bibtex",
        blade: "blade",
        c: "c",
        cabal: "haskell",
        cc: "cpp",
        cfg: "ini",
        clj: "clojure",
        cljs: "clojure",
        cmake: "cmake",
        cmd: "batch",
        conf: "ini",
        config: "ini",
        cpp: "cpp",
        cs: "csharp",
        csh: "shellscript",
        css: "css",
        csv: "csv",
        cts: "typescript",
        dart: "dart",
        diff: "diff",
        dockerfile: "dockerfile",
        dtd: "xml",
        editorconfig: "ini",
        env: "dotenv",
        erl: "erlang",
        ex: "elixir",
        exs: "elixir",
        fish: "fish",
        frag: "glsl",
        fs: "fsharp",
        fsi: "fsharp",
        fsx: "fsharp",
        gemspec: "ruby",
        gitconfig: "ini",
        gitignore: "gitignore",
        gleam: "gleam",
        glsl: "glsl",
        go: "go",
        gql: "graphql",
        gradle: "groovy",
        graphql: "graphql",
        groovy: "groovy",
        h: "c",
        handlebars: "handlebars",
        hbs: "handlebars",
        heex: "elixir",
        hh: "cpp",
        hpp: "cpp",
        hrl: "erlang",
        hs: "haskell",
        htm: "html",
        html: "html",
        http: "http",
        hxx: "cpp",
        ics: "text",
        ignore: "gitignore",
        ini: "ini",
        java: "java",
        jl: "julia",
        js: "javascript",
        json: "json",
        json5: "json5",
        jsonc: "jsonc",
        jsx: "jsx",
        kdl: "kdl",
        kt: "kotlin",
        kts: "kotlin",
        less: "less",
        lhs: "haskell",
        liquid: "liquid",
        lock: "text",
        log: "log",
        lua: "lua",
        m: "objective-c",
        make: "make",
        markdown: "markdown",
        md: "markdown",
        mdx: "mdx",
        mjs: "javascript",
        mk: "make",
        mkd: "markdown",
        ml: "ocaml",
        mli: "ocaml",
        mts: "typescript",
        mustache: "handlebars",
        nix: "nix",
        patch: "diff",
        php: "php",
        pl: "perl",
        plist: "xml",
        pm: "perl",
        pp: "puppet",
        properties: "properties",
        proto: "proto",
        ps1: "powershell",
        psd1: "powershell",
        psm1: "powershell",
        pug: "pug",
        py: "python",
        pyi: "python",
        pyw: "python",
        r: "r",
        rb: "ruby",
        rego: "rego",
        res: "rescript",
        resi: "rescript",
        rs: "rust",
        rss: "xml",
        rst: "rst",
        sass: "sass",
        scala: "scala",
        scss: "scss",
        sh: "bash",
        sln: "ini",
        sol: "solidity",
        sql: "sql",
        srt: "text",
        styl: "stylus",
        svelte: "svelte",
        swift: "swift",
        tf: "terraform",
        tfvars: "terraform",
        toml: "toml",
        ts: "typescript",
        tsx: "tsx",
        txt: "log",
        v: "verilog",
        vb: "vb",
        vbs: "vb",
        vert: "glsl",
        vim: "vim",
        vue: "vue",
        wgsl: "wgsl",
        xml: "xml",
        xsd: "xml",
        xsl: "xml",
        xslt: "xml",
        yaml: "yaml",
        yml: "yaml",
        zig: "zig",
        zsh: "zsh",
    };

    const fromExt = langMap[ext];
    if (fromExt && fromExt !== "text") return fromExt;

    const trimmed = rawText.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            JSON.parse(trimmed);
            return "json";
        } catch { }
    }

    if (trimmed.startsWith("<") && trimmed.includes(">")) return "xml";
    if (rawText.includes("Traceback (most recent call last):")) return "python";

    return fromExt ?? "text";
}

function getMonacoLanguage(language: string) {
    const aliases: Record<string, string> = {
        asm: "plaintext",
        bash: "shell",
        batch: "bat",
        c: "cpp",
        csv: "plaintext",
        dotenv: "ini",
        "git-attributes": "plaintext",
        gitignore: "plaintext",
        json5: "json",
        jsonc: "json",
        jsx: "javascript",
        log: "plaintext",
        make: "plaintext",
        man: "plaintext",
        proto: "protobuf",
        rst: "restructuredtext",
        sass: "scss",
        shellscript: "shell",
        stylus: "css",
        svelte: "html",
        terraform: "hcl",
        text: "plaintext",
        tsx: "typescript",
        vue: "html",
        zsh: "shell"
    };

    return aliases[language] ?? language;
}

function parseCssRgbColor(color: string): [number, number, number] | null {
    const rgbMatch = color.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
    if (rgbMatch) {
        return [
            Number(rgbMatch[1]),
            Number(rgbMatch[2]),
            Number(rgbMatch[3])
        ];
    }

    const hexMatch = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hexMatch) return null;

    const hex = hexMatch[1].length === 3
        ? hexMatch[1].split("").map(char => char + char).join("")
        : hexMatch[1];

    return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16)
    ];
}

function isLightCssColor(color: string) {
    const rgb = parseCssRgbColor(color);
    if (!rgb) return false;

    const [red, green, blue] = rgb;
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue) > 160;
}

function withLineNumbers(rawText: string, lineCount: number) {
    const width = Math.max(3, lineCount.toString().length);
    const lines = rawText.split("\n");
    // Avoid adding an artificial numbered empty line when the file ends with a trailing newline.
    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }

    return lines
        .map((line, idx) => `${(idx + 1).toString().padStart(width, " ")} | ${line}`)
        .join("\n");
}

function getLineCount(rawText: string) {
    return rawText.split("\n").length;
}

function getTextMimeType(filename: string) {
    return TEXT_MIME_TYPES[getFilenameExtension(filename)] ?? "text/plain";
}

type ShortcutSpec = {
    alt: boolean;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    key: string;
};

type TextMateThemeRule = {
    scope?: string | string[];
    settings?: {
        background?: string;
        fontStyle?: string;
        foreground?: string;
    };
};

type VsCodeSemanticTokenColor = string | {
    bold?: boolean;
    fontStyle?: string;
    foreground?: string;
    italic?: boolean;
    underline?: boolean;
};

type CustomVsCodeTheme = {
    base?: unknown;
    bg?: unknown;
    colors?: unknown;
    fg?: unknown;
    inherit?: unknown;
    name?: string;
    rules?: unknown;
    semanticTokenColors?: unknown;
    settings?: unknown;
    tokenColors?: unknown;
    type?: unknown;
};

type MonacoThemeData = {
    base: typeof MONACO_THEME_VS_LIGHT | typeof MONACO_THEME_VS_DARK | typeof MONACO_THEME_HC_BLACK;
    colors: Record<string, string>;
    inherit: boolean;
    rules: Array<{
        background?: string;
        fontStyle?: string;
        foreground?: string;
        token: string;
    }>;
};

type MonacoThemeConfig = {
    theme: string;
    themeData?: MonacoThemeData;
    useTextMateGrammar?: boolean;
};

type CustomMonacoTheme = {
    themeData: MonacoThemeData;
    useTextMateGrammar: boolean;
};

const TEXTMATE_TO_MONACO_TOKEN_RULES: Array<[RegExp, string[]]> = [
    [/comment/, ["comment", "comment.content"]],
    [/(string|regexp)/, ["string"]],
    [/(constant\.numeric|number)/, ["number"]],
    [/(keyword|storage\.modifier|storage\.type)/, ["keyword"]],
    [/(entity\.name\.function|support\.function|variable\.function|meta\.function-call)/, ["function"]],
    [/(entity\.name\.type|entity\.name\.class|entity\.name\.interface|support\.type)/, ["type", "type.identifier"]],
    [/entity\.name\.tag/, ["tag"]],
    [/(entity\.other\.attribute-name|support\.type\.property-name)/, ["attribute.name"]],
    [/(variable\.other\.property|meta\.object-literal\.key)/, ["property"]],
    [/(constant\.language|constant\.character|constant\.other)/, ["constant"]],
    [/(variable|identifier)/, ["variable", "identifier"]],
    [/(operator|keyword\.operator)/, ["operator"]],
    [/(punctuation|delimiter)/, ["delimiter"]],
    [/(namespace|entity\.name\.namespace)/, ["namespace"]],
    [/(invalid|illegal)/, ["invalid"]]
];

const TEXTMATE_XML_TO_MONACO_TOKEN_RULES: Array<[RegExp, string[]]> = [
    [/entity\.name\.tag/, ["tag", "tag.xml"]],
    [/entity\.other\.attribute-name/, ["attribute.name", "attribute.name.xml"]],
    [/(string\.quoted|punctuation\.definition\.string)/, ["attribute.value", "attribute.value.xml", "string", "string.xml"]],
    [/constant\.character\.entity/, ["string.escape", "string.escape.xml"]],
    [/punctuation\.definition\.tag/, ["delimiter", "delimiter.xml"]],
    [/comment/, ["comment", "comment.xml", "comment.content", "comment.content.xml"]]
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ToUint8Array(base64: string) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function normalizeMonacoThemeColor(color?: string) {
    const rawHex = color?.trim().replace(/^#/, "");
    if (!rawHex) return undefined;

    const hex = rawHex.length === 3
        ? rawHex.split("").map(char => char + char).join("")
        : rawHex;
    return /^[\da-f]{6}(?:[\da-f]{2})?$/i.test(hex) ? hex.slice(0, 6) : undefined;
}

function normalizeMonacoEditorColor(color: unknown) {
    if (typeof color !== "string") return undefined;

    const rawHex = color.trim().replace(/^#/, "");
    if (!rawHex) return undefined;

    const hex = rawHex.length === 3
        ? rawHex.split("").map(char => char + char).join("")
        : rawHex;

    return /^[\da-f]{6}(?:[\da-f]{2})?$/i.test(hex) ? `#${hex}` : undefined;
}

function withEditorColorAlpha(color: string | undefined, alphaHex: string) {
    const hex = color?.trim().replace(/^#/, "");
    if (!hex || !/^[\da-f]{6}(?:[\da-f]{2})?$/i.test(hex)) return undefined;

    return `#${hex.slice(0, 6)}${alphaHex}`;
}

function normalizeMonacoFontStyle(fontStyle?: string) {
    const value = fontStyle
        ?.split(/\s+/)
        .map(style => style.trim())
        .filter(style => style && style !== "normal")
        .join(" ");

    return value || undefined;
}

function getMonacoTokensForTextMateScope(scope: string) {
    const tokens = new Set<string>();
    const parts = scope
        .split(/\s+/)
        .map(part => part.trim())
        .filter(Boolean);

    if (parts.length === 1) {
        tokens.add(parts[0]);
    }

    for (const part of parts) {
        if (part.endsWith(".xml") || part.includes(".xml.")) {
            for (const [pattern, monacoTokens] of TEXTMATE_XML_TO_MONACO_TOKEN_RULES) {
                if (!pattern.test(part)) continue;
                monacoTokens.forEach(token => tokens.add(token));
            }
        }

        const root = part.split(".")[0];
        if (["comment", "string", "keyword", "number", "operator", "delimiter"].includes(root)) {
            tokens.add(root);
        }

        for (const [pattern, monacoTokens] of TEXTMATE_TO_MONACO_TOKEN_RULES) {
            if (!pattern.test(part)) continue;
            monacoTokens.forEach(token => tokens.add(token));
        }
    }

    return [...tokens];
}

function stripJsonComments(input: string) {
    let output = "";
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const nextChar = input[i + 1];

        if (inLineComment) {
            if (char === "\n") {
                inLineComment = false;
                output += char;
            }
            continue;
        }

        if (inBlockComment) {
            if (char === "*" && nextChar === "/") {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            output += char;
            continue;
        }

        if (char === "/" && nextChar === "/") {
            inLineComment = true;
            i++;
            continue;
        }

        if (char === "/" && nextChar === "*") {
            inBlockComment = true;
            i++;
            continue;
        }

        output += char;
    }

    return output;
}

function stripTrailingJsonCommas(input: string) {
    let output = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            output += char;
            continue;
        }

        if (char === ",") {
            let nextIndex = i + 1;
            while (/\s/.test(input[nextIndex] ?? "")) nextIndex++;
            if (input[nextIndex] === "}" || input[nextIndex] === "]") continue;
        }

        output += char;
    }

    return output;
}

function parseCustomThemeJson(rawTheme: string): CustomVsCodeTheme | null {
    const trimmedTheme = rawTheme.trim();
    if (!trimmedTheme) return null;

    try {
        const parsedTheme: unknown = JSON.parse(trimmedTheme);
        return isRecord(parsedTheme) ? parsedTheme as CustomVsCodeTheme : null;
    } catch { }

    try {
        const parsedTheme: unknown = JSON.parse(stripTrailingJsonCommas(stripJsonComments(trimmedTheme)));
        return isRecord(parsedTheme) ? parsedTheme as CustomVsCodeTheme : null;
    } catch {
        return null;
    }
}

function getShikiMonacoThemeName(themeMode: string) {
    if (!themeMode.startsWith(MONACO_THEME_SHIKI_PREFIX)) return null;

    const themeName = themeMode.slice(MONACO_THEME_SHIKI_PREFIX.length) as keyof typeof shikiThemes;
    return shikiThemeNames.includes(themeName) ? themeName : null;
}

function normalizeMonacoThemeMode(themeMode: string) {
    if (
        themeMode === MONACO_THEME_AUTO
        || themeMode === MONACO_THEME_CUSTOM
        || themeMode === MONACO_THEME_VS_DARK
        || themeMode === MONACO_THEME_VS_LIGHT
        || themeMode === MONACO_THEME_HC_BLACK
        || getShikiMonacoThemeName(themeMode)
    ) {
        return themeMode;
    }

    return MONACO_THEME_AUTO;
}

function getCustomThemeBase(theme: CustomVsCodeTheme, isLightTheme: boolean): MonacoThemeData["base"] {
    if (
        theme.base === MONACO_THEME_VS_DARK
        || theme.base === MONACO_THEME_VS_LIGHT
        || theme.base === MONACO_THEME_HC_BLACK
    ) {
        return theme.base;
    }

    const type = typeof theme.type === "string" ? theme.type.toLowerCase() : "";
    if (type.includes("light")) return MONACO_THEME_VS_LIGHT;
    if (type.includes("hc") || type.includes("highcontrast")) return MONACO_THEME_HC_BLACK;
    if (type.includes("dark")) return MONACO_THEME_VS_DARK;

    return isLightTheme ? MONACO_THEME_VS_LIGHT : MONACO_THEME_VS_DARK;
}

function getCustomThemeColors(theme: CustomVsCodeTheme) {
    const colors: Record<string, string> = {};
    if (isRecord(theme.colors)) {
        for (const [key, value] of Object.entries(theme.colors)) {
            const color = normalizeMonacoEditorColor(value);
            if (color) colors[key] = color;
        }
    }

    colors["editor.background"] ??= normalizeMonacoEditorColor(theme.bg) ?? colors["editor.background"];
    colors["editor.foreground"] ??= normalizeMonacoEditorColor(theme.fg) ?? colors["editor.foreground"];

    return colors;
}

function applyGlobalTextMateThemeColors(colors: Record<string, string>, textMateRules: TextMateThemeRule[]) {
    for (const { scope, settings } of textMateRules) {
        if (scope || !settings) continue;

        colors["editor.background"] ??= normalizeMonacoEditorColor(settings.background) ?? colors["editor.background"];
        colors["editor.foreground"] ??= normalizeMonacoEditorColor(settings.foreground) ?? colors["editor.foreground"];
    }
}

function applyDerivedEditorColors(colors: Record<string, string>) {
    if (colors["editor.foreground"]) {
        colors["editorCursor.foreground"] ??= colors["editor.foreground"];
        colors["editorLineNumber.foreground"] ??= colors["editor.foreground"];
    }

    const wordHighlightBackground = colors["editor.wordHighlightBackground"]
        ?? colors["editor.selectionHighlightBackground"]
        ?? withEditorColorAlpha(colors["editor.selectionBackground"], "33");
    const strongWordHighlightBackground = colors["editor.wordHighlightStrongBackground"]
        ?? colors["editor.wordHighlightTextBackground"]
        ?? colors["editor.selectionHighlightBackground"]
        ?? withEditorColorAlpha(colors["editor.selectionBackground"], "44");

    if (wordHighlightBackground) {
        colors["editor.wordHighlightBackground"] ??= wordHighlightBackground;
        colors["editor.selectionHighlightBackground"] ??= wordHighlightBackground;
    }

    if (strongWordHighlightBackground) {
        colors["editor.wordHighlightStrongBackground"] ??= strongWordHighlightBackground;
        colors["editor.wordHighlightTextBackground"] ??= strongWordHighlightBackground;
    }

    colors["editor.wordHighlightBorder"] ??= colors["editor.selectionHighlightBorder"] ?? "#00000000";
    colors["editor.wordHighlightStrongBorder"] ??= colors["editor.selectionHighlightBorder"] ?? "#00000000";
    colors["editor.wordHighlightTextBorder"] ??= colors["editor.selectionHighlightBorder"] ?? "#00000000";
}

function getTextMateScopes(scope: string | string[] | undefined) {
    const scopes = Array.isArray(scope) ? scope : scope?.split(",") ?? [];
    return scopes
        .flatMap(item => item.split(","))
        .map(item => item.trim())
        .filter(Boolean);
}

function getTextMateThemeRules(rules: unknown): TextMateThemeRule[] {
    if (!Array.isArray(rules)) return [];

    return rules
        .filter(isRecord)
        .map(rule => {
            const scope = typeof rule.scope === "string"
                ? rule.scope
                : Array.isArray(rule.scope)
                    ? rule.scope.filter((item): item is string => typeof item === "string")
                    : undefined;
            const settings = isRecord(rule.settings)
                ? {
                    background: typeof rule.settings.background === "string" ? rule.settings.background : undefined,
                    fontStyle: typeof rule.settings.fontStyle === "string" ? rule.settings.fontStyle : undefined,
                    foreground: typeof rule.settings.foreground === "string" ? rule.settings.foreground : undefined
                }
                : undefined;

            return { scope, settings };
        });
}

function addRulesFromTextMateThemeRules(rules: MonacoThemeData["rules"], textMateRules: TextMateThemeRule[] | undefined) {
    for (const rule of textMateRules ?? []) {
        const { settings, scope } = rule;
        if (!settings || !scope) continue;

        const monacoRuleBase = {
            background: normalizeMonacoThemeColor(settings.background),
            fontStyle: normalizeMonacoFontStyle(settings.fontStyle),
            foreground: normalizeMonacoThemeColor(settings.foreground)
        };

        if (!monacoRuleBase.background && !monacoRuleBase.fontStyle && !monacoRuleBase.foreground) continue;

        for (const textMateScope of getTextMateScopes(scope)) {
            const directToken = textMateScope
                .split(/\s+/)
                .map(part => part.trim())
                .filter(Boolean)
                .at(-1);

            if (directToken) {
                rules.push({
                    token: directToken,
                    ...monacoRuleBase
                });
            }

            for (const token of getMonacoTokensForTextMateScope(textMateScope)) {
                rules.push({
                    token,
                    ...monacoRuleBase
                });
            }
        }
    }
}

function addRulesFromMonacoThemeRules(rules: MonacoThemeData["rules"], monacoRules: unknown[] | undefined) {
    for (const rule of monacoRules ?? []) {
        if (!isRecord(rule) || typeof rule.token !== "string") continue;

        const monacoRule = {
            token: rule.token,
            background: typeof rule.background === "string" ? normalizeMonacoThemeColor(rule.background) : undefined,
            fontStyle: typeof rule.fontStyle === "string" ? normalizeMonacoFontStyle(rule.fontStyle) : undefined,
            foreground: typeof rule.foreground === "string" ? normalizeMonacoThemeColor(rule.foreground) : undefined
        };

        if (monacoRule.background || monacoRule.fontStyle || monacoRule.foreground) {
            rules.push(monacoRule);
        }
    }
}

function getSemanticTokenColors(semanticTokenColors: unknown) {
    if (!isRecord(semanticTokenColors)) return undefined;

    const colors: Record<string, VsCodeSemanticTokenColor> = {};
    for (const [token, value] of Object.entries(semanticTokenColors)) {
        if (typeof value === "string") {
            colors[token] = value;
            continue;
        }

        if (!isRecord(value)) continue;
        colors[token] = {
            bold: typeof value.bold === "boolean" ? value.bold : undefined,
            fontStyle: typeof value.fontStyle === "string" ? value.fontStyle : undefined,
            foreground: typeof value.foreground === "string" ? value.foreground : undefined,
            italic: typeof value.italic === "boolean" ? value.italic : undefined,
            underline: typeof value.underline === "boolean" ? value.underline : undefined
        };
    }

    return colors;
}

function addRulesFromSemanticTokenColors(rules: MonacoThemeData["rules"], semanticTokenColors: Record<string, VsCodeSemanticTokenColor> | undefined) {
    for (const [token, value] of Object.entries(semanticTokenColors ?? {})) {
        const foreground = typeof value === "string"
            ? normalizeMonacoThemeColor(value)
            : normalizeMonacoThemeColor(value.foreground);
        const fontStyles = typeof value === "string"
            ? undefined
            : normalizeMonacoFontStyle([
                value.bold ? "bold" : "",
                value.italic ? "italic" : "",
                value.underline ? "underline" : "",
                value.fontStyle ?? ""
            ].join(" "));

        if (foreground || fontStyles) {
            rules.push({
                token,
                foreground,
                fontStyle: fontStyles
            });
        }
    }
}

function getCustomMonacoThemeData(rawTheme: string, isLightTheme: boolean): CustomMonacoTheme | null {
    const theme = parseCustomThemeJson(rawTheme);
    if (!theme) return null;

    return getCustomMonacoTheme(theme, isLightTheme);
}

function getCustomMonacoTheme(theme: CustomVsCodeTheme, isLightTheme: boolean): CustomMonacoTheme | null {
    const colors = getCustomThemeColors(theme);
    const tokenColorRules = getTextMateThemeRules(theme.tokenColors);
    const textMateRules = tokenColorRules.length ? tokenColorRules : getTextMateThemeRules(theme.settings);
    applyGlobalTextMateThemeColors(colors, textMateRules);
    applyDerivedEditorColors(colors);

    const rules: MonacoThemeData["rules"] = [];
    addRulesFromMonacoThemeRules(rules, Array.isArray(theme.rules) ? theme.rules : undefined);
    addRulesFromTextMateThemeRules(rules, textMateRules);
    addRulesFromSemanticTokenColors(rules, getSemanticTokenColors(theme.semanticTokenColors));

    if (!rules.length && !Object.keys(colors).length) return null;

    return {
        themeData: {
            base: getCustomThemeBase(theme, isLightTheme),
            colors,
            inherit: typeof theme.inherit === "boolean" ? theme.inherit : true,
            rules
        },
        useTextMateGrammar: true
    };
}

async function fetchShikiTheme(themeName: keyof typeof shikiThemes) {
    const url = shikiThemes[themeName];
    let promise = shikiThemeCache.get(url);
    if (!promise) {
        promise = fetch(url)
            .then(async res => {
                if (!res.ok) {
                    shikiThemeCache.delete(url);
                    return null;
                }

                const theme: unknown = await res.json();
                if (isRecord(theme)) return theme as CustomVsCodeTheme;

                shikiThemeCache.delete(url);
                return null;
            })
            .catch(() => {
                shikiThemeCache.delete(url);
                return null;
            });
        shikiThemeCache.set(url, promise);
    }

    return promise;
}

async function getShikiMonacoThemeConfig(themeName: keyof typeof shikiThemes, isLightTheme: boolean): Promise<MonacoThemeConfig | null> {
    const shikiTheme = await fetchShikiTheme(themeName);
    if (!shikiTheme) return null;

    const customTheme = getCustomMonacoTheme(shikiTheme, isLightTheme);
    if (!customTheme) return null;

    return {
        theme: `vencode-shiki-${themeName}`,
        themeData: customTheme.themeData,
        useTextMateGrammar: customTheme.useTextMateGrammar
    };
}

async function getMonacoThemeConfig(themeMode: string, isLightTheme: boolean, customThemeJson: string): Promise<MonacoThemeConfig> {
    if (normalizeMonacoThemeMode(themeMode) === MONACO_THEME_CUSTOM) {
        const customTheme = getCustomMonacoThemeData(customThemeJson, isLightTheme);
        if (customTheme) {
            return {
                theme: "vencode-custom-theme",
                themeData: customTheme.themeData,
                useTextMateGrammar: customTheme.useTextMateGrammar
            };
        }
    }

    themeMode = normalizeMonacoThemeMode(themeMode);
    const shikiThemeName = getShikiMonacoThemeName(themeMode);
    if (shikiThemeName) {
        const shikiThemeConfig = await getShikiMonacoThemeConfig(shikiThemeName, isLightTheme);
        if (shikiThemeConfig) return shikiThemeConfig;
    }

    if (
        themeMode === MONACO_THEME_VS_DARK
        || themeMode === MONACO_THEME_VS_LIGHT
        || themeMode === MONACO_THEME_HC_BLACK
    ) {
        return { theme: themeMode };
    }

    return { theme: isLightTheme ? MONACO_THEME_VS_LIGHT : MONACO_THEME_VS_DARK };
}

function normalizeShortcutKey(key: string) {
    const lower = key.trim().toLowerCase();
    if (lower === "return") return "enter";
    if (lower === "esc") return "escape";
    if (lower === "spacebar" || lower === " ") return "space";
    return lower;
}

function parseShortcut(shortcut: string): ShortcutSpec | null {
    const parts = shortcut
        .split("+")
        .map(part => part.trim())
        .filter(Boolean);
    if (!parts.length) return null;

    const spec: ShortcutSpec = {
        alt: false,
        ctrl: false,
        meta: false,
        shift: false,
        key: ""
    };

    for (const part of parts) {
        const key = normalizeShortcutKey(part);
        if (key === "ctrl" || key === "control") spec.ctrl = true;
        else if (key === "cmd" || key === "command" || key === "meta") spec.meta = true;
        else if (key === "alt" || key === "option") spec.alt = true;
        else if (key === "shift") spec.shift = true;
        else if (!spec.key) spec.key = key;
        else return null;
    }

    return spec.key ? spec : null;
}

function eventMatchesShortcut(event: KeyboardEvent, shortcut: string, allowExtraShift = false) {
    const spec = parseShortcut(shortcut);
    if (!spec) return false;

    const key = normalizeShortcutKey(event.key);
    const shiftMatches = event.shiftKey === spec.shift || (allowExtraShift && event.shiftKey && !spec.shift);

    return key === spec.key
        && event.altKey === spec.alt
        && event.ctrlKey === spec.ctrl
        && event.metaKey === spec.meta
        && shiftMatches;
}

function dispatchBestEffortSend() {
    window.setTimeout(() => {
        ComponentDispatch?.dispatchToLastSubscribed?.("SEND_MESSAGE");
        ComponentDispatch?.dispatch?.("SEND_MESSAGE");

        const textbox = document.querySelector<HTMLElement>("[role='textbox'][contenteditable='true'], [data-slate-editor='true']");
        textbox?.dispatchEvent(new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            code: "Enter",
            key: "Enter"
        }));
    }, 350);
}

function attachFileToCurrentChannel(filename: string, fileText: string, sendImmediately = false) {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;

    if (!channel) {
        showToast(t("toast.attachNoChannel"), Toasts.Type.FAILURE);
        return false;
    }

    const uploadFile = new File([fileText], filename || t("defaultFilename"), { type: getTextMimeType(filename) });

    try {
        UploadHandler.promptToUpload([uploadFile], channel, DraftType.ChannelMessage);
        if (sendImmediately) {
            dispatchBestEffortSend();
            showToast(t("toast.attachAndSendAttempted"), Toasts.Type.SUCCESS);
        } else {
            showToast(t("toast.attachAdded"), Toasts.Type.SUCCESS);
        }
        return true;
    } catch (err) {
        console.error("[VenCode] Failed to attach edited file", err);
        showToast(t("toast.attachFailed"), Toasts.Type.FAILURE);
        return false;
    }
}

function clearSearchHighlights(root: HTMLElement) {
    const marks = root.querySelectorAll("mark.vc-log-search-hit");
    marks.forEach(mark => {
        const text = document.createTextNode(mark.textContent ?? "");
        mark.replaceWith(text);
    });

    root.normalize();
}

function applySearchHighlight(root: HTMLElement, query: string, maxMatches = Number.POSITIVE_INFINITY) {
    clearSearchHighlights(root);
    if (!query) return [] as HTMLElement[];

    const lowerQuery = query.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const marks: HTMLElement[] = [];

    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        nodes.push(node);
    }

    for (const textNode of nodes) {
        if (marks.length >= maxMatches) break;
        const source = textNode.nodeValue ?? "";
        const lower = source.toLowerCase();
        let start = 0;
        let idx = lower.indexOf(lowerQuery, start);
        if (idx === -1) continue;

        const frag = document.createDocumentFragment();
        while (idx !== -1) {
            if (marks.length >= maxMatches) break;
            if (idx > start) frag.appendChild(document.createTextNode(source.slice(start, idx)));
            const mark = document.createElement("mark");
            mark.className = "vc-log-search-hit";
            mark.style.background = "#f7cc4a";
            mark.style.color = "#1a1a1a";
            mark.textContent = source.slice(idx, idx + query.length);
            frag.appendChild(mark);
            marks.push(mark);

            start = idx + query.length;
            idx = lower.indexOf(lowerQuery, start);
        }

        if (start < source.length) frag.appendChild(document.createTextNode(source.slice(start)));
        textNode.replaceWith(frag);
    }

    return marks;
}

function getSearchRoots(root: HTMLElement) {
    const shikiCodeCells = root.querySelectorAll<HTMLElement>(".vc-shiki-table-row > .vc-shiki-table-cell:nth-child(2)");
    return shikiCodeCells.length ? Array.from(shikiCodeCells) : [root];
}

type SearchSegment = { node: Text; start: number; end: number; };
type SearchIndex = {
    lowerText: string;
    segments: SearchSegment[];
};

function buildSearchIndex(root: HTMLElement): SearchIndex {
    const segments: SearchSegment[] = [];
    let combinedText = "";

    for (const searchRoot of getSearchRoots(root)) {
        if (combinedText) combinedText += "\n";

        const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const value = node.nodeValue ?? "";
            if (!value) continue;

            const start = combinedText.length;
            combinedText += value;
            segments.push({ node, start, end: combinedText.length });
        }
    }

    return {
        lowerText: combinedText.toLowerCase(),
        segments
    };
}

function findSegmentForOffset(segments: SearchSegment[], offset: number) {
    let low = 0;
    let high = segments.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const segment = segments[mid];

        if (offset < segment.start) {
            high = mid - 1;
        } else if (offset > segment.end) {
            low = mid + 1;
        } else {
            return segment;
        }
    }

    return null;
}

function findSearchRanges(searchIndex: SearchIndex, query: string, maxMatches = Number.POSITIVE_INFINITY) {
    if (!query) return [] as Range[];

    const lowerQuery = query.toLowerCase();
    const ranges: Range[] = [];
    let start = 0;
    let idx = searchIndex.lowerText.indexOf(lowerQuery, start);

    while (idx !== -1 && ranges.length < maxMatches) {
        const end = idx + query.length;
        const startSegment = findSegmentForOffset(searchIndex.segments, idx);
        const endSegment = findSegmentForOffset(searchIndex.segments, end);

        if (startSegment && endSegment) {
            const range = document.createRange();
            range.setStart(startSegment.node, idx - startSegment.start);
            range.setEnd(endSegment.node, end - endSegment.start);
            ranges.push(range);
        }

        start = end;
        idx = searchIndex.lowerText.indexOf(lowerQuery, start);
    }

    return ranges;
}

function canUseCssHighlights() {
    return Boolean((CSS as unknown as { highlights?: Map<string, unknown>; }).highlights && (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown; }).Highlight);
}

function clearCssSearchHighlights(hitName: string, activeName: string) {
    const { highlights } = CSS as unknown as { highlights?: Map<string, unknown>; };
    highlights?.delete(hitName);
    highlights?.delete(activeName);
}

function setCssSearchHighlights(hitName: string, activeName: string, ranges: Range[], activeIndex: number) {
    const { highlights } = CSS as unknown as { highlights?: Map<string, unknown>; };
    const { Highlight: HighlightCtor } = window as unknown as { Highlight?: new (...ranges: Range[]) => unknown; };
    if (!highlights || !HighlightCtor) return false;

    const safeActiveIndex = activeIndex >= 0 && activeIndex < ranges.length ? activeIndex : -1;
    const regularRanges = safeActiveIndex === -1
        ? ranges
        : ranges.filter((_, i) => i !== safeActiveIndex);
    const activeRanges = safeActiveIndex === -1 ? [] : [ranges[safeActiveIndex]];

    highlights.set(hitName, new HighlightCtor(...regularRanges));
    highlights.set(activeName, new HighlightCtor(...activeRanges));
    return true;
}

function openLogModal(filename: string, rawText: string) {
    const {
        customMonacoThemeJson,
        monacoEditorTheme,
        showEditorLineNumbers
    } = settings.store;

    let currentText = rawText;
    let monacoFrame: HTMLIFrameElement | null = null;
    let monacoReady = false;
    let monacoText = currentText;
    let monacoBridgeUrl: string | null = null;
    let monacoOnigurumaUrl: string | null = null;
    let monacoOnigurumaWasmDataUrl: string | null = null;
    let monacoOnigurumaWasmUrl: string | null = null;
    let monacoStyleUrl: string | null = null;
    let monacoTextMateUrl: string | null = null;
    let monacoTextMateStatus = "";
    let didCleanup = false;
    let overlayMouseDownStartedOnBackdrop = false;
    let overlayMouseUpEndedOnBackdrop = false;

    const bgPrimary = "var(--background-primary, #1e1f22)";
    const bgSecondary = "var(--background-secondary, #2b2d31)";
    const borderColor = "var(--background-modifier-accent, #4e5058)";
    const textNormal = "var(--text-normal, #dbdee1)";
    const textMuted = "var(--text-muted, #b5bac1)";
    const buttonSecondary = "var(--button-secondary-background, #4e5058)";
    const buttonDanger = "var(--button-danger-background, #da373c)";

    const existing = document.getElementById("vc-full-log-viewer-modal");
    if (existing) {
        (existing as { vcCleanup?: () => void; }).vcCleanup?.();
        existing.remove();
    }

    const overlay = document.createElement("div");
    overlay.id = "vc-full-log-viewer-modal";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.75)";
    overlay.style.zIndex = "999999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const box = document.createElement("div");
    box.style.width = "min(95vw, 1500px)";
    box.style.height = "min(92vh, 1000px)";
    box.style.background = bgPrimary;
    box.style.border = `1px solid ${borderColor}`;
    box.style.borderRadius = "12px";
    box.style.display = "flex";
    box.style.flexDirection = "column";
    box.style.overflow = "hidden";
    box.style.boxShadow = "0 20px 60px rgba(0,0,0,0.45)";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.gap = "8px";
    header.style.alignItems = "center";
    header.style.padding = "12px";
    header.style.borderBottom = `1px solid ${borderColor}`;
    header.style.background = bgSecondary;

    const title = document.createElement("div");
    title.textContent = filename;
    title.style.fontWeight = "700";
    title.style.flex = "1";
    title.style.minWidth = "0";
    title.style.overflow = "hidden";
    title.style.textOverflow = "ellipsis";
    title.style.whiteSpace = "nowrap";

    const makeActionButton = (label: string) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.style.padding = "8px 12px";
        button.style.borderRadius = "8px";
        button.style.border = "none";
        button.style.cursor = "pointer";
        button.style.background = buttonSecondary;
        button.style.color = textNormal;
        return button;
    };

    const insertActionBtn = makeActionButton(t("viewer.action.insert.short"));
    insertActionBtn.title = t("viewer.action.insert.title", { shortcut: "CTRL + I" });
    const insertAndSendActionBtn = makeActionButton(t("viewer.action.insertAndSend.short"));
    insertAndSendActionBtn.title = t("viewer.action.insertAndSend.title", { shortcut: "CTRL + ENTER" });
    const saveActionBtn = makeActionButton(t("viewer.action.save.short"));
    saveActionBtn.title = t("viewer.action.save.title", { shortcut: "CTRL + S" });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "X";
    closeBtn.title = t("viewer.close");
    closeBtn.style.width = "36px";
    closeBtn.style.height = "32px";
    closeBtn.style.padding = "0";
    closeBtn.style.borderRadius = "6px";
    closeBtn.style.border = "none";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.background = "transparent";
    closeBtn.style.color = textNormal;
    closeBtn.style.fontSize = "22px";
    closeBtn.style.lineHeight = "32px";
    closeBtn.style.display = "inline-flex";
    closeBtn.style.alignItems = "center";
    closeBtn.style.justifyContent = "center";
    closeBtn.onmouseenter = () => {
        closeBtn.style.background = buttonDanger;
        closeBtn.style.color = "white";
    };
    closeBtn.onmouseleave = () => {
        closeBtn.style.background = "transparent";
        closeBtn.style.color = textNormal;
    };

    const stats = document.createElement("div");
    stats.style.padding = "8px 12px";
    stats.style.fontSize = "12px";
    stats.style.color = textMuted;
    stats.style.borderBottom = `1px solid ${borderColor}`;

    const content = document.createElement("div");
    content.style.flex = "1";
    content.style.background = bgPrimary;
    content.style.overflow = "hidden";

    const revokeMonacoResourceUrls = () => {
        if (monacoBridgeUrl) URL.revokeObjectURL(monacoBridgeUrl);
        if (monacoOnigurumaUrl) URL.revokeObjectURL(monacoOnigurumaUrl);
        if (monacoOnigurumaWasmDataUrl) URL.revokeObjectURL(monacoOnigurumaWasmDataUrl);
        if (monacoOnigurumaWasmUrl) URL.revokeObjectURL(monacoOnigurumaWasmUrl);
        if (monacoStyleUrl) URL.revokeObjectURL(monacoStyleUrl);
        if (monacoTextMateUrl) URL.revokeObjectURL(monacoTextMateUrl);
        monacoBridgeUrl = null;
        monacoOnigurumaUrl = null;
        monacoOnigurumaWasmDataUrl = null;
        monacoOnigurumaWasmUrl = null;
        monacoStyleUrl = null;
        monacoTextMateUrl = null;
    };

    const createMonacoFrameHtml = () => {
        revokeMonacoResourceUrls();
        monacoBridgeUrl = URL.createObjectURL(new Blob([monacoBridgeJs], { type: "text/javascript" }));
        monacoOnigurumaUrl = URL.createObjectURL(new Blob([vscodeOnigurumaJs], { type: "text/javascript" }));
        monacoOnigurumaWasmDataUrl = URL.createObjectURL(new Blob([
            `window.VENCODE_ONIGURUMA_WASM_BASE64=${JSON.stringify(vscodeOnigurumaWasmBase64)};`
        ], { type: "text/javascript" }));
        monacoOnigurumaWasmUrl = URL.createObjectURL(new Blob([base64ToUint8Array(vscodeOnigurumaWasmBase64)], { type: "application/wasm" }));
        monacoStyleUrl = URL.createObjectURL(new Blob([monacoEditorCss], { type: "text/css" }));
        monacoTextMateUrl = URL.createObjectURL(new Blob([vscodeTextMateJs], { type: "text/javascript" }));

        return monacoEditorHtml
            .replace("VENCODE_MONACO_BRIDGE_URL", monacoBridgeUrl)
            .replace("VENCODE_MONACO_STYLE_URL", monacoStyleUrl)
            .replace("VENCODE_ONIGURUMA_URL", monacoOnigurumaUrl)
            .replace("VENCODE_ONIGURUMA_WASM_DATA_URL", monacoOnigurumaWasmDataUrl)
            .replace("VENCODE_ONIGURUMA_WASM_URL", monacoOnigurumaWasmUrl)
            .replace("VENCODE_TEXTMATE_URL", monacoTextMateUrl);
    };

    const postMonacoMessage = (message: Record<string, unknown>) => {
        monacoFrame?.contentWindow?.postMessage({
            source: MONACO_BRIDGE_SOURCE,
            ...message
        }, "*");
    };

    const getWorkingText = () => monacoText;

    const updateStats = () => {
        const text = getWorkingText();
        const textMatePart = monacoTextMateStatus ? ` • ${monacoTextMateStatus}` : "";
        stats.textContent = t("stats.summary", {
            characters: text.length.toLocaleString(),
            lines: getLineCount(text).toLocaleString()
        }) + textMatePart;
    };

    const cleanup = () => {
        if (didCleanup) return;
        didCleanup = true;
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("message", onMonacoMessage);
        revokeMonacoResourceUrls();
        overlay.remove();
    };

    function runInsertAction(sendImmediately = false) {
        currentText = getWorkingText();
        attachFileToCurrentChannel(filename, currentText, sendImmediately);
    }

    function copyAndOpenBlueLineLogReader() {
        currentText = getWorkingText();
        void copyToClipboard(currentText)
            .then(() => showToast(t("toast.copied"), Toasts.Type.SUCCESS))
            .catch(err => {
                console.error("[VenCode] Failed to copy file contents", err);
                showToast(t("toast.copyFailed"), Toasts.Type.FAILURE);
            });

        open(BLUELINE_LOG_READER_URL, "_blank", "noopener,noreferrer");
    }

    const renderMonacoEditor = async () => {
        monacoText = currentText;
        monacoReady = false;

        const editorWrap = document.createElement("div");
        editorWrap.style.position = "relative";
        editorWrap.style.width = "100%";
        editorWrap.style.height = "100%";
        editorWrap.style.background = "#1e1e1e";
        editorWrap.style.overflow = "hidden";

        const loading = document.createElement("div");
        loading.className = "vc-vencode-monaco-loading";
        loading.textContent = t("viewer.loading");
        loading.style.position = "absolute";
        loading.style.inset = "0";
        loading.style.display = "flex";
        loading.style.alignItems = "center";
        loading.style.justifyContent = "center";
        loading.style.background = bgSecondary;
        loading.style.color = textMuted;
        loading.style.fontSize = "13px";
        loading.style.zIndex = "1";

        const iframe = document.createElement("iframe");
        iframe.title = "VenCode Monaco Editor";
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.border = "0";
        iframe.style.display = "block";
        iframe.style.background = "#1e1e1e";
        iframe.setAttribute("allow", "clipboard-read; clipboard-write");

        monacoFrame = iframe;
        editorWrap.appendChild(iframe);
        editorWrap.appendChild(loading);
        content.replaceChildren(editorWrap);

        const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue("--background-primary").trim() || "#1e1f22";
        const isLightTheme = isLightCssColor(backgroundColor);
        const monacoThemeConfig = await getMonacoThemeConfig(monacoEditorTheme ?? MONACO_THEME_AUTO, isLightTheme, customMonacoThemeJson);
        if (didCleanup || monacoFrame !== iframe) return;

        const sendInit = () => {
            if (monacoFrame !== iframe) return;

            const inferredLanguage = inferLanguage(filename, monacoText);
            postMonacoMessage({
                type: "init",
                value: monacoText,
                language: getMonacoLanguage(inferredLanguage),
                textMateLanguage: inferredLanguage,
                enableTextMateGrammar: Boolean(monacoThemeConfig.useTextMateGrammar),
                isLightTheme,
                theme: monacoThemeConfig.theme,
                themeData: monacoThemeConfig.themeData,
                showLineNumbers: Boolean(showEditorLineNumbers),
                enableMinimap: monacoText.length < 250_000 && getLineCount(monacoText) < 5_000,
                maxHighlightedMatches: 2_500,
                shortcuts: {
                    insert: "CTRL + I",
                    insertAndSend: "CTRL + ENTER",
                    save: "CTRL + S"
                },
                closeOnShift: false
            });
        };

        iframe.addEventListener("load", sendInit);
        iframe.srcdoc = createMonacoFrameHtml();
        updateStats();
    };

    const onMonacoMessage = (event: MessageEvent) => {
        if (!monacoFrame || event.source !== monacoFrame.contentWindow) return;

        const message = event.data as Record<string, unknown> | null;
        if (!message || message.source !== MONACO_BRIDGE_SOURCE) return;

        if (typeof message.value === "string") {
            monacoText = message.value;
        }

        switch (message.type) {
            case "ready":
                monacoReady = true;
                content.querySelector<HTMLElement>(".vc-vencode-monaco-loading")?.remove();
                postMonacoMessage({ type: "focus" });
                updateStats();
                break;
            case "change":
                updateStats();
                break;
            case "textmate":
                if (message.status === "loading") {
                    monacoTextMateStatus = t("stats.textmate.loading");
                } else if (message.enabled) {
                    monacoTextMateStatus = t("stats.textmate.enabled", {
                        language: typeof message.language === "string" ? message.language : ""
                    });
                    console.info("[VenCode] TextMate tokenizer enabled", message);
                } else {
                    monacoTextMateStatus = t("stats.textmate.failed");
                    console.warn("[VenCode] TextMate tokenizer disabled", message);
                }
                updateStats();
                break;
            case "action":
                switch (message.action) {
                    case "insert":
                        runInsertAction(false);
                        break;
                    case "insertAndSend":
                        runInsertAction(true);
                        break;
                    case "save":
                        copyAndOpenBlueLineLogReader();
                        break;
                    case "close":
                        cleanup();
                        break;
                }
                break;
            case "error":
                console.error("[VenCode] Monaco editor failed", message.message);
                content.querySelector<HTMLElement>(".vc-vencode-monaco-loading")?.remove();
                showToast(t("toast.monacoFallback"), Toasts.Type.FAILURE);
                break;
        }
    };

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            cleanup();
        }
    };

    insertActionBtn.onclick = () => runInsertAction(false);
    insertAndSendActionBtn.onclick = () => runInsertAction(true);
    saveActionBtn.onclick = copyAndOpenBlueLineLogReader;
    closeBtn.onclick = cleanup;

    overlay.addEventListener("mousedown", event => {
        overlayMouseDownStartedOnBackdrop = event.target === overlay;
        overlayMouseUpEndedOnBackdrop = false;
    });
    overlay.addEventListener("mouseup", event => {
        overlayMouseUpEndedOnBackdrop = event.target === overlay;
    });
    overlay.addEventListener("click", event => {
        if (event.target === overlay && overlayMouseDownStartedOnBackdrop && overlayMouseUpEndedOnBackdrop) {
            cleanup();
        }

        overlayMouseDownStartedOnBackdrop = false;
        overlayMouseUpEndedOnBackdrop = false;
    });

    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("message", onMonacoMessage);

    header.appendChild(title);
    header.appendChild(insertActionBtn);
    header.appendChild(insertAndSendActionBtn);
    header.appendChild(saveActionBtn);
    header.appendChild(closeBtn);

    box.appendChild(header);
    box.appendChild(stats);
    box.appendChild(content);
    overlay.appendChild(box);
    (overlay as { vcCleanup?: () => void; }).vcCleanup = cleanup;
    document.body.appendChild(overlay);

    void renderMonacoEditor();
}


function getFullFileUrlsFromButton(button: HTMLButtonElement, fileName: string, attachmentUrl?: string | null): string[] {
    const lowerName = fileName.toLowerCase();
    const attachmentRoot = button.closest("[class*=attachment]") ?? button.closest("[class*=container]") ?? button.parentElement;
    const getCandidatesFrom = (root: ParentNode) => {
        return Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
            .map(link => link.href)
            .filter(Boolean)
            .filter(href => href.includes("/attachments/") || href.toLowerCase().includes(lowerName));
    };

    const localCandidates = getCandidatesFrom((attachmentRoot ?? document) as ParentNode);
    const baseCandidates = localCandidates.length ? localCandidates : getCandidatesFrom(document);

    const prioritizedCandidates = attachmentUrl ? [attachmentUrl, ...baseCandidates] : baseCandidates;
    const sorted = [...prioritizedCandidates].sort((a, b) => {
        const aExact = isExactFileUrl(a, lowerName);
        const bExact = isExactFileUrl(b, lowerName);
        return Number(bExact) - Number(aExact);
    });

    const expanded = sorted.flatMap(url => {
        const noQuery = url.split("?")[0] ?? url;
        const withDownload = url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
        return [url, noQuery, withDownload];
    });

    return Array.from(new Set(expanded));
}

async function getFullFileContents(
    button: HTMLButtonElement,
    fileName: string,
    previewContents: string,
    bytesLeft: number,
    attachmentUrl?: string | null
): Promise<string | null> {
    const candidates = getFullFileUrlsFromButton(button, fileName, attachmentUrl);
    if (!candidates.length) return null;

    let bestContent: string | null = null;

    for (const url of candidates) {
        let response: Response;
        try {
            response = await fetch(url);
        } catch {
            continue;
        }

        if (!response.ok) continue;

        let text: string;
        try {
            text = await response.text();
        } catch {
            continue;
        }

        if (!bestContent || text.length > bestContent.length) {
            bestContent = text;
        }

        if (text.replace(/\r\n/g, "\n") !== previewContents.replace(/\r\n/g, "\n")) {
            return text;
        }
    }

    if (!bestContent) return null;

    const previewNormalized = previewContents.replace(/\r\n/g, "\n");
    const bestNormalized = bestContent.replace(/\r\n/g, "\n");
    const stillLooksTruncated = bestNormalized === previewNormalized;

    return stillLooksTruncated ? null : bestContent;
}

function isExactFileUrl(url: string, lowerName: string): boolean {
    const path = url.split("?")[0]?.toLowerCase() ?? "";
    try {
        return decodeURIComponent(path).endsWith(`/${lowerName}`);
    } catch {
        return path.endsWith(`/${lowerName}`);
    }
}

function FullLogButton({ fileName, fileContents, bytesLeft, attachmentUrl }: { fileName: string, fileContents: string, bytesLeft: number, attachmentUrl?: string | null; }) {
    const [loading, setLoading] = useState(false);
    const [isDuplicate, setIsDuplicate] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    if (!isSupportedFilename(fileName)) return null;

    useEffect(() => {
        const button = buttonRef.current;
        if (!button) return;

        const attachmentRoot = button.closest("[class*=attachment]") ?? button.closest("[class*=container]") ?? button.parentElement;
        if (!attachmentRoot) return;

        const allPluginButtons = Array.from(attachmentRoot.querySelectorAll<HTMLButtonElement>("button.vc-open-full-file-button"));
        setIsDuplicate(allPluginButtons[0] !== button);
    }, []);

    if (isDuplicate) return null;

    return (
        <Tooltip text={loading ? t("viewer.loading") : t("viewer.openFullFile")}>
            {props => (
                <button
                    {...props}
                    ref={buttonRef}
                    className="vc-open-full-file-button"
                    style={{
                        marginLeft: "8px",
                        background: "transparent",
                        border: "1px solid var(--background-modifier-accent)",
                        borderRadius: "8px",
                        padding: "6px 10px",
                        cursor: loading ? "wait" : "pointer",
                        color: "var(--text-normal)"
                    }}
                    disabled={loading}
                    onClick={async event => {
                        try {
                            setLoading(true);
                            let contentToOpen = fileContents;

                            const downloadedContents = await getFullFileContents(
                                event.currentTarget,
                                fileName,
                                fileContents,
                                bytesLeft,
                                attachmentUrl
                            );

                            if (downloadedContents != null) {
                                contentToOpen = downloadedContents;
                            } else if (bytesLeft > 0) {
                                alert(t("alert.fetchFullFileFailed"));
                                return;
                            }

                            openLogModal(fileName || t("defaultLogFilename"), contentToOpen);
                        } catch (err) {
                            console.error("[VenCode]", err);
                            alert(t("alert.loadFullFileFailed"));
                        } finally {
                            setLoading(false);
                        }
                    }}
                >
                    {loading ? t("viewer.loading") : t("viewer.openFullFile")}
                </button>
            )}
        </Tooltip>
    );
}

export default definePlugin({
    name: "VenCode",
    description: "Add a text editor to Discord !",
    tags: ["Chat", "Utility"],
    settings,
    authors: [Devs.Lepoissongamer],
    id: 669191195997503491n,

    patches: [
        {
            find: "#{intl::PREVIEW_BYTES_LEFT}",
            replacement: {
                match: /fileContents:(\i),bytesLeft:(\i)\}\):null,/,
                replace: "$&$self.addOpenButton({...arguments[0],fileContents:$1,bytesLeft:$2}),"
            }
        }
    ],

    addOpenButton: ErrorBoundary.wrap((attachmentData: {
        fileName?: string,
        filename?: string,
        name?: string,
        fileContents: string,
        bytesLeft: number,
        url?: string,
        downloadUrl?: string,
        attachmentUrl?: string,
        attachment?: { filename?: string, name?: string, url?: string, downloadUrl?: string; };
    }) => {
        const { fileContents, bytesLeft } = attachmentData;
        const fileName =
            attachmentData.fileName
            ?? attachmentData.filename
            ?? attachmentData.name
            ?? attachmentData.attachment?.filename
            ?? attachmentData.attachment?.name;
        const attachmentUrl =
            attachmentData.url
            ?? attachmentData.downloadUrl
            ?? attachmentData.attachmentUrl
            ?? attachmentData.attachment?.url
            ?? attachmentData.attachment?.downloadUrl
            ?? null;

        if (!fileName || typeof fileContents !== "string") return null;
        return <FullLogButton fileName={fileName} fileContents={fileContents} bytesLeft={bytesLeft} attachmentUrl={attachmentUrl} />;
    }, { noop: true })
});
