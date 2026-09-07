import assert from "node:assert/strict";
import { modelSelectorInternals } from "../src/model-selector.js";
import type { AutoReviewConfig, ExtensionContextLike } from "../src/types.js";

const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const extendedPictographicRegex = /\p{Extended_Pictographic}/u;
const markRegex = /^\p{Mark}+$/u;

function testGraphemeWidth(segment: string): number {
  if (extendedPictographicRegex.test(segment)) return 2;
  if (markRegex.test(segment)) return 0;
  const base = segment.normalize("NFC").codePointAt(0) ?? 0;
  return (
    (base >= 0x1100 && base <= 0x115f)
    || (base >= 0x2e80 && base <= 0xa4cf)
    || (base >= 0xac00 && base <= 0xd7a3)
    || (base >= 0xf900 && base <= 0xfaff)
    || (base >= 0xff00 && base <= 0xff60)
    || (base >= 0xffe0 && base <= 0xffe6)
  ) ? 2 : 1;
}

function testVisibleWidth(text: string): number {
  const clean = text.replace(ANSI_SGR_PATTERN, "");
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    width += testGraphemeWidth(segment);
  }
  return width;
}

let truncateCalls = 0;
const piLikeTextUtils = {
  visibleWidth: testVisibleWidth,
  truncateToWidth(text: string, maxWidth: number): string {
    truncateCalls += 1;
    if (testVisibleWidth(text) <= maxWidth) return text;
    const clean = text.replace(ANSI_SGR_PATTERN, "");
    const ellipsis = "…";
    const budget = Math.max(0, maxWidth - 1);
    let result = "";
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(clean)) {
      const segmentWidth = testGraphemeWidth(segment);
      if (width + segmentWidth > budget) break;
      result += segment;
      width += segmentWidth;
    }
    return maxWidth > 0 ? `${result}${ellipsis}` : "";
  },
};

function assertFits(text: string, width: number): void {
  const fitted = modelSelectorInternals.fitLineToWidth(text, width, piLikeTextUtils);
  assert.ok(
    piLikeTextUtils.visibleWidth(fitted) <= width,
    `${JSON.stringify(fitted)} exceeds ${width} columns`,
  );
}

async function run(): Promise<void> {
  assertFits("😀😀", 3);
  assertFits("e\u0301e\u0301e\u0301", 2);
  assertFits("👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 3);
  assertFits("中文😀abc", 6);
  assertFits("\u001b[31m😀中文abcdef\u001b[0m", 8);
  assert.ok(truncateCalls >= 5, "Pi truncateToWidth-compatible helper should be used for overflowing lines");

  const config = {
    classifierModel: null,
  } as AutoReviewConfig;
  const ctx: ExtensionContextLike = {
    cwd: "/tmp/workspace",
    hasUI: true,
    mode: "tui",
    model: { provider: "current-provider", id: "current-model" },
    sessionManager: { getBranch: () => [] },
  };

  const items = [
    {
      value: "review-provider/😀😀😀e\u0301中文👨‍👩‍👧‍👦-very-long-model",
      provider: "review-provider",
      id: "😀😀😀e\u0301中文👨‍👩‍👧‍👦-very-long-model",
      name: "😀 Model e\u0301 中文 👨‍👩‍👧‍👦 with a very long display name",
    },
  ];

  const component = modelSelectorInternals.createSelectorComponent(
    { requestRender: () => {} },
    items,
    ctx,
    config,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text },
    {},
    piLikeTextUtils,
    () => {},
  ) as { render: (width: number) => string[] };

  const rendered = component.render(20);
  assert.ok(rendered.length > 0);
  for (const line of rendered) {
    assert.ok(
      piLikeTextUtils.visibleWidth(line) <= 20,
      `rendered line exceeds Pi-style width: ${JSON.stringify(line)}`,
    );
  }
  assert.equal(piLikeTextUtils.visibleWidth(rendered[0]), 20);
  assert.equal(piLikeTextUtils.visibleWidth(rendered.at(-1) ?? ""), 20);

  console.log("[PASS] model selector uses Pi-compatible width helpers for emoji, combining marks, ZWJ emoji, CJK, and ANSI text");
  console.log("[PASS] narrow selector render keeps every row within terminal width");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
