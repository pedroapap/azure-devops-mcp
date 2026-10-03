#!/usr/bin/env node
// Live smoke test: spawns the compiled server (dist/index.js) over stdio and calls every
// tool/action against a real Azure DevOps Server (SERVER_URL) or Services organization.
//
// Read-only by default. Set SMOKE_WRITE=1 to also exercise write tools; they only create
// clearly-labelled "[mcp-smoke]" artifacts (a work item, comments, a branch, a wiki page).
//
// Usage:
//   npm run build
//   NODE_OPTIONS=--use-system-ca \  (when the server certificate comes from an internal CA)
//   SERVER_URL=https://ado.contoso.com/tfs PERSONAL_ACCESS_TOKEN=<pat> \
//     node scripts/smoke-test.mjs <collection> [--project <name>] [--only <prefix>]
//
// Optional env: SMOKE_PROJECT, SMOKE_REPO, SMOKE_SEARCH_TEXT, SMOKE_AUTH (default "pat"),
// SMOKE_WRITE=1, SMOKE_OUT (report directory, default: OS temp dir).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync, createWriteStream } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const collection = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!collection) {
  console.error("Usage: node scripts/smoke-test.mjs <collection|organization> [--project <name>] [--only <toolPrefix>]");
  process.exit(2);
}

const auth = process.env.SMOKE_AUTH ?? "pat";
const write = process.env.SMOKE_WRITE === "1";
const only = flag("only");
const searchText = process.env.SMOKE_SEARCH_TEXT ?? "test";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(process.env.SMOKE_OUT ?? tmpdir(), `ado-mcp-smoke-${stamp}`);
mkdirSync(outDir, { recursive: true });

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/index.js"), collection, "--authentication", auth],
  env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "debug" },
  stderr: "pipe",
});
transport.stderr?.pipe(createWriteStream(join(outDir, "server.log")));

const client = new Client({ name: "ado-mcp-smoke-test", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const available = new Set(tools.map((t) => t.name));

const results = [];
const called = new Set();

// Strips the spotlighting delimiters added by content-safety.ts and parses JSON when possible.
function unwrap(result) {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) =>
      c.text
        .split("\n")
        .filter((line) => !/^<<\/?[0-9a-f]{32}>>/.test(line))
        .join("\n")
    )
    .join("\n");
  try {
    return { text, data: JSON.parse(text) };
  } catch {
    return { text, data: undefined };
  }
}

// Finds the first array in a response (raw array, { value: [] }, { workItems: [] }, ...).
function firstArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return [];
}
const first = (data) => firstArray(data)[0];

async function call(tool, params, note = "") {
  const label = params.action ? `${tool}:${params.action}` : tool;
  if (only && !tool.startsWith(only)) return undefined;
  called.add(tool);
  if (!available.has(tool)) {
    results.push({ label, status: "SKIP", detail: "tool not registered" });
    return undefined;
  }
  const started = Date.now();
  try {
    const res = await client.callTool({ name: tool, arguments: params }, undefined, { timeout: 120_000 });
    const { text, data } = unwrap(res);
    const failed = res.isError || /^(Error|An error occurred)/i.test(text.trim());
    results.push({ label, status: failed ? "FAIL" : "PASS", ms: Date.now() - started, detail: failed ? text.slice(0, 300) : note, params, response: text.slice(0, 4000) });
    return failed ? undefined : (data ?? text);
  } catch (err) {
    results.push({ label, status: "FAIL", ms: Date.now() - started, detail: String(err?.message ?? err).slice(0, 300), params });
    return undefined;
  }
}

function skip(tool, action, reason) {
  if (only && !tool.startsWith(only)) return;
  called.add(tool);
  results.push({ label: action ? `${tool}:${action}` : tool, status: "SKIP", detail: reason });
}

// ---------------- core ----------------
const projects = await call("core_list_projects", { top: 50 });
const projectName = flag("project") ?? process.env.SMOKE_PROJECT ?? first(projects)?.name;
if (!projectName) {
  console.error("No project found (core_list_projects failed or returned nothing). See report for details.");
}
const project = projectName ?? "";
const teams = await call("core_list_project_teams", { project, top: 20 });
const teamName = (firstArray(teams).find((x) => x.name === `${project} Team`) ?? first(teams))?.name ?? `${project} Team`;
await call("core_get_identity_ids", { searchFilter: process.env.SMOKE_IDENTITY ?? teamName });

