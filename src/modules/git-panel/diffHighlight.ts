/**
 * Kvn: syntax colors for diff lines, like the IDE (functions blue, keywords
 * purple, strings green…). Loaded lazily so the git panel renders first.
 * Each line is tokenized on its own, which is good enough for a diff (a
 * comment or string spanning lines may lose its color after the first line).
 */
import refractor, { type RefractorNode } from 'refractor/core';
import bash from 'refractor/lang/bash';
import css from 'refractor/lang/css';
import go from 'refractor/lang/go';
import java from 'refractor/lang/java';
import json from 'refractor/lang/json';
import kotlin from 'refractor/lang/kotlin';
import markdown from 'refractor/lang/markdown';
import markup from 'refractor/lang/markup';
import php from 'refractor/lang/php';
import python from 'refractor/lang/python';
import ruby from 'refractor/lang/ruby';
import scss from 'refractor/lang/scss';
import sql from 'refractor/lang/sql';
import swift from 'refractor/lang/swift';
import tsx from 'refractor/lang/tsx';
import yaml from 'refractor/lang/yaml';

for (const language of [markup, css, bash, go, java, json, kotlin, markdown, php, python, ruby, scss, sql, swift, tsx, yaml]) {
  refractor.register(language);
}

export type { RefractorNode };

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', css: 'css', scss: 'scss', html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  md: 'markdown', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
  yml: 'yaml', yaml: 'yaml', swift: 'swift', kt: 'kotlin', java: 'java', go: 'go', rb: 'ruby', php: 'php',
};

/** The Prism language for a file path, or null when there is none worth coloring. */
export function languageForPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const name = filePath.split('/').pop() ?? '';
  if (name === 'Dockerfile' || name.endsWith('.env')) return 'bash';
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const language = BY_EXTENSION[extension];
  return language && refractor.registered(language) ? language : null;
}

const MODULE_KEYWORDS = new Set(['import', 'export', 'from', 'as', 'default', 'require']);
const CONTROL_KEYWORDS = new Set(['if', 'else', 'return', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'await', 'yield']);
const PASCAL_CASE = /\b[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*\b/g;

/**
 * IDE-like extras Prism's grammar lacks: import/export and control-flow
 * keywords get their own classes, and PascalCase names (Router,
 * ExternalProductsService) are colored as types.
 */
function enrich(nodes: RefractorNode[], inString = false): RefractorNode[] {
  return nodes.flatMap((node): RefractorNode[] => {
    if (node.type === 'element') {
      const classes = node.properties.className ?? [];
      const text = node.children.length === 1 && node.children[0].type === 'text' ? node.children[0].value : null;
      if (classes.includes('keyword') && text) {
        const extra = MODULE_KEYWORDS.has(text) ? 'module' : CONTROL_KEYWORDS.has(text) ? 'control-flow' : null;
        if (extra && !classes.includes(extra)) return [{ ...node, properties: { ...node.properties, className: [...classes, extra] } }];
      }
      const stringy = inString || classes.some((c) => c === 'string' || c === 'comment' || c === 'template-string');
      const isInterpolation = classes.includes('interpolation');
      return [{ ...node, children: enrich(node.children, stringy && !isInterpolation) }];
    }
    if (inString) return [node];
    const parts: RefractorNode[] = [];
    let last = 0;
    for (const match of node.value.matchAll(PASCAL_CASE)) {
      const start = match.index ?? 0;
      if (start > last) parts.push({ type: 'text', value: node.value.slice(last, start) });
      parts.push({ type: 'element', tagName: 'span', properties: { className: ['token', 'class-name'] }, children: [{ type: 'text', value: match[0] }] });
      last = start + match[0].length;
    }
    if (parts.length === 0) return [node];
    if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
    return parts;
  });
}

export function highlightLine(code: string, language: string): RefractorNode[] | null {
  try {
    const nodes = refractor.highlight(code, language);
    return ['typescript', 'tsx', 'javascript', 'jsx', 'java', 'kotlin', 'swift'].includes(language) ? enrich(nodes) : nodes;
  } catch {
    return null;
  }
}
