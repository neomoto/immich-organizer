import test from "node:test";
import assert from "node:assert/strict";
import {
  validateObservation,
  propose,
  DEFAULTS,
  eligible,
  unchanged,
  eventKey,
} from "../src/policy.mjs";
import { secretBox } from "../src/store.mjs";
import { analyze, lookupPlace } from "../src/vision.mjs";
const asset = {
  id: "test",
  fileCreatedAt: "2024-09-12T00:00:00Z",
  exifInfo: {
    dateTimeOriginal: "2024-09-12T00:00:00Z",
    latitude: 40,
    longitude: 20,
    description: "My description",
  },
};
const observation = () => ({
  caption: "People beside a lake.",
  objects: ["lake"],
  activities: ["walking"],
  tags: ["Outdoors"],
  ocr: ["Казахстан"],
  category: "photo",
  evidence: [{ id: "v1", kind: "visual", text: "A lake and mountain ridge" }],
  event: "Trip",
  date: {
    start: "2014-08-01",
    end: "2014-08-31",
    precision: "month",
    kind: "capture",
    confidence: "high",
    evidenceIds: ["v1"],
  },
  location: {
    name: "Almaty",
    latitude: 43.24,
    longitude: 76.89,
    precision: "city",
    kind: "capture",
    confidence: "medium",
    evidenceIds: ["v1"],
  },
});
test("validates Unicode observations and date ranges", () =>
  assert.equal(validateObservation(observation()).ocr[0], "Казахстан"));
test("rejects hallucinated provenance", () => {
  const o = observation();
  o.date.evidenceIds = ["fake"];
  assert.throws(() => validateObservation(o));
});
test("rejects impossible dates and coordinates", () => {
  let o = observation();
  o.date.start = "2024-02-31";
  assert.throws(() => validateObservation(o));
  o = observation();
  o.location.latitude = 190;
  assert.throws(() => validateObservation(o));
});
test("preserves valid existing EXIF and human description", () =>
  assert.deepEqual(propose(asset, observation()).patch, {}));
test("month inference never invents an exact date", () => {
  const p = propose({ ...asset, exifInfo: {} }, observation());
  assert.equal(p.patch.dateTimeOriginal, undefined);
});
test("a common import date alone is not proof it is wrong", () => {
  const o = observation();
  o.date.end = o.date.start;
  o.date.precision = "day";
  assert.equal(
    propose(asset, o, { facts: { captureDay: o.date.start } }).patch
      .dateTimeOriginal,
    undefined,
  );
});
test("corrects independently verified suspect dates", () => {
  const o = observation();
  o.date.end = o.date.start;
  o.date.precision = "day";
  const p = propose(asset, o, {
    original: { verified: true, fileModifiedAt: "2024-09-12" },
    facts: { captureDay: o.date.start, suspectDate: true },
  });
  assert.equal(p.patch.dateTimeOriginal, "2014-08-01T12:00:00.000Z");
});
test("depicted dates and locations do not become capture facts", () => {
  const o = observation();
  o.date.kind = o.location.kind = "depicted";
  const p = propose({ ...asset, exifInfo: {} }, o);
  assert.equal(p.patch.latitude, undefined);
  assert.equal(p.patch.dateTimeOriginal, undefined);
});
test("approximate coordinates honor preference and locks", () => {
  const a = { ...asset, exifInfo: {} };
  assert.equal(propose(a, observation()).patch.latitude, 43.24);
  assert.equal(
    propose(a, observation(), {
      settings: { ...DEFAULTS, approximatePins: false },
    }).patch.latitude,
    undefined,
  );
  assert.equal(
    propose(a, observation(), { locks: { location: true } }).patch.latitude,
    undefined,
  );
});
test("rejects overwriting a newer edit during undo", () =>
  assert.equal(unchanged(asset, { description: "Something else" }), false));
test("locked and hidden assets are excluded while timeline and archive remain eligible", () => {
  assert.equal(eligible({ visibility: "locked" }), false);
  for (const type of ["IMAGE", "VIDEO"])
    assert.equal(eligible({ visibility: "hidden", type }), false);
  assert.equal(eligible({ visibility: "timeline" }), true);
  assert.equal(eligible({ visibility: "archive" }), true);
  assert.equal(eligible({ isTrashed: true, visibility: "timeline" }), false);
  assert.equal(eligible({ isOffline: true, visibility: "timeline" }), false);
  assert.equal(eligible({ deletedAt: "2026-09-05T00:00:00.000Z", visibility: "timeline" }), false);
});
test("events do not cross owner or source groups", () => {
  const o = observation();
  assert.notEqual(
    eventKey("a", o, { group: "one" }),
    eventKey("b", o, { group: "one" }),
  );
  assert.notEqual(
    eventKey("a", o, { group: "one" }),
    eventKey("a", o, { group: "two" }),
  );
});
test("encrypted credentials authenticate ciphertext", () => {
  const box = secretBox("a".repeat(32));
  const sealed = box.seal("not-a-real-key");
  assert.equal(box.open(sealed), "not-a-real-key");
  assert.throws(() => secretBox("b".repeat(32)).open(sealed));
});
test("provider request uses image content and validates response", async () => {
  let request;
  const result = await analyze(
    ["data:image/jpeg;base64,AA=="],
    { filename: "test" },
    { base: "https://example.test/v1", model: "test", key: "fake" },
    async (url, options) => {
      request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(observation()) } }],
        }),
      );
    },
  );
  assert.equal(request.messages[1].content[1].type, "image_url");
  assert.equal(result.caption, observation().caption);
});
test("provider failures do not leak secret response bodies", async () => {
  await assert.rejects(
    () =>
      analyze(
        [],
        {},
        { base: "https://example.test", model: "test", key: "private" },
        async () => new Response("sensitive", { status: 429 }),
      ),
    (e) => e.message === "Vision provider HTTP 429" && e.retryable,
  );
});
test("web lookup uses a fixed public endpoint", async () => {
  let used;
  await lookupPlace("test", async (url) => {
    used = url;
    return new Response('{"query":{"pages":{}}}');
  });
  assert.equal(used.hostname, "en.wikipedia.org");
});
