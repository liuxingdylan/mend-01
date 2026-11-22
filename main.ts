// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`. It reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit
// names at the first of three matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

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

/** One file's line-break style, its lines, and whether it ends with a line break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function fileInfo(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function renderFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

/** ---- Section 5: matching lines at three tiers ---- */

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Every 0-based position where O occurs in the file's lines at this tier. */
function occurrences(o: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(o: string[], lines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(o, lines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Replace the k matched lines at pos by N, honouring context lines and tier-2 re-indent. */
function buildNew(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out = fileLines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWS(fileLines[pos]!);
    p = leadingWS(o[0]!);
  }
  for (const ln of n) {
    if (ln.ctx) out.push(fileLines[pos + ln.oIdx]!);
    else if (tier === 2 && ln.text.trim() !== '' && ln.text.startsWith(p)) out.push(f + ln.text.slice(p.length));
    else out.push(ln.text);
  }
  for (let i = pos + o.length; i < fileLines.length; i++) out.push(fileLines[i]!);
  return out;
}

/** ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  /** A `\` line follows the hunk's last `+` line; null when it has no `+` line. */
  lastPlusNoBreak: boolean | null;
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunkHeader(line: string, num: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${num}`);
  return Number(m[1]);
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let st = fileInfo(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(h.o, st.lines, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist || (dist === bestDist && pos < best)) {
          best = pos;
          bestDist = dist;
        }
      }
      const nl = buildNew(st.lines, best, h.o, h.n, found.tier);
      const toEnd = best + h.o.length === st.lines.length;
      st = { br: st.br, lines: nl, final: toEnd ? !h.noBreak : st.final };
    } else {
      const at = Math.min(h.a + d, st.lines.length);
      const ins = h.n.map((x) => x.text);
      const nl = [...st.lines.slice(0, at), ...ins, ...st.lines.slice(at)];
      const atEnd = at === st.lines.length;
      st = { br: st.br, lines: nl, final: atEnd ? !h.noBreak : st.final };
    }
    d += h.n.length - h.o.length;
  }
  return renderFile(st);
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : (s.diffOld ?? null);
  const newP = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : (s.diffNew ?? null);
  return (tree) => {
    if (oldP === null && newP === null) throw new Fail('unsafe', '');
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = s.newFile || oldP === null;
    const isDelete = !isCreate && (s.deletedFile || newP === null);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const ln of h.n) if (!ln.ctx) plus.push(ln.text);
      let plusNoBreak = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        if (s.hunks[hi]!.lastPlusNoBreak !== null) {
          plusNoBreak = s.hunks[hi]!.lastPlusNoBreak!;
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (plusNoBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    const content = applyHunks(cur, s.hunks, strict, op);
    if (isMove) {
      tree.now.set(newP!, content);
      tree.now.set(op, null);
      tree.moves.push([op, newP!]);
    } else {
      tree.now.set(op, content);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHunks = false;
  let i = 0;
  const n = lines.length;
  const startSection = (diffOld?: string, diffNew?: string): void => {
    cur = { diffOld, diffNew, newFile: false, deletedFile: false, hunks: [] };
    sections.push(cur);
    inHunks = false;
  };
  const parseDiff = (line: string): [string, string] => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    return [m[1]!, m[2]!.replace(/[ \t]+$/, '')];
  };
  const parseHunk = (): void => {
    const a = parseHunkHeader(lines[i]!, i + 1);
    i++;
    const body: string[] = [];
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) break;
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        body.push(l);
        i++;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const o: string[] = [];
    const nl: NLine[] = [];
    let lastCtxPlus = -1;
    let lastPlus = -1;
    for (let b = 0; b < body.length; b++) {
      const bl = body[b]!;
      if (bl.startsWith(' ')) {
        const t = bl.slice(1);
        const oi = o.length;
        o.push(t);
        nl.push({ text: t, ctx: true, oIdx: oi });
        lastCtxPlus = b;
      } else if (bl.startsWith('-')) {
        o.push(bl.slice(1));
      } else if (bl.startsWith('+')) {
        nl.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
        lastCtxPlus = b;
        lastPlus = b;
      } else if (bl === '') {
        const oi = o.length;
        o.push('');
        nl.push({ text: '', ctx: true, oIdx: oi });
        lastCtxPlus = b;
      }
    }
    const noBreak = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
    const lastPlusNoBreak = lastPlus >= 0 ? lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\') : null;
    cur!.hunks.push({ a, o, n: nl, noBreak, lastPlusNoBreak });
    inHunks = true;
  };
  while (i < n) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const [x, y] = parseDiff(line);
        startSection(x, y);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection();
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
      continue;
    }
    if (!inHunks) {
      if (line.startsWith('diff --git ')) {
        const [x, y] = parseDiff(line);
        startSection(x, y);
        i++;
      } else if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.pairOld === undefined) cur.pairOld = stripPrefix(headerPath(line));
        if (cur.pairNew === undefined) cur.pairNew = stripPrefix(headerPath(lines[i + 1]!));
        i += 2;
      } else if (line.startsWith('+++ ')) {
        if (cur.pairNew === undefined) cur.pairNew = stripPrefix(headerPath(line));
        i++;
      } else if (line.startsWith('rename from ')) {
        if (cur.renameOld === undefined) cur.renameOld = line.slice(12).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        if (cur.renameNew === undefined) cur.renameNew = line.slice(10).trim();
        i++;
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
      } else if (line.startsWith('@@')) {
        parseHunk();
      } else {
        i++;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiff(line);
      startSection(x, y);
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection();
    } else if (line.startsWith('@@')) {
      parseHunk();
    } else {
      i++;
    }
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** ---- Section 7: SEARCH/REPLACE blocks ---- */

interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const st = fileInfo(cur);
    const found = findTier(b.old, st.lines, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const nl = buildNew(st.lines, found.occ[0]!, b.old, b.new.map((t) => ({ text: t, ctx: false, oIdx: -1 })), found.tier);
    tree.now.set(b.path, renderFile({ br: st.br, lines: nl, final: st.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const sIdx = i;
      let path: string | null = null;
      for (let j = sIdx - 1; j >= prevEnd; j--) {
        const ln = lines[j]!;
        if (blank(ln)) continue;
        const t = ln.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${sIdx + 1}`);
      }
      let eq = -1;
      for (let k = sIdx + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      let gt = -1;
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          gt = k;
          break;
        }
      }
      if (gt < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      blocks.push({ path, old: lines.slice(sIdx + 1, eq), new: lines.slice(eq + 1, gt) });
      prevEnd = gt + 1;
      i = gt + 1;
    } else {
      i++;
    }
  }
  return blocks.map((b) => srEdit(b, strict));
}

