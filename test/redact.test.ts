import { describe, it, expect } from "vitest";
import { redactString, redactDeep } from "../src/sync/redact.js";

// Fake, structurally-valid secrets (never real). If any of these survives into output, the
// sanitize step is broken — this is the load-bearing security test.
const CASES: Array<[string, string]> = [
  ["aws-akid", "AKIAIOSFODNN7EXAMPLE"],
  ["github-pat", "ghp_" + "a".repeat(36)],
  ["github-fine", "github_pat_" + "A".repeat(30)],
  ["openai", "sk-" + "abcdEFGH1234".repeat(2)],
  ["anthropic", "sk-ant-api03-" + "Xy1".repeat(10)],
  ["google-api", "AIza" + "B".repeat(35)],
  ["slack-token", "xoxb-123456789012-abcdefghijklmno"],
  ["stripe", "sk_live_" + "0aZ".repeat(9)],
  ["gitlab-pat", "glpat-" + "abcDEF12345".repeat(2)],
  [
    "jwt",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY7 ".trim().replace(" ", "") + ".SflKxwRJSMeKKF2QT4",
  ],
];

describe("redactString token families", () => {
  for (const [label, secret] of CASES) {
    it(`redacts ${label}`, () => {
      const input = `here is a token ${secret} in prose`;
      const { value, count } = redactString(input);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(value).not.toContain(secret);
      expect(value).toContain("«redacted:");
    });
  }

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nAAAABBBBCCCCDDDD\n-----END RSA PRIVATE KEY-----";
    const { value, count } = redactString(`key:\n${pem}\ndone`);
    expect(count).toBe(1);
    expect(value).not.toContain("AAAABBBBCCCC");
    expect(value).toContain("done");
  });

  it("keeps the key name but redacts an assignment value", () => {
    const { value, count } = redactString('API_KEY="supersecretvalue123"');
    expect(count).toBe(1);
    expect(value).toContain("API_KEY");
    expect(value).not.toContain("supersecretvalue123");
  });

  it("redacts only the password in a credentialed URL", () => {
    const { value } = redactString("postgres://user:hunter2pw@db.example.com:5432/app");
    expect(value).toContain("postgres://user:");
    expect(value).toContain("@db.example.com");
    expect(value).not.toContain("hunter2pw");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "We refactored the auth flow and the tests pass now.";
    const { value, count } = redactString(prose);
    expect(count).toBe(0);
    expect(value).toBe(prose);
  });

  it("does not choke on empty input", () => {
    expect(redactString("")).toEqual({ value: "", count: 0 });
  });
});

describe("redactDeep", () => {
  it("walks nested objects and arrays", () => {
    const input = {
      cmd: "curl -H 'authorization: Bearer sk-" + "abcd1234EFGH".repeat(2) + "'",
      nested: { list: ["ghp_" + "b".repeat(36), "plain text"] },
    };
    const { value, count } = redactDeep(input);
    expect(count).toBeGreaterThanOrEqual(2);
    const json = JSON.stringify(value);
    expect(json).not.toContain("ghp_bbbb");
    expect(json).toContain("plain text");
  });

  it("passes through non-string scalars", () => {
    const { value, count } = redactDeep({ n: 5, b: true, z: null });
    expect(count).toBe(0);
    expect(value).toEqual({ n: 5, b: true, z: null });
  });
});
