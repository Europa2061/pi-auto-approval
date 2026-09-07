import type { AutoReviewConfig, ExtensionContextLike } from "./types.js";

const ANSI_SGR_PATTERN = /(\x1b\[[0-9;]*m)/g;

/**
 * @deprecated Compatibility helper retained for existing tests/consumers.
 * Production selector rendering uses Pi TUI's own width utilities instead.
 */
export function columnWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x20000 && code <= 0x2fffd)
    || (code >= 0x30000 && code <= 0x3fffd)
  ) ? 2 : 1;
}

/** @deprecated See columnWidth(). */
export function visibleWidthOf(line: string): number {
  let width = 0;
  const parts = line.split(ANSI_SGR_PATTERN);
  for (let i = 0; i < parts.length; i += 2) {
    for (const char of parts[i]) {
      width += columnWidth(char);
    }
  }
  return width;
}

/** @deprecated See columnWidth(). Production rendering does not call this. */
export function truncateVisible(line: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (visibleWidthOf(line) <= maxWidth) {
    return line;
  }
  const ellipsis = "...";
  const ellipsisWidth = 3;
  const textBudget = ellipsisWidth < maxWidth ? maxWidth - ellipsisWidth : maxWidth;
  const parts = line.split(ANSI_SGR_PATTERN);
  let result = "";
  let visible = 0;
  let usedAnsi = false;
  let truncated = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) {
      usedAnsi = true;
      result += part;
      continue;
    }
    for (const char of part) {
      const width = columnWidth(char);
      if (visible + width > textBudget) {
        truncated = true;
        break;
      }
      result += char;
      visible += width;
    }
    if (truncated) {
      break;
    }
  }
  if (!truncated) {
    return result;
  }
  if (ellipsisWidth < maxWidth) {
    return usedAnsi ? `${result}\x1b[0m${ellipsis}` : `${result}${ellipsis}`;
  }
  return usedAnsi ? `${result}\x1b[0m` : result;
}

type ThemeLike = {
  fg?: (name: string, text: string) => string;
  bold?: (text: string) => string;
};

type KeybindingsLike = {
  matches?: (data: string, key: string) => boolean;
};

type TuiLike = {
  requestRender?: () => void;
};

type TuiTextUtils = {
  visibleWidth: (text: string) => number;
  truncateToWidth: (text: string, maxWidth: number) => string;
};

type ModelRecord = {
  provider?: string;
  id?: string;
  name?: string;
};

type ModelItem = {
  value: string | null;
  provider: string;
  id: string;
  name?: string;
  model?: unknown;
};

const TUI_PACKAGE_CANDIDATES = [
  "@oh-my-pi/pi-tui",
  "@earendil-works/pi-tui",
] as const;

function normalizeRenderWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
}

function toTuiTextUtils(moduleValue: unknown): TuiTextUtils | null {
  if (!moduleValue || typeof moduleValue !== "object") {
    return null;
  }
  const record = moduleValue as Record<string, unknown>;
  if (typeof record.visibleWidth !== "function" || typeof record.truncateToWidth !== "function") {
    return null;
  }
  return {
    visibleWidth: record.visibleWidth as TuiTextUtils["visibleWidth"],
    truncateToWidth: record.truncateToWidth as TuiTextUtils["truncateToWidth"],
  };
}

function fallbackPlainText(text: string): string {
  return text.replace(ANSI_SGR_PATTERN, "").replace(/[^\x20-\x7e]/gu, "?");
}

const safeFallbackTextUtils: TuiTextUtils = {
  visibleWidth(text: string): number {
    const withoutSgr = text.replace(ANSI_SGR_PATTERN, "");
    return /^[\x20-\x7e]*$/.test(withoutSgr) ? withoutSgr.length : Number.POSITIVE_INFINITY;
  },
  truncateToWidth(text: string, maxWidth: number): string {
    const width = Math.max(0, Math.trunc(maxWidth));
    if (width === 0) return "";
    const plain = fallbackPlainText(text);
    const ellipsis = width >= 4 ? "..." : "";
    const budget = Math.max(0, width - ellipsis.length);
    return `${plain.slice(0, budget)}${ellipsis}`.slice(0, width);
  },
};

async function loadTuiTextUtils(): Promise<TuiTextUtils> {
  const loaded: TuiTextUtils[] = [];
  for (const packageName of TUI_PACKAGE_CANDIDATES) {
    try {
      const moduleValue = await import(packageName);
      const textUtils = toTuiTextUtils(moduleValue);
      if (textUtils) {
        loaded.push(textUtils);
      }
    } catch {
      // The extension supports both Pi package scopes; normally only the
      // active runtime's TUI package is resolvable.
    }
  }

  // Use Pi's exact width engine when it is unambiguous. Otherwise preserve the
  // custom selector with an ASCII-only fallback that cannot underestimate
  // terminal width: non-ASCII/control content is converted to printable ASCII
  // before truncation instead of guessing Unicode cell widths.
  return loaded.length === 1 ? loaded[0] : safeFallbackTextUtils;
}

