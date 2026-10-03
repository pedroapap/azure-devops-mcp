// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";
import { configureWorkItemTools } from "../../../src/tools/work-items";

// On-premises (SERVER_URL) behaviour of wit_work_item_write: Azure DevOps Server rejects Markdown work item fields.
describe("wit_work_item_write on Azure DevOps Server", () => {
  const originalFetch = global.fetch;
  let handler: (params: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  let createWorkItem: jest.Mock;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.SERVER_URL = "https://ado.contoso.com/tfs";
    createWorkItem = jest.fn().mockResolvedValue({ id: 1 });
    fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ count: 1, value: [{ code: 200, body: "{}" }] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const connection = { serverUrl: "https://ado.contoso.com/tfs/DefaultCollection", getWorkItemTrackingApi: jest.fn().mockResolvedValue({ createWorkItem }) };
    const server = { tool: jest.fn(), server: { elicitInput: jest.fn() } } as unknown as McpServer;
    configureWorkItemTools(server, jest.fn<() => Promise<string>>().mockResolvedValue("token"), jest.fn<() => Promise<WebApi>>().mockResolvedValue(connection as unknown as WebApi), () => "Jest");
    const call = (server.tool as jest.Mock).mock.calls.find(([toolName]) => toolName === "wit_work_item_write");
    if (!call) throw new Error("wit_work_item_write tool not registered");
    handler = call[3] as typeof handler;
  });

  afterEach(() => {
    delete process.env.SERVER_URL;
    global.fetch = originalFetch;
  });

  it.each([
    ["create", { project: "Contoso", workItemType: "Task", fields: [{ name: "System.Description", value: "**bold**", format: "Markdown" }] }],
    ["update_batch", { batchUpdates: [{ id: 1, path: "/fields/System.Description", value: "**bold**", format: "Markdown" }] }],
    ["add_child", { project: "Contoso", parentId: 1, workItemType: "Task", items: [{ title: "Child", description: "**bold**", format: "Markdown" }] }],
  ])("rejects Markdown fields for %s before calling the server", async (action, params) => {
    const result = await handler({ action, ...params });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Markdown format for work item fields is not supported on Azure DevOps Server");
    expect(createWorkItem).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates work items with Html fields", async () => {
    const result = await handler({ action: "create", project: "Contoso", workItemType: "Task", fields: [{ name: "System.Description", value: "<b>bold</b>", format: "Html" }] });

    expect(result.isError).toBeUndefined();
    expect(createWorkItem).toHaveBeenCalledWith(null, [{ op: "add", path: "/fields/System.Description", value: "<b>bold</b>" }], "Contoso", "Task");
  });

  it("creates child work items with Html descriptions without a multilineFieldsFormat operation", async () => {
    const result = await handler({ action: "add_child", project: "Contoso", parentId: 1, workItemType: "Task", items: [{ title: "Child", description: "<b>bold</b>", format: "Html" }] });

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://ado.contoso.com/tfs/DefaultCollection/_apis/wit/$batch?api-version=5.0", expect.anything());
    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).not.toContain("multilineFieldsFormat");
  });
});
