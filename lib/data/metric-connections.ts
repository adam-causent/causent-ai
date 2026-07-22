export type MetricConnectionSummary = {
  connected: number;
  total: number;
};

// The legacy partner fixture has five instrumented metrics. Any additional
// metric definitions are visible but not counted as connected in this view.
const LEGACY_CONNECTED_METRIC_COUNT = 5;

export function summarizeMetricConnections(
  totalMetricCount: number,
): MetricConnectionSummary {
  const total = Math.max(0, Math.floor(totalMetricCount));
  return {
    connected: Math.min(LEGACY_CONNECTED_METRIC_COUNT, total),
    total,
  };
}
