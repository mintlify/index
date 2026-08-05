import { countTokens } from '@anthropic-ai/tokenizer';

export type ContextSnippet = { url: string; title: string; markdown: string };

export type AssembleContextOptions = {
  tokenBudget: number;
  maxSnippetsPerPage?: number;
  minimumSnippets?: number;
  firstSnippetTokenShare?: number;
};

export type AssembledContext = {
  text: string;
  outputTokens: number;
  usedSnippets: number;
};

export type ContextItem = { title: string; url: string; content: string };

export type AssembledContextItems = {
  response: string;
  outputTokens: number;
  usedSnippets: number;
};

type FenceState = { char: '`' | '~'; length: number };

type FenceScanResult = { finalState: FenceState | null; blocks: string[] };

type ExpressionQuote = "'" | '"' | '`';

type ExpressionState = {
  braces: number;
  brackets: number;
  parentheses: number;
  quote: ExpressionQuote | null;
  escaped: boolean;
  blockComment: boolean;
};

const SEPARATOR = '-'.repeat(32);
const EXPORTED_COMPONENT_START = /^\s*export\s+const\s+[A-Z][A-Za-z0-9_$]*\s*=/;

function toFenceChar(char: string): '`' | '~' | undefined {
  if (char === '`') return '`';
  if (char === '~') return '~';
  return undefined;
}

function scanFences(lines: string[]): FenceScanResult {
  const openFenceRegex = /^ {0,3}(`{3,}|~{3,})/;
  const closeFenceRegex = /^ {0,3}(`+|~+)\s*$/;

  let state: FenceState | null = null;
  let blockLines: string[] = [];
  const blocks: string[] = [];

  for (const line of lines) {
    if (state === null) {
      const fence = openFenceRegex.exec(line)?.[1];
      if (fence !== undefined) {
        const fenceChar = toFenceChar(fence.charAt(0));
        if (fenceChar !== undefined) {
          state = { char: fenceChar, length: fence.length };
          blockLines = [];
        }
      }
      continue;
    }

    const closeFence = closeFenceRegex.exec(line)?.[1];
    if (closeFence !== undefined) {
      const closeChar = toFenceChar(closeFence.charAt(0));
      if (closeChar === state.char && closeFence.length >= state.length) {
        blocks.push(blockLines.join('\n'));
        state = null;
        blockLines = [];
        continue;
      }
    }

    blockLines.push(line);
  }

  return { finalState: state, blocks };
}

function closingFenceLine(state: FenceState): string {
  return state.char.repeat(state.length);
}

function expressionQuote(char: string): ExpressionQuote | undefined {
  if (char === "'") return "'";
  if (char === '"') return '"';
  if (char === '`') return '`';
  return undefined;
}

function initialExpressionState(): ExpressionState {
  return {
    braces: 0,
    brackets: 0,
    parentheses: 0,
    quote: null,
    escaped: false,
    blockComment: false,
  };
}

