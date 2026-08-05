import { countTokens } from '@anthropic-ai/tokenizer';
import { describe, expect, it } from 'vitest';

import {
  assembleContext,
  assembleContextItems,
  sanitizeContextMarkdown,
  truncateMarkdownToCharacters,
  type ContextSnippet,
} from '../../src/retrieval/contextAssembly.js';

const SEPARATOR = '-'.repeat(32);

describe('truncateMarkdownToCharacters', () => {
  it('returns short markdown unchanged', () => {
    expect(truncateMarkdownToCharacters('short', 10)).toBe('short');
  });

  it('closes an open code fence within the character limit', () => {
    const result = truncateMarkdownToCharacters(
      'Intro\n```ts\nconst value = 123456789;\n```\nAfter',
      30
    );

    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toMatch(/\n```$/);
  });
});

describe('sanitizeContextMarkdown', () => {
  it('preserves documentation after a semicolonless component block', () => {
    const markdown = [
      '# Before',
      'export const Card = () => {',
      '  return <Card />',
      '}',
      '## After',
      'Real documentation.',
    ].join('\n');

    expect(sanitizeContextMarkdown(markdown)).toBe('# Before\n## After\nReal documentation.');
  });

  it('preserves documentation after a parenthesized component export', () => {
    const markdown = [
      '# Before',
      'export const Card = () => (',
      '  <Card />',
      ')',
      '## After',
      'Real documentation.',
    ].join('\n');

    expect(sanitizeContextMarkdown(markdown)).toBe('# Before\n## After\nReal documentation.');
  });

  it('preserves documentation after a bracketed export', () => {
    const markdown = [
      '# Before',
      'export const Items = [',
      "  'one',",
      "  'two',",
      ']',
      '## After',
      'Real documentation.',
    ].join('\n');

    expect(sanitizeContextMarkdown(markdown)).toBe('# Before\n## After\nReal documentation.');
  });

  it('removes a semicolonless single-line component export', () => {
    const markdown = [
      '# Before',
      'export const Card = () => <Card />',
      '## After',
      'Real documentation.',
    ].join('\n');

    expect(sanitizeContextMarkdown(markdown)).toBe('# Before\n## After\nReal documentation.');
  });

  it('preserves component-like exports inside code fences', () => {
    const markdown = [
      '# Example',
      '```tsx',
      'export const Card = () => {',
      '  return <Card />',
      '}',
      '```',
      'After the example.',
    ].join('\n');

    expect(sanitizeContextMarkdown(markdown)).toBe(markdown);
  });
});

function hasUnclosedFence(text: string): boolean {
  const openFenceRegex = /^ {0,3}(`{3,}|~{3,})/;
  const closeFenceRegex = /^ {0,3}(`+|~+)\s*$/;

  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of text.split('\n')) {
    if (fenceChar === null) {
      const fence = openFenceRegex.exec(line)?.[1];
      if (fence !== undefined) {
        fenceChar = fence.charAt(0);
        fenceLen = fence.length;
      }
      continue;
    }

    const closeFence = closeFenceRegex.exec(line)?.[1];
    if (
      closeFence !== undefined &&
      closeFence.charAt(0) === fenceChar &&
      closeFence.length >= fenceLen
    ) {
      fenceChar = null;
      fenceLen = 0;
    }
  }

  return fenceChar !== null;
}

