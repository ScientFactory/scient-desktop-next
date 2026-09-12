/** Source spans for recovery only. This is not a replacement Mermaid parser. */
export interface MermaidSourceSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export const MERMAID_RECOVERY_ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_]|-(?![-.>=]))*/u;
export const MERMAID_RECOVERY_LINK =
  /^(?:-\.[ \t]+-->|<-->|<--|-->|---|==>|===|-\.->|-\.-|--o|--x|->)/;

export function isEscaped(source: string, index: number): boolean {
  let preceding = index - 1;
  while (preceding >= 0 && source[preceding] === "\\") preceding -= 1;
  return (index - preceding - 1) % 2 === 1;
}

/** A quoted square label supplies its own boundary; bare labels do not. */
export function hasMissingQuotedSquareClose(text: string, afterQuote: number): boolean {
  let afterSpace = afterQuote;
  while (text[afterSpace] === " " || text[afterSpace] === "\t") afterSpace += 1;
  return MERMAID_RECOVERY_LINK.test(text.slice(afterSpace));
}

/**
 * Keep multiline strings, shape data, accessibility text and directives opaque.
 * Separators outside those spans retain original UTF-16 offsets and line endings.
 * Brackets protect flowchart labels and class/state bodies. Other families use
 * punctuation (including semicolons) in free text, not as statement separators.
 */
export function recoveryStatements(
  source: string,
  from: number,
  bracketed: boolean,
  semicolons: boolean,
): MermaidSourceSpan[] {
  const result: MermaidSourceSpan[] = [];
  let start = from;
  let quoteStart = -1;
  let pipeLabel = false;
  const brackets: { character: string; index: number }[] = [];
  let opaqueEnd: string | null = null;
  const push = (end: number) => {
    const raw = source.slice(start, end);
    const text = raw.trim();
    if (text) {
      const contentStart = start + raw.indexOf(text);
      result.push({ start: contentStart, end: contentStart + text.length, text });
    }
  };
  for (let i = from; i < source.length; i += 1) {
    if (i === start) {
      // Metadata owns the rest of its physical line, including punctuation,
      // quotes and diagram-looking fragments. It is never executable syntax.
      const metadata = /^[ \t]*acc(?:Title|Descr)[ \t]*:[^\r\n]*/.exec(source.slice(i));
      if (metadata) {
        i += metadata[0].length;
        push(i);
        if (source[i] === "\r" && source[i + 1] === "\n") i += 1;
        start = i + 1;
        continue;
      }
    }
    const character = source[i]!;
    if (opaqueEnd) {
      if (source.startsWith(opaqueEnd, i)) {
        i += opaqueEnd.length - 1;
        opaqueEnd = null;
      }
      continue;
    }
    if (character === '"' && !isEscaped(source, i)) {
      if (quoteStart < 0) quoteStart = i;
      else {
        const bracket = brackets.at(-1);
        if (
          bracket?.character === "[" &&
          bracket.index === quoteStart - 1 &&
          hasMissingQuotedSquareClose(source, i + 1)
        )
          brackets.pop();
        quoteStart = -1;
      }
      continue;
    }
    if (quoteStart >= 0) continue;
    if (semicolons && !brackets.length && character === "|") {
      pipeLabel = !pipeLabel;
      continue;
    }
    if (pipeLabel) continue;
    if (source.startsWith("%%{", i)) {
      opaqueEnd = "}%%";
      i += 2;
      continue;
    }
    if (source.startsWith("%%", i)) {
      if (!brackets.length) {
        push(i);
        while (i < source.length && !/[\r\n]/.test(source[i]!)) i += 1;
        start = i;
      } else while (i < source.length && !/[\r\n]/.test(source[i]!)) i += 1;
      if (i === source.length) break;
    }
    // Accessibility descriptions can contain arbitrary diagram-looking prose.
    if (character === "{" && !brackets.length && /^\s*accDescr\s*$/.test(source.slice(start, i))) {
      opaqueEnd = "}";
      continue;
    }
    if (bracketed) {
      if ("[({".includes(character)) brackets.push({ character, index: i });
      else if ("])}".includes(character)) {
        if (brackets.at(-1)?.character === { "]": "[", ")": "(", "}": "{" }[character])
          brackets.pop();
        // Mismatched delimiters stay in the same opaque span until EOF.
        else brackets.push({ character, index: i });
      }
    }
    if (
      quoteStart < 0 &&
      brackets.length === 0 &&
      (/[\r\n]/.test(source[i]!) || (semicolons && source[i] === ";"))
    ) {
      push(i);
      if (source[i] === "\r" && source[i + 1] === "\n") i += 1;
      start = i + 1;
    }
  }
  push(source.length);
  return result;
}

/** Only literal single-line text is encoded; rich labels remain native. */
export function quoteMermaidLiteral(text: string): string | null {
  if (!text || /[`$<>\r\n]/.test(text)) return null;
  // Backslash quote escapes have a specific interpretation. Other escapes do not.
  const withoutEscapedQuotes = text.replace(/\\"/g, "");
  if (withoutEscapedQuotes.includes("\\")) return null;
  if ((withoutEscapedQuotes.match(/"/g)?.length ?? 0) % 2 !== 0) return null;
  return `"${text.replace(/\\"|"/g, "#quot;")}"`;
}
