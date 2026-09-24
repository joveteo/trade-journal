/** Keep whitespace outside emphasis delimiters so toolbar output is valid Markdown. */
export function formatInlineSelection(
  value: string,
  start: number,
  end: number,
  marker: "*" | "**",
) {
  const selected = value.slice(start, end);
  const leading = selected.match(/^\s*/)?.[0] ?? "";
  const content = selected.trim() || (marker === "**" ? "bold text" : "italic text");
  const trailing = selected.trim() ? (selected.match(/\s*$/)?.[0] ?? "") : "";
  const replacement = leading + marker + content + marker + trailing;
  const selectionStart = start + leading.length + marker.length;
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    selectionStart,
    selectionEnd: selectionStart + content.length,
  };
}

const LATEX_SYMBOLS: Record<string, string> = {
  times: "×",
  cdot: "·",
  pm: "±",
  mp: "∓",
  approx: "≈",
  sim: "~",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  le: "≤",
  ge: "≥",
  infty: "∞",
  percent: "%",
};

const decodeLatexBody = (body: string): string => {
  let text = body.trim();
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(
      /\\(?:text|mathrm|operatorname|mathbf|mathit|textrm|textbf|textsf|mbox)\s*\{([^{}]*)\}/g,
      "$1",
    );
    text = text.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1/$2");
    text = text.replace(/\\(?:left|right)\b/g, "");
    text = text.replace(/\\[,; ]|\\(?:quad|qquad)\b/g, " ");
    text = text.replace(/\\([a-zA-Z]+)\b/g, (match, name: string) => LATEX_SYMBOLS[name] ?? match);
    text = text.replace(/\\([%$&#_{}])/g, "$1");
  }
  text = text.replace(/\{([^{}\\]*)\}/g, "$1");
  text = text.replace(/\\[a-zA-Z]+\*?/g, "");
  return text.replace(/\s+/g, " ").trim();
};

/** Flatten model LaTeX (`$\text{net } 2787.32$`) into readable text without touching `$1,901` currency. */
export const decodeLatexMarkup = (source: string): string => {
  const unwrap = (match: string, body: string) => (/\\/.test(body) ? decodeLatexBody(body) : match);
  return source
    .replace(/\$\$([\s\S]+?)\$\$/g, unwrap)
    .replace(/\\\[([\s\S]+?)\\\]/g, unwrap)
    .replace(/\\\(([\s\S]+?)\\\)/g, unwrap)
    .replace(/\$(?=[^$\n]*\\[a-zA-Z])([^$\n]+)\$(?!\$)/g, unwrap)
    .replace(
      /\\(?:text|mathrm|operatorname|mathbf|mathit|textrm|textbf|textsf|mbox)\s*\{([^{}]*)\}/g,
      "$1",
    );
};

interface NoteNode {
  type: string;
  value?: string;
  children?: NoteNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Decode LaTeX in markdown text nodes; code spans and fences stay untouched. */
export function remarkDecodeLatex() {
  return (tree: NoteNode) => {
    const visit = (node: NoteNode) => {
      if (node.type === "text" && node.value) node.value = decodeLatexMarkup(node.value);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** Repair the old toolbar's spaced delimiters at render time; never rewrite saved notes.
 * Only plain text is eligible. Code, escaped stars and already parsed formatting stay intact.
 */
export function remarkRepairSpacedEmphasis() {
  return (tree: NoteNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (parent: NoteNode) => {
      if (!parent.children) return;
      parent.children = parent.children.flatMap((node): NoteNode[] => {
        if (node.type !== "text" || !node.value) {
          visit(node);
          return [node];
        }
        const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
        if (raw !== node.value) return [node];
        const parts: NoteNode[] = [];
        let cursor = 0;
        for (const match of node.value.matchAll(/(?<!\*)(\*{1,2})([^*\n]+)\1(?!\*)/g)) {
          const content = match[2]!;
          if (!content.trim() || content === content.trim()) continue;
          const leading = content.match(/^[ \t]*/)?.[0] ?? "";
          const trailing = content.match(/[ \t]*$/)?.[0] ?? "";
          parts.push({ type: "text", value: node.value.slice(cursor, match.index) + leading });
          parts.push({
            type: match[1] === "**" ? "strong" : "emphasis",
            children: [{ type: "text", value: content.trim() }],
          });
          parts.push({ type: "text", value: trailing });
          cursor = match.index! + match[0].length;
        }
        if (!parts.length) return [node];
        parts.push({ type: "text", value: node.value.slice(cursor) });
        return parts;
      });
    };
    visit(tree);
  };
}
