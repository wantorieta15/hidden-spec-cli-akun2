// main.ts is mend, the CLI SPEC.md specifies. It implements the whole specification: the command line, the output and
// exit codes, safe paths, format detection, all four edit formats (unified diff, SEARCH/REPLACE, V4A, JSON), line
// matching at three tiers, and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, as [old, new] pairs: used to print `R` lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3) and matching (section 5)        */
/* ------------------------------------------------------------------ */

/** A file split at its own line break, remembering whether it ends with one. */
interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
};

function lineMatches(o: string, f: string, tier: number): boolean {
  if (tier === 0) return o === f;
  if (tier === 1) return trimEndWS(o) === trimEndWS(f);
  return trimWS(o) === trimWS(f);
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** All 0-based positions at or after `from` where O occurs in `lines` at `tier`. */
function occurrencesAt(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineMatches(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences; null when none. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiersToTry(strict)) {
    const occ = occurrencesAt(lines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * Build the replacement lines for a match at `at`. Context lines are written as the file's own matched lines;
 * at tier 2 every other line is re-indented from O's first line's indent to the file's first matched line's.
 */
function buildNew(fileLines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWS(fileLines[at]!);
    P = leadingWS(O[0]!);
  }
  for (const nl of N) {
    if (nl.ctx >= 0) {
      out.push(fileLines[at + nl.ctx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                     */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                  */
/* ------------------------------------------------------------------ */

interface UHunk {
  /** The old start line number A from the `@@ -A[,B] +C[,D] @@` header. */
  a: number;
  body: string[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** A `--- <path>` / `+++ <path>` line: text after the four characters, up to the first tab, trimmed, a/ b/ stripped. */
function diffPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hasPair = false;
  let hasHunk = false;
  const newSection = (): USection => {
    const s: USection = {
      diffOld: null,
      diffNew: null,
      pairOld: null,
      pairNew: null,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    hasPair = false;
    hasHunk = false;
    return s;
  };
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !hasPair && !hasHunk) {
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(lines[i + 1]!);
        hasPair = true;
      } else {
        const s = newSection();
        s.pairOld = diffPath(line);
        s.pairNew = diffPath(lines[i + 1]!);
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(hunkHead);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      hasHunk = true;
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          hunk.body.push(b);
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      continue;
    }
    if (!hasHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match') on a failing hunk. */
function applyHunks(content: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of h.body) {
      if (b.startsWith(' ')) {
        const t = b.slice(1);
        O.push(t);
        N.push({ text: t, ctx: O.length - 1 });
      } else if (b === '') {
        O.push('');
        N.push({ text: '', ctx: O.length - 1 });
      } else if (b.startsWith('-')) O.push(b.slice(1));
      else if (b.startsWith('+')) N.push({ text: b.slice(1), ctx: -1 });
      // '\' lines only affect the final line break, handled below.
    }
    let backslash = false;
    for (let j = h.body.length - 1; j >= 0; j--) {
      const b = h.body[j]!;
      if (b.startsWith(' ') || b === '' || b.startsWith('+')) {
        backslash = j + 1 < h.body.length && h.body[j + 1]!.startsWith('\\');
        break;
      }
    }
    if (O.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      const nl = buildNew(f.lines, pos, O, N, 0);
      f.lines.splice(pos, 0, ...nl);
      if (atEnd) f.final = !backslash;
      d += N.length;
      continue;
    }
    const found = findTier(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        at = p;
      }
    }
    const touchesEnd = at + O.length === f.lines.length;
    const nl = buildNew(f.lines, at, O, N, found.tier);
    f.lines.splice(at, O.length, ...nl);
    if (touchesEnd) f.final = !backslash;
    d += N.length - O.length;
  }
  return joinFile(f);
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld!;
  const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew!;
  return (tree) => {
    const isCreate = oldP === '/dev/null' || sec.newFile;
    const isDelete = !isCreate && (newP === '/dev/null' || sec.deletedFile);
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let endBreak = true;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.startsWith('+')) {
            plus.push(b.slice(1));
            endBreak = !(j + 1 < h.body.length && h.body[j + 1]!.startsWith('\\'));
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (endBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const content = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, content);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                          */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevReplace = rep;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const nl = buildNew(f.lines, at, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
    f.lines.splice(at, oldLines.length, ...nl);
    tree.now.set(path, joinFile(f));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                    */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface RawLine {
  text: string;
  idx: number;
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Parse the chunks of an Update File section from its (trailing-blank-stripped) lines. */
function parseV4aChunks(raw: RawLine[]): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let closed = false;
  for (const r of raw) {
    const l = r.text;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), eof: false, O: [], N: [] };
      chunks.push(cur);
      closed = false;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.idx + 1}`);
      cur.eof = true;
      cur = null;
      closed = true;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (closed) throw new Exit2(`error: parse ${r.idx + 1}`);
        cur = { anchor: null, eof: false, O: [], N: [] };
        chunks.push(cur);
      }
      if (l === '') {
        cur.O.push('');
        cur.N.push({ text: '', ctx: cur.O.length - 1 });
      } else if (l.startsWith(' ')) {
        const t = l.slice(1);
        cur.O.push(t);
        cur.N.push({ text: t, ctx: cur.O.length - 1 });
      } else if (l.startsWith('-')) cur.O.push(l.slice(1));
      else cur.N.push({ text: l.slice(1), ctx: -1 });
      continue;
    }
    throw new Exit2(`error: parse ${r.idx + 1}`);
  }
  return chunks;
}

/** The first line at or after `from` equal to the anchor as a single line, at the first tier with one. */
function findAnchorLine(lines: string[], from: number, anchor: string, strict: boolean): number {
  for (const t of tiersToTry(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (lineMatches(anchor, lines[i]!, t)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `from`, at the first tier with one (EOF chunks: ending at the last line). */
function findOccFrom(lines: string[], O: string[], from: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  for (const t of tiersToTry(strict)) {
    for (const p of occurrencesAt(lines, O, t, from)) {
      if (!eof || p + O.length === lines.length) return { pos: p, tier: t };
    }
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) {
      i++;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      i++;
      const raw: RawLine[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i++;
      const raw: RawLine[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const updateIdx = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      const raw: RawLine[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const chunks = parseV4aChunks(raw);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const aidx = findAnchorLine(f.lines, cursor, ch.anchor, strict);
        if (aidx < 0) throw new Fail('no-match', path);
        cursor = aidx + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const nl = buildNew(f.lines, at, ch.O, ch.N, 0);
        f.lines.splice(at, 0, ...nl);
        cursor = at + nl.length;
        continue;
      }
      const found = findOccFrom(f.lines, ch.O, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const nl = buildNew(f.lines, found.pos, ch.O, ch.N, found.tier);
      f.lines.splice(found.pos, ch.O.length, ...nl);
      cursor = found.pos + nl.length;
    }
    const content = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, content);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10)                             */
/* ------------------------------------------------------------------ */

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const kinds = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    kinds.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const used = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (kinds.get(oldP) === 'D' && kinds.get(newP) === 'A' && !used.has(oldP) && !used.has(newP)) {
      used.add(oldP);
      used.add(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, k] of kinds) {
    if (used.has(p)) continue;
    rows.push({ key: p, text: `${k} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
