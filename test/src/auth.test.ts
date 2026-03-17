// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { jest } from "@jest/globals";
import { AzureCliCredential, ChainedTokenCredential, DefaultAzureCredential } from "@azure/identity";
import { PublicClientApplication } from "@azure/msal-node";
import { createAuthenticator } from "../../src/auth";

jest.mock("../../src/logger.js", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("open", () => jest.fn().mockResolvedValue(undefined));

jest.mock("@azure/identity", () => ({
  AzureCliCredential: jest.fn(),
  DefaultAzureCredential: jest.fn(),
  ChainedTokenCredential: jest.fn(),
}));

jest.mock("@azure/msal-node", () => ({
  PublicClientApplication: jest.fn(),
}));

describe("createAuthenticator", () => {
  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.AZURE_DEVOPS_PAT;
    delete process.env.ADO_MCP_AUTH_TOKEN;
    delete process.env.AZURE_TOKEN_CREDENTIALS;
  });

  describe("pat strategy", () => {
    it("should return PAT from AZURE_DEVOPS_PAT environment variable", async () => {
      process.env.AZURE_DEVOPS_PAT = "test-pat-value";
      const authenticate = createAuthenticator("pat");
      const token = await authenticate();
      expect(token).toBe("test-pat-value");
    });

    it("should throw when AZURE_DEVOPS_PAT is not set", async () => {
      const authenticate = createAuthenticator("pat");
      await expect(authenticate()).rejects.toThrow("AZURE_DEVOPS_PAT environment variable is not set. Please set it with your Personal Access Token.");
    });
  });

  describe("envvar strategy", () => {
    it("should return token from ADO_MCP_AUTH_TOKEN environment variable", async () => {
      process.env.ADO_MCP_AUTH_TOKEN = "test-envvar-token";
      const authenticate = createAuthenticator("envvar");
      const token = await authenticate();
      expect(token).toBe("test-envvar-token");
    });

    it("should throw when ADO_MCP_AUTH_TOKEN is not set", async () => {
      const authenticate = createAuthenticator("envvar");
      await expect(authenticate()).rejects.toThrow("Environment variable 'ADO_MCP_AUTH_TOKEN' is not set or empty. Please set it with a valid Azure DevOps Personal Access Token.");
    });
  });

  describe("azcli strategy", () => {
    it("should set AZURE_TOKEN_CREDENTIALS to 'dev'", () => {
      jest.mocked(DefaultAzureCredential).mockImplementation(() => ({ getToken: jest.fn().mockResolvedValue({ token: "t" }) }) as never);
      createAuthenticator("azcli");
      expect(process.env.AZURE_TOKEN_CREDENTIALS).toBe("dev");
    });

    it("should return token from DefaultAzureCredential", async () => {
      const mockGetToken = jest.fn().mockResolvedValue({ token: "azcli-token" });
      jest.mocked(DefaultAzureCredential).mockImplementation(() => ({ getToken: mockGetToken }) as never);
      const authenticate = createAuthenticator("azcli");
      const token = await authenticate();
      expect(token).toBe("azcli-token");
    });

    it("should create ChainedTokenCredential when tenantId is provided", async () => {
      const mockChainedGetToken = jest.fn().mockResolvedValue({ token: "chained-token" });
      jest.mocked(DefaultAzureCredential).mockImplementation(() => ({ getToken: jest.fn() }) as never);
      jest.mocked(AzureCliCredential).mockImplementation(() => ({ getToken: jest.fn() }) as never);
      jest.mocked(ChainedTokenCredential).mockImplementation(() => ({ getToken: mockChainedGetToken }) as never);

      const authenticate = createAuthenticator("azcli", "my-tenant-id");
      const token = await authenticate();

      expect(AzureCliCredential).toHaveBeenCalledWith({ tenantId: "my-tenant-id" });
      expect(ChainedTokenCredential).toHaveBeenCalled();
      expect(token).toBe("chained-token");
    });

    it("should throw when credential.getToken returns null", async () => {
      jest.mocked(DefaultAzureCredential).mockImplementation(() => ({ getToken: jest.fn().mockResolvedValue(null) }) as never);
      const authenticate = createAuthenticator("azcli");
      await expect(authenticate()).rejects.toThrow("Failed to obtain Azure DevOps token. Ensure you have Azure CLI logged or use interactive type of authentication.");
    });
  });

  describe("env strategy", () => {
    it("should not set AZURE_TOKEN_CREDENTIALS", () => {
      jest.mocked(DefaultAzureCredential).mockImplementation(() => ({ getToken: jest.fn().mockResolvedValue({ token: "t" }) }) as never);
      createAuthenticator("env");
      expect(process.env.AZURE_TOKEN_CREDENTIALS).toBeUndefined();
    });

    it("should return token from DefaultAzureCredential", async () => {
      const mockGetToken = jest.fn().mockResolvedValue({ token: "env-token" });
      jest.mocked(DefaultAzureCredential).mockImplementation(() => ({ getToken: mockGetToken }) as never);
      const authenticate = createAuthenticator("env");
      const token = await authenticate();
      expect(token).toBe("env-token");
    });

    it("should throw when credential.getToken returns null", async () => {
      jest.mocked(DefaultAzureCredential).mockImplementation(() => ({ getToken: jest.fn().mockResolvedValue(null) }) as never);
      const authenticate = createAuthenticator("env");
      await expect(authenticate()).rejects.toThrow("Failed to obtain Azure DevOps token. Ensure you have Azure CLI logged or use interactive type of authentication.");
    });
  });

  describe("default (OAuth interactive) strategy", () => {
    it("should call acquireTokenInteractive on first call when no account is cached", async () => {
      const account = { homeAccountId: "user-123" };
      const mockAcquireTokenInteractive = jest.fn().mockResolvedValue({ accessToken: "oauth-token", account });
      const mockAcquireTokenSilent = jest.fn();
      jest.mocked(PublicClientApplication).mockImplementation(
        () =>
          ({
            acquireTokenInteractive: mockAcquireTokenInteractive,
            acquireTokenSilent: mockAcquireTokenSilent,
          }) as never
      );

      const authenticate = createAuthenticator("interactive");
      const token = await authenticate();

      expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(1);
      expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
      expect(token).toBe("oauth-token");
    });

    it("should use silent token acquisition after account is cached", async () => {
      const account = { homeAccountId: "user-123" };
      const mockAcquireTokenInteractive = jest.fn().mockResolvedValue({ accessToken: "oauth-token-interactive", account });
      const mockAcquireTokenSilent = jest.fn().mockResolvedValue({ accessToken: "oauth-token-silent", account });
      jest.mocked(PublicClientApplication).mockImplementation(
        () =>
          ({
            acquireTokenInteractive: mockAcquireTokenInteractive,
            acquireTokenSilent: mockAcquireTokenSilent,
          }) as never
      );

      const authenticate = createAuthenticator("interactive");
      await authenticate(); // first call caches account
      const token = await authenticate(); // second call uses silent

      expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(1);
      expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
      expect(token).toBe("oauth-token-silent");
    });

    it("should fall back to interactive auth when silent acquisition fails", async () => {
      const account = { homeAccountId: "user-123" };
      const mockAcquireTokenInteractive = jest.fn().mockResolvedValue({ accessToken: "oauth-token-interactive", account });
      const mockAcquireTokenSilent = jest.fn().mockRejectedValue(new Error("Silent auth failed"));
      jest.mocked(PublicClientApplication).mockImplementation(
        () =>
          ({
            acquireTokenInteractive: mockAcquireTokenInteractive,
            acquireTokenSilent: mockAcquireTokenSilent,
          }) as never
      );

      const authenticate = createAuthenticator("interactive");
      await authenticate(); // first call caches account
      const token = await authenticate(); // second call: silent fails, interactive is used

      expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
      expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(2);
      expect(token).toBe("oauth-token-interactive");
    });

    it("should throw when accessToken is missing from auth result", async () => {
      const mockAcquireTokenInteractive = jest.fn().mockResolvedValue({ accessToken: null, account: null });
      jest.mocked(PublicClientApplication).mockImplementation(
        () =>
          ({
            acquireTokenInteractive: mockAcquireTokenInteractive,
            acquireTokenSilent: jest.fn(),
          }) as never
      );

      const authenticate = createAuthenticator("interactive");
      await expect(authenticate()).rejects.toThrow("Failed to obtain Azure DevOps OAuth token.");
    });

    it("should use tenant-specific authority when tenantId is provided", () => {
      jest.mocked(PublicClientApplication).mockImplementation(
        () =>
          ({
            acquireTokenInteractive: jest.fn().mockResolvedValue({ accessToken: "token", account: null }),
            acquireTokenSilent: jest.fn(),
          }) as never
      );

      createAuthenticator("interactive", "my-tenant-id");

      expect(PublicClientApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({
            authority: "https://login.microsoftonline.com/my-tenant-id",
          }),
        })
      );
    });

    it("should use common authority when tenantId is the zero GUID", () => {
      jest.mocked(PublicClientApplication).mockImplementation(
        () =>
          ({
            acquireTokenInteractive: jest.fn().mockResolvedValue({ accessToken: "token", account: null }),
            acquireTokenSilent: jest.fn(),
          }) as never
      );

      createAuthenticator("interactive", "00000000-0000-0000-0000-000000000000");

      expect(PublicClientApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: expect.objectContaining({
            authority: "https://login.microsoftonline.com/common",
          }),
        })
      );
    });
  });
});