function fitLineToWidth(line: string, width: number, textUtils: TuiTextUtils): string {
  const maxWidth = normalizeRenderWidth(width);
  return textUtils.visibleWidth(line) <= maxWidth
    ? line
    : textUtils.truncateToWidth(line, maxWidth);
}

function style(theme: ThemeLike, name: string, text: string): string {
  return theme.fg?.(name, text) ?? text;
}

function modelLabel(model: unknown): string | null {
  if (!model || typeof model !== "object") {
    return null;
  }
  const record = model as ModelRecord;
  const provider = typeof record.provider === "string" ? record.provider : "";
  const id = typeof record.id === "string" ? record.id : "";
  return provider && id ? `${provider}/${id}` : id || null;
}

function searchText(item: ModelItem): string {
  const name = item.name ? ` ${item.name}` : "";
  return `${item.id} ${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`.toLowerCase();
}

function fuzzyMatches(text: string, query: string): boolean {
  let position = 0;
  for (const char of query.toLowerCase()) {
    position = text.indexOf(char, position);
    if (position < 0) {
      return false;
    }
    position += 1;
  }
  return true;
}

function normalizeModel(model: unknown): ModelItem | null {
  if (!model || typeof model !== "object") {
    return null;
  }
  const record = model as ModelRecord;
  if (typeof record.id !== "string") {
    return null;
  }
  const provider = typeof record.provider === "string" ? record.provider : "";
  const value = provider ? `${provider}/${record.id}` : record.id;
  return {
    value,
    provider,
    id: record.id,
    name: typeof record.name === "string" ? record.name : undefined,
    model,
  };
}

function selectedModelRef(config: AutoReviewConfig, currentModel: unknown): string | null {
  return config.classifierModel ?? modelLabel(currentModel);
}

function sortModels(models: ModelItem[], currentRef: string | null): ModelItem[] {
  const sorted = [...models];
  sorted.sort((a, b) => {
    const aIsCurrent = a.value === currentRef;
    const bIsCurrent = b.value === currentRef;
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
  return sorted;
}

function keyMatches(keybindings: KeybindingsLike, data: string, key: string, fallback: string[]): boolean {
  return keybindings.matches?.(data, key) ?? fallback.includes(data);
}

async function loadModelItems(ctx: ExtensionContextLike, config: AutoReviewConfig): Promise<ModelItem[]> {
  ctx.modelRegistry?.refresh?.();
  const available = await Promise.resolve(ctx.modelRegistry?.getAvailable?.() ?? []);
  const currentRef = selectedModelRef(config, ctx.model);
  return sortModels(available.map(normalizeModel).filter((item): item is ModelItem => Boolean(item)), currentRef);
}

function renderSearchInput(query: string, focused: boolean): string {
  const cursor = focused ? "█" : "";
  return `Search: ${query}${cursor}`;
}

function createSelectorComponent(
  tui: TuiLike,
  items: ModelItem[],
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  textUtils: TuiTextUtils,
  done: (value: string | null | undefined) => void,
) {
  const currentRef = selectedModelRef(config, ctx.model);
  const allItems: ModelItem[] = [
    { value: null, provider: "auto-approval", id: "current", name: "Use active Pi session model" },
    ...items,
  ];
  let query = "";
  let selectedIndex = Math.max(0, allItems.findIndex((item) => item.value === config.classifierModel));
  let filtered = allItems;
  let focused = false;

  const filter = () => {
    filtered = query ? allItems.filter((item) => fuzzyMatches(searchText(item), query)) : allItems;
    selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
  };

  const select = () => {
    const selected = filtered[selectedIndex];
    if (selected) {
      done(selected.value);
    }
  };

  const renderLines = (): string[] => {
    const lines: string[] = [];
    lines.push(style(theme, "border", "─".repeat(1)));
    lines.push("");
    lines.push(style(theme, "warning", "Only showing models from configured providers. Use /login to add providers."));
    lines.push("");
    lines.push(renderSearchInput(query, focused));
    lines.push("");

    const maxVisible = 10;
    const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, filtered.length);

    for (let i = startIndex; i < endIndex; i += 1) {
      const item = filtered[i];
      if (!item) continue;
      const isSelected = i === selectedIndex;
      const isCurrent = item.value === config.classifierModel || (config.classifierModel === null && item.value === null);
      const modelText = `${isSelected ? "→ " : "  "}${item.id}`;
      const providerBadge = style(theme, "muted", `[${item.provider}]`);
      const checkmark = isCurrent || item.value === currentRef ? style(theme, "success", " ✓") : "";
      lines.push(isSelected ? `${style(theme, "accent", modelText)} ${providerBadge}${checkmark}` : `${modelText} ${providerBadge}${checkmark}`);
    }

    if (startIndex > 0 || endIndex < filtered.length) {
      lines.push(style(theme, "muted", `  (${selectedIndex + 1}/${filtered.length})`));
    }

    if (filtered.length === 0) {
      lines.push(style(theme, "muted", "  No matching models"));
    } else {
      const selected = filtered[selectedIndex];
      lines.push("");
      lines.push(style(theme, "muted", `  Model Name: ${selected?.name ?? selected?.id ?? ""}`));
    }

    lines.push("");
    lines.push(style(theme, "muted", "↑↓ navigate • enter select • esc cancel"));
    lines.push(style(theme, "border", "─".repeat(1)));
    return lines;
  };

  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
    },
    render(width: number) {
      const safeWidth = normalizeRenderWidth(width);
      const lines = renderLines();
      const border = style(theme, "border", "─".repeat(safeWidth));
      return lines.map((line, index) => {
        if (index === 0 || index === lines.length - 1) {
          return border;
        }
        return fitLineToWidth(line, safeWidth, textUtils);
      });
    },
    invalidate() {},
    handleInput(data: string) {
      let changed = true;
      if (keyMatches(keybindings, data, "tui.select.up", ["\u001b[A"])) {
        if (filtered.length > 0) {
          selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
        }
      } else if (keyMatches(keybindings, data, "tui.select.down", ["\u001b[B"])) {
        if (filtered.length > 0) {
          selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
        }
      } else if (keyMatches(keybindings, data, "tui.select.confirm", ["\n", "\r"])) {
        select();
      } else if (keyMatches(keybindings, data, "tui.select.cancel", ["\u001b", "\u0003"])) {
        done(undefined);
      } else if (data === "\u007f" || data === "\b") {
        query = query.slice(0, -1);
        selectedIndex = 0;
        filter();
      } else if (!data.startsWith("\u001b") && data >= " ") {
        query += data;
        selectedIndex = 0;
        filter();
      } else {
        changed = false;
      }
      if (changed) {
        tui.requestRender?.();
      }
    },
  };
}