function scanExpression(line: string, initialState: ExpressionState): ExpressionState {
  const state = { ...initialState };
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    const nextChar = line.charAt(index + 1);
    if (state.blockComment) {
      if (char === '*' && nextChar === '/') {
        state.blockComment = false;
        index += 1;
      }
      continue;
    }
    if (state.quote !== null) {
      if (state.escaped) {
        state.escaped = false;
      } else if (char === '\\') {
        state.escaped = true;
      } else if (char === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (char === '/' && nextChar === '/') break;
    if (char === '/' && nextChar === '*') {
      state.blockComment = true;
      index += 1;
      continue;
    }
    const quote = expressionQuote(char);
    if (quote !== undefined) {
      state.quote = quote;
    } else if (char === '{') {
      state.braces += 1;
    } else if (char === '}') {
      state.braces -= 1;
    } else if (char === '[') {
      state.brackets += 1;
    } else if (char === ']') {
      state.brackets -= 1;
    } else if (char === '(') {
      state.parentheses += 1;
    } else if (char === ')') {
      state.parentheses -= 1;
    }
  }
  return state;
}

function expressionIsOpen(state: ExpressionState): boolean {
  return (
    state.braces > 0 ||
    state.brackets > 0 ||
    state.parentheses > 0 ||
    state.quote !== null ||
    state.blockComment
  );
}

function expressionContinues(line: string): boolean {
  return /(?:=>|=|[?:,+\-*/%&|.^])\s*$/.test(line);
}

export function sanitizeContextMarkdown(markdown: string): string {
  const output: string[] = [];
  let fence: FenceState | null = null;
  let skippingComponent = false;
  let componentState = initialExpressionState();
  let componentContinues = false;

  for (const line of markdown.split('\n')) {
    if (skippingComponent) {
      componentState = scanExpression(line, componentState);
      if (line.trim() !== '') componentContinues = expressionContinues(line);
      if (!expressionIsOpen(componentState) && !componentContinues) {
        skippingComponent = false;
      }
      continue;
    }

    if (fence !== null) {
      output.push(line);
      const closeFence = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
      if (closeFence !== undefined) {
        const closeChar = toFenceChar(closeFence.charAt(0));
        if (closeChar === fence.char && closeFence.length >= fence.length) {
          fence = null;
        }
      }
      continue;
    }

    const openFence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (openFence !== undefined) {
      const openChar = toFenceChar(openFence.charAt(0));
      if (openChar !== undefined) {
        fence = { char: openChar, length: openFence.length };
      }
      output.push(line);
      continue;
    }

    if (EXPORTED_COMPONENT_START.test(line)) {
      componentState = scanExpression(line, initialExpressionState());
      componentContinues = expressionContinues(line);
      skippingComponent = expressionIsOpen(componentState) || componentContinues;
      continue;
    }

    if (line.trim() === '' && output.at(-1)?.trim() === '') continue;
    output.push(line);
  }

  while (output[0]?.trim() === '') output.shift();
  while (output.at(-1)?.trim() === '') output.pop();
  return output.join('\n');
}

function stripFragment(url: string): string {
  const fragmentIndex = url.indexOf('#');
  return fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
}

function formatSnippet(title: string, url: string, content: string): string {
  return `### ${title}\n\nSource: ${url}\n\n${content}\n\n${SEPARATOR}`;
}

function closeUnclosedLines(lines: string[]): string[] {
  const state = scanFences(lines).finalState;
  return state !== null ? [...lines, closingFenceLine(state)] : lines;
}

function registerBlocks(lines: string[], emittedBlocks: Set<string>): void {
  for (const block of scanFences(lines).blocks) {
    const normalized = block.trim();
    if (normalized !== '') {
      emittedBlocks.add(normalized);
    }
  }
}

type ContextAssemblyStrategy<T> = {
  buildPart: (snippet: ContextSnippet, content: string) => T;
  serialize: (parts: T[]) => string;
};

type ContextAssemblyResult<T> = {
  parts: T[];
  outputTokens: number;
  usedSnippets: number;
};

function tryTruncatePart<T>(
  snippet: ContextSnippet,
  {
    originalLines,
    acceptedParts,
    tokenBudget,
    strategy,
  }: {
    originalLines: string[];
    acceptedParts: T[];
    tokenBudget: number;
    strategy: ContextAssemblyStrategy<T>;
  }
): { part: T; contentLines: string[] } | null {
  const contentLinesForPrefix = (k: number): string[] => {
    return closeUnclosedLines(originalLines.slice(0, k));
  };

  const fits = (k: number): boolean => {
    const contentLines = contentLinesForPrefix(k);
    const part = strategy.buildPart(snippet, contentLines.join('\n'));
    return countTokens(strategy.serialize([...acceptedParts, part])) <= tokenBudget;
  };

  const isViable = (k: number): boolean =>
    originalLines.slice(0, k).some((line) => line.trim().length > 0);

  let lo = 0;
  let hi = originalLines.length;
  let bestK = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      bestK = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestK <= 0 || !isViable(bestK)) {
    return null;
  }

  const contentLines = contentLinesForPrefix(bestK);
  const part = strategy.buildPart(snippet, contentLines.join('\n'));
  return { part, contentLines };
}

