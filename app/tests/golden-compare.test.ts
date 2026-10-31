/** The tolerant image comparison used by the golden suite (incident I-7). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { compareImages, describeComparison, MAX_CHANNEL_DIFF, MAX_DIFFERING_FRACTION } from "./golden.compare.ts";

const make = async (mutate?: (data: Buffer, width: number) => void, width = 120, height = 80) => {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 251;
  mutate?.(data, width);
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
};

describe("compareImages", () => {
  test("identical bytes: fast path, no decode needed", async () => {
    const a = await make();
    const c = await compareImages(a, Buffer.from(a));
    assert.deepEqual([c.identical, c.withinTolerance, c.differingPixels], [true, true, 0]);
    assert.equal(describeComparison(c), "identical bytes");
  });

  test("platform-style noise (+-1 on a few pixels) is within tolerance and reported, not identical", async () => {
    const expected = await make();
    const actual = await make((d) => {
      for (const i of [0, 3 * 500, 3 * 2000 + 1, 3 * 7000 + 2]) d[i] = Math.min(255, d[i]! + 1);
    });
    const c = await compareImages(actual, expected);
    assert.equal(c.identical, false);
    assert.equal(c.withinTolerance, true);
    assert.deepEqual([c.maxDiff, c.differingPixels], [1, 4]);
    assert.match(describeComparison(c), /^4 of 9600 px differ \(0\.042%\), max channel diff 1, e\.g\. \(0,0\):1/);
  });

  test("a real change fails: big local diff, or many small diffs, or a different size", async () => {
    const expected = await make();
    const hot = await compareImages(
      await make((d) => {
        d[3 * 50] = 0;
        d[3 * 50 + 1] = 0;
        d[3 * 50 + 2] = 0;
      }),
      expected,
    );
    assert.equal(hot.withinTolerance, false, "one pixel way off is not rounding");
    assert.ok(hot.maxDiff > MAX_CHANNEL_DIFF);
    const spread = await compareImages(
      await make((d) => {
        for (let i = 0; i < d.length; i += 30) d[i] = Math.min(255, d[i]! + 1);
      }),
      expected,
    );
    assert.equal(spread.withinTolerance, false, "1% of pixels differing by 1 is a systematic shift, not rounding");
    assert.ok(spread.differingPixels / spread.totalPixels > MAX_DIFFERING_FRACTION);
    const resized = await compareImages(await make(undefined, 121, 80), expected);
    assert.deepEqual([resized.sizeMismatch, resized.withinTolerance], [true, false]);
    assert.equal(describeComparison(resized), "size mismatch: got 121x80");
  });

  test("works across encodings: the same pixels as JPEG vs PNG are NOT within tolerance (lossy), as PNG vs PNG they are identical", async () => {
    const png = await make();
    const jpeg = await sharp(png).jpeg({ quality: 95 }).toBuffer();
    assert.equal((await compareImages(jpeg, png)).withinTolerance, false);
  });
});
