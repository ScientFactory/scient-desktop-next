import { describe, expect, it } from "@effect/vitest";

import {
  ENVIRONMENT_DENYLIST,
  ENVIRONMENT_PREFIX_DENYLIST,
  sanitizeComputeEnvironment,
  validateProjectRoot,
} from "./ComputeEnvironmentPolicy.ts";

describe("compute environment policy", () => {
  describe("project root validation", () => {
    it("accepts an absolute canonical path", () => {
      expect(() => validateProjectRoot("/project/root")).not.toThrow();
      expect(validateProjectRoot("/project/root")).toBe("/project/root");
    });

    it("rejects a relative path", () => {
      expect(() => validateProjectRoot("project/root")).toThrow("absolute");
    });

    it("rejects a non-canonical path with traversal segments", () => {
      expect(() => validateProjectRoot("/project/../root")).toThrow("canonical");
    });

    it("rejects a non-canonical path with dot segments", () => {
      expect(() => validateProjectRoot("/project/./root")).toThrow("canonical");
    });
  });

  describe("sanitization", () => {
    it("removes exact denylisted keys", () => {
      const { environment, removedKeys } = sanitizeComputeEnvironment({
        PYTHONPATH: "/evil",
        PYTHONHOME: "/evil",
        HOME: "/user",
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "secret",
      });
      expect(environment["PYTHONPATH"]).toBeUndefined();
      expect(environment["PYTHONHOME"]).toBeUndefined();
      expect(environment["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(environment["HOME"]).toBe("/user");
      expect(environment["PATH"]).toBe("/usr/bin");
      expect(removedKeys).toContain("PYTHONPATH");
      expect(removedKeys).toContain("PYTHONHOME");
      expect(removedKeys).toContain("ANTHROPIC_API_KEY");
    });

    it("removes prefix-matched keys", () => {
      const { environment, removedKeys } = sanitizeComputeEnvironment({
        SCIENT_DB_PASSWORD: "secret",
        SCIENT_API_TOKEN: "token",
        T3_PAIRING_KEY: "key",
        OPENAI_ORG_ID: "org",
        HOME: "/user",
      });
      expect(environment["SCIENT_DB_PASSWORD"]).toBeUndefined();
      expect(environment["SCIENT_API_TOKEN"]).toBeUndefined();
      expect(environment["T3_PAIRING_KEY"]).toBeUndefined();
      expect(environment["OPENAI_ORG_ID"]).toBeUndefined();
      expect(environment["HOME"]).toBe("/user");
      expect(removedKeys).toContain("SCIENT_DB_PASSWORD");
      expect(removedKeys).toContain("T3_PAIRING_KEY");
    });

    it("preserves ordinary runtime variables", () => {
      const { environment } = sanitizeComputeEnvironment({
        HOME: "/user",
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TMPDIR: "/tmp",
        DISPLAY: ":0",
        LD_LIBRARY_PATH: "/usr/local/lib",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
      });
      expect(environment["HOME"]).toBe("/user");
      expect(environment["PATH"]).toBe("/usr/bin:/bin");
      expect(environment["LANG"]).toBe("en_US.UTF-8");
      expect(environment["TMPDIR"]).toBe("/tmp");
      expect(environment["DISPLAY"]).toBe(":0");
    });

    it("sets UTF-8 and unbuffered overrides", () => {
      const { environment } = sanitizeComputeEnvironment({});
      expect(environment["PYTHONUTF8"]).toBe("1");
      expect(environment["PYTHONUNBUFFERED"]).toBe("1");
    });

    it("overrides existing PYTHONUTF8 and PYTHONUNBUFFERED", () => {
      const { environment } = sanitizeComputeEnvironment({
        PYTHONUTF8: "0",
        PYTHONUNBUFFERED: "0",
      });
      expect(environment["PYTHONUTF8"]).toBe("1");
      expect(environment["PYTHONUNBUFFERED"]).toBe("1");
    });

    it("sets Jupyter runtime directory when provided", () => {
      const { environment } = sanitizeComputeEnvironment(
        { JUPYTER_CONFIG_DIR: "/evil" },
        { jupyterRuntimeDir: "/app/tmp/jupyter" },
      );
      expect(environment["JUPYTER_RUNTIME_DIR"]).toBe("/app/tmp/jupyter");
      expect(environment["JUPYTER_CONFIG_DIR"]).toBeUndefined();
    });

    it("does not expose any environment value in removed keys", () => {
      const { removedKeys } = sanitizeComputeEnvironment({
        ANTHROPIC_API_KEY: "sk-very-secret",
        SCIENT_DB_PASSWORD: "hunter2",
      });
      for (const key of removedKeys) {
        expect(key).not.toContain("sk-very-secret");
        expect(key).not.toContain("hunter2");
      }
    });

    it("every denylisted key is removed", () => {
      const hostEnv: Record<string, string> = {};
      for (const key of ENVIRONMENT_DENYLIST) hostEnv[key] = "test";
      const { removedKeys } = sanitizeComputeEnvironment(hostEnv);
      for (const key of ENVIRONMENT_DENYLIST) {
        expect(removedKeys).toContain(key);
      }
    });

    it("every prefix-matched key is removed", () => {
      const hostEnv: Record<string, string> = {};
      for (const prefix of ENVIRONMENT_PREFIX_DENYLIST) {
        hostEnv[prefix + "TEST"] = "test";
      }
      const { removedKeys } = sanitizeComputeEnvironment(hostEnv);
      for (const prefix of ENVIRONMENT_PREFIX_DENYLIST) {
        expect(removedKeys).toContain(prefix + "TEST");
      }
    });
  });
});
