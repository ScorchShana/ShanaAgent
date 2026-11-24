import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SkillLoadError,
  listSkillNames,
  loadSkill,
  renderSkillMessage,
  splitSkillCommand,
  type SkillSnapshot,
} from "../../src/core/skills.js";
import {
  cleanupTempDirs,
  createDirLink,
  supportsDirectoryLinks,
  supportsFileSymlinks,
  tempDir,
  writeFileAt,
} from "../tools/helpers.js";

afterEach(cleanupTempDirs);

const DIR_LINKS = supportsDirectoryLinks();
const FILE_SYMLINKS = supportsFileSymlinks();

function makeSkill(root: string, name: string, content: string): string {
  return writeFileAt(root, `${name}/SKILL.md`, content);
}

function expectLoadError(fn: () => unknown, code: string, name: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SkillLoadError);
    expect((error as SkillLoadError).code).toBe(code);
    expect((error as SkillLoadError).skillName).toBe(name);
    return;
  }
  throw new Error(`expected SkillLoadError(${code})`);
}

describe("loadSkill — 加载与校验", () => {
  it("成功加载：location 为 realpath，content 剥 frontmatter 并 trim", () => {
    const root = tempDir("shana-skills-");
    const file = makeSkill(root, "review", "---\ndescription: x\n---\n\n# Review\n\nbody\n");
    const skill = loadSkill("review", root);
    expect(skill.name).toBe("review");
    expect(skill.location).toBe(fs.realpathSync.native(file));
    expect(skill.content).toBe("# Review\n\nbody");
  });

  it("非法 name 一律 invalid_name：大写、traversal、绝对路径、NUL、空、首字符非法", () => {
    const root = tempDir("shana-skills-");
    for (const name of ["Review", "../evil", "a/../b", "/abs", "a\0b", "", "-lead", "_lead", "a b"]) {
      expectLoadError(() => loadSkill(name, root), "invalid_name", name);
    }
  });

  it("目录或 SKILL.md 缺失 → not_found", () => {
    const root = tempDir("shana-skills-");
    expectLoadError(() => loadSkill("ghost", root), "not_found", "ghost");
    fs.mkdirSync(path.join(root, "empty"));
    expectLoadError(() => loadSkill("empty", root), "not_found", "empty");
  });

  it("skills 根不存在 → not_found（根 realpath 回退不炸）", () => {
    const root = path.join(tempDir("shana-skills-"), "missing");
    expectLoadError(() => loadSkill("review", root), "not_found", "review");
  });

  it("读取失败与非法 UTF-8 → io", () => {
    const root = tempDir("shana-skills-");
    // SKILL.md 是目录：realpath 成功但读取 EISDIR。
    fs.mkdirSync(path.join(root, "broken", "SKILL.md"), { recursive: true });
    expectLoadError(() => loadSkill("broken", root), "io", "broken");
    writeFileAt(root, "badenc/SKILL.md", Buffer.from([0xff, 0xfe, 0x00]));
    expectLoadError(() => loadSkill("badenc", root), "io", "badenc");
  });

  it("目录链接逃逸到 skills 根外 → escape", () => {
    if (!DIR_LINKS) return;
    const root = tempDir("shana-skills-");
    const outside = tempDir("shana-outside-");
    makeSkill(outside, "evil", "secret");
    createDirLink(path.join(outside, "evil"), path.join(root, "evil"));
    expectLoadError(() => loadSkill("evil", root), "escape", "evil");
  });

  it("SKILL.md 文件符号链接逃逸 → escape；根内链接放行", () => {
    if (!FILE_SYMLINKS) return;
    const root = tempDir("shana-skills-");
    const outside = tempDir("shana-outside-");
    const outsideFile = writeFileAt(outside, "SKILL.md", "secret");
    fs.mkdirSync(path.join(root, "evil"));
    fs.symlinkSync(outsideFile, path.join(root, "evil", "SKILL.md"), "file");
    expectLoadError(() => loadSkill("evil", root), "escape", "evil");

    const inner = makeSkill(root, "real", "inner body");
    fs.mkdirSync(path.join(root, "alias"));
    fs.symlinkSync(inner, path.join(root, "alias", "SKILL.md"), "file");
    const skill = loadSkill("alias", root);
    expect(skill.location).toBe(fs.realpathSync.native(inner));
    expect(skill.content).toBe("inner body");
  });

  it("skills 根本身是链接时以真实路径为边界", () => {
    if (!DIR_LINKS) return;
    const real = tempDir("shana-skills-real-");
    makeSkill(real, "review", "body");
    const linkRoot = path.join(tempDir("shana-skills-link-"), "skills");
    createDirLink(real, linkRoot);
    const skill = loadSkill("review", linkRoot);
    expect(skill.location).toBe(fs.realpathSync.native(path.join(real, "review", "SKILL.md")));
  });
});