function assembleRankedSnippets<T>(
  rankedSnippets: ContextSnippet[],
  options: AssembleContextOptions,
  strategy: ContextAssemblyStrategy<T>
): ContextAssemblyResult<T> {
  const {
    tokenBudget,
    maxSnippetsPerPage = 3,
    minimumSnippets = 2,
    firstSnippetTokenShare,
  } = options;
  const acceptedParts: T[] = [];
  const pageCounts = new Map<string, number>();
  const emittedBlocks = new Set<string>();
  const targetSnippetCount = Math.min(minimumSnippets, rankedSnippets.length);
  let balancedSlotsSeen = 0;
  let usedSnippets = 0;

  for (const snippet of rankedSnippets) {
    const pageKey = stripFragment(snippet.url);
    const currentCount = pageCounts.get(pageKey) ?? 0;
    if (currentCount >= maxSnippetsPerPage) continue;

    const originalLines = sanitizeContextMarkdown(snippet.markdown).split('\n');
    const fullLines = closeUnclosedLines(originalLines);
    const snippetBlocks = scanFences(fullLines).blocks.map((block) => block.trim());
    if (snippetBlocks.some((block) => block !== '' && emittedBlocks.has(block))) continue;

    const balancedBudget =
      targetSnippetCount === 1
        ? tokenBudget
        : balancedSlotsSeen === 0 && firstSnippetTokenShare !== undefined
          ? Math.floor(tokenBudget * firstSnippetTokenShare)
          : balancedSlotsSeen < targetSnippetCount
            ? Math.floor((tokenBudget * (balancedSlotsSeen + 1)) / targetSnippetCount)
            : tokenBudget;
    balancedSlotsSeen += 1;
    const fullPart = strategy.buildPart(snippet, fullLines.join('\n'));
    if (countTokens(strategy.serialize([...acceptedParts, fullPart])) <= balancedBudget) {
      acceptedParts.push(fullPart);
      pageCounts.set(pageKey, currentCount + 1);
      usedSnippets += 1;
      registerBlocks(fullLines, emittedBlocks);
      continue;
    }

    const truncated = tryTruncatePart(snippet, {
      originalLines,
      acceptedParts,
      tokenBudget: balancedBudget,
      strategy,
    });
    if (truncated !== null) {
      acceptedParts.push(truncated.part);
      pageCounts.set(pageKey, currentCount + 1);
      usedSnippets += 1;
      registerBlocks(truncated.contentLines, emittedBlocks);
      if (balancedSlotsSeen >= targetSnippetCount) break;
    }
  }

  return {
    parts: acceptedParts,
    outputTokens: countTokens(strategy.serialize(acceptedParts)),
    usedSnippets,
  };
}

const HEADING_LINE = /^\s*(?:#{1,6}\s|<h[1-6][\s>])/i;
const HEADING_MATCH_BONUS = 5;
const HEADING_CONTEXT_LINES = 3;
const MAX_RELEVANT_SECTIONS = 3;
const QUERY_STOP_WORDS = new Set([
  'and',
  'code',
  'current',
  'for',
  'from',
  'how',
  'implement',
  'include',
  'into',
  'required',
  'runnable',
  'show',
  'that',
  'the',
  'this',
  'using',
  'with',
]);

type MarkdownSection = { text: string; heading: string };

function splitIntoSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const starts = lines.reduce<number[]>((acc, line, index) => {
    if (HEADING_LINE.test(line)) acc.push(index);
    return acc;
  }, []);
  if (starts.length === 0) return [];
  if (starts[0] !== 0) starts.unshift(0);

  return starts.map((start, index) => {
    const next = starts[index + 1];
    const end = next ?? lines.length;
    return {
      text: lines.slice(start, end).join('\n'),
      heading: lines.slice(start, Math.min(start + HEADING_CONTEXT_LINES, end)).join(' '),
    };
  });
}

