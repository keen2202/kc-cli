import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';

interface MarkdownRendererProps {
  content: string;
}

/**
 * Simple markdown-to-Ink renderer.
 * Supports: code blocks (```), headings (#), bold (**), italic (*), inline code (`), lists (-/*).
 */
export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const { tokens } = useTheme();
  const lines = content.split('\n');
  const elements: React.ReactElement[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = '';

  const flushCodeBlock = () => {
    if (codeLines.length > 0) {
      elements.push(
        <Box key={`code-${elements.length}`} flexDirection="column" marginBottom={1}>
          <Box borderStyle="single" padding={1} flexDirection="column">
            {codeLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        </Box>,
      );
      codeLines = [];
      codeLang = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';

    // Code block toggle
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<Box key={`empty-${i}`} height={1} />);
      continue;
    }

    // Heading
    if (line.startsWith('# ')) {
      elements.push(
        <Box key={`h1-${i}`} marginBottom={1}>
          <Text bold>{line.slice(2)}</Text>
        </Box>,
      );
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <Box key={`h2-${i}`} marginBottom={1}>
          <Text bold>{line.slice(3)}</Text>
        </Box>,
      );
      continue;
    }
    if (line.startsWith('### ')) {
      elements.push(
        <Box key={`h3-${i}`} marginBottom={1}>
          <Text bold>{line.slice(4)}</Text>
        </Box>,
      );
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      elements.push(
        <Box key={`quote-${i}`} marginBottom={1}>
          <Text dimColor>│ {line.slice(2)}</Text>
        </Box>,
      );
      continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(line)) {
      elements.push(
        <Box key={`ul-${i}`} marginBottom={1}>
          <Text>  · {line.replace(/^[-*]\s/, '')}</Text>
        </Box>,
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      elements.push(
        <Box key={`ol-${i}`} marginBottom={1}>
          <Text>  {line}</Text>
        </Box>,
      );
      continue;
    }

    // Horizontal rule
    if (/^[-_*]{3,}$/.test(line.trim())) {
      elements.push(
        <Box key={`hr-${i}`} marginBottom={1}>
          <Text dimColor>─────────────</Text>
        </Box>,
      );
      continue;
    }

    // Regular paragraph
    elements.push(
      <Box key={`p-${i}`} marginBottom={1}>
        <Text>{line}</Text>
      </Box>,
    );
  }

  // Flush any remaining code block
  flushCodeBlock();

  return <Box flexDirection="column">{elements}</Box>;
}
