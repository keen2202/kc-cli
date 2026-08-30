/**
 * Composer panel (audit round3 T25 phase 1) — the input/editor slot of the app
 * frame.
 *
 * Panel-boundary extraction only: the composer receives the editor's full
 * render state as down-flowing props (buffer text, cursor position, steer
 * indicator, attachment list and delete-attachment mode) and delegates to the
 * existing Editor. It owns no state and no key handling — all input still
 * flows through the focus stack's editor base layer in AppRoot.
 *
 * Spec: docs/specs/audit-remediation-round3-spec.md §5-L2.
 */

import React from 'react';
import { Editor } from '../components/Editor';

/** An attached file shown in the composer's attachment strip. */
export interface ComposerAttachment {
  path: string;
  name: string;
}

interface ComposerPanelProps {
  /** Current buffer text. */
  text: string;
  /** Cursor position inside `text` (code-unit index). */
  cursorPos: number;
  /** Whether steer mode (Ctrl+I) is active — swaps the prompt prefix. */
  isSteerMode: boolean;
  /** Attached files (@ picker), capped upstream at MAX_ATTACHMENTS. */
  attachments: ComposerAttachment[];
  /** Whether delete-attachment mode (numbered removal) is armed. */
  deleteMode: boolean;
  /** Reports the columns actually available for input text (measured by the
   *  Editor) so AppRoot's key handling can match the rendered wrapping. */
  onMeasure?: (textCols: number) => void;
}

export function ComposerPanel({
  text,
  cursorPos,
  isSteerMode,
  attachments,
  deleteMode,
  onMeasure,
}: ComposerPanelProps) {
  return (
    <Editor
      text={text}
      cursorPos={cursorPos}
      isSteerMode={isSteerMode}
      attachments={attachments}
      deleteMode={deleteMode}
      onMeasure={onMeasure}
    />
  );
}
