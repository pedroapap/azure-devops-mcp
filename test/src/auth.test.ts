// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createAuthenticator } from "../../src/auth";

jest.mock("../../src/logger.js", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("@azure/msal-node", () => ({
  PublicClientApplication: jest.fn().mockImplementation(() => ({
    acquireTokenSilent: jest.fn(),
    acquireTokenInteractive: jest.fn(),
  })),
}));

jest.mock("@azure/identity", () => ({
  AzureCliCredential: jest.fn(),
  ChainedTokenCredential: jest.fn(),
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({
    getToken: jest.fn(),
  })),
}));

jest.mock("open", () => jest.fn());

describe("createAuthenticator", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("pat authentication", () => {
    it("returns the PAT from AZURE_DEVOPS_PAT environment variable when set", async () => {
      process.env.AZURE_DEVOPS_PAT = "my-personal-access-token";

      const authenticate = createAuthenticator("pat");
      const token = await authenticate();

      expect(token).toBe("my-personal-access-token");
    });

    it("throws an error when AZURE_DEVOPS_PAT is not set", async () => {
      delete process.env.AZURE_DEVOPS_PAT;

      const authenticate = createAuthenticator("pat");

      await expect(authenticate()).rejects.toThrow("AZURE_DEVOPS_PAT environment variable is not set. Please set it with your Personal Access Token.");
    });

    it("throws an error when AZURE_DEVOPS_PAT is an empty string", async () => {
      process.env.AZURE_DEVOPS_PAT = "";

      const authenticate = createAuthenticator("pat");

      await expect(authenticate()).rejects.toThrow("AZURE_DEVOPS_PAT environment variable is not set. Please set it with your Personal Access Token.");
    });

    it("returns a new authenticator function on each call to createAuthenticator, each independently resolving the PAT", async () => {
      process.env.AZURE_DEVOPS_PAT = "shared-token";

      const fn1 = createAuthenticator("pat");
      const fn2 = createAuthenticator("pat");

      expect(fn1).not.toBe(fn2);
      await expect(fn1()).resolves.toBe("shared-token");
      await expect(fn2()).resolves.toBe("shared-token");
    });

    it("reads AZURE_DEVOPS_PAT lazily at call time, not at createAuthenticator time", async () => {
      delete process.env.AZURE_DEVOPS_PAT;
      const authenticate = createAuthenticator("pat");

      // Setting the env var after createAuthenticator is called should still work
      process.env.AZURE_DEVOPS_PAT = "late-set-token";
      const token = await authenticate();

      expect(token).toBe("late-set-token");
    });
  });
});
