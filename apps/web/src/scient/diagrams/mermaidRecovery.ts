import {
  hasMissingQuotedSquareClose,
  isEscaped,
  MERMAID_RECOVERY_ID as ID,
  MERMAID_RECOVERY_LINK as LINK,
  quoteMermaidLiteral,
  recoveryStatements,
  type MermaidSourceSpan,
} from "./mermaidRecoverySyntax";

export interface MermaidRecoveryEdit {
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly replacement: string;
  readonly rule:
    | "label"
    | "link"
    | "sequence-separator"
    | "pie-separator"
    | "metadata"
    | "header"
    | "delimiter"
    | "command";
}
export interface MermaidRecovery {
  readonly originalSource: string;
  readonly source: string;
  readonly edits: readonly MermaidRecoveryEdit[];
}
const MAX_EDITS = 256;
export const MAX_MERMAID_SOURCE_LENGTH = 50_000;
const HEADERS = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "pie",
  "classDiagram",
  "stateDiagram-v2",
  "stateDiagram",
  "C4Context",
  "xychart-beta",
  "xychart",
  "quadrantChart",
  "gitGraph",
] as const;
type Kind = (typeof HEADERS)[number];

function edit(
  source: string,
  start: number,
  end: number,
  replacement: string,
  rule: MermaidRecoveryEdit["rule"],
): MermaidRecoveryEdit {
  return { start, end, original: source.slice(start, end), replacement, rule };
}
function sourceLines(source: string): MermaidSourceSpan[] {
  let start = 0;
  const lines: MermaidSourceSpan[] = [];
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    lines.push({ start, end: start + match[0].length, text: match[0].replace(/[\r\n]+$/, "") });
    start += match[0].length;
  }
  return lines;
}

function readHeader(source: string) {
  const lines = sourceLines(source);
  const edits: MermaidRecoveryEdit[] = [];
  const metadata: MermaidSourceSpan[] = [];
  let index = 0;
  if (lines[0]?.text.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index]?.text.trim() !== "---") index += 1;
    if (index === lines.length) return null;
    index += 1;
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    const text = line.text.trim();
    if (text.startsWith("%%{")) {
      while (index < lines.length && !lines[index]!.text.trimEnd().endsWith("}%%")) index += 1;
      if (index === lines.length) return null;
      continue;
    }
    if (!text || text.startsWith("%%")) continue;
    if (/^acc(?:Title|Descr)[ \t]*:[ \t]*\S/.test(text)) {
      metadata.push(line);
      continue;
    }
    const match = /^([ \t]*)([\w-]+)/.exec(line.text);
    if (!match) return null;
    const kind = HEADERS.find((header) => header.toLowerCase() === match[2]!.toLowerCase());
    if (!kind) return null; // Never infer a missing or misspelled diagram family.
    const keywordStart = line.start + match[1]!.length;
    if (match[2] !== kind)
      edits.push(edit(source, keywordStart, keywordStart + match[2]!.length, kind, "header"));
    let consumed = match[0].length;
    if (kind === "flowchart" || kind === "graph") {
      const direction = /^([ \t]+)(LR|RL|TB|TD|BT)\b/i.exec(line.text.slice(consumed));
      if (!direction) return null;
      const at = line.start + consumed + direction[1]!.length;
      if (direction[2] !== direction[2]!.toUpperCase())
        edits.push(edit(source, at, at + 2, direction[2]!.toUpperCase(), "header"));
      consumed += direction[0].length;
    } else {
      const option =
        kind === "pie"
          ? /^(?:[ \t]+showData\b|[ \t]+title[ \t]+[^\r\n;]+)/
          : kind.startsWith("xychart")
            ? /^[ \t]+horizontal\b/
            : kind === "gitGraph"
              ? /^[ \t]+(?:LR|TB|BT)\b/
              : null;
      consumed += option?.exec(line.text.slice(consumed))?.[0].length ?? 0;
    }
    const rest = line.text.slice(consumed);
    const semicolon = /^[ \t]*;/.exec(rest);
    let bodyStart = line.end;
    if (semicolon) bodyStart = line.start + consumed + semicolon[0].length;
    else if (/^[ \t]*%%(?!\{)/.test(rest)) {
      const whitespace = /^[ \t]*/.exec(rest)![0];
      edits.push(
        edit(
          source,
          line.start + consumed,
          line.start + consumed + whitespace.length,
          /\r\n|\n|\r/.exec(source)?.[0] ?? "\n",
          "header",
        ),
      );
    } else if (rest.trim()) return null;
    return { kind, edits, metadata, bodyStart, header: line, inlineBody: !!semicolon };
  }
  return null;
}

