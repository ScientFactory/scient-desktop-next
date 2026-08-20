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

    it("removes the Jupyter overrides that can redirect code, and keeps the one that cannot", () => {
      const { environment } = sanitizeComputeEnvironment({
        JUPYTER_CONFIG_DIR: "/evil",
        JUPYTER_PATH: "/evil",
        JUPYTER_DATA_DIR: "/evil",
        IPYTHONDIR: "/evil",
        // Only chooses where the connection file goes, and a container may have
        // exactly one writable directory to put it in.
        JUPYTER_RUNTIME_DIR: "/run/user/1000/jupyter",
      });
      expect(environment["JUPYTER_CONFIG_DIR"]).toBeUndefined();
      expect(environment["JUPYTER_PATH"]).toBeUndefined();
      expect(environment["JUPYTER_DATA_DIR"]).toBeUndefined();
      expect(environment["IPYTHONDIR"]).toBeUndefined();
      expect(environment["JUPYTER_RUNTIME_DIR"]).toBe("/run/user/1000/jupyter");
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

    it("removes a denied key whatever case the host spelled it in", () => {
      // Windows treats these as one variable and so does Python there, so a
      // host that exported `PythonPath` is exporting PYTHONPATH.
      const { environment, removedKeys } = sanitizeComputeEnvironment({
        PythonPath: "/evil",
        pythonhome: "/evil",
        Anthropic_Api_Key: "secret",
        scient_db_password: "secret",
        t3_pairing_key: "key",
        HOME: "/user",
      });
      expect(
        Object.keys(environment)
          .filter((key) => key !== "HOME")
          .sort(),
      ).toEqual(["PYTHONUNBUFFERED", "PYTHONUTF8"]);
      expect(removedKeys.toSorted()).toEqual([
        "Anthropic_Api_Key",
        "PythonPath",
        "pythonhome",
        "scient_db_password",
        "t3_pairing_key",
      ]);
    });

    it("leaves one spelling of each override, not two", () => {
      const { environment } = sanitizeComputeEnvironment({
        pythonutf8: "0",
        PythonUnbuffered: "0",
      });
      expect(environment).toEqual({ PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" });
    });

    it("removes the sign-in tokens this application was started with", () => {
      // Named rather than left to the exhaustive case below, because these are
      // the credentials likeliest to actually be present -- the server process
      // is holding them -- and neither is covered by any prefix.
      const { environment, removedKeys } = sanitizeComputeEnvironment({
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        GH_TOKEN: "token",
        ANTHROPIC_AUTH_TOKEN: "token",
        PATH: "/usr/bin",
      });
      expect(Object.keys(environment).toSorted()).toEqual([
        "PATH",
        "PYTHONUNBUFFERED",
        "PYTHONUTF8",
      ]);
      expect(removedKeys.toSorted()).toEqual([
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GH_TOKEN",
      ]);
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
