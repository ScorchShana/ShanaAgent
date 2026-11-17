import { describe, expect, it } from "vitest";
import { parseArguments } from "../../src/llm/argument-parser.js";

describe("strict arguments", () => {
  it("rejects numeric overflow recursively before persistence can turn it into null", () => {
    expect(parseArguments('{"nested":[{"n":1e400}]}', true)).toEqual({
      status: "invalid",
      error: "non_finite_number",
    });
    expect(parseArguments('{"n":1e308}', true).status).toBe("parsed");
  });
  it("repairs only complete unambiguous syntax", () => {
    expect(parseArguments('{"x":"a\nb",}', true)).toEqual({ status: "parsed", arguments: { x: "a\nb" } });
    expect(parseArguments('{"x":1,}', false).status).toBe("invalid");
  });
  it("rejects decoded duplicate keys, invalid escapes and non objects", () => {
    expect(parseArguments('{"x":1,"\\u0078":2}', true)).toEqual({
      status: "invalid",
      error: "duplicate_key",
    });
    expect(parseArguments('{"x":"\\q"}', true)).toEqual({ status: "invalid", error: "syntax" });
    expect(parseArguments("[]", true)).toEqual({ status: "invalid", error: "not_object" });
  });
  it("distinguishes incomplete grammar without inferring provider truncation", () => {
    for (const raw of ['{"x":"a', '{"x":', '{"x":1', '{"x":tru']) {
      expect(parseArguments(raw, true)).toEqual({ status: "invalid", error: "incomplete" });
    }
    for (const raw of ["", " ", '{"x":,}', '{"x":1,,}', "{'x':1}"]) {
      expect(parseArguments(raw, true)).toEqual({ status: "invalid", error: "syntax" });
    }
  });
});