// ---------------- work ----------------
await call("work", { action: "list_iterations", project, depth: 2 });
const teamIterations = await call("work", { action: "list_team_iterations", project, team: teamName });
const iterationId = first(teamIterations)?.id;
await call("work", { action: "get_team_settings", project, team: teamName });
if (iterationId) {
  await call("work", { action: "get_team_capacity", project, team: teamName, iterationId });
  await call("work", { action: "get_iteration_capacities", project, iterationId });
} else {
  skip("work", "get_team_capacity", "no team iteration found");
  skip("work", "get_iteration_capacities", "no team iteration found");
}

// ---------------- repositories ----------------
const repos = await call("repo_repository", { action: "list", project, top: 20 });
const repo = (process.env.SMOKE_REPO && firstArray(repos).find((r) => r.name === process.env.SMOKE_REPO)) ?? first(repos);
const repoId = repo?.id ?? process.env.SMOKE_REPO;
let defaultBranch;
if (repoId) {
  const repoDetails = await call("repo_repository", { action: "get", project, repositoryNameOrId: repoId });
  defaultBranch = (repoDetails?.defaultBranch ?? repo?.defaultBranch ?? "refs/heads/main").replace("refs/heads/", "");
  await call("repo_branch", { action: "list", repositoryId: repoId, project, top: 20 });
  await call("repo_branch", { action: "list_mine", repositoryId: repoId, project });
  await call("repo_branch", { action: "get", repositoryId: repoId, project, branchName: defaultBranch });
  const tree = firstArray(await call("repo_file", { action: "list_directory", repositoryId: repoId, project, path: "/", recursive: false }));
  const file = tree.find((e) => !e.isFolder && e.gitObjectType !== "tree") ?? { path: "/README.md" };
  await call("repo_file", { action: "get_content", repositoryId: repoId, project, path: file.path });

  const prs = await call("repo_pull_request", { action: "list", project, repositoryId: repoId, status: "All", top: 10 });
  const pr = first(prs);
  if (pr?.pullRequestId) {
    await call("repo_pull_request", { action: "get", repositoryId: repoId, pullRequestId: pr.pullRequestId, project, includeWorkItemRefs: true, includeChangedFiles: true });
    const threads = await call("repo_pull_request_thread", { action: "list", repositoryId: repoId, pullRequestId: pr.pullRequestId, project, top: 10 });
    const thread = firstArray(threads).find((t) => t.id);
    if (thread) {
      await call("repo_pull_request_thread", { action: "list_comments", repositoryId: repoId, pullRequestId: pr.pullRequestId, project, threadId: thread.id });
    } else skip("repo_pull_request_thread", "list_comments", "PR has no threads");
    const commit = pr.lastMergeSourceCommit?.commitId;
    if (commit) await call("repo_pull_request", { action: "list_by_commits", project, repository: repoId, commits: [commit] });
    else skip("repo_pull_request", "list_by_commits", "no commit id on PR");
  } else {
    for (const a of ["get", "list_by_commits"]) skip("repo_pull_request", a, "no pull requests in repo");
    for (const a of ["list", "list_comments"]) skip("repo_pull_request_thread", a, "no pull requests in repo");
  }
  await call("repo_search_commits", { searchText, repository: [repo?.name ?? repoId], top: 5 });
} else {
  for (const t of ["repo_branch", "repo_file", "repo_pull_request", "repo_pull_request_thread", "repo_search_commits"]) skip(t, "", "no repository found");
}

