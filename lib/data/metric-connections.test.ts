import assert from "node:assert/strict";
import test from "node:test";

import { summarizeMetricConnections } from "./metric-connections.ts";

test("the six-metric legacy fixture reports five of six connected", () => {
  assert.deepEqual(summarizeMetricConnections(6), {
    connected: 5,
    total: 6,
  });
});

test("the connected count never exceeds the number of available metrics", () => {
  assert.deepEqual(summarizeMetricConnections(3), {
    connected: 3,
    total: 3,
  });
});