async function selectClassifierModelWithTextUtils(
  ctx: ExtensionContextLike,
  config: AutoReviewConfig,
  textUtils: TuiTextUtils,
): Promise<string | null | undefined> {
  const items = await loadModelItems(ctx, config);
  return ctx.ui?.custom?.<string | null | undefined>((tui: TuiLike, theme: ThemeLike, keybindings: KeybindingsLike, done: (value: string | null | undefined) => void) => (
    createSelectorComponent(tui, items, ctx, config, theme, keybindings, textUtils, (value) => {
      done(value);
      tui.requestRender?.();
    })
  ));
}

export async function selectClassifierModel(ctx: ExtensionContextLike, config: AutoReviewConfig): Promise<string | null | undefined> {
  if (ctx.mode !== undefined && ctx.mode !== "tui") {
    return selectClassifierModelFallback(ctx, config);
  }

  if (ctx.ui?.custom) {
    const textUtils = await loadTuiTextUtils();
    return selectClassifierModelWithTextUtils(ctx, config, textUtils);
  }

  return selectClassifierModelFallback(ctx, config);
}

async function selectClassifierModelFallback(ctx: ExtensionContextLike, config: AutoReviewConfig): Promise<string | null | undefined> {
  if (!ctx.ui?.select) {
    ctx.ui?.notify?.(`approval classifier model: ${config.classifierModel ?? "current"}`);
    return undefined;
  }

  const labels = (await loadModelItems(ctx, config))
    .map((item) => item.value)
    .filter((label): label is string => Boolean(label));
  const selected = await ctx.ui.select(
    [
      "Select approval classifier model",
      "",
      `Current setting: ${config.classifierModel ?? "current"}`,
      "",
      "Interactive Pi TUI uses the /model-style searchable selector.",
    ].join("\n"),
    ["current", ...labels],
  );
  return selected === "current" ? null : selected;
}

export const modelSelectorInternals = {
  fuzzyMatches,
  modelLabel,
  normalizeModel,
  sortModels,
  truncateVisible,
  visibleWidthOf,
  columnWidth,
  fitLineToWidth,
  createSelectorComponent,
  selectClassifierModelWithTextUtils,
  loadTuiTextUtils,
  safeFallbackTextUtils,
};
