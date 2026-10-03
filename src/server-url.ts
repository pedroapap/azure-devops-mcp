// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// On-premises Azure DevOps Server support: when SERVER_URL is set (e.g. "https://ado.contoso.com/tfs"),
// all requests go to that server instead of the Azure DevOps Services cloud hosts.

function getServerUrl(): string | undefined {
  const serverUrl = process.env.SERVER_URL?.trim().replace(/\/+$/, "");
  return serverUrl ? serverUrl : undefined;
}

function getOrgUrl(orgName: string): string {
  const serverUrl = getServerUrl();
  return serverUrl ? `${serverUrl}/${orgName}` : `https://dev.azure.com/${orgName}`;
}

// On-premises servers host Search at the collection level instead of almsearch.dev.azure.com.
function getSearchBaseUrl(orgName: string): string {
  const serverUrl = getServerUrl();
  return serverUrl ? `${serverUrl}/${orgName}` : `https://almsearch.dev.azure.com/${orgName}`;
}

// Origin (scheme://host:port) of SERVER_URL, or undefined when unset or invalid.
function getServerOrigin(): string | undefined {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return undefined;
  }
  try {
    return new URL(serverUrl).origin;
  } catch {
    return undefined;
  }
}

// Azure DevOps Server rejects Markdown work item fields (/multilineFieldsFormat), so fail early with guidance
// instead of a cryptic server error (or, for $batch calls, a silent per-item failure).
function getMarkdownFieldsUnsupportedError(formats: (string | undefined)[]): string | undefined {
  if (!getServerUrl() || !formats.includes("Markdown")) {
    return undefined;
  }
  return "Markdown format for work item fields is not supported on Azure DevOps Server. Send the content as HTML and set format to 'Html' on every field or item (add_child defaults to 'Markdown', so pass format: 'Html' explicitly).";
}

export { getMarkdownFieldsUnsupportedError, getOrgUrl, getSearchBaseUrl, getServerOrigin, getServerUrl };