const SHAPES = [
  ["([", "])"],
  ["[(", ")]"],
  ["[[", "]]"],
  ["((", "))"],
  ["{{", "}}"],
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
] as const;

/** Accept changes only after consuming the complete flow statement. */
function flowEdits(source: string, span: MermaidSourceSpan): MermaidRecoveryEdit[] {
  const text = span.text;
  if (/[\r\n]/.test(text)) return []; // Multiline labels/data are opaque, not globally disqualifying.
  const edits: MermaidRecoveryEdit[] = [];
  let pos = 0;
  const space = () => {
    while (pos < text.length && /[ \t]/.test(text[pos]!)) pos += 1;
  };
  const label = (open: string, close: string): boolean => {
    pos += open.length;
    const start = pos;
    if (text[pos] === '"') {
      pos += 1;
      while (pos < text.length) {
        if (text[pos] === '"' && !isEscaped(text, pos)) {
          const after = pos + 1;
          const closed = text.startsWith(close, after);
          const missingSquare = open === "[" && !closed && hasMissingQuotedSquareClose(text, after);
          if (closed || missingSquare) {
            const inner = text.slice(start + 1, pos);
            if (inner.includes('"') || inner.includes("\\")) {
              const replacement = quoteMermaidLiteral(inner);
              if (!replacement) return false;
              edits.push(
                edit(source, span.start + start, span.start + after, replacement, "label"),
              );
            }
            if (missingSquare)
              edits.push(edit(source, span.start + after, span.start + after, "]", "delimiter"));
            pos = after + (closed ? close.length : 0);
            return true;
          }
        }
        pos += 1;
      }
      return false;
    }
    const nested: string[] = [];
    while (pos < text.length) {
      if (!nested.length && text.startsWith(close, pos)) {
        const raw = text.slice(start, pos);
        const literal = raw.trim();
        if (/[()[\]{}"]/.test(literal)) {
          const replacement = quoteMermaidLiteral(literal);
          if (replacement) {
            const at = span.start + start + raw.indexOf(literal);
            edits.push(edit(source, at, at + literal.length, replacement, "label"));
          }
        }
        pos += close.length;
        return true;
      }
      const char = text[pos]!;
      // Balance literal parentheses without choosing a different outer shape.
      if (char === "(") nested.push(")");
      else if (char === ")") {
        if (nested.pop() !== ")") return false;
      } else if ("[{}]".includes(char)) {
        if (text.startsWith(open, pos)) return false;
        if (char === "[" || char === "{") nested.push(char === "[" ? "]" : "}");
        else if (nested.pop() !== char) return false;
      }
      pos += 1;
    }
    return false;
  };
  const node = (): boolean => {
    space();
    const id = ID.exec(text.slice(pos));
    if (!id) return false;
    pos += id[0].length;
    const shape = SHAPES.find(([open]) => text.startsWith(open, pos));
    if (shape && !label(shape[0], shape[1])) return false;
    if (text.startsWith(":::", pos)) {
      pos += 3;
      const className = ID.exec(text.slice(pos));
      if (!className) return false;
      pos += className[0].length;
    }
    return true;
  };
  const nodeGroup = (): boolean => {
    if (!node()) return false;
    space();
    while (text[pos] === "&") {
      pos += 1;
      if (!node()) return false;
      space();
    }
    return true;
  };
  space();
  if (
    /^(?:%%|accTitle\b|accDescr\b|style\b|classDef\b|class\b|linkStyle\b|click\b|direction\b|end\b)/.test(
      text.slice(pos),
    )
  )
    return [];
  if (/^subgraph[ \t]+/.test(text.slice(pos))) {
    pos += /^subgraph[ \t]+/.exec(text.slice(pos))![0].length;
    const id = ID.exec(text.slice(pos));
    if (!id) return [];
    pos += id[0].length;
    space();
    if (text[pos] === '"') {
      // Explicit ID and a complete quoted title; never manufacture an ID.
      const title = /^"([^"\\\r\n]*)"[ \t]*(?:%%.*)?$/.exec(text.slice(pos));
      if (!title || !title[1] || /[\u0060$<>]/.test(title[1])) return [];
      edits.push(
        edit(
          source,
          span.start + pos,
          span.start + pos + title[1].length + 2,
          '["' + title[1] + '"]',
          "delimiter",
        ),
      );
      return edits;
    }
    if (text[pos] !== "[" || !label("[", "]")) return [];
    space();
    return pos === text.length || text.startsWith("%%", pos) ? edits : [];
  }
  if (!nodeGroup()) return [];
  while (pos < text.length) {
    space();
    if (pos === text.length || text.startsWith("%%", pos)) return edits;
    const edgeId = /^([\p{L}\p{N}_]+)@/u.exec(text.slice(pos));
    if (edgeId) pos += edgeId[0].length;
    const link = LINK.exec(text.slice(pos));
    if (!link) return [];
    if (link[0] === "->" || /^-\.[ \t]+-->$/.test(link[0])) {
      edits.push(
        edit(
          source,
          span.start + pos,
          span.start + pos + link[0].length,
          link[0] === "->" ? "-->" : "-.->",
          "link",
        ),
      );
    }
    pos += link[0].length;
    space();
    if (text[pos] === "|" && !label("|", "|")) return [];
    if (!nodeGroup()) return [];
  }
  return edits;
}

