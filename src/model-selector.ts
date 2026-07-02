import type { AutoReviewConfig, ExtensionContextLike } from "./types.js";

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
  done: (value: string | null | undefined) => void,
) {
  const currentRef = selectedModelRef(config, ctx.model);
  const allItems: ModelItem[] = [
    { value: null, provider: "auto-review", id: "current", name: "Use active Pi session model" },
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

  const render = (): string[] => {
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
      return render().map((line) => (line === style(theme, "border", "─".repeat(1)) ? style(theme, "border", "─".repeat(Math.max(1, width))) : line));
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

export async function selectClassifierModel(ctx: ExtensionContextLike, config: AutoReviewConfig): Promise<string | null | undefined> {
  if (ctx.mode !== undefined && ctx.mode !== "tui") {
    return selectClassifierModelFallback(ctx, config);
  }

  if (ctx.ui?.custom) {
    const items = await loadModelItems(ctx, config);
    return ctx.ui.custom<string | null | undefined>((tui: TuiLike, theme: ThemeLike, keybindings: KeybindingsLike, done: (value: string | null | undefined) => void) => (
      createSelectorComponent(tui, items, ctx, config, theme, keybindings, (value) => {
        done(value);
        tui.requestRender?.();
      })
    ));
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
};
