// Live GitHub poller adapter (#16) — the credential-gated backstop that finds a
// created issue by its provenance label. Analogous to lib/ingest/github-transport
// (the thin, live-only edge over the pure core). Needs a fine-grained PAT with
// issues:read on the watch target; without it the cron uses a null poller and
// only the timeout sweep runs (webhook detection still works). This is the piece
// that goes live once the PAT lands — the reconcile core (lib/levers/reconcile)
// is already tested against a mock of the LeverPoller interface.

import type { LeverPoller, PolledIssue } from "@/lib/levers/reconcile";

/** A poller that never finds anything — used when no GITHUB_TOKEN is configured,
 *  so the cron still runs the timeout sweep without a live API call. */
export const nullPoller: LeverPoller = {
  async findIssueForToken(): Promise<PolledIssue | null> {
    return null;
  },
};

/**
 * Real poller: GitHub issue search filtered by the provenance label on the watch
 * target repo. Read-only; honors a bad response by returning null (the sweep
 * treats a miss and an error the same — try again next tick).
 */
export function createGitHubPoller(token: string, fetchImpl: typeof fetch = fetch): LeverPoller {
  return {
    async findIssueForToken(repo: string, token_label: string): Promise<PolledIssue | null> {
      const q = encodeURIComponent(`repo:${repo} label:"${token_label}" is:issue`);
      const res = await fetchImpl(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        items?: Array<{ number?: number; html_url?: string }>;
      };
      const item = body.items?.[0];
      if (!item || typeof item.number !== "number" || typeof item.html_url !== "string") {
        return null;
      }
      return { number: item.number, htmlUrl: item.html_url };
    },
  };
}
