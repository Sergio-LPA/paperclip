import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePaperclipSkillSymlink,
  materializePaperclipSkillCopy,
} from "./server-utils";

async function makeSource(root: string, body: string): Promise<string> {
  const source = path.join(root, "source", "sample-skill");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), body, "utf8");
  return source;
}

describe("ensurePaperclipSkillSymlink vs a stale materialized copy", () => {
  it("replaces a stale managed copy with a symlink to the live source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nub8692-"));
    const source = await makeSource(root, "STUB\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(path.dirname(target), { recursive: true });

    // A materialized copy holding the old content.
    await materializePaperclipSkillCopy(source, target);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);

    // The source is edited afterwards.
    await fs.writeFile(path.join(source, "SKILL.md"), "REAL CONTENT\n", "utf8");

    const result = await ensurePaperclipSkillSymlink(source, target);
    expect(result).toBe("repaired");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(target)).toBe(source);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("REAL CONTENT\n");
  });

  it("leaves a fresh managed copy alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nub8692-"));
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await materializePaperclipSkillCopy(source, target);

    expect(await ensurePaperclipSkillSymlink(source, target)).toBe("skipped");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
  });

  it("leaves a non-Paperclip directory alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nub8692-"));
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "hand written\n", "utf8");

    expect(await ensurePaperclipSkillSymlink(source, target)).toBe("skipped");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("hand written\n");
  });

  it("still creates the symlink when nothing is there", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nub8692-"));
    const source = await makeSource(root, "REAL CONTENT\n");
    const target = path.join(root, "home", "sample-skill--0a8c11691b");
    await fs.mkdir(path.dirname(target), { recursive: true });

    expect(await ensurePaperclipSkillSymlink(source, target)).toBe("created");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  });
});
