/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(() => {
    const SOURCE = "vencode-monaco";
    const MONACO_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs";
    const TEXTMATE_GRAMMAR_BASE = "https://cdn.jsdelivr.net/gh/shikijs/textmate-grammars-themes@bc5436518111d87ea58eb56d97b3f9bec30e6b83/packages/tm-grammars/grammars";
    const TEXTMATE_LANGUAGE_INDEX = "https://cdn.jsdelivr.net/gh/Vencord/ShikiPluginAssets@75d69df9fdf596a31eef8b7f6f891231a6feab44/grammars.json";
    const TEXTMATE_DISABLED_LANGUAGES = new Set(["plaintext", "text"]);
    const TEXTMATE_LANGUAGE_OVERRIDES = {
        css: { id: "css", scopeName: "source.css" },
        html: { id: "html", scopeName: "text.html.basic" },
        javascript: { id: "javascript", scopeName: "source.js" },
        json: { id: "json", scopeName: "source.json" },
        markdown: { id: "markdown", scopeName: "text.html.markdown" },
        shell: { id: "shellscript", scopeName: "source.shell" },
        typescript: { id: "typescript", scopeName: "source.ts" },
        xml: { id: "xml", scopeName: "text.xml" },
        yaml: { id: "yaml", scopeName: "source.yaml" }
    };
    const post = message => parent.postMessage(Object.assign({ source: SOURCE }, message), "*");

    let config = null;
    let editor = null;
    let creatingEditor = false;
    let searchDecorations = null;
    let searchQuery = "";
    let searchMatches = [];
    let activeSearchIndex = -1;
    let textMateLanguageIndexPromise = null;
    let textMateRegistryPromise = null;
    const textMateGrammarCache = new Map();
    const textMateTokenProviders = new Map();

    function normalizeShortcutKey(key) {
        const lower = String(key || "").trim().toLowerCase();
        if (lower === "return") return "enter";
        if (lower === "esc") return "escape";
        if (lower === "spacebar" || lower === " ") return "space";
        return lower;
    }

    function parseShortcut(shortcut) {
        const parts = String(shortcut || "")
            .split("+")
            .map(part => part.trim())
            .filter(Boolean);
        if (!parts.length) return null;

        const spec = { alt: false, ctrl: false, meta: false, shift: false, key: "" };
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

    function eventMatchesShortcut(event, shortcut, allowExtraShift) {
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

    function stopShortcutEvent(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }

    function postAction(action, event) {
        post({
            type: "action",
            action,
            value: editor ? editor.getValue() : "",
            shiftKey: Boolean(event && event.shiftKey)
        });
    }

    function updateSearch(query, direction) {
        if (!editor || !searchDecorations) return;

        searchQuery = query || "";
        const model = editor.getModel();
        if (!model || !searchQuery) {
            searchMatches = [];
            activeSearchIndex = -1;
            searchDecorations.clear();
            post({ type: "search", matchCount: 0, activeMatchIndex: -1 });
            return;
        }

        searchMatches = model.findMatches(searchQuery, true, false, false, null, false, config?.maxHighlightedMatches || 2500);
        if (!searchMatches.length) {
            activeSearchIndex = -1;
        } else if (direction === "next") {
            activeSearchIndex = (activeSearchIndex + 1 + searchMatches.length) % searchMatches.length;
        } else if (direction === "previous") {
            activeSearchIndex = (activeSearchIndex - 1 + searchMatches.length) % searchMatches.length;
        } else if (activeSearchIndex < 0 || activeSearchIndex >= searchMatches.length) {
            activeSearchIndex = 0;
        }

        searchDecorations.set(searchMatches.map((match, index) => ({
            range: match.range,
            options: {
                inlineClassName: index === activeSearchIndex ? "vc-monaco-search-active" : "vc-monaco-search-hit"
            }
        })));

        if ((direction === "next" || direction === "previous") && activeSearchIndex !== -1) {
            const { range } = searchMatches[activeSearchIndex];
            editor.setSelection(range);
            editor.revealRangeInCenter(range);
            editor.focus();
        }

        post({
            type: "search",
            matchCount: searchMatches.length,
            activeMatchIndex: activeSearchIndex
        });
    }

    function postChange() {
        if (!editor) return;
        const model = editor.getModel();
        const value = editor.getValue();
        post({
            type: "change",
            value,
            characters: value.length,
            lineCount: model ? model.getLineCount() : value.split("\n").length
        });
    }

    function normalizeTextMateLanguageId(language) {
        return String(language || "")
            .trim()
            .toLowerCase()
            .replace(/^\./, "");
    }

    function getTextMateRuntime() {
        if (!window.vscodetextmate || !window.onig) {
            throw new Error("TextMate runtime is unavailable");
        }

        return {
            onig: window.onig,
            textmate: window.vscodetextmate
        };
    }

    function base64ToUint8Array(base64) {
        const binary = atob(String(base64 || ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return bytes;
    }

    function getTextMateLanguageIndex() {
        if (!textMateLanguageIndexPromise) {
            textMateLanguageIndexPromise = fetch(TEXTMATE_LANGUAGE_INDEX)
                .then(response => response.ok ? response.json() : [])
                .then(languages => Array.isArray(languages) ? languages : [])
                .then(languages => languages
                    .filter(language => language && language.name && language.scopeName)
                    .map(language => ({
                        aliases: [
                            language.name,
                            language.displayName,
                            ...(Array.isArray(language.aliases) ? language.aliases : [])
                        ].map(normalizeTextMateLanguageId).filter(Boolean),
                        id: language.name,
                        scopeName: language.scopeName
                    })));
        }

        return textMateLanguageIndexPromise;
    }

    async function resolveTextMateLanguage(...languageIds) {
        const candidates = new Set(languageIds.map(normalizeTextMateLanguageId).filter(Boolean));
        if (!candidates.size) return null;

        for (const candidate of candidates) {
            const override = TEXTMATE_LANGUAGE_OVERRIDES[candidate];
            if (override) return override;
        }

        const languages = await getTextMateLanguageIndex();
        return languages.find(language => {
            if (candidates.has(normalizeTextMateLanguageId(language.id))) return true;
            if (candidates.has(normalizeTextMateLanguageId(language.scopeName))) return true;
            return language.aliases.some(alias => candidates.has(alias));
        }) || null;
    }

    async function loadTextMateGrammarByScope(scopeName) {
        if (textMateGrammarCache.has(scopeName)) {
            return textMateGrammarCache.get(scopeName);
        }

        const language = await resolveTextMateLanguage(scopeName);
        if (!language) return null;

        const grammarUrl = `${TEXTMATE_GRAMMAR_BASE}/${language.id}.json`;
        const rawGrammarText = await fetch(grammarUrl).then(response => response.ok ? response.text() : null);
        if (!rawGrammarText) return null;

        const { textmate } = getTextMateRuntime();
        const rawGrammar = textmate.parseRawGrammar(rawGrammarText, grammarUrl);
        textMateGrammarCache.set(scopeName, rawGrammar);
        return rawGrammar;
    }

    function getTextMateRegistry() {
        if (!textMateRegistryPromise) {
            textMateRegistryPromise = (async () => {
                const { onig, textmate } = getTextMateRuntime();
                const wasmUrl = document.body?.dataset?.vencodeOnigurumaWasmUrl;
                const wasmBase64 = window.VENCODE_ONIGURUMA_WASM_BASE64;
                if (!wasmBase64 && !wasmUrl) throw new Error("Oniguruma WASM data is missing");

                await onig.loadWASM(wasmBase64
                    ? { data: base64ToUint8Array(wasmBase64) }
                    : fetch(wasmUrl));
                const registry = new textmate.Registry({
                    loadGrammar: loadTextMateGrammarByScope,
                    onigLib: Promise.resolve({
                        createOnigScanner: sources => new onig.OnigScanner(sources),
                        createOnigString: value => new onig.OnigString(value)
                    })
                });

                return { registry, textmate };
            })();
        }

        return textMateRegistryPromise;
    }

    function TextMateState(ruleStack) {
        this.ruleStack = ruleStack || null;
    }

    TextMateState.prototype.clone = function () {
        return new TextMateState(this.ruleStack?.clone ? this.ruleStack.clone() : this.ruleStack);
    };

    TextMateState.prototype.equals = function (other) {
        if (!other || !(other instanceof TextMateState)) return false;
        return this.ruleStack === other.ruleStack
            || Boolean(this.ruleStack?.equals && this.ruleStack.equals(other.ruleStack));
    };

    function normalizeThemeScope(scope) {
        const parts = String(scope || "").split(".");
        if (parts.length < 3) return scope || "";

        const languageIds = [
            config?.language,
            config?.textMateLanguage,
            "bat",
            "css",
            "html",
            "ini",
            "js",
            "json",
            "jsx",
            "shell",
            "sh",
            "ts",
            "tsx",
            "xml",
            "yaml",
            "yml"
        ].map(normalizeTextMateLanguageId).filter(Boolean);
        const lastPart = normalizeTextMateLanguageId(parts[parts.length - 1]);

        return languageIds.includes(lastPart)
            ? parts.slice(0, -1).join(".")
            : scope;
    }

    function getBestTextMateScope(scopes) {
        for (let i = scopes.length - 1; i >= 0; i--) {
            const scope = scopes[i];
            if (scope && !scope.startsWith("source.") && !scope.startsWith("text.")) {
                return normalizeThemeScope(scope);
            }
        }

        return normalizeThemeScope(scopes[scopes.length - 1] || "");
    }

    function createTextMateTokensProvider(grammar) {
        return {
            getInitialState: () => new TextMateState(null),
            tokenize: (line, state) => {
                const result = grammar.tokenizeLine(line, state?.ruleStack || null);
                return {
                    endState: new TextMateState(result.ruleStack),
                    tokens: result.tokens.map(token => ({
                        startIndex: token.startIndex,
                        scopes: getBestTextMateScope(token.scopes)
                    }))
                };
            }
        };
    }

    function sampleTextMateScopes(grammar) {
        const sampleLine = String(config?.value || "")
            .split("\n")
            .find(line => line.trim())
            || "<root attr=\"value\">text</root>";
        const result = grammar.tokenizeLine(sampleLine, null);

        return result.tokens
            .slice(0, 8)
            .map(token => getBestTextMateScope(token.scopes))
            .filter(Boolean);
    }

    function retokenizeModel(language) {
        const model = editor?.getModel();
        if (!model || !language || language === "plaintext") return;

        monaco.editor.setModelLanguage(model, "plaintext");
        monaco.editor.setModelLanguage(model, language);
    }

    function applyTextMateProvider(languageId, language, grammar) {
        const existingProvider = textMateTokenProviders.get(languageId);
        existingProvider?.disposable?.dispose?.();
        textMateTokenProviders.set(languageId, {
            disposable: monaco.languages.setTokensProvider(languageId, createTextMateTokensProvider(grammar)),
            scopeName: language.scopeName
        });

        retokenizeModel(languageId);
    }

    async function enableTextMateTokenizer() {
        if (!config?.enableTextMateGrammar || !config?.language || TEXTMATE_DISABLED_LANGUAGES.has(config.language)) return;

        try {
            post({ type: "textmate", status: "loading" });
            const language = await resolveTextMateLanguage(config.textMateLanguage, config.language);
            if (!language) {
                post({ type: "textmate", enabled: false, status: "missing-language", message: `No TextMate grammar found for ${config.textMateLanguage || config.language}` });
                return;
            }

            const { registry } = await getTextMateRegistry();
            const grammar = await registry.loadGrammar(language.scopeName);
            if (!grammar) {
                post({ type: "textmate", enabled: false, status: "missing-grammar", message: `Unable to load ${language.scopeName}` });
                return;
            }

            applyTextMateProvider(config.language, language, grammar);
            window.setTimeout(() => applyTextMateProvider(config.language, language, grammar), 250);
            window.setTimeout(() => applyTextMateProvider(config.language, language, grammar), 1000);
            post({ type: "textmate", enabled: true, status: "enabled", language: language.id, sampleScopes: sampleTextMateScopes(grammar), scopeName: language.scopeName });
        } catch (err) {
            console.warn("[VenCode] TextMate tokenizer failed", err);
            post({ type: "textmate", enabled: false, status: "error", message: String(err && (err.message || err)) });
        }
    }

    function getEditorTheme() {
        if (config?.theme && config?.themeData) {
            monaco.editor.defineTheme(config.theme, config.themeData);
            return config.theme;
        }

        return config?.theme || (config?.isLightTheme ? "vs" : "vs-dark");
    }

    function createEditor() {
        if (!config || editor || creatingEditor || !window.monaco) return;
        creatingEditor = true;

        const container = document.getElementById("container");
        editor = monaco.editor.create(container, {
            value: config.value || "",
            language: config.language || "plaintext",
            theme: getEditorTheme(),
            automaticLayout: true,
            lineNumbers: config.showLineNumbers ? "on" : "off",
            glyphMargin: true,
            folding: true,
            foldingStrategy: "auto",
            links: true,
            matchBrackets: "always",
            minimap: { enabled: Boolean(config.enableMinimap) },
            overviewRulerLanes: 3,
            renderLineHighlight: "all",
            renderWhitespace: "selection",
            roundedSelection: false,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            stickyScroll: { enabled: true },
            wordWrap: "off",
            bracketPairColorization: { enabled: true },
            guides: {
                bracketPairs: true,
                indentation: true
            },
            fontFamily: "var(--font-code, Consolas, 'Courier New', monospace)",
            fontSize: 13,
            tabSize: 4,
            insertSpaces: true
        });

        searchDecorations = editor.createDecorationsCollection();
        editor.onDidChangeModelContent(() => {
            postChange();
            updateSearch(searchQuery, "keep");
        });

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
            editor.getAction("actions.find")?.run();
        });

        window.addEventListener("keydown", event => {
            const shortcuts = config?.shortcuts || {};
            const allowShift = Boolean(config?.closeOnShift);

            if (eventMatchesShortcut(event, shortcuts.save, allowShift)) {
                stopShortcutEvent(event);
                postAction("save", event);
                return;
            }

            if (eventMatchesShortcut(event, shortcuts.insertAndSend, allowShift)) {
                stopShortcutEvent(event);
                postAction("insertAndSend", event);
                return;
            }

            if (eventMatchesShortcut(event, shortcuts.insert, allowShift)) {
                stopShortcutEvent(event);
                postAction("insert", event);
                return;
            }

            if (event.key === "Escape") {
                postAction("close", event);
            }
        }, true);

        postChange();
        post({ type: "ready" });
        creatingEditor = false;
        void enableTextMateTokenizer();
        editor.focus();
    }

    window.addEventListener("message", event => {
        const message = event.data;
        if (!message || message.source !== SOURCE) return;

        if (message.type === "init") {
            config = message;
            createEditor();
            return;
        }

        if (!editor) return;

        if (message.type === "setSearch") {
            if (typeof message.maxHighlightedMatches === "number") {
                config.maxHighlightedMatches = message.maxHighlightedMatches;
            }
            updateSearch(message.query || "", "set");
        } else if (message.type === "nextSearch") {
            updateSearch(searchQuery, "next");
        } else if (message.type === "previousSearch") {
            updateSearch(searchQuery, "previous");
        } else if (message.type === "focus") {
            editor.focus();
        } else if (message.type === "layout") {
            editor.layout();
        }
    });

    if (!window.require) {
        post({ type: "error", message: "Monaco loader was blocked" });
        return;
    }

    require.config({ paths: { vs: MONACO_BASE } });
    require(["vs/editor/editor.main"], createEditor, err => {
        post({ type: "error", message: String(err && (err.message || err)) });
    });
})();
