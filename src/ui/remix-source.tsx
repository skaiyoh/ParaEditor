import { Component, createRef, type JSX } from 'preact';
import type { RemixActions, RemixDiagnostic, RemixSource } from './remix-model.ts';
import { Icon } from './icons.tsx';

type SourceToken = { readonly kind: 'text' | 'k' | 'p'; readonly text: string };

/** Lossless, achromatic presentation tokens, not a parser or validator. */
export function sourceTokens(text: string): readonly SourceToken[] {
  const tokens: SourceToken[] = [];
  const pattern = /\/\/[^\r\n]*|\b(?:fn|let|return|true|false)\b|->|[(){}\[\],:;=+*/<>!\-]/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) tokens.push({ kind: 'text', text: text.slice(end, match.index) });
    const value = match[0];
    tokens.push({ kind: value.startsWith('//') || /^[a-z]/.test(value) ? 'k' : 'p', text: value });
    end = match.index + value.length;
  }
  if (end < text.length) tokens.push({ kind: 'text', text: text.slice(end) });
  return tokens;
}

/** Clamp 1-based diagnostics to a real line and its end, including CRLF input. */
export function offsetAt(text: string, line: number, column: number): number {
  const lines = text.split('\n');
  const row = Math.max(0, Math.min(lines.length - 1, Math.trunc(line) - 1 || 0));
  let start = 0;
  for (let i = 0; i < row; i++) start += (lines[i]?.length ?? 0) + 1;
  const length = (lines[row] ?? '').replace(/\r$/, '').length;
  return start + Math.max(0, Math.min(length, Math.trunc(column) - 1 || 0));
}

function dimensions(text: string): { rows: number; cols: number } {
  const lines = text.split('\n');
  return { rows: lines.length, cols: lines.reduce((longest, line) => Math.max(longest, line.replace(/\r$/, '').length), 0) + 2 };
}

function Gutter({ rows, diagnostics = [] }: { readonly rows: number; readonly diagnostics?: readonly RemixDiagnostic[] }): JSX.Element {
  const errors = new Set(diagnostics.map(({ line }) => line));
  return <pre class="remix-gutter" aria-hidden="true">{Array.from({ length: rows }, (_, index) =>
    <span key={index} class={errors.has(index + 1) ? 'is-error' : undefined}>{index + 1}{index + 1 < rows ? '\n' : ''}</span>,
  )}</pre>;
}

function SourceText({ text, diagnostics = [] }: { readonly text: string; readonly diagnostics?: readonly RemixDiagnostic[] }): JSX.Element {
  const lines = text.split(/\r?\n/);
  const errors = new Set(diagnostics.map(({ line }) => line));
  const marked = lines.some((_, index) => errors.has(index + 1));
  return <div class="remix-source" style={{ '--remix-number-width': `${String(lines.length).length + (marked ? 2 : 0)}ch` }}>
    {lines.map((line, index) => <div key={index} class="remix-source-row">
      <span class={`remix-source-number${errors.has(index + 1) ? ' is-error' : ''}`} aria-hidden="true">{index + 1}</span>
      <pre class="remix-source-line">{sourceTokens(line).map((token, tokenIndex) =>
        token.kind === 'text' ? token.text : <span key={tokenIndex} class={token.kind}>{token.text}</span>,
      )}</pre>
    </div>)}
  </div>;
}

type SourceProps = {
  readonly source: RemixSource;
  readonly actions: Pick<RemixActions, 'beginEdit' | 'setDraft' | 'endEdit'>;
  /** A newly created function deliberately opens and focuses its editor. */
  readonly autoEdit?: boolean;
};
type FocusRequest = { readonly kind: 'end' } | { readonly kind: 'diagnostic'; readonly line: number; readonly column: number };
type EditSession = Pick<RemixSource, 'block' | 'node'> & Pick<RemixActions, 'endEdit'>;
let nextErrorId = 0;

/** Lifecycle bookkeeping stays local; draft, validation and history belong to the caller. */
class SourceEditor extends Component<SourceProps, { rows: number; cols: number }> {
  private readonly editor = createRef<HTMLTextAreaElement>();
  private readonly code = createRef<HTMLDivElement>();
  private readonly errorId = `remix-source-error-${++nextErrorId}`;
  private active: EditSession | null = null;
  private pendingFocus: FocusRequest | null = null;
  private viewport: VisualViewport | null = null;
  private panel: HTMLElement | null = null;

