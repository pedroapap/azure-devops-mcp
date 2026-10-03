#!/usr/bin/env node
// End-to-end test of every MCP tool against a disposable Azure DevOps project.
//
// Spawns the compiled server (dist/index.js) over stdio, seeds its own data inside the project
// (repo, commits, branch, PR, work items, iteration, wiki, test plan, YAML pipeline + runs),
// calls every tool/action against that data, asserts on the responses, then deletes what it created.
//
// Only touches project-scoped resources, all named "mcp-smoke-<timestamp>". Nothing collection-level.
//
// Usage:
//   npm run build
//   NODE_OPTIONS=--use-system-ca \
//   SERVER_URL=https://tfs.contoso.com PERSONAL_ACCESS_TOKEN=<pat> \
//     node scripts/e2e-sandbox.mjs <collection> <project> [--keep] [--only <toolPrefix>]
//
// Env: SMOKE_TEAM (default "<project> Team"), SMOKE_POOL (agent pool for the test pipeline, default "Default"),
//      SMOKE_PIPELINE_TIMEOUT (seconds to wait for the pipeline, default 900), SMOKE_SEARCH_TEXT (default "Hello"),
//      SMOKE_OUT (report directory, default: OS temp dir).
// Statuses: PASS, FAIL, XFAIL (known not to work on Azure DevOps Server), WARN (call succeeded, check inconclusive), SKIP.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
const [collection, project] = positional;
const keep = args.includes("--keep");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const serverUrl = process.env.SERVER_URL?.replace(/\/+$/, "");
const patEnv = process.env.PERSONAL_ACCESS_TOKEN;
if (!collection || !project || !serverUrl || !patEnv) {
  console.error("Usage: SERVER_URL=... PERSONAL_ACCESS_TOKEN=... node scripts/e2e-sandbox.mjs <collection> <project> [--keep] [--only <toolPrefix>]");
  process.exit(2);
}

const team = process.env.SMOKE_TEAM ?? `${project} Team`;
const pool = process.env.SMOKE_POOL ?? "Default";
const pipelineTimeoutMs = Number(process.env.SMOKE_PIPELINE_TIMEOUT ?? 900) * 1000;
const searchText = process.env.SMOKE_SEARCH_TEXT ?? "Hello";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const tag = `mcp-smoke-${stamp}`;
const outDir = join(process.env.SMOKE_OUT ?? tmpdir(), tag);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- direct REST (setup / cleanup only)
// Same credential formats as the server: raw PAT or base64("email:pat").
function rawPat(value) {
  const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  const roundTrip = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") === value.trim().replace(/=+$/, "");
  return roundTrip && sep > 0 && /^[\x20-\x7E]+$/.test(decoded) ? decoded.slice(sep + 1) : value.trim();
}
const basicAuth = "Basic " + Buffer.from(`:${rawPat(patEnv)}`).toString("base64");
const collUrl = `${serverUrl}/${collection}`;
const projUrl = `${collUrl}/${encodeURIComponent(project)}`;