function sequenceEdits(source: string, spans: readonly MermaidSourceSpan[]): MermaidRecoveryEdit[] {
  const participants = new Set<string>();
  for (const { text } of spans) {
    const declaration =
      /^[ \t]*(?:participant|actor)[ \t]+([\p{L}\p{N}_]+)(?:[ \t]+as[ \t]+[^\r\n]+)?[ \t]*$/u.exec(
        text,
      );
    if (declaration?.[1]) participants.add(declaration[1]);
  }
  const edits: MermaidRecoveryEdit[] = [];
  for (const span of spans) {
    if (/[\r\n]/.test(span.text)) continue;
    const message =
      /^([ \t]*)([\p{L}\p{N}_]+)(--?>>|--?>|--?x|--?\))([+-]?)([\p{L}\p{N}_]+)([ \t]*：[ \t]*|[ \t]+)(\S.*)$/u.exec(
        span.text,
      );
    if (
      message &&
      participants.has(message[2]!) &&
      participants.has(message[5]!) &&
      !/[:：]/.test(message[7]!)
    ) {
      const at = span.start + message.slice(1, 6).join("").length;
      const wide = message[6]!.indexOf("：");
      edits.push(
        wide < 0
          ? edit(source, at, at, ":", "sequence-separator")
          : edit(source, at + wide, at + wide + 1, ":", "sequence-separator"),
      );
      continue;
    }
    const note =
      /^([ \t]*Note[ \t]+(?:over|(?:left|right)[ \t]+of)[ \t]+)([\p{L}\p{N}_]+(?:,[ \t]*[\p{L}\p{N}_]+)?)([ \t]*：[ \t]*|[ \t]+)(\S.*)$/u.exec(
        span.text,
      );
    if (
      note &&
      note[2]!.split(",").every((id) => participants.has(id.trim())) &&
      !/[:：]/.test(note[4]!)
    ) {
      const at = span.start + note[1]!.length + note[2]!.length;
      const wide = note[3]!.indexOf("：");
      edits.push(
        wide < 0
          ? edit(source, at, at, ":", "sequence-separator")
          : edit(source, at + wide, at + wide + 1, ":", "sequence-separator"),
      );
    }
  }
  return edits;
}