export function selectRelevantWindow(
  markdown: string,
  query: string,
  maxCharacters: number
): string {
  if (markdown.length <= maxCharacters) return markdown;

  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((term) => term.length > 2 && !QUERY_STOP_WORDS.has(term))
        .flatMap((term) =>
          term.length > 4 && term.endsWith('s') ? [term, term.slice(0, -1)] : [term]
        )
    )
  );
  const sections = splitIntoSections(markdown);
  if (terms.length === 0 || sections.length === 0) {
    return truncateMarkdownToCharacters(markdown, maxCharacters);
  }

  const scores = sections.map(({ text, heading }) => {
    const body = text.toLowerCase();
    const headingText = heading.toLowerCase();
    return terms.reduce((total, term) => {
      const occurrences = body.split(term).length - 1;
      return total + occurrences + (headingText.includes(term) ? HEADING_MATCH_BONUS : 0);
    }, 0);
  });

  let best = 0;
  scores.forEach((score, index) => {
    const current = scores[best] ?? 0;
    if (score > current) best = index;
  });
  if ((scores[best] ?? 0) === 0) {
    return truncateMarkdownToCharacters(markdown, maxCharacters);
  }

  const rankedSections = scores
    .map((score, index) => ({ score, index }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_SECTIONS);
  if (rankedSections.length > 1) {
    let remaining = maxCharacters - (rankedSections.length - 1) * 2;
    const selected = rankedSections.map(({ index }, rank) => {
      const allocation = Math.floor(remaining / (rankedSections.length - rank));
      const text = truncateMarkdownToCharacters(sections[index]?.text ?? '', allocation);
      remaining -= text.length;
      return { index, text };
    });
    const window = selected
      .sort((a, b) => a.index - b.index)
      .map(({ text }) => text)
      .join('\n\n');
    return truncateMarkdownToCharacters(window, maxCharacters);
  }

  let start = best;
  let end = best;
  let length = sections[best]?.text.length ?? 0;
  for (;;) {
    const after = sections[end + 1];
    const before = sections[start - 1];
    const afterCost = after ? after.text.length + 2 : Number.POSITIVE_INFINITY;
    const beforeCost = before ? before.text.length + 2 : Number.POSITIVE_INFINITY;
    if (afterCost <= beforeCost && length + afterCost <= maxCharacters) {
      end += 1;
      length += afterCost;
      continue;
    }
    if (beforeCost < Number.POSITIVE_INFINITY && length + beforeCost <= maxCharacters) {
      start -= 1;
      length += beforeCost;
      continue;
    }
    break;
  }

  const window = sections
    .slice(start, end + 1)
    .map(({ text }) => text)
    .join('\n\n');
  return truncateMarkdownToCharacters(window, maxCharacters);
}

export function truncateMarkdownToCharacters(markdown: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return '';
  if (markdown.length <= maxCharacters) return markdown;

  const lines = markdown.split('\n');
  const accepted: string[] = [];
  let length = 0;
  for (const line of lines) {
    const addition = accepted.length === 0 ? line.length : line.length + 1;
    if (length + addition > maxCharacters) break;
    accepted.push(line);
    length += addition;
  }

  while (accepted.length > 0) {
    const result = closeUnclosedLines(accepted).join('\n');
    if (result.length <= maxCharacters) return result;
    accepted.pop();
  }

  return (lines[0] ?? '').slice(0, maxCharacters);
}

export function assembleContext(
  rankedSnippets: ContextSnippet[],
  options: AssembleContextOptions
): AssembledContext {
  if (options.tokenBudget <= 0) {
    return { text: '', outputTokens: 0, usedSnippets: 0 };
  }

  const assembled = assembleRankedSnippets(rankedSnippets, options, {
    buildPart: (snippet, content) => formatSnippet(snippet.title, snippet.url, content),
    serialize: (parts) => parts.join('\n\n'),
  });
  return {
    text: assembled.parts.join('\n\n'),
    outputTokens: assembled.outputTokens,
    usedSnippets: assembled.usedSnippets,
  };
}

export function assembleContextItems(
  rankedSnippets: ContextSnippet[],
  options: AssembleContextOptions
): AssembledContextItems {
  const emptyResponse = JSON.stringify({ results: [] });
  if (countTokens(emptyResponse) > options.tokenBudget) {
    return { response: '', outputTokens: 0, usedSnippets: 0 };
  }

  const assembled = assembleRankedSnippets<ContextItem>(rankedSnippets, options, {
    buildPart: (snippet, content) => ({
      title: snippet.title,
      url: snippet.url,
      content,
    }),
    serialize: (items) => JSON.stringify({ results: items }),
  });
  return {
    response: JSON.stringify({ results: assembled.parts }),
    outputTokens: assembled.outputTokens,
    usedSnippets: assembled.usedSnippets,
  };
}