async function rest(method, url, body, contentType = "application/json") {
  const res = await fetch(url, {
    method,
    headers: { "Authorization": basicAuth, "Content-Type": contentType, "Accept": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, timeoutMs, intervalMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- MCP client
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/index.js"), collection, "--authentication", process.env.SMOKE_AUTH ?? "pat"],
  env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "debug" },
  cwd: outDir, // tools that save files (attachments, artifacts) require relative paths
  stderr: "pipe",
});
transport.stderr?.pipe(createWriteStream(join(outDir, "server.log")));
const client = new Client({ name: "ado-mcp-e2e", version: "1.0.0" });
await client.connect(transport);
const available = new Set((await client.listTools()).tools.map((t) => t.name));

const results = [];
const covered = new Set();

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

const arr = (d) => (Array.isArray(d) ? d : Array.isArray(d?.value) ? d.value : []);

/**
 * Calls a tool and records the outcome.
 * check(data, text) returns an error string (FAIL), { warn: string } (WARN) or nothing (PASS).
 * xfail marks calls known not to work on Azure DevOps Server; expectError marks calls that must be rejected
 * (optionally with an error message containing errorIncludes).
 */
async function t(tool, params, { check, xfail, expectError, errorIncludes } = {}) {
  const label = params.action ? `${tool}:${params.action}` : tool;
  covered.add(label);
  if (only && !tool.startsWith(only)) return undefined;
  if (!available.has(tool)) return record({ label, status: "FAIL", detail: "tool not registered" });
  const started = Date.now();
  let data, text, error;
  try {
    const res = await client.callTool({ name: tool, arguments: params }, undefined, { timeout: 180_000 });
    ({ data, text } = unwrap(res));
    if (res.isError || /^(Error|An error occurred)/i.test(text.trim())) error = text;
  } catch (err) {
    error = String(err?.message ?? err);
  }
  const ms = Date.now() - started;
  if (expectError) {
    const detail = !error ? "call succeeded but should have failed" : errorIncludes && !error.includes(errorIncludes) ? `unexpected error: ${error}` : "";
    return record({ label: `${label} (${expectError})`, status: detail ? "FAIL" : "PASS", ms, detail, params, response: text });
  }
  if (!error && check) {
    try {
      const verdict = check(data, text);
      if (typeof verdict === "string") error = `check: ${verdict}`;
      else if (verdict?.warn) return record({ label, status: "WARN", ms, detail: verdict.warn, params, response: text }, data ?? text);
    } catch (e) {
      error = `check threw: ${e.message}`;
    }
  }
  if (error) return record({ label, status: xfail ? "XFAIL" : "FAIL", ms, detail: (xfail ? `${xfail} — ` : "") + error, params, response: text });
  return record({ label, status: "PASS", ms, detail: xfail ? `unexpectedly works (${xfail})` : "", params, response: text }, data ?? text);
}
function record(r, value) {
  results.push({ ...r, response: r.response?.slice(0, 6000) });
  const icon = { PASS: "✔", FAIL: "✘", XFAIL: "~", WARN: "!", SKIP: "-" }[r.status];
  console.log(`${icon} ${r.status.padEnd(5)} ${r.label.padEnd(44)} ${r.ms != null ? `${r.ms}ms`.padStart(7) : "       "}  ${(r.detail ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  return r.status === "PASS" || r.status === "WARN" ? value : undefined;
}
function skip(label, reason) {
  covered.add(label);
  if (only && !label.startsWith(only)) return;
  record({ label, status: "SKIP", detail: reason });
}
async function setup(name, fn) {
  try {
    return await fn();
  } catch (err) {
    results.push({ label: `setup:${name}`, status: "FAIL", detail: String(err.message) });
    console.log(`✘ SETUP ${name}: ${String(err.message).slice(0, 200)}`);
    return undefined;
  }
}

const created = { workItems: [], testCases: [] };
console.log(`Sandbox run ${tag} against ${projUrl} (pool '${pool}', team '${team}')\n`);

// ================================================================ core
const me = await rest("GET", `${collUrl}/_apis/connectionData`).then((d) => d.authenticatedUser);
const projectInfo = await rest("GET", `${collUrl}/_apis/projects/${encodeURIComponent(project)}?api-version=6.0`);
await t("core_list_projects", { projectNameFilter: project }, { check: (d) => (arr(d).some((p) => p.name === project) ? undefined : `project '${project}' not in result`) });
await t("core_list_project_teams", { project }, { check: (d) => (arr(d).some((x) => x.name === team) ? undefined : `team '${team}' not in result`) });
await t("core_get_identity_ids", { searchFilter: me.providerDisplayName }, { check: (d, txt) => (txt.includes(me.id) ? undefined : `own identity ${me.id} not returned`) });

// ================================================================ repository (seed via REST: no MCP tool creates repos or commits)
const repo = await setup("create repository", () => rest("POST", `${projUrl}/_apis/git/repositories?api-version=6.0`, { name: tag, project: { id: projectInfo.id } }));
created.repo = repo;
const pipelineYaml = `trigger: none
parameters:
  - name: smokeTag
    type: string
    default: none
pool:
  name: ${pool}
stages:
  - stage: Build
    jobs:
      - job: Build
        steps:
          - script: echo "mcp smoke build \${{ parameters.smokeTag }}"
          - task: PublishTestResults@2
            inputs:
              testResultsFormat: JUnit
              testResultsFiles: results/junit.xml
              testRunTitle: ${tag}
          - publish: artifact
            artifact: smoke-artifact
  - stage: Slow
    jobs:
      - job: Wait
        steps:
          - script: ping -n 300 127.0.0.1 > nul
            condition: eq(variables['Agent.OS'], 'Windows_NT')
          - script: sleep 300
            condition: ne(variables['Agent.OS'], 'Windows_NT')
`;
const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="smoke" tests="2" failures="1">
<testcase classname="smoke" name="passes"/>
<testcase classname="smoke" name="fails"><failure message="expected failure">boom</failure></testcase>
</testsuite></testsuites>
`;
const seedFiles = {
  "/README.md": `# ${tag}\n\nHello from the MCP sandbox test.\n`,
  "/src/app.txt": "line 1\nline 2\nline 3\n",
  "/azure-pipelines.yml": pipelineYaml,
  "/results/junit.xml": junit,
  "/artifact/hello.txt": "artifact content\n",
  "/wiki/Home.md": `# Home\n\nSandbox wiki ${tag}.\n`,
  "/wiki/Second-Page.md": "# Second page\n",
};
const push = (refName, oldObjectId, comment, changes) =>
  rest("POST", `${projUrl}/_apis/git/repositories/${repo.id}/pushes?api-version=6.0`, {
    refUpdates: [{ name: refName, oldObjectId }],
    commits: [{ comment, changes }],
  });
const initialPush =
  repo &&
  (await setup("initial commit", () =>
    push(
      "refs/heads/main",
      "0".repeat(40),
      `${tag}: initial`,
      Object.entries(seedFiles).map(([path, content]) => ({ changeType: "add", item: { path }, newContent: { content, contentType: "rawtext" } }))
    )
  ));
const mainCommit = initialPush?.commits?.[0]?.commitId;

if (repo && mainCommit) {
  await t("repo_repository", { action: "list", project, repoNameFilter: tag }, { check: (d) => (arr(d).some((r) => r.id === repo.id) ? undefined : "new repo not listed") });
  await t("repo_repository", { action: "get", project, repositoryNameOrId: tag }, { check: (d) => (d?.id === repo.id ? undefined : "wrong repo returned") });
  await t("repo_create_branch", { repositoryId: repo.id, project, branchName: "feature/smoke", sourceBranchName: "main" });
  await t("repo_branch", { action: "list", repositoryId: repo.id, project }, { check: (d, txt) => (txt.includes("feature/smoke") ? undefined : "feature/smoke not listed") });
  await t("repo_branch", { action: "list_mine", repositoryId: repo.id, project }, { check: (d, txt) => (txt.includes("feature/smoke") ? undefined : "feature/smoke not in list_mine") });
  await t(
    "repo_branch",
    { action: "get", repositoryId: repo.id, project, branchName: "feature/smoke" },
    { check: (d, txt) => (txt.includes(mainCommit) ? undefined : "branch does not point at the main commit") }
  );
  await t(
    "repo_file",
    { action: "list_directory", repositoryId: repo.id, project, path: "/", recursive: true, recursionDepth: 5 },
    { check: (d, txt) => (txt.includes("src/app.txt") ? undefined : "recursive listing misses src/app.txt") }
  );
  await t(
    "repo_file",
    { action: "get_content", repositoryId: repo.id, project, path: "/README.md", version: "main", versionType: "Branch" },
    { check: (d, txt) => (txt.includes(tag) ? undefined : "README content mismatch") }
  );
} else {
  for (const l of [
    "repo_repository:list",
    "repo_repository:get",
    "repo_create_branch",
    "repo_branch:list",
    "repo_branch:list_mine",
    "repo_branch:get",
    "repo_file:list_directory",
    "repo_file:get_content",
  ])
    skip(l, "repository seeding failed");
}
const branchHead = repo && (await setup("feature branch head", () => rest("GET", `${projUrl}/_apis/git/repositories/${repo.id}/refs?filter=heads/feature/smoke&api-version=6.0`))).value?.[0]?.objectId;
const featurePush =
  branchHead &&
  (await setup("feature commit", () =>
    push("refs/heads/feature/smoke", branchHead, `${tag}: feature change`, [
      { changeType: "edit", item: { path: "/src/app.txt" }, newContent: { content: "line 1\nline 2 changed\nline 3\nline 4\n", contentType: "rawtext" } },
    ])
  ));
const featureCommit = featurePush?.commits?.[0]?.commitId;

// ================================================================ iterations & capacity
const iterStart = new Date();
const iterEnd = new Date(Date.now() + 13 * 86400000);
const iterResult = await t(
  "work_iteration_write",
  { action: "create", project, iterations: [{ iterationName: tag, startDate: iterStart.toISOString(), finishDate: iterEnd.toISOString() }] },
  { check: (d, txt) => (txt.includes(tag) ? undefined : "created iteration not echoed") }
);
const iteration = arr(iterResult)[0] ?? iterResult;
const iterationPath = `${project}\\${tag}`;
created.iteration = iteration?.identifier ? iteration : undefined;
if (iteration?.identifier) {
  await t(
    "work_iteration_write",
    { action: "assign", project, team, iterations: [{ identifier: iteration.identifier, path: iterationPath }] },
    { check: (d, txt) => (txt.includes(iteration.identifier) ? undefined : "assignment not echoed") }
  );
  created.teamIteration = iteration.identifier;
} else skip("work_iteration_write:assign", "iteration create failed");
await t("work", { action: "list_iterations", project, depth: 2 }, { check: (d, txt) => (txt.includes(tag) ? undefined : "new iteration not listed") });
await t("work", { action: "list_team_iterations", project, team }, { check: (d, txt) => (txt.includes(tag) ? undefined : "new iteration not assigned to team") });
await t("work", { action: "get_team_settings", project, team }, { check: (d, txt) => (txt.length > 2 ? undefined : "empty settings") });
if (iteration?.identifier) {
  await t(
    "work_capacity_write",
    {
      action: "update",
      project,
      team,
      teamMemberId: me.id,
      iterationId: iteration.identifier,
      activities: [{ name: "Development", capacityPerDay: 4 }],
      daysOff: [{ start: iterStart.toISOString(), end: iterStart.toISOString() }],
    },
    { check: (d, txt) => (txt.includes("4") ? undefined : "capacity not echoed") }
  );
  await t(
    "work",
    { action: "get_team_capacity", project, team, iterationId: iteration.identifier },
    { check: (d, txt) => (txt.includes(me.id) || txt.includes(me.providerDisplayName) ? undefined : "own capacity entry missing") }
  );
  await t(
    "work",
    { action: "get_iteration_capacities", project, iterationId: iteration.identifier },
    { check: (d, txt) => (txt.includes(team) || txt.includes("4") ? undefined : "team capacity missing") }
  );
} else for (const l of ["work_capacity_write", "work:get_team_capacity", "work:get_iteration_capacities"]) skip(l, "iteration create failed");

// ================================================================ work items
const field = (name, value) => ({ name, value });
const story = await t(
  "wit_work_item_write",
  {
    action: "create",
    project,
    workItemType: "User Story",
    fields: [field("System.Title", `[${tag}] story`), field("System.Description", "Story created by **e2e-sandbox**"), field("System.Tags", tag), field("System.IterationPath", iterationPath)],
  },
  { check: (d) => (d?.id ? undefined : "no id returned") }
);
const bug = await t(
  "wit_work_item_write",
  { action: "create", project, workItemType: "Bug", fields: [field("System.Title", `[${tag}] bug`), field("System.Tags", tag), field("System.IterationPath", iterationPath)] },
  { check: (d) => (d?.id ? undefined : "no id returned") }
);
const storyId = story?.id;
const bugId = bug?.id;
created.workItems.push(...[storyId, bugId].filter(Boolean));

if (storyId && bugId) {
  await t(
    "wit_work_item_write",
    {
      action: "update",
      id: storyId,
      updates: [
        { op: "test", path: "/rev", value: story.rev },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 1 },
      ],
    },
    { check: (d) => (d?.fields?.["Microsoft.VSTS.Common.Priority"] === 1 ? undefined : "priority not updated") }
  );
  await t(
    "wit_work_item_write",
    {
      action: "update",
      id: storyId,
      updates: [
        { op: "test", path: "/rev", value: story.rev },
        { op: "add", path: "/fields/System.Title", value: "stale write" },
      ],
    },
    { expectError: "stale /rev must be rejected" }
  );
  await t(
    "wit_work_item_write",
    {
      action: "update_batch",
      batchUpdates: [
        { id: storyId, path: "/fields/System.State", value: "Active" },
        { id: bugId, path: "/fields/System.State", value: "Active" },
      ],
    },
    { check: (d, txt) => (txt.includes(String(storyId)) && txt.includes(String(bugId)) ? undefined : "both items not in batch result") }
  );
  // The $batch API reports per-item failures inside a 200 response.
  const batchItemError = (txt) => (txt.includes('"code": 400') ? (txt.match(/Message\\?":\\?"([^"\\]+)/)?.[1] ?? "batch item rejected") : undefined);
  // Markdown work item fields are Services-only; the server must reject them up front with guidance (add_child defaults to Markdown).
  await t(
    "wit_work_item_write",
    { action: "add_child", project, parentId: storyId, workItemType: "Task", items: [{ title: `[${tag}] markdown child`, description: "**markdown**", iterationPath }] },
    { expectError: "Markdown rejected on Azure DevOps Server", errorIncludes: "format to 'Html'" }
  );
  const children = await t(
    "wit_work_item_write",
    {
      action: "add_child",
      project,
      parentId: storyId,
      workItemType: "Task",
      items: [
        { title: `[${tag}] child A`, description: "child A", format: "Html", iterationPath },
        { title: `[${tag}] child B`, description: "child B", format: "Html", iterationPath },
      ],
    },
    { check: (d, txt) => batchItemError(txt) ?? ((txt.match(/"id\\?":\s*\d+/g) ?? []).length >= 2 ? undefined : "two children not returned") }
  );
  const childIds = arr(children)
    .map((r) => (typeof r.body === "string" ? JSON.parse(r.body).id : r.body?.id))
    .filter(Boolean);
  created.workItems.push(...childIds);

  const comment = await t("wit_work_item_comment_write", { action: "add", project, workItemId: storyId, text: `comment from ${tag}` }, { check: (d) => (d?.id ? undefined : "no comment id") });
  if (comment?.id)
    await t(
      "wit_work_item_comment_write",
      { action: "update", project, workItemId: storyId, commentId: comment.id, text: `edited comment from ${tag}` },
      { check: (d, txt) => (txt.includes("edited") ? undefined : "edit not echoed") }
    );
  else skip("wit_work_item_comment_write:update", "comment add failed");

  await t("wit_work_item_link_write", { action: "link", project, updates: [{ id: storyId, linkToId: bugId, type: "related", comment: tag }] });
  await t("wit_work_item_link_write", { action: "link", project, updates: [{ id: bugId, type: "hyperlink", url: "https://example.com/mcp-smoke" }] });
  await t("wit_work_item_link_write", { action: "unlink", project, id: bugId, type: "hyperlink", url: "https://example.com/mcp-smoke" });
  if (featureCommit) {
    await t("wit_work_item_link_write", { action: "add_artifact_link", project, workItemId: bugId, projectId: projectInfo.id, repositoryId: repo.id, branchName: "feature/smoke", linkType: "Branch" });
    await t("wit_work_item_link_write", {
      action: "add_artifact_link",
      project,
      workItemId: bugId,
      projectId: projectInfo.id,
      repositoryId: repo.id,
      commitId: featureCommit,
      linkType: "Fixed in Commit",
    });
  } else for (const l of ["wit_work_item_link_write:add_artifact_link"]) skip(l, "no commit to link");

  // attachment: uploaded via REST (no MCP upload tool), downloaded via MCP
  const attachment = await setup("upload attachment", () => rest("POST", `${projUrl}/_apis/wit/attachments?fileName=smoke.txt&api-version=6.0`, `attachment ${tag}`, "application/octet-stream"));
  if (attachment?.id) {
    await setup("attach to story", () =>
      rest(
        "PATCH",
        `${collUrl}/_apis/wit/workitems/${storyId}?api-version=6.0`,
        [{ op: "add", path: "/relations/-", value: { rel: "AttachedFile", url: attachment.url } }],
        "application/json-patch+json"
      )
    );
    mkdirSync(join(outDir, "attachments"), { recursive: true }); // the tool does not create savePath itself
    await t(
      "wit_work_item_attachment",
      { project, attachmentId: attachment.id, fileName: "smoke.txt", savePath: "attachments" },
      { check: () => (existsSync(join(outDir, "attachments")) && readdirSync(join(outDir, "attachments")).length ? undefined : "file not saved") }
    );
  } else skip("wit_work_item_attachment", "attachment upload failed");

  await t(
    "wit_work_item",
    { action: "get", project, id: storyId, expand: "All" },
    {
      check: (d, txt) =>
        txt.includes("AttachedFile") && txt.includes("System.LinkTypes.Related") && txt.includes("Hierarchy-Forward") ? undefined : "expected attachment, related and child relations",
    }
  );
  await t(
    "wit_work_item",
    { action: "get_batch", project, ids: [storyId, bugId, ...childIds] },
    { check: (d) => (arr(d).length === 2 + childIds.length ? undefined : `expected ${2 + childIds.length} items`) }
  );
  await t("wit_work_item", { action: "list_comments", project, workItemId: storyId }, { check: (d, txt) => (txt.includes("edited comment") ? undefined : "edited comment missing") });
  await t("wit_work_item", { action: "list_revisions", project, workItemId: storyId }, { check: (d) => (arr(d).length >= 3 ? undefined : "expected >= 3 revisions") });
  await t("wit_work_item", { action: "get_type", project, workItemType: "User Story" }, { check: (d, txt) => (txt.includes("User Story") ? undefined : "type not returned") });
  await t("wit_work_item", { action: "my", project, type: "myactivity", top: 50 }, { check: (d, txt) => (txt.includes(String(storyId)) ? undefined : { warn: "new story not yet in 'my activity'" }) });
  if (iteration?.identifier)
    await t(
      "wit_work_item",
      { action: "list_for_iteration", project, team, iterationId: iteration.identifier },
      { check: (d, txt) => (childIds.every((id) => txt.includes(String(id))) ? undefined : "children not in iteration") }
    );
  else skip("wit_work_item:list_for_iteration", "no iteration");

  // queries
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${tag}'`;
  await t("wit_query", { action: "wiql", project, wiql }, { check: (d, txt) => (txt.includes(String(storyId)) && txt.includes(String(bugId)) ? undefined : "tagged items not returned") });
  const savedQuery = await setup("create saved query", () => rest("POST", `${projUrl}/_apis/wit/queries/My%20Queries?api-version=6.0`, { name: tag, wiql }));
  created.query = savedQuery;
  if (savedQuery?.id) {
    await t("wit_query", { action: "get", project, query: savedQuery.id, expand: "Wiql" }, { check: (d, txt) => (txt.includes(tag) ? undefined : "saved query not returned") });
    await t("wit_query", { action: "get_results", project, id: savedQuery.id }, { check: (d, txt) => (txt.includes(String(storyId)) ? undefined : "query results miss story") });
  } else for (const l of ["wit_query:get", "wit_query:get_results"]) skip(l, "saved query setup failed");

  // backlog
  const backlogs = await t("wit_backlog", { action: "list", project, team }, { check: (d) => (arr(d).length ? undefined : "no backlog levels") });
  const reqBacklog = arr(backlogs).find((b) => b.id === "Microsoft.RequirementCategory") ?? arr(backlogs)[0];
  if (reqBacklog)
    await t(
      "wit_backlog",
      { action: "list_work_items", project, team, backlogId: reqBacklog.id },
      { check: (d, txt) => (txt.includes(String(storyId)) ? undefined : { warn: "story not on team backlog (area path outside team areas?)" }) }
    );
  else skip("wit_backlog:list_work_items", "no backlog levels");
  if (childIds.length >= 2 && iteration?.identifier)
    await t("wit_backlog", { action: "reorder", project, team, ids: [childIds[1]], previousId: 0, nextId: childIds[0], parentId: storyId, iterationId: iteration.identifier });
  else skip("wit_backlog:reorder", "children or iteration missing");
} else {
  skip("wit_work_item_write:*", "work item create failed");
}

// ================================================================ pull request
let prId;
if (featureCommit) {
  const pr = await t(
    "repo_pull_request_write",
    {
      action: "create",
      repositoryId: repo.id,
      project,
      sourceRefName: "refs/heads/feature/smoke",
      targetRefName: "refs/heads/main",
      title: `[${tag}] PR`,
      description: "created by e2e-sandbox",
      isDraft: true,
      workItems: storyId ? String(storyId) : undefined,
      labels: [tag],
    },
    { check: (d) => (d?.pullRequestId ? undefined : "no pullRequestId") }
  );
  prId = pr?.pullRequestId;
}
if (prId) {
  const base = { repositoryId: repo.id, pullRequestId: prId, project };
  await t(
    "repo_pull_request_write",
    { action: "update", ...base, title: `[${tag}] PR (updated)`, isDraft: false, labels: [tag, "second-label"] },
    { check: (d, txt) => (txt.includes("(updated)") ? undefined : "title not updated") }
  );
  await t(
    "repo_pull_request_write",
    { action: "update_reviewers", ...base, reviewerIds: [me.id], reviewerAction: "add" },
    { check: (d, txt) => (txt.includes(me.id) ? undefined : "reviewer not added") }
  );
  await t(
    "repo_pull_request_write",
    { action: "vote", ...base, vote: "ApprovedWithSuggestions" },
    { check: (d, txt) => (/"vote":\s*5/.test(txt) || txt.includes("ApprovedWithSuggestions") ? undefined : "vote not reflected") }
  );
  await t(
    "repo_pull_request",
    { action: "get", ...base, includeWorkItemRefs: true, includeLabels: true, includeChangedFiles: true },
    { check: (d, txt) => (txt.includes("app.txt") && txt.includes("second-label") && (!storyId || txt.includes(String(storyId))) ? undefined : "missing changed file, label or work item ref") }
  );
  await t(
    "repo_pull_request",
    { action: "list", repositoryId: repo.id, project, status: "Active", created_by_me: true },
    { check: (d, txt) => (txt.includes(String(prId)) ? undefined : "PR not listed") }
  );
  await t(
    "repo_pull_request",
    { action: "list", repositoryId: repo.id, project, status: "Active", i_am_reviewer: true },
    { check: (d, txt) => (txt.includes(String(prId)) ? undefined : "PR not listed for reviewer") }
  );
  await t(
    "repo_pull_request",
    { action: "list_by_commits", project, repository: repo.id, commits: [featureCommit], queryType: "Commit" },
    { check: (d, txt) => (txt.includes(String(prId)) ? undefined : { warn: "PR not found by commit (index may lag)" }) }
  );

  const thread = await t("repo_pull_request_thread_write", { action: "create", ...base, content: `general comment ${tag}` }, { check: (d) => (d?.id ? undefined : "no thread id") });
  const fileThread = await t(
    "repo_pull_request_thread_write",
    { action: "create", ...base, content: "line comment", filePath: "/src/app.txt", rightFileStartLine: 2, rightFileStartOffset: 1, rightFileEndLine: 2, rightFileEndOffset: 5 },
    { check: (d, txt) => (txt.includes("app.txt") ? undefined : "file context missing") }
  );
  if (thread?.id) {
    const reply = await t(
      "repo_pull_request_thread_write",
      { action: "reply", ...base, threadId: thread.id, content: "a reply", fullResponse: true },
      { check: (d) => (d?.id ? undefined : "no comment id") }
    );
    if (reply?.id)
      await t(
        "repo_pull_request_thread_write",
        { action: "update", ...base, threadId: thread.id, commentId: reply.id, content: "an edited reply", fullResponse: true },
        { check: (d, txt) => (txt.includes("edited reply") ? undefined : "edit not echoed") }
      );
    else skip("repo_pull_request_thread_write:update", "reply failed");
    await t(
      "repo_pull_request_thread_write",
      { action: "update_status", ...base, threadId: thread.id, status: "Fixed" },
      { check: (d, txt) => (/fixed|"status":\s*2/i.test(txt) ? undefined : "status not updated") }
    );
    await t(
      "repo_pull_request_thread",
      { action: "list", ...base, fullResponse: true },
      { check: (d, txt) => (txt.includes(String(thread.id)) && (!fileThread || txt.includes(String(fileThread.id))) ? undefined : "threads missing") }
    );
    await t(
      "repo_pull_request_thread",
      { action: "list_comments", ...base, threadId: thread.id, fullResponse: true },
      { check: (d, txt) => (txt.includes("edited reply") ? undefined : "edited reply missing") }
    );
  } else
    for (const l of [
      "repo_pull_request_thread_write:reply",
      "repo_pull_request_thread_write:update",
      "repo_pull_request_thread_write:update_status",
      "repo_pull_request_thread:list",
      "repo_pull_request_thread:list_comments",
    ])
      skip(l, "thread create failed");
  if (storyId) await t("wit_work_item_link_write", { action: "link_to_pull_request", project, projectId: projectInfo.id, repositoryId: repo.id, pullRequestId: prId, workItemId: bugId });

  await t("repo_pull_request_write", { action: "update", ...base, status: "Abandoned" }, { check: (d, txt) => (/abandoned|"status":\s*2/i.test(txt) ? undefined : "not abandoned") });
  await t("repo_pull_request_write", { action: "update", ...base, status: "Active" }, { check: (d, txt) => (/active|"status":\s*1/i.test(txt) ? undefined : "not reactivated") });
} else {
  for (const l of ["repo_pull_request_write:*", "repo_pull_request:*", "repo_pull_request_thread_write:*", "repo_pull_request_thread:*"]) skip(l, "PR create failed");
}

// ================================================================ wiki (code wiki published from the sandbox repo, removable on cleanup)
const wiki =
  mainCommit &&
  (await setup("publish code wiki", () =>
    rest("POST", `${projUrl}/_apis/wiki/wikis?api-version=6.0`, { name: tag, type: "codeWiki", projectId: projectInfo.id, repositoryId: repo.id, mappedPath: "/wiki", version: { version: "main" } })
  ));
created.wiki = wiki;
if (wiki?.id) {
  await t("wiki", { action: "list_wikis", project }, { check: (d, txt) => (txt.includes(wiki.id) ? undefined : "wiki not listed") });
  await t("wiki", { action: "get_wiki", project, wikiIdentifier: wiki.id }, { check: (d, txt) => (txt.includes(tag) ? undefined : "wrong wiki") });
  await t("wiki_upsert_page", { wikiIdentifier: wiki.id, project, path: "/Created-By-MCP", content: `# Created\n\n${tag}`, branch: "main" });
  await t("wiki_upsert_page", { wikiIdentifier: wiki.id, project, path: "/Created-By-MCP", content: `# Created\n\n${tag} (updated)`, branch: "main" });
  await t("wiki", { action: "list_pages", project, wikiIdentifier: wiki.id }, { check: (d, txt) => (txt.includes("/Second Page") && txt.includes("Created-By-MCP") ? undefined : "pages missing") });
  await t("wiki", { action: "get_page", project, wikiIdentifier: wiki.id, path: "/Second Page" }, { check: (d, txt) => (txt.includes("Second") ? undefined : "page metadata missing") });
  await t(
    "wiki",
    { action: "get_page_content", project, wikiIdentifier: wiki.id, path: "/Created-By-MCP" },
    { check: (d, txt) => (txt.includes("(updated)") ? undefined : "updated content not returned") }
  );
  await t(
    "wiki",
    { action: "get_page_content", url: `${projUrl}/_wiki/wikis/${encodeURIComponent(tag)}?pagePath=/Home` },
    { check: (d, txt) => (txt.includes("Sandbox wiki") ? undefined : "page by URL not returned") }
  );
  const pageId = await setup("wiki page id", () => rest("GET", `${projUrl}/_apis/wiki/wikis/${wiki.id}/pages?path=/Home&api-version=6.0`)).then((p) => p?.id);
  if (bugId && pageId) await t("wit_work_item_link_write", { action: "add_artifact_link", project, workItemId: bugId, projectId: projectInfo.id, wikiId: wiki.id, pageId, linkType: "Wiki" });
} else for (const l of ["wiki:*", "wiki_upsert_page"]) skip(l, "wiki setup failed");

// ================================================================ test plans
const testCase =
  storyId &&
  (await t(
    "testplan_test_case_write",
    { action: "create", project, title: `[${tag}] test case`, priority: 2, iterationPath, testsWorkItemId: storyId },
    { check: (d) => (d?.id ? undefined : "no id") }
  ));
if (testCase?.id) {
  created.testCases.push(testCase.id);
  await t(
    "testplan_test_case_write",
    { action: "update_steps", id: testCase.id, steps: "1. Open app|App opens\n2. Click run|Run starts" },
    { check: (d, txt) => (txt.includes("Click run") || txt.includes("Microsoft.VSTS.TCM.Steps") ? undefined : "steps not echoed") }
  );
}
const plan = await t(
  "testplan_test_plan_write",
  { action: "create", project, name: `[${tag}] plan`, iteration: iterationPath, description: tag },
  { check: (d) => (d?.id && d?.rootSuite?.id ? undefined : "no plan/root suite id") }
);
created.plan = plan;
if (plan?.id) {
  const suite = await t(
    "testplan_test_suite_write",
    { action: "create", project, planId: plan.id, parentSuiteId: plan.rootSuite.id, name: "smoke suite" },
    { check: (d) => (d?.id ? undefined : "no suite id") }
  );
  if (suite?.id && testCase?.id) await t("testplan_test_suite_write", { action: "add_test_cases", project, planId: plan.id, suiteId: suite.id, testCaseIds: [String(testCase.id)] });
  else skip("testplan_test_suite_write:add_test_cases", "suite or test case missing");
  await t("testplan", { action: "list_plans", project, filterActivePlans: false, includePlanDetails: true }, { check: (d, txt) => (txt.includes(String(plan.id)) ? undefined : "plan not listed") });
  await t("testplan", { action: "list_suites", project, planId: plan.id }, { check: (d, txt) => (suite?.id && txt.includes(String(suite.id)) ? undefined : "suite not listed") });
  if (suite?.id)
    await t(
      "testplan",
      { action: "list_cases", project, planId: plan.id, suiteId: suite.id },
      { check: (d, txt) => (testCase?.id && txt.includes(String(testCase.id)) ? undefined : "test case not in suite") }
    );
} else for (const l of ["testplan_test_suite_write:*", "testplan:*"]) skip(l, "plan create failed");

// ================================================================ pipelines
let pipelineId, runId;
if (mainCommit) {
  const pipeline = await t(
    "pipelines_write",
    { action: "create_pipeline", project, name: tag, folder: "\\mcp-smoke", yamlPath: "/azure-pipelines.yml", repositoryType: "AzureReposGit", repositoryName: tag, repositoryId: repo.id },
    { check: (d) => (d?.id ? undefined : "no pipeline id") }
  );
  pipelineId = pipeline?.id;
  created.pipelineId = pipelineId;
}
if (pipelineId) {
  await t("pipelines_write", { action: "rename_pipeline", project, pipelineId, name: `${tag}-renamed` }, { check: (d, txt) => (txt.includes("renamed") ? undefined : "rename not echoed") });
  await t("pipelines_definition", { action: "list", project, name: `${tag}-renamed` }, { check: (d, txt) => (txt.includes(String(pipelineId)) ? undefined : "definition not listed") });
  await t("pipelines_definition", { action: "list_revisions", project, definitionId: pipelineId }, { check: (d) => (arr(d).length >= 2 ? undefined : "expected >= 2 revisions after rename") });
  await t(
    "pipelines_write",
    { action: "run_pipeline", project, pipelineId, previewRun: true },
    { check: (d, txt) => (txt.includes("finalYaml") || txt.includes("stage") ? undefined : "no preview YAML") }
  );
  const run = await t("pipelines_write", { action: "run_pipeline", project, pipelineId, templateParameters: { smokeTag: tag } }, { check: (d) => (d?.id ? undefined : "no run id") });
  runId = run?.id;
}
if (runId) {
  await t("pipelines_run", { action: "list", project, pipelineId }, { check: (d, txt) => (txt.includes(String(runId)) ? undefined : "run not listed") });
  await t("pipelines_run", { action: "get", project, pipelineId, runId }, { check: (d) => (d?.id === runId ? undefined : "wrong run") });
  await t("pipelines_build", { action: "list", project, definitions: [pipelineId] }, { check: (d, txt) => (txt.includes(String(runId)) ? undefined : "build not listed") });
  console.log(`  … waiting up to ${pipelineTimeoutMs / 1000}s for stage 'Build' of run ${runId} on pool '${pool}'`);
  const timeline = () => rest("GET", `${projUrl}/_apis/build/builds/${runId}/timeline?api-version=6.0`);
  const stageState = async (name) => (await timeline())?.records?.find((r) => r.type === "Stage" && r.identifier === name);
  const buildDone = await poll(async () => ((await stageState("Build"))?.state === "completed" ? true : undefined), pipelineTimeoutMs, 10000);
  if (buildDone) {
    await t("pipelines_build", { action: "get_status", project, buildId: runId }, { check: (d, txt) => (txt.includes("Build") ? undefined : "no stage info") });
    await t(
      "pipelines_build",
      { action: "get_changes", project, buildId: runId },
      { check: (d, txt) => (txt.includes(mainCommit) ? undefined : { warn: "initial commit not in changes (first run of a definition may report none)" }) }
    );
    const logs = await t("pipelines_build_log", { action: "list", project, buildId: runId }, { check: (d) => (arr(d).length ? undefined : "no logs") });
    const logId = arr(logs).at(-1)?.id;
    if (logId) await t("pipelines_build_log", { action: "get_content", project, buildId: runId, logId, startLine: 1, endLine: 50 }, { check: (d, txt) => (txt.length > 20 ? undefined : "empty log") });
    await t("pipelines_artifact", { action: "list", project, buildId: runId }, { check: (d, txt) => (txt.includes("smoke-artifact") ? undefined : "artifact not listed") });
    await t(
      "pipelines_artifact",
      { action: "download", project, buildId: runId, artifactName: "smoke-artifact", destinationPath: "artifacts" },
      { check: () => (existsSync(join(outDir, "artifacts")) ? undefined : "nothing downloaded") }
    );
    await t(
      "testplan_show_test_results_from_build_id",
      { project, buildid: runId },
      { check: (d, txt) => (txt.includes("fails") || txt.includes("passes") ? undefined : "published test results missing") }
    );
    await t(
      "testplan_show_test_results_from_build_id",
      { project, buildid: runId, outcomes: ["Failed"] },
      { check: (d, txt) => (txt.includes("fails") && !txt.includes('"passes"') ? undefined : "outcome filter not applied") }
    );
    if (bugId) await t("wit_work_item_link_write", { action: "add_artifact_link", project, workItemId: bugId, buildId: runId, linkType: "Found in build" });

    // stage control on the long-running 'Slow' stage
    const slowRunning = await poll(async () => ((await stageState("Slow"))?.state === "inProgress" ? true : undefined), 180000, 5000);
    if (slowRunning) {
      await t("pipelines_write", { action: "update_build_stage", project, buildId: runId, stageName: "Slow", status: "Cancel" });
      const canceled = await poll(async () => ((await rest("GET", `${projUrl}/_apis/build/builds/${runId}?api-version=6.0`)).status === "completed" ? true : undefined), 180000, 5000);
      if (canceled) {
        await t("pipelines_write", { action: "update_build_stage", project, buildId: runId, stageName: "Slow", status: "Retry", forceRetryAllJobs: true });
        const retried = await poll(async () => ((await stageState("Slow"))?.state !== "completed" ? true : undefined), 60000, 3000);
        if (!retried) results.at(-1).status = "WARN";
        await setup("cancel retried run", () => rest("PATCH", `${projUrl}/_apis/build/builds/${runId}?api-version=6.0`, { status: "cancelling" }));
      } else skip("pipelines_write:update_build_stage", "build did not finish after stage cancel");
    } else skip("pipelines_write:update_build_stage", "'Slow' stage never started");
  } else {
    console.log("  … pipeline did not finish; is an agent online in that pool?");
    for (const l of [
      "pipelines_build:get_status",
      "pipelines_build:get_changes",
      "pipelines_build_log:*",
      "pipelines_artifact:*",
      "testplan_show_test_results_from_build_id",
      "pipelines_write:update_build_stage",
    ])
      skip(l, `stage 'Build' did not complete within ${pipelineTimeoutMs / 1000}s (pool '${pool}')`);
    await setup("cancel stuck run", () => rest("PATCH", `${projUrl}/_apis/build/builds/${runId}?api-version=6.0`, { status: "cancelling" }));
  }
} else skip("pipelines_*", "pipeline create/run failed");

// ================================================================ search (pre-existing content; new content is not indexed immediately)
await t("search_code", { searchText, top: 5 }, { check: (d, txt) => (/"count":\s*0\b/.test(txt) ? { warn: `no code results for '${searchText}'` } : undefined) });
await t("search_workitem", { searchText: tag, project: [project], top: 5 }, { check: (d, txt) => (txt.includes(tag) ? undefined : { warn: "new work items not indexed yet" }) });
await t("search_wiki", { searchText: "Sandbox", project: [project], top: 5 }, { check: (d, txt) => (txt.includes(tag) ? undefined : { warn: "new wiki not indexed yet" }) });
await t("repo_search_commits", { searchText: "smoke", repository: [tag], top: 5 }, { xfail: "commit search is not available on Azure DevOps Server" });

// ================================================================ advanced security (cloud-only)
await t("advsec_get_alerts", { project, repository: tag, top: 5 }, { xfail: "Advanced Security is Azure DevOps Services only" });
await t("advsec_get_alert_details", { project, repository: tag, alertId: 1 }, { xfail: "Advanced Security is Azure DevOps Services only" });

await client.close();

// ================================================================ cleanup
if (keep) {
  console.log(`\n--keep: leaving sandbox data in place (repo/pipeline/iteration/wiki named '${tag}')`);
} else {
  console.log("\nCleaning up…");
  const c = (name, fn) => setup(`cleanup ${name}`, fn);
  // Includes the "<repo> CI" pipeline Azure DevOps Server auto-creates when azure-pipelines.yml is pushed to a new repo.
  const definitions = await rest("GET", `${projUrl}/_apis/build/definitions?name=${encodeURIComponent(tag)}*&api-version=6.0`).catch(() => ({ value: [] }));
  for (const definition of definitions.value) {
    const builds = await rest("GET", `${projUrl}/_apis/build/builds?definitions=${definition.id}&api-version=6.0`).catch(() => ({ value: [] }));
    for (const b of builds.value) {
      if (b.status !== "completed") await c(`cancel build ${b.id}`, () => rest("PATCH", `${projUrl}/_apis/build/builds/${b.id}?api-version=6.0`, { status: "cancelling" }));
      await poll(async () => ((await rest("GET", `${projUrl}/_apis/build/builds/${b.id}?api-version=6.0`)).status === "completed" ? true : undefined), 120000, 5000);
      await c(`build ${b.id}`, () => rest("DELETE", `${projUrl}/_apis/build/builds/${b.id}?api-version=6.0`));
    }
    await c(`pipeline ${definition.name}`, () => rest("DELETE", `${projUrl}/_apis/build/definitions/${definition.id}?api-version=6.0`));
  }
  for (const id of created.testCases) await c(`test case ${id}`, () => rest("DELETE", `${projUrl}/_apis/test/testcases/${id}?api-version=6.0-preview.1`));
  if (created.plan?.id) await c("test plan", () => rest("DELETE", `${projUrl}/_apis/testplan/plans/${created.plan.id}?api-version=6.0`));
  for (const id of created.workItems) await c(`work item ${id}`, () => rest("DELETE", `${projUrl}/_apis/wit/workitems/${id}?api-version=6.0`));
  if (created.query?.id) await c("saved query", () => rest("DELETE", `${projUrl}/_apis/wit/queries/${created.query.id}?api-version=6.0`));
  if (created.wiki?.id) await c("wiki", () => rest("DELETE", `${projUrl}/_apis/wiki/wikis/${created.wiki.id}?api-version=6.0`));
  if (created.repo?.id) await c("repository", () => rest("DELETE", `${projUrl}/_apis/git/repositories/${created.repo.id}?api-version=6.0`));
  if (created.teamIteration) await c("team iteration", () => rest("DELETE", `${projUrl}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations/${created.teamIteration}?api-version=6.0`));
  if (created.iteration) {
    const rootIter = await rest("GET", `${projUrl}/_apis/wit/classificationnodes/iterations?api-version=6.0`).catch(() => undefined);
    await c("iteration", () => rest("DELETE", `${projUrl}/_apis/wit/classificationnodes/iterations/${encodeURIComponent(tag)}?$reclassifyId=${rootIter?.id}&api-version=6.0`));
  }
  const cleanupFailures = results.filter((r) => r.label.startsWith("setup:cleanup"));
  console.log(cleanupFailures.length ? `Cleanup incomplete — ${cleanupFailures.length} item(s) left; see report.` : "Cleanup done (deleted repos and work items sit in the project recycle bin).");
}

// ================================================================ report
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
const toolsHit = new Set([...covered].map((l) => l.split(":")[0]));
const missing = [...available].filter((n) => !toolsHit.has(n));
writeFileSync(join(outDir, "report.json"), JSON.stringify({ collection, project, serverUrl, tag, counts, missing, results }, null, 2));
console.log(
  `\n${Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}${missing.length ? `  — tools never called: ${missing.join(", ")}` : `  — all ${available.size} tools called`}`
);
console.log(`Report: ${join(outDir, "report.json")}\nServer log: ${join(outDir, "server.log")}`);
process.exit(counts.FAIL ? 1 : 0);