// ---------------- pipelines ----------------
const builds = await call("pipelines_build", { action: "list", project, top: 10 });
const build = first(builds);
const definitions = await call("pipelines_definition", { action: "list", project, top: 10 });
const definition = first(definitions);
if (definition?.id) {
  await call("pipelines_definition", { action: "list_revisions", project, definitionId: definition.id });
  const runs = await call("pipelines_run", { action: "list", project, pipelineId: definition.id });
  const run = first(runs);
  if (run?.id) await call("pipelines_run", { action: "get", project, pipelineId: definition.id, runId: run.id });
  else skip("pipelines_run", "get", "pipeline has no runs");
} else {
  skip("pipelines_definition", "list_revisions", "no definitions");
  skip("pipelines_run", "list", "no definitions");
}
if (build?.id) {
  await call("pipelines_build", { action: "get_status", project, buildId: build.id });
  await call("pipelines_build", { action: "get_changes", project, buildId: build.id });
  const logs = await call("pipelines_build_log", { action: "list", project, buildId: build.id });
  const log = first(logs);
  if (log?.id) await call("pipelines_build_log", { action: "get_content", project, buildId: build.id, logId: log.id, startLine: 1, endLine: 20 });
  else skip("pipelines_build_log", "get_content", "build has no logs");
  const artifacts = await call("pipelines_artifact", { action: "list", project, buildId: build.id });
  const artifact = first(artifacts);
  if (artifact?.name) await call("pipelines_artifact", { action: "download", project, buildId: build.id, artifactName: artifact.name, destinationPath: join(outDir, "artifacts") });
  else skip("pipelines_artifact", "download", "build has no artifacts");
  await call("testplan_show_test_results_from_build_id", { project, buildid: build.id });
} else {
  for (const t of ["pipelines_build_log", "pipelines_artifact", "testplan_show_test_results_from_build_id"]) skip(t, "", "no builds");
}
skip("pipelines_write", "", "not exercised: queues/renames/creates real pipelines — test manually");

// ---------------- work items ----------------
const wiql = await call("wit_query", {
  action: "wiql",
  project,
  wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC",
  top: 5,
  responseType: "ids",
});
const wiIds = (wiql?.workItems ?? firstArray(wiql)).map((w) => (typeof w === "number" ? w : w.id)).filter(Boolean);
const wiId = wiIds[0];
await call("wit_work_item", { action: "my", project, type: "assignedtome", top: 5 });
if (wiId) {
  const wi = await call("wit_work_item", { action: "get", project, id: wiId, expand: "Relations" });
  await call("wit_work_item", { action: "get_batch", project, ids: wiIds });
  await call("wit_work_item", { action: "list_comments", project, workItemId: wiId });
  await call("wit_work_item", { action: "list_revisions", project, workItemId: wiId, top: 5 });
  await call("wit_work_item", { action: "get_type", project, workItemType: wi?.fields?.["System.WorkItemType"] ?? "Task" });
  const attachment = (wi?.relations ?? []).find((r) => r.rel === "AttachedFile");
  if (attachment) await call("wit_work_item_attachment", { project, attachmentId: attachment.url.split("/").pop(), savePath: outDir });
  else skip("wit_work_item_attachment", "", `work item ${wiId} has no attachment`);
} else {
  for (const a of ["get", "get_batch", "list_comments", "list_revisions", "get_type"]) skip("wit_work_item", a, "no work items found");
  skip("wit_work_item_attachment", "", "no work items found");
}
if (iterationId) await call("wit_work_item", { action: "list_for_iteration", project, team: teamName, iterationId });
else skip("wit_work_item", "list_for_iteration", "no team iteration found");

const queries = await call("wit_query", { action: "get", project, query: "Shared Queries", depth: 1 });
const savedQuery = firstArray(queries).find((q) => !q.isFolder && q.id);
if (savedQuery) await call("wit_query", { action: "get_results", project, id: savedQuery.id, top: 5 });
else skip("wit_query", "get_results", "no saved query found under Shared Queries");

const backlogs = await call("wit_backlog", { action: "list", project, team: teamName });
const backlog = first(backlogs);
if (backlog?.id) await call("wit_backlog", { action: "list_work_items", project, team: teamName, backlogId: backlog.id });
else skip("wit_backlog", "list_work_items", "no backlog found");
skip("wit_backlog", "reorder", "not exercised: changes backlog order");

// ---------------- wiki ----------------
const wikis = await call("wiki", { action: "list_wikis", project });
const wiki = first(wikis);
if (wiki?.id) {
  await call("wiki", { action: "get_wiki", project, wikiIdentifier: wiki.id });
  const pages = await call("wiki", { action: "list_pages", project, wikiIdentifier: wiki.id, top: 10 });
  const pagePath = first(pages)?.path ?? "/";
  await call("wiki", { action: "get_page", project, wikiIdentifier: wiki.id, path: pagePath });
  await call("wiki", { action: "get_page_content", project, wikiIdentifier: wiki.id, path: pagePath });
} else {
  for (const a of ["get_wiki", "list_pages", "get_page", "get_page_content"]) skip("wiki", a, "no wiki in project");
}