/** ---- Section 8: V4A patches ---- */

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

function v4aEdit(s: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let st = fileInfo(cur);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let foundLine = -1;
        for (const t of tiers) {
          for (let li = cursor; li < st.lines.length; li++) {
            if (lineEq(st.lines[li]!, ch.anchor!, t)) {
              foundLine = li;
              break;
            }
          }
          if (foundLine >= 0) break;
        }
        if (foundLine < 0) throw new Fail('no-match', s.path);
        cursor = foundLine + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? st.lines.length : cursor;
        const ins = ch.n.map((x) => x.text);
        st = { br: st.br, lines: [...st.lines.slice(0, at), ...ins, ...st.lines.slice(at)], final: st.final };
        cursor = at + ins.length;
      } else {
        let chosen: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(ch.o, st.lines, t).filter((pos) => pos >= cursor && (!ch.eof || pos + ch.o.length === st.lines.length));
          if (occ.length > 0) {
            chosen = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (!chosen) throw new Fail('no-match', s.path);
        const nl = buildNew(st.lines, chosen.pos, ch.o, ch.n, chosen.tier);
        st = { br: st.br, lines: nl, final: st.final };
        cursor = chosen.pos + ch.n.length;
      }
    }
    const content = renderFile(st);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, content);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, content);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (ln: string): boolean =>
    ln.startsWith('*** Add File: ') || ln.startsWith('*** Delete File: ') || ln.startsWith('*** Update File: ');
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const ln = lines[i]!;
    if (blank(ln)) {
      i++;
      continue;
    }
    if (ln.startsWith('*** Add File: ')) {
      const path = ln.slice(14).trim();
      const content: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l2 = lines[j]!;
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        if (l2.startsWith('+') || blank(l2)) {
          content.push(l2);
          j++;
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      sections.push({ kind: 'add', path, moveTo: null, lines: content.map((x) => (x === '' ? '' : x.slice(1))), chunks: [] });
      i = j;
    } else if (ln.startsWith('*** Delete File: ')) {
      const path = ln.slice(17).trim();
      let j = i + 1;
      while (j < last) {
        const l2 = lines[j]!;
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        if (blank(l2)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
      i = j;
    } else if (ln.startsWith('*** Update File: ')) {
      const path = ln.slice(17).trim();
      const updateLine = i + 1;
      const raw: Array<{ text: string; num: number }> = [];
      let j = i + 1;
      let seenContent = false;
      let moveTo: string | null = null;
      while (j < last) {
        const l2 = lines[j]!;
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        if (l2.startsWith('*** Move to: ')) {
          if (seenContent) throw new Exit2(`error: parse ${j + 1}`);
          moveTo = l2.slice(13).trim();
          seenContent = true;
          raw.push({ text: l2, num: j + 1 });
          j++;
        } else if (l2.startsWith('@@') || l2 === '*** End of File' || l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+') || blank(l2)) {
          if (!blank(l2)) seenContent = true;
          raw.push({ text: l2, num: j + 1 });
          j++;
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let k = 0;
      while (k < raw.length && blank(raw[k]!.text)) k++;
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      for (; k < raw.length; k++) {
        const { text: l2, num } = raw[k]!;
        if (l2.startsWith('*** Move to: ')) {
          continue;
        } else if (l2.startsWith('@@')) {
          if (cur) chunks.push(cur);
          const anchor = l2.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
        } else if (l2 === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else {
          if (!cur) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${num}`);
            cur = { anchor: null, o: [], n: [], eof: false };
          }
          if (l2.startsWith(' ')) {
            const t = l2.slice(1);
            const oi = cur.o.length;
            cur.o.push(t);
            cur.n.push({ text: t, ctx: true, oIdx: oi });
          } else if (l2.startsWith('-')) {
            cur.o.push(l2.slice(1));
          } else if (l2.startsWith('+')) {
            cur.n.push({ text: l2.slice(1), ctx: false, oIdx: -1 });
          } else {
            const oi = cur.o.length;
            cur.o.push('');
            cur.n.push({ text: '', ctx: true, oIdx: oi });
          }
        }
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks });
      i = j;
    } else throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Write in the same byte-sorted order as the printed rows, so a partial
    // failure leaves a predictable set of files on disk.
    const changed = [...tree.now.keys()]
      .filter((p) => tree.now.get(p) !== tree.original(p))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
