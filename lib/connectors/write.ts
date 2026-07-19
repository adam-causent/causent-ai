// Write-scope create adapters (#19, the "efficient path") — GitHub + Jira.
//
// The opt-in upgrade over the read-only deep-link: with a write-scoped credential
// Causent CREATES the lever ticket itself, zero user clicks, and stamps the
// provenance so detection is immediate. GitHub carries provenance as the
// `causent-decision-<id>` label (same as the read-only path); Jira ALSO sets the
// `causent.decisionId` issue property — strategy 1, the detector's preferred
// signal — with the label as a backstop.
//
// The HTTP is behind an INJECTED transport seam (like lib/ingest/github-transport)
// so every branch is exercised against a mock with zero credentials; the live
// transports (fetch-backed, server-only) are the two files that need a real token
// to go live. Nothing here touches the DB — lib/levers/autocreate orchestrates
// draft → create → detect.

import { issueExternalRef, provenanceToken } from "./github.ts";
import { jiraIssueExternalRef, JIRA_DECISION_PROPERTY } from "./jira.ts";

export interface CreatedIssue {
  /** github:issue:<n> | jira:issue:<KEY> — stamped onto the actions row. */
  externalRef: string;
  /** The created ticket's human URL (stored on the lever payload). */
  url: string;
  /** Which provenance strategy the created ticket carries. */
  strategy: "label" | "issue_property";
}

export interface IssueCreator {
  create(input: { decisionId: string; title: string; body: string }): Promise<CreatedIssue>;
}

/** Minimal HTTP seam: a method + URL + optional JSON body → a status + body. */
export interface WriteTransport {
  request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

// ---------------------------------------------------------------------------
// GitHub write-scope creator.
// ---------------------------------------------------------------------------

export function gitHubIssueCreator(
  transport: WriteTransport,
  opts: { owner: string; repo: string },
): IssueCreator {
  return {
    async create({ decisionId, title, body }) {
      const token = provenanceToken(decisionId);
      const res = await transport.request(
        "POST",
        `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues`,
        { title, body: `${body}\n\n<!-- ${token} -->`, labels: [token] },
      );
      if (!ok(res.status)) {
        throw new Error(`GitHub issue create failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { number?: number; html_url?: string };
      if (typeof data.number !== "number") {
        throw new Error("GitHub issue create returned no issue number");
      }
      return {
        externalRef: issueExternalRef(data.number),
        url: data.html_url ?? "",
        strategy: "label",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Jira write-scope creator (create issue, then set the causent.decisionId property).
// ---------------------------------------------------------------------------

export function jiraIssueCreator(
  transport: WriteTransport,
  opts: { baseUrl: string; projectKey: string; issueTypeId: string },
): IssueCreator {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async create({ decisionId, title, body }) {
      const token = provenanceToken(decisionId);
      // 1. Create the issue. Description is ADF (REST v3); the token rides in the
      //    text AND the labels as the strategy-2 backstop.
      const createRes = await transport.request("POST", `${base}/rest/api/3/issue`, {
        fields: {
          project: { key: opts.projectKey },
          issuetype: { id: opts.issueTypeId },
          summary: title,
          labels: [token],
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: `${body}\n\n${token}` }] }],
          },
        },
      });
      if (!ok(createRes.status)) {
        throw new Error(`Jira issue create failed (${createRes.status}): ${await createRes.text()}`);
      }
      const created = (await createRes.json()) as { key?: string };
      if (!created.key) throw new Error("Jira issue create returned no key");

      // 2. Set the issue property (strategy 1, the detector's preferred signal).
      //    A property failure is NON-fatal: the label backstop still attributes.
      let strategy: CreatedIssue["strategy"] = "label";
      try {
        const propRes = await transport.request(
          "PUT",
          `${base}/rest/api/3/issue/${created.key}/properties/${JIRA_DECISION_PROPERTY}`,
          decisionId,
        );
        if (ok(propRes.status)) strategy = "issue_property";
      } catch {
        // keep the label strategy — the ticket is created + attributable
      }
      return {
        externalRef: jiraIssueExternalRef(created.key),
        url: `${base}/browse/${created.key}`,
        strategy,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Live transports (SERVER-ONLY — hold real write credentials).
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  throw new Error("lib/connectors/write.ts is server-only (holds write credentials).");
}

/** Fetch-backed GitHub transport (Bearer PAT/OAuth with `issues:write`). */
export function createGitHubWriteTransport(token: string): WriteTransport {
  return {
    async request(method, url, body) {
      return fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}

/** Fetch-backed Jira transport (basic auth = email:api-token, v1 per #19). */
export function createJiraWriteTransport(auth: { email: string; apiToken: string }): WriteTransport {
  const basic = Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64");
  return {
    async request(method, url, body) {
      return fetch(url, {
        method,
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}
