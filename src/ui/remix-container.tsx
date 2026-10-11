import type { JSX } from 'preact';
import type { DemoSession } from '../session/scene.ts';
import { RangeControl } from './controls.tsx';
import { RemixBrushBasics, RemixPad } from './remix-brush.tsx';
import type { RemixModel, RemixParam, RemixParamOwner } from './remix-model.ts';
import { RemixSourceView } from './remix-source.tsx';
import { RemixPanel } from './remix.tsx';

export type RemixFocus = { readonly block: string; readonly level: 'blocks' | 'functions' };

// Fixed-width UTF-16 encoding preserves case and punctuation without ID collisions.
const idPart = (value: string): string => value.split('').map((char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');

export function RemixContainer(props: {
  readonly session: DemoSession;
  readonly model: RemixModel;
  /** The same object until the next shortcut use, so RemixPanel applies it once. */
  readonly focus: RemixFocus | null;
  readonly onOpenColor: () => void;
}): JSX.Element {
  const { session, model, focus } = props;
  const paramControl = (param: RemixParam, owner: RemixParamOwner): JSX.Element => {
    const parts = owner.kind === 'brush' ? [param.id]
      : owner.kind === 'block' ? [owner.block, param.id] : [owner.block, owner.node, param.id];
    const id = `remix-${model.target}-${owner.kind}-${parts.map(idPart).join('-')}`;
    if (owner.kind === 'brush') return <label class="range-row" for={id}>
      <span class="range-label">{param.label}</span>
      <input type="range" id={id} min={param.min} max={param.max} step={param.step} value={param.value}
        style={{ '--fill': `${100 * (param.value - param.min) / (param.max - param.min)}%` }}
        onInput={(event) => model.setBrushParam(param, Number(event.currentTarget.value))} />
      <output class="range-value" for={id}>{param.display}</output>
    </label>;
    return <RangeControl id={id} label={param.label} min={param.min} max={param.max} step={param.step}
      value={param.value} session={session} valueFor={(value) => model.parameterValue(owner, param, value)} />;
  };
  const brush = model.brush;
  const pad = brush === null ? null : { ...brush.pad, openColor: props.onOpenColor };
  return <RemixPanel status={model.status} targets={model.targets} target={model.target} onTarget={model.setTarget}
    rack={model.rack} detail={model.detail} actions={model.actions} focus={focus} paramControl={paramControl}
    renderSource={(block, node, { autoEdit }) => {
      const source = model.source(block, node);
      return source === null ? <p class="remix-note">This function is no longer available.</p>
        : <RemixSourceView source={source} actions={model.actions} autoEdit={autoEdit} />;
    }}
    brushHead={brush !== null && pad !== null ? <RemixPad brush={brush.view} pad={pad} /> : null}
    brushBasics={brush !== null && pad !== null ? <RemixBrushBasics brush={brush.view} pad={pad} paramControl={paramControl} /> : null} />;
}
