export type HtmlDiffKind = "same" | "added" | "removed";

export type HtmlDiffLine = {
  kind: HtmlDiffKind;
  text: string;
  leftNo: number | null;
  rightNo: number | null;
};

export type HtmlDiffRow = HtmlDiffLine | { kind: "skip"; count: number };

function stripHtmlNoise(html: string): string {
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** LCS 行 diff。原型 HTML 通常几百行，O(nm) 可接受。 */
export function diffHtmlLines(left: string, right: string, maxLines = 2500): HtmlDiffLine[] {
  const a = stripHtmlNoise(left).split("\n").slice(0, maxLines);
  const b = stripHtmlNoise(right).split("\n").slice(0, maxLines);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    if (!row || !next) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: HtmlDiffLine[] = [];
  let i = 0;
  let j = 0;
  let leftNo = 1;
  let rightNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "", leftNo: leftNo++, rightNo: rightNo++ });
      i += 1;
      j += 1;
      continue;
    }
    if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "removed", text: a[i] ?? "", leftNo: leftNo++, rightNo: null });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j] ?? "", leftNo: null, rightNo: rightNo++ });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "removed", text: a[i] ?? "", leftNo: leftNo++, rightNo: null });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "added", text: b[j] ?? "", leftNo: null, rightNo: rightNo++ });
    j += 1;
  }
  return out;
}

export function htmlDiffStats(lines: HtmlDiffLine[]): { added: number; removed: number; changed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed, changed: added + removed };
}

/** 只留变更行及其前后 context，中间相同行折叠。 */
export function collapseHtmlDiff(lines: HtmlDiffLine[], context = 2): HtmlDiffRow[] {
  if (lines.length === 0) return [];
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) {
      keep.add(i);
    }
  });
  if (keep.size === 0) return [];
  const out: HtmlDiffRow[] = [];
  let skip = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skip > 0) {
        out.push({ kind: "skip", count: skip });
        skip = 0;
      }
      out.push(line);
      return;
    }
    skip += 1;
  });
  if (skip > 0) out.push({ kind: "skip", count: skip });
  return out;
}