describe('assembleContext', () => {
  it('removes exported MDX component definitions before budgeting context', () => {
    const snippet: ContextSnippet = {
      url: 'https://example.com/reference',
      title: 'Reference',
      markdown: [
        '# Create invitations',
        '',
        'Create an invitation for an organization.',
        '',
        'export const Scopes = ({scopes = []}) => {',
        '  return',
        '',
        '  Scopes',
        '',
        '  {"Scopes define permissions."}',
        '',
        '  {scopes.map((scope) => {',
        '    return scope;',
        '  })}',
        '};',
        '',
        '',
        '',
        '## OpenAPI',
        '',
        'POST /organizations/{id}/invitations',
      ].join('\n'),
    };

    const result = assembleContext([snippet], { tokenBudget: 1000 });

    expect(result.text).not.toContain('export const Scopes');
    expect(result.text).not.toContain('Scopes define permissions');
    expect(result.text).toContain(
      '# Create invitations\n\nCreate an invitation for an organization.\n\n## OpenAPI'
    );
    expect(result.text).not.toMatch(/\n{3,}/);
  });

  it('formats a simple two-snippet assembly exactly', () => {
    const snippetA: ContextSnippet = {
      url: 'https://example.com/a',
      title: 'Title A',
      markdown: 'Content A',
    };
    const snippetB: ContextSnippet = {
      url: 'https://example.com/b',
      title: 'Title B',
      markdown: 'Content B',
    };

    const result = assembleContext([snippetA, snippetB], { tokenBudget: 1000 });

    expect(result.text).toBe(
      `### Title A\n\nSource: https://example.com/a\n\nContent A\n\n${SEPARATOR}\n\n### Title B\n\nSource: https://example.com/b\n\nContent B\n\n${SEPARATOR}`
    );
    expect(result.usedSnippets).toBe(2);
    expect(result.outputTokens).toBe(countTokens(result.text));
  });

  it('returns empty result for empty input', () => {
    expect(assembleContext([], { tokenBudget: 1000 })).toEqual({
      text: '',
      outputTokens: 0,
      usedSnippets: 0,
    });
  });

  it('returns empty result for zero or negative budget', () => {
    const snippet: ContextSnippet = {
      url: 'https://example.com/x',
      title: 'X',
      markdown: 'Some content.',
    };

    expect(assembleContext([snippet], { tokenBudget: 0 })).toEqual({
      text: '',
      outputTokens: 0,
      usedSnippets: 0,
    });
    expect(assembleContext([snippet], { tokenBudget: -5 })).toEqual({
      text: '',
      outputTokens: 0,
      usedSnippets: 0,
    });
  });

  describe('token budget adherence on adversarial fixtures', () => {
    it('never exceeds budget with a huge code block', () => {
      const hugeCodeLines = Array.from({ length: 200 }, (_, i) => `const variable${i} = ${i};`);
      const markdown = ['Intro.', '```ts', ...hugeCodeLines, '```', 'Outro.'].join('\n');
      const snippet: ContextSnippet = {
        url: 'https://example.com/hugecode',
        title: 'Huge Code',
        markdown,
      };

      const result = assembleContext([snippet], { tokenBudget: 200 });

      expect(result.outputTokens).toBeLessThanOrEqual(200);
      expect(hasUnclosedFence(result.text)).toBe(false);
    });

    it('never exceeds budget with many near-duplicate snippets', () => {
      const dupCode = '```js\nfunction shared() { return 1; }\n```';
      const manySnippets: ContextSnippet[] = Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/dup${i}`,
        title: `Dup ${i}`,
        markdown: `Some unique intro ${i}.\n${dupCode}`,
      }));

      const result = assembleContext(manySnippets, { tokenBudget: 100000 });

      expect(result.usedSnippets).toBe(1);
      expect(result.outputTokens).toBeLessThanOrEqual(100000);
    });

    it('never exceeds a tiny budget', () => {
      const snippet: ContextSnippet = {
        url: 'https://example.com/tiny',
        title: 'Tiny Budget Test',
        markdown: 'Some content for tiny budget test case.',
      };

      const result = assembleContext([snippet], { tokenBudget: 3 });

      expect(result.outputTokens).toBeLessThanOrEqual(3);
    });
  });

  describe('exact-boundary budget', () => {
    it('accepts a snippet whole when budget equals candidate tokens exactly, and not when one less', () => {
      const snippet: ContextSnippet = {
        url: 'https://example.com/boundary',
        title: 'Boundary',
        markdown: 'Line one of content.\nLine two of content.\nLine three of content.',
      };

      const full = assembleContext([snippet], { tokenBudget: 100000 });
      const exactBudget = countTokens(full.text);

      const atBoundary = assembleContext([snippet], { tokenBudget: exactBudget });
      expect(atBoundary.text).toBe(full.text);
      expect(atBoundary.outputTokens).toBe(exactBudget);

      const belowBoundary = assembleContext([snippet], { tokenBudget: exactBudget - 1 });
      expect(belowBoundary.text).not.toBe(full.text);
      expect(belowBoundary.outputTokens).toBeLessThanOrEqual(exactBudget - 1);
    });
  });

  describe('fence-aware truncation', () => {
    it('closes a fence when truncation lands mid-code-block', () => {
      const codeLines = Array.from(
        { length: 50 },
        (_, i) => `line ${i} of code content that is reasonably long to consume tokens`
      );
      const markdown = [
        'Intro text before code.',
        '```ts',
        ...codeLines,
        '```',
        'Outro text after code.',
      ].join('\n');
      const snippet: ContextSnippet = {
        url: 'https://example.com/code',
        title: 'Code Snippet',
        markdown,
      };

      const full = assembleContext([snippet], { tokenBudget: 100000 });
      const budget = Math.floor(full.outputTokens / 2);

      const result = assembleContext([snippet], { tokenBudget: budget });

      expect(result.usedSnippets).toBe(1);
      expect(hasUnclosedFence(result.text)).toBe(false);
      expect(result.outputTokens).toBeLessThanOrEqual(budget);
    });

    it('closes an unclosed fence present in the input markdown', () => {
      const snippet: ContextSnippet = {
        url: 'https://example.com/unclosed',
        title: 'Unclosed',
        markdown: 'Some intro.\n```ts\nconst a = 1;\nconst b = 2;',
      };

      const result = assembleContext([snippet], { tokenBudget: 100000 });

      expect(result.usedSnippets).toBe(1);
      expect(hasUnclosedFence(result.text)).toBe(false);
      expect(result.text).toContain('```ts\nconst a = 1;\nconst b = 2;\n```');
    });

    it('handles tilde fences', () => {
      const snippet: ContextSnippet = {
        url: 'https://example.com/tilde',
        title: 'Tilde',
        markdown: 'Text.\n~~~\ncode here\n~~~\nMore text.',
      };

      const result = assembleContext([snippet], { tokenBudget: 100000 });

      expect(result.text).toContain('~~~\ncode here\n~~~');
      expect(hasUnclosedFence(result.text)).toBe(false);
    });

    it('does not let an inner triple-backtick line close an outer 4-backtick fence', () => {
      const markdown = 'Intro.\n````ts\nsome code\n```\nmore code\n````\nOutro.';
      const snippet: ContextSnippet = {
        url: 'https://example.com/four',
        title: 'Four',
        markdown,
      };

      const result = assembleContext([snippet], { tokenBudget: 100000 });

      expect(result.text).toContain('````ts\nsome code\n```\nmore code\n````');
      expect(hasUnclosedFence(result.text)).toBe(false);
    });

    it('skips a snippet whose truncation is not viable, and accepts a later smaller snippet whole', () => {
      const words = Array.from({ length: 1000 }, (_, i) => `uniqueword${i}`).join(' ');
      const snippetHuge: ContextSnippet = {
        url: 'https://example.com/huge',
        title: 'Huge',
        markdown: words,
      };
      const snippetSmall: ContextSnippet = {
        url: 'https://example.com/small',
        title: 'Small',
        markdown: 'Tiny content.',
      };

      const smallOnly = assembleContext([snippetSmall], { tokenBudget: 100000 });
      const budget = smallOnly.outputTokens;

      const result = assembleContext([snippetHuge, snippetSmall], { tokenBudget: budget });

      expect(result.usedSnippets).toBe(1);
      expect(result.text).toContain('Tiny content.');
      expect(result.text).not.toContain('uniqueword');
    });
  });

  describe('per-page diversity cap', () => {
    const snippets: ContextSnippet[] = [1, 2, 3, 4].map((n) => ({
      url: `https://example.com/page#section-${n}`,
      title: `Section ${n}`,
      markdown: `Content for section ${n}.`,
    }));

    it('caps accepted snippets per page at the default of 3', () => {
      const result = assembleContext(snippets, { tokenBudget: 100000 });

      expect(result.usedSnippets).toBe(3);
      expect(result.text).toContain('Section 1');
      expect(result.text).toContain('Section 2');
      expect(result.text).toContain('Section 3');
      expect(result.text).not.toContain('Section 4');
    });

    it('respects a custom maxSnippetsPerPage', () => {
      const result = assembleContext(snippets, { tokenBudget: 100000, maxSnippetsPerPage: 2 });

      expect(result.usedSnippets).toBe(2);
      expect(result.text).not.toContain('Section 3');
    });
  });

  describe('identical code block dedup', () => {
    it('skips a snippet whose code block was already emitted by an earlier snippet on a different page', () => {
      const dupCode = '```ts\nconst shared = 42;\n```';
      const snippetA: ContextSnippet = {
        url: 'https://example.com/p1',
        title: 'P1',
        markdown: `Intro A.\n${dupCode}`,
      };
      const snippetB: ContextSnippet = {
        url: 'https://example.com/p2',
        title: 'P2',
        markdown: `Intro B.\n${dupCode}`,
      };

      const result = assembleContext([snippetA, snippetB], { tokenBudget: 100000 });

      expect(result.usedSnippets).toBe(1);
      expect(result.text).toContain('Intro A.');
      expect(result.text).not.toContain('Intro B.');
    });

    it('treats code blocks differing only by surrounding whitespace as identical', () => {
      const snippetC: ContextSnippet = {
        url: 'https://example.com/p3',
        title: 'P3',
        markdown: 'Intro C.\n```ts\nconst shared = 42;\n```',
      };
      const snippetD: ContextSnippet = {
        url: 'https://example.com/p4',
        title: 'P4',
        markdown: 'Intro D.\n```ts\n\n  const shared = 42;  \n\n```',
      };

      const result = assembleContext([snippetC, snippetD], { tokenBudget: 100000 });

      expect(result.usedSnippets).toBe(1);
      expect(result.text).toContain('Intro C.');
      expect(result.text).not.toContain('Intro D.');
    });

    it('never dedups snippets that have no code blocks', () => {
      const snippetE: ContextSnippet = {
        url: 'https://example.com/p5',
        title: 'P5',
        markdown: 'Just plain text one.',
      };
      const snippetF: ContextSnippet = {
        url: 'https://example.com/p6',
        title: 'P6',
        markdown: 'Just plain text two.',
      };

      const result = assembleContext([snippetE, snippetF], { tokenBudget: 100000 });

      expect(result.usedSnippets).toBe(2);
    });

    it('dedups identical code blocks even when both snippets leave the fence unclosed', () => {
      const snippetG: ContextSnippet = {
        url: 'https://example.com/p7',
        title: 'P7',
        markdown: 'Intro G.\n```ts\nconst shared = 42;',
      };
      const snippetH: ContextSnippet = {
        url: 'https://example.com/p8',
        title: 'P8',
        markdown: 'Intro H.\n```ts\nconst shared = 42;',
      };

      const result = assembleContext([snippetG, snippetH], { tokenBudget: 100000 });

      expect(result.usedSnippets).toBe(1);
      expect(result.text).toContain('Intro G.');
      expect(result.text).not.toContain('Intro H.');
    });
  });
});

