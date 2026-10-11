import { Component, createRef, Fragment } from 'preact';
import type { ComponentChildren, JSX } from 'preact';
import type {
  RemixActions, RemixBlock, RemixBlockDetail, RemixChoice, RemixFunctionNode, RemixParam,
  RemixParamOwner, RemixPlace, RemixRack, RemixStatus, RemixTarget,
} from './remix-model.ts';
import { Icon } from './icons.tsx';

type Props = {
  readonly status: RemixStatus;
  readonly targets: readonly RemixTarget[];
  readonly target: RemixTarget;
  readonly onTarget: (target: RemixTarget) => void;
  readonly rack: RemixRack;
  readonly detail: (block: string) => RemixBlockDetail | null;
  readonly actions: RemixActions;
  readonly paramControl: (param: RemixParam, owner: RemixParamOwner) => ComponentChildren;
  readonly renderSource: (block: string, node: string, options: { readonly autoEdit: boolean }) => ComponentChildren;
  readonly brushHead?: ComponentChildren;
  readonly brushBasics?: ComponentChildren;
  readonly focus?: { readonly block: string; readonly level: 'blocks' | 'functions' } | null;
};
type View =
  | { readonly kind: 'blocks' | 'add-block' }
  | { readonly kind: 'functions'; readonly block: string }
  | { readonly kind: 'chooser'; readonly block: string; readonly place: RemixPlace }
  | { readonly kind: 'source'; readonly block: string; readonly node: string; readonly autoEdit: boolean };
type State = {
  readonly view: View;
  readonly selectedBlock: string | null;
  readonly selectedNodes: Readonly<Record<string, string>>;
  readonly reason: { readonly owner: string; readonly text: string } | null;
  readonly expandedChoice: string | null;
  readonly rename: string | null;
  readonly slots: boolean;
  readonly savingName: boolean;
  readonly drag: { readonly block: string; readonly index: number; readonly line: number } | null;
};
type Drag = {
  readonly pointer: number;
  readonly handle: HTMLButtonElement;
  readonly block: string;
  readonly from: number;
  readonly startY: number;
  readonly order: string;
  moved: boolean;
  index: number;
};
const STATE_TEXT = {
  checking: 'Checking…', applied: 'Applied', saving: 'Saving…', saved: 'Saved',
  invalid: 'Not applied', 'draft-saved': 'Draft saved', 'save-failed': 'Save failed',
} satisfies Record<RemixStatus['state'], string>;
const targetName = (target: RemixTarget): string => target === 'photo' ? 'Photo' : 'Brush';
const viewKey = (view: View): string => 'block' in view ? `${view.kind}:${view.block}${view.kind === 'source' ? `:${view.node}` : ''}` : view.kind;
const controlKey = (...parts: string[]): string => JSON.stringify(parts);

/** The public component accepts only the read model and operations supplied by its host. */
export function RemixPanel(props: Props): JSX.Element {
  return <Panel {...props} />;
}

/** A local editor field: Enter/blur commit once, Escape cancels before the host sees it. */
class NameInput extends Component<{
  readonly name: string;
  readonly label: string;
  readonly saveButton?: boolean;
  readonly onCommit: (name: string) => void;
  readonly onFinish: () => void;
}, { readonly value: string; readonly invalid: boolean }> {
  private input = createRef<HTMLInputElement>();
  private finished = false;
  state = { value: this.props.name, invalid: false };
  componentDidMount(): void { this.input.current?.focus(); this.input.current?.select(); }
  private finish = (commit: boolean, blur = false): void => {
    if (this.finished) return;
    const name = this.input.current?.value.trim() ?? '';
    if (commit && name === '' && !blur) { this.setState({ invalid: true }); return; }
    this.finished = true;
    if (commit && name !== '') this.props.onCommit(name);
    this.props.onFinish();
  };
  render(): JSX.Element {
    return <>
      <input ref={this.input} class="layer-name-input" aria-label={this.props.label} aria-invalid={this.state.invalid}
        placeholder={this.props.label} title={this.state.invalid ? 'Enter a name' : this.props.label} value={this.state.value}
        onInput={(event) => this.setState({ value: event.currentTarget.value, invalid: false })}
        onBlur={() => { if (!this.props.saveButton) this.finish(true, true); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); this.finish(event.key === 'Enter');
          }
        }} />
      {this.props.saveButton && <button type="button" onClick={() => this.finish(true)}>Save</button>}
    </>;
  }
}

