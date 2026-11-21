import { describe, expect, it } from "vitest";
import { matchFirstCommand } from "../../src/security/bash-policy.js";

describe("v1 首命令白名单", () => {
  it.each([
    "ls",
    "pwd",
    "echo",
    "cat",
    "head",
    "tail",
    "wc",
    "which",
    "whoami",
    "hostname",
    "uname",
    "true",
    "false",
  ])("白名单命令 %s 放行", (command) => {
    expect(matchFirstCommand(command)).toBe("allow");
  });

  it("白名单命令带相对路径参数与常规选项放行", () => {
    for (const command of [
      "ls -la",
      "ls -la src sub/dir",
      "cat src/a.ts",
      "cat -n a.txt b.txt",
      "head -20 src/a.ts",
      "wc -l *.ts",
      "which node",
      "uname -a",
      "echo hello world",
      "  pwd  ",
    ]) {
      expect(matchFirstCommand(command)).toBe("allow");
    }
  });

  it("glob 参数放行（纯展开无写副作用）", () => {
    for (const command of ["ls *.ts", "cat file?.txt", "ls [ab].txt", "cat src/**/*.ts"]) {
      expect(matchFirstCommand(command)).toBe("allow");
    }
  });

  it("tail -f 只读长驻由 timeout 兜底，放行", () => {
    expect(matchFirstCommand("tail -f log.txt")).toBe("allow");
  });

  it.each([
    "git status",
    "find . -delete",
    "rm a.txt",
    "node script.js",
    "python -c x",
    "npm install",
    "date -s now",
    "env",
    "printenv",
    "sed -i s/a/b/ f",
    "awk {print}",
    "sort -o out f",
    "tee out.txt",
    "xargs rm",
    "dd if=a of=b",
    "curl http://x",
    "mkdir d",
    "mv a b",
    "cp a b",
    "touch a",
  ])("非白名单命令 %s 询问", (command) => {
    expect(matchFirstCommand(command)).toBe("ask");
  });
});

describe("shell 元字符一律询问", () => {
  it.each([
    ["分号", "ls; rm a"],
    ["后台/与", "ls & rm a"],
    ["逻辑与", "ls && rm a"],
    ["逻辑或", "ls || rm a"],
    ["管道", "ls | tee out"],
    ["重定向写", "echo x > out.txt"],
    ["追加重定向", "echo x >> out.txt"],
    ["重定向读", "cat < in.txt"],
    ["命令替换括号", "echo $(whoami)"],
    ["变量", "echo $HOME"],
    ["变量花括号", "echo ${HOME}"],
    ["反引号", "echo `whoami`"],
    ["换行", "ls\nrm a"],
    ["回车", "ls\rrm a"],
    ["波浪号", "cat ~/x"],
    ["子 shell 括号", "(ls)"],
    ["命令组花括号", "{ ls; }"],
  ])("%s 询问", (_label, command) => {
    expect(matchFirstCommand(command)).toBe("ask");
  });
});

describe("首 token 必须是裸白名单命令名", () => {
  it.each([
    "/bin/ls",
    "./ls",
    "../bin/ls",
    "sub\\ls",
    "C:\\tools\\ls.exe",
    "FOO=bar ls",
    "LS=1 pwd",
  ])("路径/赋值形式 %s 询问", (command) => {
    expect(matchFirstCommand(command)).toBe("ask");
  });
});

describe("参数隐私守卫", () => {
  it.each([
    ["绝对路径", "cat /etc/passwd"],
    ["家目录", "cat ~/.shana/model.json"],
    ["上跳开头", "cat ../secret.txt"],
    ["上跳开头裸", "ls .."],
    ["中间上跳段", "cat src/../secret.txt"],
    ["反斜杠上跳段", "cat src\\..\\secret.txt"],
    ["盘符绝对", "cat C:\\Users\\me\\.shana\\model.json"],
    ["盘符相对", "cat C:secret.txt"],
    ["UNC", "cat \\\\server\\share\\x"],
    ["盘根反斜杠", "cat \\secret.txt"],
    ["双点前缀文件名（保守）", "cat ..notes.txt"],
  ])("%s 询问", (_label, command) => {
    expect(matchFirstCommand(command)).toBe("ask");
  });

  it("普通相对路径与含点文件名不误伤", () => {
    for (const command of ["cat a.txt", "ls .hidden", "ls dir/..."]) {
      expect(matchFirstCommand(command)).toBe("allow");
    }
  });
});

describe("空输入", () => {
  it.each(["", "   ", "\t\n"])("空串/纯空白 %j 询问", (command) => {
    expect(matchFirstCommand(command)).toBe("ask");
  });
});