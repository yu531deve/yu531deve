#!/usr/bin/env node
// Injects the numeric value for each axis of the radar chart produced by
// yoshi389111/github-profile-3d-contrib into every SVG under profile-3d-contrib/.
//
// Plain Node 20 script, no npm dependencies (uses global fetch).
//
// Env vars:
//   GITHUB_TOKEN - token with read access to the target user's contributions
//   USERNAME     - GitHub login to query (defaults to "yu531deve")

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN = process.env.GITHUB_TOKEN;
const USERNAME = process.env.USERNAME || "yu531deve";
const SVG_DIR = "profile-3d-contrib";

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const QUERY = `
  query ($login: String!) {
    user(login: $login) {
      contributionsCollection {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalRepositoryContributions
        restrictedContributionsCount
      }
    }
  }
`;

async function fetchContributions(login) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "inject-chart-values-script",
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const cc = json.data.user.contributionsCollection;
  return {
    Commit: cc.totalCommitContributions,
    Issue: cc.totalIssueContributions,
    PullReq: cc.totalPullRequestContributions,
    Review: cc.totalPullRequestReviewContributions,
    Repo: cc.totalRepositoryContributions,
  };
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

// Matches a full <text ...>Label...</text> element for one of the five radar
// axis labels. The label text itself may be immediately followed by a
// <title>...</title> tooltip element (as emitted by github-profile-3d-contrib),
// so we tolerate that optional tail before the closing </text>.
const LABELS = ["Commit", "Issue", "PullReq", "Review", "Repo"];
const labelPattern = new RegExp(
  `<text([^>]*)>(${LABELS.join("|")})(?:<title>[^<]*</title>)?</text>`,
  "g"
);

function extractAttr(tagAttrs, name) {
  const m = tagAttrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function injectIntoSvg(svg, values) {
  let injectedCount = 0;
  const injectedLabels = [];

  const updated = svg.replace(labelPattern, (fullMatch, attrs, label) => {
    const value = values[label];
    if (value === undefined) return fullMatch;

    const x = extractAttr(attrs, "x");
    const y = extractAttr(attrs, "y");
    const fill = extractAttr(attrs, "fill");

    if (x === null || y === null || fill === null) return fullMatch;

    const newY = (parseFloat(y) + 22).toString();
    const valueText = `<text style="font-size: 18px;" text-anchor="middle" dominant-baseline="middle" x="${x}" y="${newY}" fill="${fill}">${formatNumber(
      value
    )}</text>`;

    injectedCount++;
    injectedLabels.push(`${label}=${formatNumber(value)}`);

    return `${fullMatch}${valueText}`;
  });

  return { updated, injectedCount, injectedLabels };
}

async function main() {
  const values = await fetchContributions(USERNAME);
  console.log(`Fetched contributions for ${USERNAME}:`, values);

  const entries = await readdir(SVG_DIR, { withFileTypes: true });
  const svgFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".svg"))
    .map((e) => e.name);

  let totalInjected = 0;
  for (const file of svgFiles) {
    const path = join(SVG_DIR, file);
    const svg = await readFile(path, "utf8");
    const { updated, injectedCount, injectedLabels } = injectIntoSvg(svg, values);

    if (injectedCount === 0) {
      console.log(`- ${file}: no radar labels found, skipped`);
      continue;
    }

    await writeFile(path, updated, "utf8");
    totalInjected += injectedCount;
    console.log(`- ${file}: injected ${injectedCount} value(s) [${injectedLabels.join(", ")}]`);
  }

  console.log(`Done. Injected values into ${totalInjected} axis label(s) across ${svgFiles.length} file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