describe("stripFrontmatter 边界（经 loadSkill 观察）", () => {
  function contentOf(raw: string): string {
    const root = tempDir("shana-skills-");
    makeSkill(root, "fm", raw);
    return loadSkill("fm", root).content;
  }

  it("无闭合 --- 视同无 frontmatter，原文保留", () => {
    expect(contentOf("---\ndescription: x\nbody")).toBe("---\ndescription: x\nbody");
  });

  it("非开头 --- 不剥", () => {
    expect(contentOf("intro\n---\na\n---\nb")).toBe("intro\n---\na\n---\nb");
    expect(contentOf("----\na\n---\nb")).toBe("----\na\n---\nb");
  });

  it("CRLF 开头与闭合均剥", () => {
    expect(contentOf("---\r\ndescription: x\r\n---\r\nbody\r\n")).toBe("body");
  });

  it("CRLF checkout 归一：快照恒存 LF，孤立 CR 保留", () => {
    const root = tempDir("shana-skills-");
    makeSkill(root, "crlf", "---\r\ndescription: x\r\n---\r\n\r\n# Title\r\n\r\na\r\nb\rc\r\n");
    expect(loadSkill("crlf", root).content).toBe("# Title\n\na\nb\rc");
  });

  it("空 frontmatter 与 EOF 处闭合（无尾随换行）", () => {
    expect(contentOf("---\n---\nbody")).toBe("body");
    expect(contentOf("---\na: b\n---")).toBe("");
  });

  it("闭合行必须恰为 ---，---- 不算闭合", () => {
    expect(contentOf("---\na: b\n----\nbody")).toBe("---\na: b\n----\nbody");
  });
});

describe("splitSkillCommand", () => {
  it("非 /skill: 前缀返回 null", () => {
    expect(splitSkillCommand("hello")).toBeNull();
    expect(splitSkillCommand("/skill review")).toBeNull();
    expect(splitSkillCommand("x /skill:review")).toBeNull();
    expect(splitSkillCommand("/Skill:review")).toBeNull();
  });

  it("剥命令 token 与其后空白，请求其余逐字保留", () => {
    expect(splitSkillCommand("/skill:review fix the bug")).toEqual({
      name: "review",
      request: "fix the bug",
    });
    expect(splitSkillCommand("/skill:review\nline1\nline2")).toEqual({
      name: "review",
      request: "line1\nline2",
    });
    expect(splitSkillCommand("/skill:review   spaced  ")).toEqual({
      name: "review",
      request: "spaced  ",
    });
  });

  it("空请求与空 name 可解析（name 合法性由 loadSkill 把关）", () => {
    expect(splitSkillCommand("/skill:review")).toEqual({ name: "review", request: "" });
    expect(splitSkillCommand("/skill:review  \n")).toEqual({ name: "review", request: "" });
    expect(splitSkillCommand("/skill:")).toEqual({ name: "", request: "" });
    expect(splitSkillCommand("/skill:Bad name")).toEqual({ name: "Bad", request: "name" });
  });
});

describe("renderSkillMessage — §2.1 权威格式", () => {
  const skill: SkillSnapshot = {
    name: "review",
    location: path.join("/skills", "review", "SKILL.md"),
    content: "# Review\n\nbody",
  };

  it("完整形态：属性 + 三行引导语 + 空行 + 正文 + 闭合 + 空行 + 请求逐字", () => {
    const text = renderSkillMessage(skill, "fix  it\nnow");
    const dir = path.dirname(skill.location);
    expect(text).toBe(
      `<skill name="review" location="${skill.location}">\n` +
        "This skill was explicitly invoked by the user. Follow its instructions for the request below.\n" +
        "The `SKILL.md` instructions are already included below. No need to reload `SKILL.md`.\n" +
        `References are relative to \`${dir}\`.\n` +
        "\n# Review\n\nbody\n</skill>\n\nfix  it\nnow",
    );
  });

  it("空请求以 </skill> 结束，不追加空行", () => {
    const text = renderSkillMessage(skill, "");
    expect(text.endsWith("</skill>")).toBe(true);
  });

  it('name/location 做 XML 属性转义（& < > "），References 目录同步转义', () => {
    const tricky: SkillSnapshot = {
      name: 'a&<>"',
      location: '/s &<>" dir/SKILL.md',
      content: "body",
    };
    const text = renderSkillMessage(tricky, "req");
    expect(
      text.startsWith('<skill name="a&amp;&lt;&gt;&quot;" location="/s &amp;&lt;&gt;&quot; dir/SKILL.md">'),
    ).toBe(true);
    expect(text).toContain("References are relative to `/s &amp;&lt;&gt;&quot; dir`.");
  });

  it("content 中 </skill> 转义防提前闭合，其余正文不动", () => {
    const text = renderSkillMessage({ ...skill, content: "a </skill> b <skill> c" }, "");
    expect(text).toContain("a &lt;/skill&gt; b <skill> c");
    expect(text.indexOf("</skill>")).toBe(text.lastIndexOf("</skill>"));
  });

  it("引导语模板 CRLF checkout 归一（模块缓存经 resetModules 隔离）", async () => {
    vi.resetModules();
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("line one\r\nline two\r\n"));
    try {
      const fresh = await import("../../src/core/skills.js");
      const text = fresh.renderSkillMessage(skill, "");
      expect(text).toContain("line one\nline two");
      expect(text).not.toContain("\r");
    } finally {
      read.mockRestore();
      vi.resetModules();
    }
  });
});

describe("listSkillNames", () => {
  it("缺目录/不可读 → 空列表不报错", () => {
    expect(listSkillNames(path.join(tempDir("shana-skills-"), "missing"))).toEqual([]);
    const file = writeFileAt(tempDir("shana-skills-"), "not-a-dir", "x");
    expect(listSkillNames(file)).toEqual([]);
  });

  it("只取匹配字符集的子目录名，排序，不检查 SKILL.md 存在性", () => {
    const root = tempDir("shana-skills-");
    fs.mkdirSync(path.join(root, "zeta"));
    fs.mkdirSync(path.join(root, "alpha"));
    fs.mkdirSync(path.join(root, "Bad"));
    fs.mkdirSync(path.join(root, "-lead"));
    writeFileAt(root, "plain.txt", "x");
    makeSkill(root, "beta", "body");
    expect(listSkillNames(root)).toEqual(["alpha", "beta", "zeta"]);
  });
});
