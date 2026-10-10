import type { ComponentChildren } from 'preact';

export function RangeControl({ id, label, value, min, max, step, onInput }: {
  readonly id: string; readonly label: string; readonly value: number;
  readonly min: number; readonly max: number; readonly step: number; readonly onInput: (value: number) => void;
}) {
  return <label class="range-row" for={id}>
    <span class={id === 'style-fry' ? 'range-label visually-hidden' : 'range-label'}>{label}</span>
    <input id={id} data-testid={id} type="range" min={min} max={max} step={step} value={value}
      style={{ '--fill': `${100 * (value - min) / (max - min)}%` }}
      onInput={(event) => onInput(Number(event.currentTarget.value))} />
    <output class="range-value" data-testid={`value-${id.replace(/^(style|symbols|motion)-/, '')}`} for={id}>{value}</output>
  </label>;
}

export function Node({ name, expanded, onExpand, toggle, children }: {
  readonly name: string; readonly expanded: boolean; readonly onExpand: () => void;
  readonly toggle?: ComponentChildren; readonly children: ComponentChildren;
}) {
  const id = `node-${name.toLowerCase()}`;
  return <section class="node" aria-label={name}>
    <div class="node-heading">
      <button class="node-disclosure" type="button" aria-expanded={expanded} aria-controls={id} onClick={onExpand}>
        <svg class="disclosure-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
        {name}
      </button>
      {toggle}
    </div>
    <div id={id} class="node-controls" hidden={!expanded}>{children}</div>
  </section>;
}

export function EnableSwitch({ name, checked, onChange }: {
  readonly name: 'Motion' | 'Symbols'; readonly checked: boolean; readonly onChange: (enabled: boolean) => void;
}) {
  return <label class="enable-switch" title={`${name} on or off`}>
    <input data-testid={`${name.toLowerCase()}-enabled`} type="checkbox" aria-label={name} checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)} />
  </label>;
}
