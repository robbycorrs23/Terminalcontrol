/**
 * Syntax highlighting for fenced code blocks in chat replies — small,
 * dependency-free, and deliberately approximate (comments, strings, numbers,
 * keywords, calls, plus tags/keys/diff lines where those matter). It is a
 * readability aid, not a parser: a misjudged token costs a colour, never
 * content.
 *
 * SAFETY: the output goes to innerHTML (via markdown.ts), so EVERY fragment —
 * token or gap — is escaped here before it is wrapped. The only markup this
 * file ever emits is `<span class="tk-…">`, with class names from a fixed set.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Rule = [cls: string, pattern: string];

const words = (list: string) => `\\b(?:${list.trim().split(/\s+/).join("|")})\\b`;

const C_COMMENT: Rule = ["com", String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`];
const HASH_COMMENT: Rule = ["com", String.raw`#[^\n]*`];
const DQ: Rule = ["str", String.raw`"(?:\\.|[^"\\\n])*"`];
const SQ: Rule = ["str", String.raw`'(?:\\.|[^'\\\n])*'`];
const BT: Rule = ["str", String.raw`\`(?:\\.|[^\`\\])*\``];
const NUM: Rule = ["num", String.raw`\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`];
const CALL: Rule = ["fn", String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`];

const JS_KW = words(`
  async await break case catch class const continue debugger default delete do else enum export extends
  false finally for from function if implements import in instanceof interface let new null of package
  private protected public readonly return static super switch this throw true try type typeof undefined
  var void while with yield as satisfies keyof declare namespace abstract`);
const PY_KW = words(`
  and as assert async await break class continue def del elif else except False finally for from global
  if import in is lambda None nonlocal not or pass raise return self True try while with yield match case`);
const GO_RUST_KW = words(`
  break case chan const continue default defer else fallthrough for func go goto if import interface map
  package range return select struct switch type var fn let mut impl trait pub use mod crate self Self
  match loop while as where enum unsafe async await move ref static dyn true false nil Some None Ok Err`);
const C_KW = words(`
  auto break case char class const continue default delete do double else enum extern float for friend goto
  if inline int long namespace new operator private protected public return short signed sizeof static
  struct switch template this throw try typedef union unsigned using virtual void volatile while bool true
  false nullptr final override import package extends implements boolean byte throws instanceof var val
  fun when object companion data sealed suspend let guard func self Self nil protocol extension`);
const SH_KW = words(`
  if then else elif fi for while until do done case esac function in select return local export unset
  readonly declare source alias exit break continue set shift trap eval exec time`);
const SQL_KW = words(`
  select from where and or not insert into values update set delete create table alter drop index view
  join left right inner outer full on as group by order having limit offset union all distinct case when
  then else end null is in like between exists primary key foreign references default unique begin commit
  rollback transaction returning with asc desc count sum avg min max`);

const LANGS: Record<string, Rule[]> = {
  js: [C_COMMENT, BT, DQ, SQ, NUM, ["kw", JS_KW], CALL],
  py: [["str", String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''`], HASH_COMMENT, DQ, SQ, NUM, ["kw", PY_KW], ["meta", String.raw`@[\w.]+`], CALL],
  go: [C_COMMENT, BT, DQ, SQ, NUM, ["kw", GO_RUST_KW], CALL],
  c: [C_COMMENT, DQ, SQ, NUM, ["meta", String.raw`^\s*#\w+`], ["kw", C_KW], CALL],
  sh: [
    HASH_COMMENT,
    DQ,
    SQ,
    ["var", String.raw`\$\{[^}\n]*\}|\$[\w@*#?$!-]+`],
    ["kw", SH_KW],
    ["fn", String.raw`^[ \t]*(?:\$ )?(?:sudo\s+)?[A-Za-z_][\w.-]*`],
    ["num", String.raw`\s-{1,2}[\w-]+`],
  ],
  json: [["key", String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`], DQ, NUM, ["kw", words("true false null")]],
  css: [["com", String.raw`\/\*[\s\S]*?\*\/`], DQ, SQ, ["num", String.raw`#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b`], ["key", String.raw`[\w-]+(?=\s*:[^;{]*[;}])`], ["kw", String.raw`@[\w-]+|!important`]],
  html: [["com", String.raw`<!--[\s\S]*?-->`], ["tag", String.raw`<\/?[\w:-]+|\/?>`], ["key", String.raw`\b[\w:-]+(?==)`], DQ, SQ],
  sql: [["com", String.raw`--[^\n]*|\/\*[\s\S]*?\*\/`], SQ, DQ, NUM, ["kw", SQL_KW], CALL],
  yaml: [HASH_COMMENT, ["key", String.raw`^[ \t-]*[\w.\- "']+(?=\s*:(?:\s|$))`], DQ, SQ, NUM, ["kw", words("true false null yes no on off")]],
  toml: [HASH_COMMENT, ["meta", String.raw`^\s*\[[^\]\n]+\]`], ["key", String.raw`^\s*[\w.\-"]+(?=\s*=)`], DQ, SQ, NUM, ["kw", words("true false")]],
};

const ALIASES: Record<string, string> = {
  javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", vue: "html", svelte: "html",
  python: "py", py3: "py", rb: "py", ruby: "py",
  golang: "go", rust: "go", rs: "go",
  cpp: "c", "c++": "c", h: "c", hpp: "c", cs: "c", csharp: "c", java: "c", kotlin: "c", kt: "c", swift: "c", php: "c", scala: "c", dart: "c", objc: "c",
  bash: "sh", shell: "sh", zsh: "sh", console: "sh", terminal: "sh", fish: "sh", ps1: "sh", powershell: "sh",
  jsonc: "json", json5: "json",
  scss: "css", sass: "css", less: "css",
  xml: "html", svg: "html", htm: "html",
  postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql", psql: "sql",
  yml: "yaml",
  ini: "toml", conf: "toml", env: "toml", dotenv: "toml",
};

const compiled = new Map<string, { re: RegExp; classes: string[] }>();
function grammar(lang: string) {
  const key = ALIASES[lang] || lang;
  const rules = LANGS[key];
  if (!rules) return null;
  let g = compiled.get(key);
  if (!g) {
    const flags = key === "sql" ? "gmi" : "gm";
    g = { re: new RegExp(rules.map(([, p]) => `(${p})`).join("|"), flags), classes: rules.map(([c]) => c) };
    compiled.set(key, g);
  }
  return g;
}

/** Diff: whole-line colours (the rest of a line is never re-tokenized). */
function diffLines(code: string): string {
  return code
    .split("\n")
    .map((l) => {
      const cls = /^(\+\+\+|---)/.test(l) ? "meta" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "meta" : "";
      return cls ? `<span class="tk-${cls}">${esc(l)}</span>` : esc(l);
    })
    .join("\n");
}

const MAX_CHARS = 30_000; // past this, plain text: a megabyte log isn't worth the regex time

/** Highlighted, fully escaped HTML for one code block. Unknown language → just escaped. */
export function highlight(code: string, lang: string): string {
  const l = (lang || "").toLowerCase();
  if (code.length > MAX_CHARS) return esc(code);
  if (l === "diff" || l === "patch") return diffLines(code);
  const g = grammar(l);
  if (!g) return esc(code);
  let out = "";
  let last = 0;
  g.re.lastIndex = 0;
  for (let m = g.re.exec(code); m; m = g.re.exec(code)) {
    if (m[0] === "") {
      g.re.lastIndex++; // a zero-width match would loop forever
      continue;
    }
    const gi = m.findIndex((v, i) => i > 0 && v !== undefined);
    out += esc(code.slice(last, m.index));
    out += `<span class="tk-${g.classes[gi - 1]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}