describe('assembleContextItems', () => {
  it('budgets and counts the exact wrapped JSON response', () => {
    const snippet: ContextSnippet = {
      url: 'https://example.com/json',
      title: 'JSON',
      markdown: Array.from({ length: 200 }, (_, index) => `Line ${index}.`).join('\n'),
    };

    const result = assembleContextItems([snippet], { tokenBudget: 100 });

    expect(result.outputTokens).toBe(countTokens(result.response));
    expect(result.outputTokens).toBeLessThanOrEqual(100);
    expect(JSON.parse(result.response)).toEqual({
      results: [expect.objectContaining({ title: 'JSON' })],
    });
  });

  it('includes the results wrapper when checking an exact token boundary', () => {
    const snippet: ContextSnippet = {
      url: 'https://example.com/boundary',
      title: 'Boundary',
      markdown: 'Line one.\nLine two.\nLine three.',
    };
    const full = assembleContextItems([snippet], { tokenBudget: 100000 });

    const atBoundary = assembleContextItems([snippet], { tokenBudget: full.outputTokens });
    const belowBoundary = assembleContextItems([snippet], {
      tokenBudget: full.outputTokens - 1,
    });

    expect(atBoundary.response).toBe(full.response);
    expect(atBoundary.outputTokens).toBe(full.outputTokens);
    expect(belowBoundary.response).not.toBe(full.response);
    expect(belowBoundary.outputTokens).toBeLessThanOrEqual(full.outputTokens - 1);
  });

  it('returns an empty response when the JSON wrapper cannot fit', () => {
    const wrapperTokens = countTokens(JSON.stringify({ results: [] }));

    for (const tokenBudget of [-1, 0, wrapperTokens - 1]) {
      expect(assembleContextItems([], { tokenBudget })).toEqual({
        response: '',
        outputTokens: 0,
        usedSnippets: 0,
      });
    }

    const atMinimum = assembleContextItems([], { tokenBudget: wrapperTokens });
    expect(atMinimum.response).toBe('{"results":[]}');
    expect(atMinimum.outputTokens).toBe(wrapperTokens);
  });
});