function pieEdits(source: string, spans: readonly MermaidSourceSpan[]): MermaidRecoveryEdit[] {
  return spans.flatMap((span) => {
    const text = span.text;
    if (/[\r\n]/.test(text)) return [];
    const quoted = text.startsWith('"');
    const labelEnd = quoted
      ? text.indexOf('"', 1) + 1
      : Math.max(text.lastIndexOf(":"), text.lastIndexOf("："));
    if (labelEnd <= 0) return [];
    const label = text.slice(0, labelEnd).trimEnd();
    if (
      quoted
        ? !/^"[^"\\]*"$/.test(label)
        : /[:："\\]/.test(label) || /^(?:title|accTitle|accDescr|%%)\b/.test(label)
    )
      return [];
    let separatorAt = labelEnd;
    while (text[separatorAt] === " " || text[separatorAt] === "\t") separatorAt += 1;
    const separator = text[separatorAt];
    const hasColon = separator === ":" || separator === "：";
    const hasRepairableDash = quoted && separator === "-";
    if (!hasColon && !hasRepairableDash && (!quoted || separatorAt === labelEnd)) return [];
    const valueStart = separatorAt + (hasColon || hasRepairableDash ? 1 : 0);
    const value = text.slice(valueStart).trim();
    // Inspect an isolated, bounded number: no ambiguous regex split between
    // arbitrary label text, long whitespace and a numeric suffix.
    if (value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
      return [];
    const edits: MermaidRecoveryEdit[] = [];
    if (!quoted) {
      const replacement = quoteMermaidLiteral(label);
      if (!replacement) return [];
      edits.push(edit(source, span.start, span.start + label.length, replacement, "label"));
    }
    if (separator === "：")
      edits.push(
        edit(source, span.start + separatorAt, span.start + separatorAt + 1, ":", "pie-separator"),
      );
    else if (hasRepairableDash)
      edits.push(
        edit(source, span.start + labelEnd, span.start + valueStart, ":", "pie-separator"),
      );
    else if (!hasColon)
      edits.push(edit(source, span.start + labelEnd, span.start + labelEnd, ":", "pie-separator"));
    return edits;
  });
}

/** Only top-level relations; a method, note or class body may contain arrow text. */
function relationEdits(source: string, spans: readonly MermaidSourceSpan[]): MermaidRecoveryEdit[] {
  let note = false;
  return spans.flatMap((span) => {
    const text = span.text.trim();
    if (/^note\b/i.test(text)) {
      note = !text.includes(":") && !text.includes('"');
      return [];
    }
    if (/^end note\b/i.test(text)) {
      note = false;
      return [];
    }
    if (note) return [];
    if (/^(?:%%|accTitle\b|accDescr\b)/.test(text) || /[\r\n"{}]/.test(text)) return [];
    const match =
      /^([ \t]*(?:[\p{L}\p{N}_]+|\[\*\])[ \t]*)(->)([ \t]*(?:[\p{L}\p{N}_]+|\[\*\])(?:[ \t]*:[^\r\n]+)?[ \t]*)$/u.exec(
        span.text,
      );
    return match
      ? [
          edit(
            source,
            span.start + match[1]!.length,
            span.start + match[1]!.length + 2,
            "-->",
            "link",
          ),
        ]
      : [];
  });
}

function chartLabelEdits(
  source: string,
  spans: readonly MermaidSourceSpan[],
  kind: Kind,
): MermaidRecoveryEdit[] {
  const edits: MermaidRecoveryEdit[] = [];
  const quote = (span: MermaidSourceSpan, start: number, raw: string) => {
    const literal = raw.trim();
    if (!literal || literal.startsWith('"')) return;
    const replacement = quoteMermaidLiteral(literal);
    if (!replacement) return;
    const at = span.start + start + raw.indexOf(literal);
    edits.push(edit(source, at, at + literal.length, replacement, "label"));
  };
  for (const span of spans) {
    if (/[\r\n]/.test(span.text)) continue;
    const title = /^([ \t]*title[ \t]+)(.+)$/.exec(span.text);
    if (title) {
      quote(span, title[1]!.length, title[2]!);
      continue;
    }
    if (kind !== "quadrantChart") continue;
    const axis = /^([xy]-axis[ \t]+)(.+)$/.exec(span.text);
    if (axis) {
      const labels = axis[2]!;
      const arrow = labels.indexOf("-->");
      if (
        arrow > 0 &&
        /[ \t]/.test(labels[arrow - 1]!) &&
        /[ \t]/.test(labels[arrow + 3] ?? "") &&
        !labels.includes('"')
      ) {
        quote(span, axis[1]!.length, labels.slice(0, arrow));
        quote(span, axis[1]!.length + arrow + 3, labels.slice(arrow + 3));
      }
      continue;
    }
    const quadrant = /^([ \t]*quadrant-[1-4][ \t]+)([^"]+)$/.exec(span.text);
    if (quadrant) {
      quote(span, quadrant[1]!.length, quadrant[2]!);
      continue;
    }
    const colon = span.text.indexOf(":");
    if (colon <= 0 || colon !== span.text.lastIndexOf(":")) continue;
    const label = span.text.slice(0, colon);
    const point = span.text.slice(colon + 1).trim();
    if (label.includes('"') || point.length > 256) continue;
    const coordinates =
      /^(\[|\()[ \t]*(0(?:\.\d+)?|1(?:\.0+)?)[ \t]*,[ \t]*(0(?:\.\d+)?|1(?:\.0+)?)[ \t]*(\]|\))$/.exec(
        point,
      );
    if (
      !coordinates ||
      (coordinates[1] === "[" && coordinates[4] !== "]") ||
      (coordinates[1] === "(" && coordinates[4] !== ")")
    )
      continue;
    quote(span, 0, label);
    if (coordinates[1] === "(") {
      const pointStart = span.text.indexOf(point, colon + 1);
      edits.push(
        edit(source, span.start + pointStart, span.start + pointStart + 1, "[", "delimiter"),
      );
      edits.push(
        edit(
          source,
          span.start + pointStart + point.length - 1,
          span.start + pointStart + point.length,
          "]",
          "delimiter",
        ),
      );
    }
  }
  return edits;
}

function c4CommandEdits(
  source: string,
  spans: readonly MermaidSourceSpan[],
): MermaidRecoveryEdit[] {
  return spans.flatMap((span) => {
    const match = /^([ \t]*)Persons(?=[ \t]*\()/u.exec(span.text);
    return match
      ? [
          edit(
            source,
            span.start + match[1]!.length,
            span.start + match[1]!.length + 7,
            "Person",
            "command",
          ),
        ]
      : [];
  });
}

function gitCommandEdits(
  source: string,
  spans: readonly MermaidSourceSpan[],
): MermaidRecoveryEdit[] {
  // Known command-position typos only, not fuzzy correction of user identifiers.
  const typos: Readonly<Record<string, string>> = {
    branchz: "branch",
    brach: "branch",
    chekout: "checkout",
  };
  return spans.flatMap((span) => {
    const match = /^([ \t]*)(branchz|brach|chekout)([ \t]+[\p{L}\p{N}_.-]+[ \t]*)$/u.exec(
      span.text,
    );
    return match
      ? [
          edit(
            source,
            span.start + match[1]!.length,
            span.start + match[1]!.length + match[2]!.length,
            typos[match[2]!]!,
            "command",
          ),
        ]
      : [];
  });
}

/** All compatible edits are one bounded candidate. Only full native rendering accepts it. */
export function planMermaidRecovery(source: string): MermaidRecovery | null {
  if (!source || source.startsWith("\uFEFF") || source.length > MAX_MERMAID_SOURCE_LENGTH)
    return null;
  const header = readHeader(source);
  if (!header) return null;
  const { kind, edits, metadata, bodyStart } = header;
  const flowchart = kind === "flowchart" || kind === "graph";
  const spans = recoveryStatements(
    source,
    bodyStart,
    flowchart || kind === "classDiagram" || kind.startsWith("stateDiagram"),
    flowchart,
  );
  if (metadata.length) {
    if (
      !(
        flowchart ||
        ["sequenceDiagram", "pie", "classDiagram", "stateDiagram-v2", "stateDiagram"].includes(kind)
      )
    )
      return null;
    const kinds = metadata.map((span) => span.text.trim().split(":")[0]!.trim());
    if (
      new Set(kinds).size !== kinds.length ||
      kinds.some((name) =>
        spans.some((span) => new RegExp("^\\s*" + name + "\\s*[:{]").test(span.text)),
      )
    )
      return null;
    const newline = /\r\n|\n|\r/.exec(source)?.[0] ?? "\n";
    for (const span of metadata) edits.push(edit(source, span.start, span.end, "", "metadata"));
    const needsNewline =
      header.inlineBody || bodyStart === header.header.start + header.header.text.length;
    edits.push(
      edit(
        source,
        bodyStart,
        bodyStart,
        (needsNewline ? newline : "") +
          metadata.map((span) => source.slice(span.start, span.end)).join(""),
        "metadata",
      ),
    );
  }
  if (flowchart) for (const span of spans) edits.push(...flowEdits(source, span));
  else if (kind === "sequenceDiagram") edits.push(...sequenceEdits(source, spans));
  else if (kind === "pie") edits.push(...pieEdits(source, spans));
  else if (kind === "classDiagram" || kind.startsWith("stateDiagram"))
    edits.push(...relationEdits(source, spans));
  else if (kind.startsWith("xychart") || kind === "quadrantChart")
    edits.push(...chartLabelEdits(source, spans, kind));
  else if (kind === "C4Context") edits.push(...c4CommandEdits(source, spans));
  else if (kind === "gitGraph") edits.push(...gitCommandEdits(source, spans));
  if (!edits.length || edits.length > MAX_EDITS) return null;
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let candidate = "";
  for (const change of edits) {
    if (change.start < cursor || source.slice(change.start, change.end) !== change.original)
      return null;
    candidate += source.slice(cursor, change.start) + change.replacement;
    cursor = change.end;
  }
  candidate += source.slice(cursor);
  if (candidate === source || candidate.length > MAX_MERMAID_SOURCE_LENGTH) return null;
  return { originalSource: source, source: candidate, edits };
}

/** Do not retry loading, security, layout or resource failures as syntax mistakes. */
export function isMermaidSyntaxError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    /^(?:Parse error on line \d+|Lexical error on line \d+|Parsing failed:\s+(?:Lexer|Parse) error on line \d+|No diagram type detected matching given configuration)/.test(
      cause.message,
    )
  );
}