  constructor(props: SourceProps) {
    super(props);
    this.state = dimensions(props.source.draft ?? props.source.text);
  }

  componentDidMount(): void {
    if (this.props.autoEdit) this.begin({ kind: 'end' });
    if (this.props.source.editing) this.openEditor();
  }

  componentDidUpdate(previous: SourceProps): void {
    const { source, actions } = this.props;
    const changed = previous.source.block !== source.block || previous.source.node !== source.node;
    if (changed) this.finish();
    if (source.editing && (changed || !previous.source.editing)) this.openEditor();
    if (!source.editing && previous.source.editing) {
      // The owner already closed this session. Do not send a second endEdit.
      this.active = null;
      this.pendingFocus = null;
      this.releaseEditor();
    }
    if (this.active) this.active = { block: source.block, node: source.node, endEdit: actions.endEdit };
  }

  componentWillUnmount(): void {
    this.finish();
  }

  private begin = (focus: FocusRequest): void => {
    this.pendingFocus = focus;
    const { source, actions } = this.props;
    actions.beginEdit(source.block, source.node);
  };

  private openEditor(): void {
    const editor = this.editor.current;
    if (!editor) return;
    const { source, actions } = this.props;
    this.active = { block: source.block, node: source.node, endEdit: actions.endEdit };
    editor.value = source.draft ?? source.text;
    this.sizeEditor();
    this.viewport = window.visualViewport;
    this.viewport?.addEventListener('resize', this.keepCaretVisible);
    this.viewport?.addEventListener('scroll', this.keepCaretVisible);
    const focus = this.pendingFocus;
    this.pendingFocus = null;
    if (focus) this.focusAt(focus);
  }

  private releaseEditor(): void {
    this.editor.current?.blur();
    this.viewport?.removeEventListener('resize', this.keepCaretVisible);
    this.viewport?.removeEventListener('scroll', this.keepCaretVisible);
    this.viewport = null;
    this.panel?.style.removeProperty('max-height');
    this.panel = null;
  }

  private finish = (): void => {
    const active = this.active;
    this.active = null;
    this.releaseEditor();
    if (active) active.endEdit(active.block, active.node);
  };

  private sizeEditor(): void {
    const editor = this.editor.current;
    if (!editor) return;
    const size = dimensions(editor.value);
    editor.rows = size.rows;
    editor.cols = size.cols;
    if (size.rows !== this.state.rows || size.cols !== this.state.cols) this.setState(size);
  }

  private input = (): void => {
    const editor = this.editor.current;
    if (!editor) return;
    this.sizeEditor();
    const { source, actions } = this.props;
    actions.setDraft(source.block, source.node, editor.value);
    this.keepCaretVisible();
  };

