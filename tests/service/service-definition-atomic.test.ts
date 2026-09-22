import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeServiceDefinitionFile } from "../../src/service";

test("a failed atomic publish preserves the prior launcher and removes its temporary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-service-atomic-"));
  const path = join(dir, "launcher.vbs");
  const nonce = "publish-failure";
  const temporary = join(dir, `.launcher.vbs.${process.pid}.${nonce}.tmp`);
  try {
    writeFileSync(path, "old-launcher", "utf8");
    const publishError = Object.assign(new Error("simulated publish collision"), { code: "EBUSY" });
    expect(() => writeServiceDefinitionFile(path, "new-launcher", "utf8", {
      uuid: () => nonce,
      rename: () => { throw publishError; },
    })).toThrow("simulated publish collision");
    expect(readFileSync(path, "utf8")).toBe("old-launcher");
    expect(existsSync(temporary)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
