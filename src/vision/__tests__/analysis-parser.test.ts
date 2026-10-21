import { describe, it, expect } from "vitest";
import { parseBatchAnalysis, extractJsonArray } from "../analysis-parser.js";
import { isVisionRefusal } from "../refusal-sentinel.js";

const el = (i: number, extra: Record<string, unknown> = {}) => ({
  i,
  type: "screenshot",
  summary: `summary ${i}`,
  text: [`text ${i}`],
  is_chart: false,
  chart_shape: null,
  importance: "high",
  entities: ["Acme"],
  ...extra,
});

describe("parseBatchAnalysis", () => {
  it("maps elements by label index, not array position", () => {
    const raw = JSON.stringify([el(2), el(1)]);
    const out = parseBatchAnalysis(raw, 2);
    expect(out[0]?.summary).toBe("summary 1");
    expect(out[1]?.summary).toBe("summary 2");
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = "Here you go:\n```json\n" + JSON.stringify([el(1)]) + "\n```";
    expect(parseBatchAnalysis(raw, 1)[0]?.kind).toBe("screenshot");
  });

  it("nulls only the malformed element, never its siblings", () => {
    const raw = JSON.stringify([el(1), { i: 2, type: "photo" }, el(3)]);
    const out = parseBatchAnalysis(raw, 3);
    expect(out[0]).not.toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).not.toBeNull();
  });

  it("nulls BOTH copies of a duplicated index (the model lost track)", () => {
    const raw = JSON.stringify([el(1), el(1), el(2)]);
    const out = parseBatchAnalysis(raw, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
  });

  it("drops out-of-range indexes and leaves missing images null", () => {
    const raw = JSON.stringify([el(0), el(5), el(2)]);
    const out = parseBatchAnalysis(raw, 3);
    expect(out).toEqual([null, expect.objectContaining({ summary: "summary 2" }), null]);
  });

  it("returns all-null for unparseable output and for a bare refusal", () => {
    expect(parseBatchAnalysis("not json", 2)).toEqual([null, null]);
    expect(
      parseBatchAnalysis(
        "I don't see an image attached to your message. Please provide the image file path.",
        1,
      ),
    ).toEqual([null]);
  });

  it("nulls an element whose summary is a refusal", () => {
    const raw = JSON.stringify([el(1, { summary: "I don't see an image attached to your message." })]);
    expect(parseBatchAnalysis(raw, 1)).toEqual([null]);
  });

  it("normalizes unknown kind/importance and keeps chart shape only for charts", () => {
    const raw = JSON.stringify([
      el(1, { type: "Meme", importance: "urgent", is_chart: false, chart_shape: "up" }),
      el(2, { type: "chart", is_chart: true, chart_shape: "rising, peak in Q3" }),
    ]);
    const [a, b] = parseBatchAnalysis(raw, 2);
    expect(a).toMatchObject({ kind: "other", importance: "medium", chartShape: null });
    expect(b).toMatchObject({ kind: "chart", isChart: true, chartShape: "rising, peak in Q3" });
  });

  it("extractJsonArray returns null when there is no array", () => {
    expect(extractJsonArray("{}")).toBeNull();
  });
});

describe("isVisionRefusal", () => {
  it.each([
    "I don't see an image attached to your message. Please provide the image file path...",
    "I don't see a chart or graph attached to your message. Please provide the image or chart",
    "I don't see an image file in your message. Please provide the image path",
    "No image was attached.",
    "I cannot see any image in this conversation.",
  ])("flags the prod refusal shape: %s", (text) => {
    expect(isVisionRefusal(text)).toBe(true);
  });

  it.each([
    "TYPE: screenshot\nSUMMARY: Gmail draft to Tara about dues",
    "Chain on a Canyon road bike; rim reads PERFORMANCE LN",
    "",
  ])("does not flag real analysis: %s", (text) => {
    expect(isVisionRefusal(text)).toBe(false);
  });
});