  private keyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.finish();
    } else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      const editor = event.currentTarget;
      // Native insertion retains the browser's text undo where supported.
      // setRangeText is the fallback for engines without insertText support.
      if (!document.execCommand('insertText', false, '  ')) {
        editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
        this.input();
      }
    }
  };

  private focusAt(focus: FocusRequest): void {
    const editor = this.editor.current;
    if (!editor) return;
    const offset = focus.kind === 'end' ? editor.value.length : offsetAt(editor.value, focus.line, focus.column);
    editor.setSelectionRange(offset, offset);
    editor.focus({ preventScroll: true });
    this.keepCaretVisible();
  }

  private goToLine = (): void => {
    const diagnostic = this.props.source.diagnostics[0];
    if (!diagnostic) return;
    const focus: FocusRequest = { kind: 'diagnostic', line: diagnostic.line, column: diagnostic.column };
    if (this.props.source.editing) this.focusAt(focus);
    else this.begin(focus);
  };

  private keepCaretVisible = (): void => {
    const editor = this.editor.current;
    const code = this.code.current;
    if (!editor || !code || document.activeElement !== editor) return;
    const line = editor.value.slice(0, editor.selectionDirection === 'backward' ? editor.selectionStart : editor.selectionEnd).split('\n').length - 1;
    const top = line * 20 + 10;
    if (top < code.scrollTop) code.scrollTop = top;
    else if (top + 20 > code.scrollTop + code.clientHeight) code.scrollTop = top + 20 - code.clientHeight;

    const panel = code.closest<HTMLElement>('.floating-panel');
    const viewport = this.viewport;
    if (!panel || !viewport) return;
    this.panel = panel;
    // Re-measure the natural panel, so it can grow again as the keyboard retreats.
    panel.style.removeProperty('max-height');
    const bounds = panel.getBoundingClientRect();
    const bottom = viewport.height + viewport.offsetTop;
    if (bounds.bottom > bottom) panel.style.maxHeight = `${Math.max(0, bottom - bounds.top - 8)}px`;
    const body = code.closest<HTMLElement>('.floating-panel-body');
    if (body) {
      const caretTop = code.getBoundingClientRect().top + code.clientTop + top - code.scrollTop;
      const visibleTop = body.getBoundingClientRect().top + (body.querySelector<HTMLElement>('.remix-head')?.offsetHeight ?? 0);
      const visibleBottom = Math.min(body.getBoundingClientRect().bottom, bottom - 8);
      if (caretTop + 20 > visibleBottom) body.scrollTop += caretTop + 20 - visibleBottom;
      else if (caretTop < visibleTop) body.scrollTop -= visibleTop - caretTop;
    }
  };

  render(): JSX.Element {
    const { source } = this.props;
    const first = source.diagnostics[0];
    // Inspecting shows the running definition; an invalid draft stays visible with its errors (Stop 1), while a valid
    // draft kept after Undo is only named, so the code under a built-in label is always the code that runs.
    const keptDraft = !source.editing && source.draft !== null && first === undefined;
    const shown = keptDraft ? source.text : source.draft ?? source.text;
    return <div class="remix-level">
      <div class="remix-fn-head">
        <strong>{source.name}</strong>
        <div class="remix-signature">{source.signature}</div>
        <span class="remix-tag">{source.owned ? 'Yours' : source.editing ? 'Built-in, your first change makes a copy' : 'Built-in, read only'}</span>
      </div>
      <div ref={this.code} class={`remix-code${source.editing ? ' is-editing' : ''}${first ? ' is-invalid' : ''}`}>
        {source.editing && <Gutter rows={this.state.rows} diagnostics={source.diagnostics} />}
        {source.editing ? <textarea ref={this.editor} class="remix-editor" rows={this.state.rows} cols={this.state.cols}
          wrap="off" spellcheck={false} autocorrect="off" autocapitalize="off" autocomplete="off"
          aria-label={`Source of ${source.name}`} aria-describedby={first ? this.errorId : undefined} aria-invalid={!!first}
          onInput={this.input} onKeyDown={this.keyDown} onFocus={this.keepCaretVisible} onSelect={this.keepCaretVisible} />
          : <SourceText text={shown} diagnostics={source.diagnostics} />}
      </div>
      {first && <div class="remix-error" id={this.errorId}>
        <Icon name="alert" />
        <span>Line {first.line}: {first.message}{source.diagnostics.length > 1 ? ` (and ${source.diagnostics.length - 1} more)` : ''}</span>
        <button type="button" onClick={this.goToLine}>Go to line</button>
      </div>}
      {keptDraft && <p class="remix-note remix-kept-draft">An unapplied draft is kept. {source.owned ? 'Edit' : 'Edit a copy'} continues it.</p>}
      <div class="remix-code-actions">
        {source.editing ? <button type="button" onClick={this.finish}>Done</button>
          : <button type="button" onClick={() => this.begin({ kind: 'end' })}>{source.owned ? 'Edit' : 'Edit a copy'}</button>}
      </div>
      <details class="remix-help">
        <summary><span class="disclosure-icon"><Icon name="chevron" /></span>What can I write?</summary>
        <p>Functions are small and pure: typed inputs, let, and one return. These built-ins are available:</p>
        <div class="remix-builtins">{source.builtins.join(', ')}</div>
        <div class="remix-code"><SourceText text={source.example} /></div>
      </details>
    </div>;
  }
}

export function RemixSourceView(props: SourceProps): JSX.Element {
  return <SourceEditor {...props} />;
}