class Panel extends Component<Props, State> {
  state: State = {
    view: { kind: 'blocks' }, selectedBlock: null, selectedNodes: {}, reason: null,
    expandedChoice: null, rename: null, slots: false, savingName: false, drag: null,
  };
  private head = createRef<HTMLElement>();
  private level = createRef<HTMLElement>();
  private scroll = new Map<string, number>();
  private openers = new Map<string, string>();
  private drag: Drag | null = null;
  private pendingPlacement: { readonly block: string; readonly place: RemixPlace; readonly before: readonly string[] } | null = null;

  componentDidMount(): void {
    window.addEventListener('blur', this.cancelDrag);
    window.addEventListener('pointerdown', this.secondPointer, true);
    window.addEventListener('keydown', this.dragKey, true);
    this.applyFocus();
  }
  componentWillUnmount(): void {
    window.removeEventListener('blur', this.cancelDrag);
    window.removeEventListener('pointerdown', this.secondPointer, true);
    window.removeEventListener('keydown', this.dragKey, true);
    this.releaseDrag();
  }
  componentDidUpdate(previous: Props): void {
    if (previous.target !== this.props.target) {
      this.cancelDrag();
      this.scroll.clear(); this.openers.clear(); this.pendingPlacement = null;
      this.setState({ view: { kind: 'blocks' }, selectedBlock: null, selectedNodes: {}, reason: null,
        expandedChoice: null, rename: null, slots: false, savingName: false, drag: null }, () => {
        const scroller = this.scroller();
        if (scroller !== null) scroller.scrollTop = 0;
        this.level.current?.focus({ preventScroll: true });
        if (previous.focus !== this.props.focus) this.applyFocus();
      });
      return;
    }
    if (previous.focus !== this.props.focus) { this.applyFocus(); return; }
    const view = this.state.view;
    if (this.drag !== null && this.drag.order !== JSON.stringify(this.props.rack.blocks.map((block) => block.id))) this.cancelDrag();
    if ('block' in view) {
      const detail = this.props.detail(view.block);
      if (!this.props.rack.blocks.some((block) => block.id === view.block) || detail === null) {
        this.navigate({ kind: 'blocks' }, undefined, true); return;
      }
      if ((view.kind === 'source' && !detail.nodes.some((node) => node.id === view.node)) ||
          (view.kind === 'chooser' && !(view.place.kind === 'node' ? detail.nodes : detail.slots).some((item) => item.id === view.place.id))) {
        this.navigate({ kind: 'functions', block: view.block }, undefined, true); return;
      }
    }
    const pending = this.pendingPlacement;
    if (pending !== null && previous !== this.props) {
      const nodes = this.props.detail(pending.block)?.nodes ?? [];
      const added = nodes.find((node) => !pending.before.includes(node.id));
      const selected = added?.id ?? (pending.place.kind === 'node' ? pending.place.id : null);
      this.pendingPlacement = null;
      if (selected !== null) this.selectNode(pending.block, selected);
    }
  }
  private scroller(): Element | null { return this.head.current?.closest('.floating-panel-body, .phone-tools') ?? null; }
  private focusControl(key: string | undefined): void {
    const control = [...(this.level.current?.querySelectorAll<HTMLButtonElement>('[data-remix-control]') ?? [])]
      .find((item) => item.dataset.remixControl === key);
    (control ?? this.level.current)?.focus({ preventScroll: true });
  }
  private applyFocus(): void {
    const focus = this.props.focus;
    if (focus == null || !this.props.rack.blocks.some((block) => block.id === focus.block)) return;
    this.setState({ selectedBlock: focus.block });
    const view: View = focus.level === 'functions' && this.props.detail(focus.block) !== null
      ? { kind: 'functions', block: focus.block } : { kind: 'blocks' };
    this.openers.set('blocks', controlKey('open-block', focus.block));
    this.navigate(view);
  }
  private navigate(view: View, opener?: string, returning = false): void {
    this.cancelDrag();
    if (view.kind !== 'functions') this.pendingPlacement = null;
    const scroller = this.scroller();
    this.scroll.set(viewKey(this.state.view), scroller?.scrollTop ?? 0);
    if (opener !== undefined) this.openers.set(viewKey(this.state.view), opener);
    this.setState({ view, reason: null, expandedChoice: null, rename: null, savingName: false }, () => {
      if (returning) this.focusControl(this.openers.get(viewKey(view)));
      else this.level.current?.focus({ preventScroll: true });
      if (scroller !== null) scroller.scrollTop = this.scroll.get(viewKey(view)) ?? 0;
    });
  }
  private back = (): void => {
    const view = this.state.view;
    if (view.kind === 'source' || view.kind === 'chooser') this.navigate({ kind: 'functions', block: view.block }, undefined, true);
    else this.navigate({ kind: 'blocks' }, undefined, true);
  };
  private selectNode(block: string, node: string): void {
    this.setState((state) => ({ selectedNodes: { ...state.selectedNodes, [block]: node }, reason: null }));
  }
  private openBlock(block: string, opener: string): void {
    this.setState({ selectedBlock: block, slots: false });
    this.navigate({ kind: 'functions', block }, opener);
  }
  private openSource(block: string, node: string, opener: string): void {
    this.selectNode(block, node);
    this.navigate({ kind: 'source', block, node, autoEdit: false }, opener);
  }
  private action(owner: string, label: string, capability: RemixBlock['remove'], run: () => void,
    icon?: Parameters<typeof Icon>[0]['name'], key?: string): JSX.Element {
    return <button type="button" aria-disabled={capability.kind === 'unavailable'} data-remix-control={key}
      onClick={() => {
        if (capability.kind === 'unavailable') this.setState({ reason: { owner, text: capability.reason } });
        else { this.setState({ reason: null }); run(); }
      }}>{icon !== undefined && <Icon name={icon} />}{label}</button>;
  }
  private reason(owner: string): ComponentChildren {
    return this.state.reason?.owner === owner ? <p class="remix-reason" role="status">{this.state.reason.text}</p> : null;
  }
  private releaseDrag(): Drag | null {
    const drag = this.drag;
    this.drag = null;
    if (drag?.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    return drag;
  }
  private cancelDrag = (): void => {
    if (this.releaseDrag() !== null) this.setState({ drag: null });
  };
  private secondPointer = (event: PointerEvent): void => {
    if (this.drag !== null && this.drag.pointer !== event.pointerId) {
      event.preventDefault(); event.stopImmediatePropagation(); this.cancelDrag();
    }
  };
  private dragKey = (event: KeyboardEvent): void => {
    if (this.drag !== null && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); this.cancelDrag();
    }
  };
  private startDrag(event: JSX.TargetedPointerEvent<HTMLButtonElement>, block: RemixBlock, index: number): void {
    event.stopPropagation();
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    this.drag = {
      pointer: event.pointerId, handle: event.currentTarget, block: block.id, from: index, startY: event.clientY,
      order: JSON.stringify(this.props.rack.blocks.map((item) => item.id)), moved: false, index,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  private moveDrag(event: JSX.TargetedPointerEvent<HTMLButtonElement>): void {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointer) return;
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    const rows = [...(this.level.current?.querySelectorAll<HTMLElement>('[data-remix-block]') ?? [])];
    // The drop index is in the final list, with the dragged row removed.
    const remaining = rows.filter((row) => row.dataset.remixBlock !== drag.block);
    const next = remaining.findIndex((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    drag.index = next < 0 ? remaining.length : next;
    const anchor = remaining[drag.index];
    const line = anchor === undefined ? rows.length : rows.indexOf(anchor);
    this.setState({ drag: { block: drag.block, index: drag.index, line } });
  }
  private finishDrag(event: JSX.TargetedPointerEvent<HTMLButtonElement>): void {
    if (this.drag?.pointer !== event.pointerId) return;
    this.moveDrag(event);
    const drag = this.releaseDrag();
    this.setState({ drag: null });
    if (drag === null || !drag.moved || drag.index === drag.from) return;
    const block = this.props.rack.blocks.find((item) => item.id === drag.block);
    if (block === undefined) return;
    const capability = drag.index < drag.from ? block.moveUp : block.moveDown;
    if (capability.kind === 'available') this.props.actions.moveBlock(drag.block, drag.index);
    else this.setState({ reason: { owner: 'blocks', text: capability.reason } });
  }
  private choice(choice: RemixChoice, choose: () => void, incompatible = false): JSX.Element {
    const unavailable = incompatible || choice.available.kind === 'unavailable';
    const expanded = this.state.expandedChoice === choice.id;
    return <Fragment key={choice.id}>
      <button class="remix-choice" type="button" aria-disabled={unavailable}
        aria-expanded={unavailable ? expanded : undefined} data-remix-control={controlKey('choice', choice.id)}
        onClick={() => unavailable ? this.setState({ expandedChoice: expanded ? null : choice.id }) : choose()}>
        <span><span class="remix-name">{choice.name}</span><span class="remix-flow">{choice.detail}</span></span>
        <Icon name={unavailable ? 'alert' : 'chevron'} />
      </button>
      {unavailable && expanded && <p class="remix-reason" role="status">{choice.available.kind === 'unavailable'
        ? choice.available.reason : 'This function needs a different input.'}</p>}
    </Fragment>;
  }
  private blockRow(block: RemixBlock, index: number): JSX.Element {
    const selected = this.state.selectedBlock === block.id;
    const dragging = this.state.drag?.block === block.id;
    const name = <span class="remix-name"><span>{block.name}</span>{block.owned && <span class="remix-tag">Yours</span>}</span>;
    const summary = <span class="remix-summary">{block.enabled ? block.params.slice(0, 2).map((param) => `${param.label} ${param.display}`).join(' · ') : 'Bypassed'}</span>;
    const openKey = controlKey('open-block', block.id);
    const forwardKey = controlKey('functions', block.id);
    const mainKey = controlKey('block', block.id);
    return <li key={block.id} data-remix-block={block.id}
      class={`remix-block${(this.state.drag !== null ? dragging : selected) ? ' is-selected' : ''}${block.enabled ? '' : ' is-bypassed'}`}>
      <div class="remix-block-row">
        <button class="remix-handle" type="button" aria-label={`Reorder ${block.name}`} title={`Reorder ${block.name}`}
          onPointerDown={(event) => this.startDrag(event, block, index)} onPointerMove={(event) => this.moveDrag(event)}
          onPointerUp={(event) => this.finishDrag(event)} onPointerCancel={this.cancelDrag} onLostPointerCapture={this.cancelDrag}
          onClick={(event) => event.stopPropagation()}><Icon name="grip" /></button>
        {this.state.rename === block.id ? <NameInput name={block.name} label="Block name"
          onCommit={(value) => this.props.actions.renameBlock(block.id, value)}
          onFinish={() => this.setState({ rename: null }, () => this.focusControl(mainKey))} />
          : <button class="remix-main" type="button" data-remix-control={mainKey}
            aria-label={selected && block.owned ? `Rename ${block.name}` : undefined} aria-pressed={selected}
            onClick={() => selected && block.owned ? this.setState({ rename: block.id }) : this.setState({ selectedBlock: block.id, reason: null })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !(selected && block.owned)) {
                event.preventDefault(); this.openBlock(block.id, mainKey);
              }
            }}>{name}{summary}</button>}
        <label class="enable-switch" title={`${block.name} on or off`}>
          <input type="checkbox" checked={block.enabled} aria-label={`${block.name} on`}
            onChange={(event) => this.props.actions.setBlockEnabled(block.id, event.currentTarget.checked)} />
        </label>
        <button class="remix-open" type="button" aria-label={`Open ${block.name} functions`} title={`Open ${block.name} functions`}
          data-remix-control={openKey} onClick={() => this.openBlock(block.id, openKey)}><Icon name="chevron" /></button>
      </div>
      {selected && <div class="remix-detail">
        {block.params.map((param) => <Fragment key={param.id}>{this.props.paramControl(param, { kind: 'block', block: block.id })}</Fragment>)}
        <div class="remix-actions">
          {this.action(block.id, 'Move up', block.moveUp, () => this.props.actions.moveBlock(block.id, index - 1), 'up')}
          {this.action(block.id, 'Move down', block.moveDown, () => this.props.actions.moveBlock(block.id, index + 1), 'down')}
          {this.action(block.id, 'Remove', block.remove, () => this.props.actions.removeBlock(block.id), 'trash')}
          {block.useInBrush !== null && this.action(block.id, 'Use in brush', block.useInBrush, () => this.props.actions.useInBrush(block.id))}
          <button class="remix-forward" type="button" data-remix-control={forwardKey}
            onClick={() => this.openBlock(block.id, forwardKey)}>Functions<Icon name="chevron" /></button>
        </div>{this.reason(block.id)}
      </div>}
    </li>;
  }
  private blocks(): JSX.Element {
    const rack = this.props.rack;
    const addKey = controlKey('add-block');
    return <>
      {this.props.target === 'brush' && this.props.brushBasics}
      <div class="remix-marker">{rack.inLabel}</div>
      {rack.blocks.length === 0 && <p class="remix-note">No blocks yet.</p>}
      <ol class="remix-list">
        {rack.blocks.map((block, index) => <Fragment key={block.id}>
          {this.state.drag?.line === index && <li class="remix-insertion" aria-hidden="true" />}
          {this.blockRow(block, index)}
        </Fragment>)}
        {this.state.drag?.line === rack.blocks.length && <li class="remix-insertion" aria-hidden="true" />}
      </ol>
      {this.reason('blocks')}
      <button class="remix-add" type="button" data-remix-control={addKey}
        onClick={() => this.navigate({ kind: 'add-block' }, addKey)}><Icon name="add" />Add block</button>
      <div class="remix-marker">{rack.outLabel}</div>
    </>;
  }
  private nodeRow(block: string, node: RemixFunctionNode): JSX.Element {
    const selected = this.state.selectedNodes[block] === node.id;
    const sourceKey = controlKey('source', block, node.id);
    const actionKey = controlKey('source-action', block, node.id);
    const mainKey = controlKey('node', block, node.id);
    const replaceKey = controlKey('replace', block, node.id);
    return <li class={`remix-fn${selected ? ' is-selected' : ''}${node.branchOf !== null ? ' is-branch' : ''}`} key={node.id}>
      <div class="remix-fn-row">
        <span class="remix-dot" aria-hidden="true" />
        <button class="remix-main" type="button" aria-pressed={selected} data-remix-control={mainKey}
          onClick={() => this.selectNode(block, node.id)} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); this.openSource(block, node.id, mainKey); }
          }}>
          <span class="remix-name"><span>{node.name}</span><span class="remix-tag">{node.owned ? 'Yours' : 'Built-in'}</span></span>
          <span class="remix-flow">{node.flow}{node.channels > 1 ? ` · ${node.channels} channels` : ''}</span>
        </button>
        <button class="remix-open" type="button" aria-label={`Source of ${node.name}`} title={`Source of ${node.name}`}
          data-remix-control={sourceKey} onClick={() => this.openSource(block, node.id, sourceKey)}><Icon name="chevron" /></button>
      </div>
      {selected && <div class="remix-detail">
        {node.params.map((param) => <Fragment key={param.id}>{this.props.paramControl(param, { kind: 'function', block, node: node.id })}</Fragment>)}
        <div class="remix-actions">
          {this.action(node.id, 'Replace', node.replace, () => this.navigate({ kind: 'chooser', block, place: { kind: 'node', id: node.id } }, replaceKey), undefined, replaceKey)}
          <button type="button" data-remix-control={actionKey} onClick={() => this.openSource(block, node.id, actionKey)}>Source<Icon name="chevron" /></button>
          {this.action(node.id, 'Move up', node.moveUp, () => this.props.actions.moveFunction(block, node.id, -1), 'up')}
          {this.action(node.id, 'Move down', node.moveDown, () => this.props.actions.moveFunction(block, node.id, 1), 'down')}
          {this.action(node.id, 'Remove', node.remove, () => this.props.actions.removeFunction(block, node.id), 'trash')}
        </div>{this.reason(node.id)}
      </div>}
    </li>;
  }
  private functions(detail: RemixBlockDetail): JSX.Element {
    const block = detail.block.id;
    const slots = (after: string | null): ComponentChildren => this.state.slots && detail.slots.filter((slot) => slot.after === after).map((slot) => {
      const key = controlKey('slot', block, slot.id);
      return <li key={slot.id}><button class="remix-slot" type="button" data-remix-control={key}
        onClick={() => this.navigate({ kind: 'chooser', block, place: { kind: 'slot', id: slot.id } }, key)}>
        <Icon name="add" /><span>Insert · {slot.flow}</span>
      </button></li>;
    });
    return <>
      <div class="remix-marker">{detail.inFlow}</div>
      <ol class="remix-chain">{slots(null)}{detail.nodes.map((node) => <Fragment key={node.id}>{this.nodeRow(block, node)}{slots(node.id)}</Fragment>)}</ol>
      <div class="remix-marker">{detail.outFlow}</div>
      <div class="remix-footer">
        <button type="button" aria-expanded={detail.slots.length === 0 ? undefined : this.state.slots}
          aria-disabled={detail.slots.length === 0} data-remix-control={controlKey('add-function')}
          onClick={() => detail.slots.length === 0
            ? this.setState({ reason: { owner: 'add-function', text: 'No function fits between these steps yet. Replace one instead.' } })
            : this.setState({ slots: !this.state.slots })}><Icon name="add" />Add function</button>
        {this.reason('add-function')}
        {this.action('save-block', 'Save as block…', detail.saveAsBlock, () => this.setState({ savingName: true }), undefined, controlKey('save-block'))}
        {this.state.savingName && <div class="remix-actions"><NameInput name={detail.block.name} label="New block name" saveButton
          onCommit={(name) => this.props.actions.saveAsBlock(block, name)}
          onFinish={() => this.setState({ savingName: false }, () => this.focusControl(controlKey('save-block')))} /></div>}
        {this.reason('save-block')}
      </div>
    </>;
  }
  private chooser(block: string, place: RemixPlace): JSX.Element {
    const candidates = this.props.actions.candidates(block, place);
    const groups = [
      { origin: 'this-block', label: 'In this block' }, { origin: 'other-block', label: 'From other blocks' }, { origin: 'yours', label: 'Yours' },
    ];
    const choose = (choice: RemixChoice): void => {
      this.pendingPlacement = { block, place, before: this.props.detail(block)?.nodes.map((node) => node.id) ?? [] };
      this.props.actions.placeFunction(block, place, choice.id);
      this.navigate({ kind: 'functions', block }, undefined, true);
    };
    return <>
      {groups.map((group) => {
        const choices = candidates.compatible.filter((choice) => choice.origin === group.origin);
        return choices.length === 0 ? null : <Fragment key={group.origin}><h3 class="panel-heading">{group.label}</h3>
          {choices.map((choice) => this.choice(choice, () => choose(choice)))}</Fragment>;
      })}
      {candidates.incompatible.length > 0 && <><h3 class="panel-heading">Needs a different input</h3>
        {candidates.incompatible.map((choice) => this.choice(choice, () => {}, true))}</>}
      {candidates.create.kind === 'available' && <button class="remix-choice" type="button" onClick={() => {
        const node = this.props.actions.createFunction(block, place);
        if (node === null) this.setState({ reason: { owner: 'create', text: 'The function could not be created here.' } });
        else {
          this.selectNode(block, node);
          this.openers.set(`functions:${block}`, controlKey('source', block, node));
          this.navigate({ kind: 'source', block, node, autoEdit: true });
        }
      }}><span class="remix-name">New function</span><Icon name="add" /></button>}
      {this.reason('create')}
    </>;
  }
  render(): JSX.Element {
    const view = this.state.view;
    const detail = 'block' in view ? this.props.detail(view.block) : null;
    const node = view.kind === 'source' ? detail?.nodes.find((node) => node.id === view.node) : undefined;
    const root = view.kind === 'blocks';
    const extra = view.kind === 'add-block' ? 'Add block' : view.kind === 'chooser' ? (view.place.kind === 'node' ? 'Replace function' : 'Insert function') : null;
    const label = view.kind === 'blocks' ? `${targetName(this.props.target)} blocks` : view.kind === 'functions' ? `${detail?.block.name ?? 'Block'} functions`
      : view.kind === 'source' ? `${node?.name ?? 'Function'} source` : extra ?? 'Choose a function';
    return <>
      <header class="remix-head" ref={this.head} onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        <div class="panel-title"><h2>Remix</h2><span class="remix-state" role="status" aria-live="polite" data-state={this.props.status.state}>
          {STATE_TEXT[this.props.status.state]}{this.props.status.state === 'save-failed' && <button type="button" onClick={() => this.props.actions.retrySave()}>Retry</button>}
        </span></div>
        {this.props.targets.length > 1 && <div class="color-segment remix-target" role="group" aria-label="Remix target">
          {this.props.targets.map((target) => <button key={target} type="button" aria-pressed={this.props.target === target}
            onClick={() => { if (target !== this.props.target) this.props.onTarget(target); }}>{targetName(target)}</button>)}
        </div>}
        <nav class="remix-path" aria-label="Remix path">
          {!root && <button class="icon-button" type="button" aria-label="Back" title="Back" onClick={this.back}><Icon name="back" /></button>}
          <ol class="remix-crumbs"><li>{root ? <span aria-current="location">{targetName(this.props.target)}</span>
            : <button type="button" onClick={() => this.navigate({ kind: 'blocks' }, undefined, true)}>{targetName(this.props.target)}</button>}</li>
            {detail !== null && <li>{view.kind === 'functions' ? <span aria-current="location">{detail.block.name}</span>
              : <button type="button" onClick={() => this.navigate({ kind: 'functions', block: detail.block.id }, undefined, true)}>{detail.block.name}</button>}</li>}
            {view.kind === 'source' && <li><span aria-current="location">{node?.name ?? 'Function'}</span></li>}
            {extra !== null && <li><span aria-current="location">{extra}</span></li>}
          </ol>
        </nav>
        {this.props.target === 'brush' && this.props.brushHead}
      </header>
      {this.props.status.notice !== null && <p class="remix-note">{this.props.status.notice}</p>}
      <section key={viewKey(view)} ref={this.level} class="remix-level" tabIndex={-1} aria-label={label}
        onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        {view.kind === 'blocks' && this.blocks()}
        {view.kind === 'add-block' && this.props.rack.addable.map((choice) => this.choice(choice, () => {
          this.props.actions.addBlock(choice.id, this.props.rack.blocks.length); this.navigate({ kind: 'blocks' }, undefined, true);
        }))}
        {view.kind === 'functions' && detail !== null && this.functions(detail)}
        {view.kind === 'chooser' && detail !== null && this.chooser(view.block, view.place)}
        {view.kind === 'source' && node !== undefined && this.props.renderSource(view.block, view.node, { autoEdit: view.autoEdit })}
      </section>
    </>;
  }
}
