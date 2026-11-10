// Kvn: minimal types for refractor 3 (Prism tokenizer, no bundled types), used by the git diff highlighter.
declare module 'refractor/core' {
  export type RefractorNode =
    | { type: 'text'; value: string }
    | { type: 'element'; tagName: string; properties: { className?: string[] }; children: RefractorNode[] };
  type Refractor = {
    register(language: unknown): void;
    registered(language: string): boolean;
    highlight(value: string, language: string): RefractorNode[];
  };
  const refractor: Refractor;
  export default refractor;
}

declare module 'refractor/lang/*' {
  const language: unknown;
  export default language;
}