// ---------------- test plans ----------------
const plans = await call("testplan", { action: "list_plans", project, filterActivePlans: false });
const plan = first(plans);
if (plan?.id) {
  const suites = await call("testplan", { action: "list_suites", project, planId: plan.id });
  const suite = first(suites);
  if (suite?.id) await call("testplan", { action: "list_cases", project, planId: plan.id, suiteId: suite.id });
  else skip("testplan", "list_cases", "plan has no suites");
} else {
  skip("testplan", "list_suites", "no test plans");
  skip("testplan", "list_cases", "no test plans");
}

// ---------------- search (needs the Search extension on-prem) ----------------
await call("search_code", { searchText, top: 5 });
await call("search_wiki", { searchText, project: [project], top: 5 });
await call("search_workitem", { searchText, project: [project], top: 5 });

// ---------------- advanced security (Services only; expected to fail on-prem) ----------------
if (repo?.name) {
  const alerts = await call("advsec_get_alerts", { project, repository: repo.name, top: 5 }, "GHAzDO is cloud-only");
  const alert = first(alerts);
  if (alert?.alertId) await call("advsec_get_alert_details", { project, repository: repo.name, alertId: alert.alertId });
  else skip("advsec_get_alert_details", "", "no alerts returned");
} else {
  skip("advsec_get_alerts", "", "no repository");
  skip("advsec_get_alert_details", "", "no repository");
}

// ---------------- writes (opt-in) ----------------
if (write) {
  const created = await call("wit_work_item_write", {
    action: "create",
    project,
    workItemType: "Task",
    fields: [
      { name: "System.Title", value: `[mcp-smoke] ${stamp}` },
      { name: "System.Description", value: "Created by scripts/smoke-test.mjs — safe to delete." },
    ],
  });
  const newId = created?.id;
  if (newId) {
    await call("wit_work_item_write", { action: "update", id: newId, updates: [{ op: "add", path: "/fields/System.Tags", value: "mcp-smoke" }] });
    const comment = await call("wit_work_item_comment_write", { action: "add", project, workItemId: newId, text: "mcp smoke comment" });
    if (comment?.id) await call("wit_work_item_comment_write", { action: "update", project, workItemId: newId, commentId: comment.id, text: "mcp smoke comment (edited)" });
    if (wiId) await call("wit_work_item_link_write", { action: "link", project, updates: [{ id: newId, linkToId: wiId, type: "related", comment: "mcp smoke link" }] });
    await call("wit_work_item_write", { action: "add_child", project, parentId: newId, workItemType: "Task", items: [{ title: `[mcp-smoke] child ${stamp}` }] });
  }
  if (repoId) await call("repo_create_branch", { repositoryId: repoId, project, branchName: `mcp-smoke/${stamp}`, sourceBranchName: defaultBranch });
  if (wiki?.id) await call("wiki_upsert_page", { wikiIdentifier: wiki.id, project, path: `/mcp-smoke-${stamp}`, content: "# MCP smoke test\n\nSafe to delete." });
  await call("testplan_test_plan_write", { action: "create", project, name: `[mcp-smoke] ${stamp}`, iteration: project });
}
for (const t of tools.map((t) => t.name)) {
  if (!called.has(t) && !(only && !t.startsWith(only))) {
    skip(t, "", write ? "not exercised automatically (would modify shared state) — test manually" : "write tool — rerun with SMOKE_WRITE=1");
  }
}

await client.close();

// ---------------- report ----------------
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) counts[r.status]++;
const icon = { PASS: "✔", FAIL: "✘", SKIP: "-" };
for (const r of results) {
  console.log(`${icon[r.status]} ${r.status.padEnd(4)} ${r.label.padEnd(48)} ${r.ms != null ? `${r.ms}ms`.padStart(7) : "       "}  ${r.detail ?? ""}`.replace(/\s+$/, ""));
}
writeFileSync(join(outDir, "report.json"), JSON.stringify({ collection, project, serverUrl: process.env.SERVER_URL, auth, write, counts, results }, null, 2));
console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped  (project: ${project || "?"}, ${available.size} tools)`);
console.log(`Full request/response report: ${join(outDir, "report.json")}\nServer debug log:              ${join(outDir, "server.log")}`);
process.exit(counts.FAIL ? 1 : 0);
