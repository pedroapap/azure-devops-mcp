import { getOrgUrl, getSearchBaseUrl, getServerOrigin, getServerUrl } from "../../src/server-url";

describe("server-url", () => {
  afterEach(() => {
    delete process.env.SERVER_URL;
  });

  it("uses Azure DevOps Services hosts when SERVER_URL is not set", () => {
    expect(getServerUrl()).toBeUndefined();
    expect(getServerOrigin()).toBeUndefined();
    expect(getOrgUrl("contoso")).toBe("https://dev.azure.com/contoso");
    expect(getSearchBaseUrl("contoso")).toBe("https://almsearch.dev.azure.com/contoso");
  });

  it("treats a blank SERVER_URL as not set", () => {
    process.env.SERVER_URL = "   ";
    expect(getServerUrl()).toBeUndefined();
    expect(getOrgUrl("contoso")).toBe("https://dev.azure.com/contoso");
  });

  it("routes organization and search URLs through an on-premises SERVER_URL", () => {
    process.env.SERVER_URL = "https://ado.contoso.com/tfs/";
    expect(getServerUrl()).toBe("https://ado.contoso.com/tfs");
    expect(getServerOrigin()).toBe("https://ado.contoso.com");
    expect(getOrgUrl("DefaultCollection")).toBe("https://ado.contoso.com/tfs/DefaultCollection");
    expect(getSearchBaseUrl("DefaultCollection")).toBe("https://ado.contoso.com/tfs/DefaultCollection");
  });

  it("returns no origin for an invalid SERVER_URL", () => {
    process.env.SERVER_URL = "not a url";
    expect(getServerOrigin()).toBeUndefined();
  });
});
