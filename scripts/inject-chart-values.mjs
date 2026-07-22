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
        commitContributionsByRepository(maxRepositories: 100) {
          repository {
            primaryLanguage {
              name
            }
          }
          contributions {
            totalCount
          }
        }
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

  // Same aggregation as github-profile-3d-contrib: sum commit contributions
  // per repository primaryLanguage, top 5 languages + "other".
  const byLang = new Map();
  for (const entry of cc.commitContributionsByRepository) {
    const lang = entry.repository.primaryLanguage?.name;
    if (!lang) continue;
    byLang.set(lang, (byLang.get(lang) || 0) + entry.contributions.totalCount);
  }
  const ranked = [...byLang.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 5);
  const otherTotal = ranked.slice(5).reduce((sum, [, n]) => sum + n, 0);
  const langTotal = ranked.reduce((sum, [, n]) => sum + n, 0);
  const languages = new Map(top);
  if (otherTotal > 0) languages.set("other", otherTotal);

  return {
    axes: {
      Commit: cc.totalCommitContributions,
      Issue: cc.totalIssueContributions,
      PullReq: cc.totalPullRequestContributions,
      Review: cc.totalPullRequestReviewContributions,
      Repo: cc.totalRepositoryContributions,
    },
    languages,
    langTotal,
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

  // Strip anything we injected on a previous run so the script is idempotent.
  svg = svg.replace(/<text[^>]* data-cv="1"[^>]*>[^<]*<\/text>/g, "");
  svg = svg.replace(
    /<text style="font-size: 18px;" text-anchor="middle" dominant-baseline="middle"[^>]*>[\d,]+<\/text>/g,
    ""
  );

  const updated = svg.replace(labelPattern, (fullMatch, attrs, label) => {
    const value = values[label];
    if (value === undefined) return fullMatch;

    const x = extractAttr(attrs, "x");
    const y = extractAttr(attrs, "y");
    const fill = extractAttr(attrs, "fill");

    if (x === null || y === null || fill === null) return fullMatch;

    // "Commit" sits at the top of the radar where the value would collide
    // with the 10K scale tick, so its value goes above the label instead.
    const newY = (parseFloat(y) + (label === "Commit" ? -26 : 22)).toString();
    const valueText = `<text data-cv="1" style="font-size: 18px;" text-anchor="middle" dominant-baseline="middle" x="${x}" y="${newY}" fill="${fill}">${formatNumber(
      value
    )}</text>`;

    injectedCount++;
    injectedLabels.push(`${label}=${formatNumber(value)}`);

    return `${fullMatch}${valueText}`;
  });

  return { updated, injectedCount, injectedLabels };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Appends " NN.N% (count)" to each language legend entry of the donut chart.
// Legend entries are plain <text ...>LanguageName</text> elements; a suffix
// from a previous run (marked by "%") is replaced rather than duplicated.
function injectLegend(svg, languages, langTotal) {
  const injected = [];
  for (const [name, count] of languages) {
    const pct = ((count / langTotal) * 100).toFixed(1);
    // The legend name may be followed by child elements (<animate> in the
    // animated variants, <title> tooltips) before </text>, so only assert
    // that a tag follows rather than matching up to the closing tag.
    const pattern = new RegExp(
      `(<text[^>]*>)${escapeRegExp(name)}(?: [\\d.]+% \\([\\d,]+\\))?(?=<)`
    );
    const next = svg.replace(
      pattern,
      `$1${name} ${pct}% (${formatNumber(count)})`
    );
    if (next !== svg) {
      injected.push(`${name}=${pct}%/${formatNumber(count)}`);
      svg = next;
    }
  }
  return { svg, injected };
}

async function main() {
  const { axes, languages, langTotal } = await fetchContributions(USERNAME);
  console.log(`Fetched contributions for ${USERNAME}:`, axes);
  console.log(`Language totals (of ${langTotal}):`, Object.fromEntries(languages));

  const entries = await readdir(SVG_DIR, { withFileTypes: true });
  const svgFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".svg"))
    .map((e) => e.name);

  let totalInjected = 0;
  for (const file of svgFiles) {
    const path = join(SVG_DIR, file);
    const svg = await readFile(path, "utf8");
    const { updated, injectedCount, injectedLabels } = injectIntoSvg(svg, axes);
    const legend = injectLegend(updated, languages, langTotal);

    if (injectedCount === 0 && legend.injected.length === 0) {
      console.log(`- ${file}: no radar/legend labels found, skipped`);
      continue;
    }

    await writeFile(path, legend.svg, "utf8");
    totalInjected += injectedCount + legend.injected.length;
    console.log(
      `- ${file}: radar [${injectedLabels.join(", ")}] legend [${legend.injected.join(", ")}]`
    );
  }

  console.log(`Done. Injected values into ${totalInjected} axis label(s) across ${svgFiles.length} file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
