import type { Capability, GestureValue } from '../session/authoring.ts';

/**
 * The Remix panel's view of one recipe (plan/evidence/MRX5u-design.md).
 * A session adapter fills these from the snapshot; Remix components only render them and call RemixActions.
 * Components keep navigation and focus only: the session owns drafts, applied revisions, errors, history and saving.
 */

export type RemixTarget = 'photo' | 'brush';

/** Checking, Applied, Saving, Saved, Not applied, Draft saved, Save failed, in the session's words. */
export type RemixState = 'checking' | 'applied' | 'saving' | 'saved' | 'invalid' | 'draft-saved' | 'save-failed';

export type RemixStatus = {
  readonly state: RemixState;
  /** True while the picture shows the last valid revision because the draft is invalid. */
  readonly lastWorkingPreview: boolean;
  /** A one-time notice, such as a copy-on-write copy; null when there is none. */
  readonly notice: string | null;
};

/** One numeric parameter. The container renders its control (a session gesture range in the app). */
export type RemixParam = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The value as shown, such as "0.42" or "2". */
  readonly display: string;
};

/** Where a parameter lives, so the container can bind its control to the right session gesture. */
export type RemixParamOwner =
  | { readonly kind: 'block'; readonly block: string }
  | { readonly kind: 'function'; readonly block: string; readonly node: string }
  | { readonly kind: 'brush' };

export type RemixBlock = {
  /** The instance id in this target's rack. */
  readonly id: string;
  readonly name: string;
  /** Packaged by the user, or a copy-on-write copy; owned blocks show "Yours" and can be renamed. */
  readonly owned: boolean;
  readonly enabled: boolean;
  /** The key parameters shown on the row and in its expanded detail. */
  readonly params: readonly RemixParam[];
  readonly moveUp: Capability;
  readonly moveDown: Capability;
  readonly remove: Capability;
  /** Offered on a block whose output is an amount, from stage 2; null when not offered. */
  readonly useInBrush: Capability | null;
};

/** An entry in a chooser: a block to add, or a function to place. */
export type RemixChoice = {
  readonly id: string;
  readonly name: string;
  /** One plain line: a block's description, or a function's flow such as "amount → amount". */
  readonly detail: string;
  /** Functions only: where the definition comes from. */
  readonly origin: 'this-block' | 'other-block' | 'yours' | null;
  /** Unavailable entries are still listed; choosing one shows the reason and changes nothing. */
  readonly available: Capability;
};

export type RemixRack = {
  readonly target: RemixTarget;
  /** The top marker, such as "Photo in". */
  readonly inLabel: string;
  /** The bottom marker, such as "Result". */
  readonly outLabel: string;
  /** In order of application: the first block runs first and is drawn at the top. */
  readonly blocks: readonly RemixBlock[];
  readonly addable: readonly RemixChoice[];
};

export type RemixFunctionNode = {
  readonly id: string;
  readonly name: string;
  /** What flows through it, in plain words: "noise → amount". */
  readonly flow: string;
  readonly owned: boolean;
  /** Parallel identical nodes drawn as one row, such as three noise channels; 1 otherwise. */
  readonly channels: number;
  /** Drawn as a short branch joining the node with this id; null on the main spine. */
  readonly branchOf: string | null;
  readonly params: readonly RemixParam[];
  readonly replace: Capability;
  readonly moveUp: Capability;
  readonly moveDown: Capability;
  readonly remove: Capability;
};

/** An insertion point to inspect; the chooser explains incompatible functions and budget limits. */
export type RemixSlot = {
  readonly id: string;
  /** The node this slot follows in chain order; null for the first position. */
  readonly after: string | null;
  /** The flow an inserted function must keep: "amount → amount". */
  readonly flow: string;
};

export type RemixBlockDetail = {
  readonly block: RemixBlock;
  /** The block's input and output in plain words, for the chain's top and bottom markers. */
  readonly inFlow: string;
  readonly outFlow: string;
  /** In chain order, input first. */
  readonly nodes: readonly RemixFunctionNode[];
  readonly slots: readonly RemixSlot[];
  readonly saveAsBlock: Capability;
};

export type RemixCandidates = {
  readonly compatible: readonly RemixChoice[];
  readonly incompatible: readonly RemixChoice[];
  /** Creating a function here starts from the backend's working example with this slot's flow. */
  readonly create: Capability;
};

export type RemixPlace = { readonly kind: 'node' | 'slot'; readonly id: string };

export type RemixDiagnostic = {
  /** 1-based, in this function's own source. */
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

export type RemixSource = {
  readonly block: string;
  readonly node: string;
  readonly name: string;
  /** The typed signature in the language's own words: "(n: noise) -> noise". */
  readonly signature: string;
  /** Owned functions edit in place; built-ins copy on the first change (lead ruling, 2026-10-11). */
  readonly owned: boolean;
  /** The applied, running source. */
  readonly text: string;
  /** The recoverable draft when it differs from the applied source; null otherwise. */
  readonly draft: string | null;
  readonly diagnostics: readonly RemixDiagnostic[];
  /** Whether an edit session (Edit to Done, one Undo step) is open for this function. */
  readonly editing: boolean;
  readonly example: string;
  readonly builtins: readonly string[];
};

export type RemixActions = {
  readonly setBlockEnabled: (block: string, enabled: boolean) => void;
  /** One history action. */
  readonly moveBlock: (block: string, toIndex: number) => void;
  readonly removeBlock: (block: string) => void;
  readonly renameBlock: (block: string, name: string) => void;
  /** `choice` is a RemixChoice id from the rack's addable list. */
  readonly addBlock: (choice: string, index: number) => void;
  readonly useInBrush: (block: string) => void;
  readonly candidates: (block: string, at: RemixPlace) => RemixCandidates;
  readonly placeFunction: (block: string, at: RemixPlace, choice: string) => void;
  /** Creates an owned function from the working example at that place; returns its node id, or null when refused. */
  readonly createFunction: (block: string, at: RemixPlace) => string | null;
  readonly moveFunction: (block: string, node: string, delta: -1 | 1) => void;
  readonly removeFunction: (block: string, node: string) => void;
  readonly saveAsBlock: (block: string, name: string) => void;
  /** Opens an edit session; a built-in is copied on its first change. */
  readonly beginEdit: (block: string, node: string) => void;
  /** The session validates, applies and saves; the component never debounces or applies. */
  readonly setDraft: (block: string, node: string, text: string) => void;
  readonly endEdit: (block: string, node: string) => void;
  readonly retrySave: () => void;
};

/** One pointer sample on the brush pad, in pad-relative units (0 to 1 on each axis). */
export type RemixPadSample = {
  readonly x: number;
  readonly y: number;
  /** 0 to 1, or null when the input reports no pressure. */
  readonly pressure: number | null;
  /** event.timeStamp, in milliseconds. */
  readonly time: number;
  /** Pencil, or anything else; the pad is an explicit drawing surface, so a finger or mouse draws there too. */
  readonly pointer: 'pen' | 'finger';
};

export type RemixBrush = {
  /** The ink as a CSS color for the color dot. */
  readonly color: string;
  readonly colorLabel: string;
  readonly size: RemixParam;
  readonly opacity: RemixParam;
  /** Null when this device reports no pressure. */
  readonly pressure: boolean | null;
  /** Whether scene drawing is available, or why not (no photo, or depth missing or not ready; MRX0 S13). */
  readonly drawing: Capability;
  /** The pad's backdrop, chosen by the session from the ink's lightness. */
  readonly backdrop: 'dark' | 'light';
};

export type RemixPadActions = {
  /** Hands the pad canvas to the session's brush renderer; returns the detach. */
  readonly attach: (canvas: HTMLCanvasElement) => () => void;
  /** Starts a test-pad stroke; returns a token, or null when refused. */
  readonly begin: (sample: RemixPadSample) => symbol | null;
  readonly extend: (token: symbol, samples: readonly RemixPadSample[]) => void;
  readonly end: (token: symbol) => void;
  readonly cancel: (token: symbol) => void;
  /** Restores the canonical stroke. */
  readonly reset: () => void;
  readonly setPressure: (enabled: boolean) => void;
  readonly openColor: () => void;
};

/** The four words fixed by the MRX0 settlement (S5), then plain words for the remaining parameter types. */
const TYPE_WORDS: Readonly<Record<string, string>> = {
  coord: 'position', cell: 'position', noise: 'noise', coverage: 'amount', srgb: 'color', linear: 'color', oklab: 'color',
  scalar: 'number', seed: 'seed', hold: 'frame', time: 'time', pressure: 'pressure', vec2: 'pair', vec3: 'triple', bool: 'yes or no',
};

/** The plain word for a semantic type (Nathan, 2026-10-11; MRX0 S5); an unknown type shows as itself. */
export function typeWord(type: string): string {
  return TYPE_WORDS[type] ?? type;
}

/** "noise → amount", from a function's input and output types; inputs repeat once each in order. */
export function flowWords(inputs: readonly string[], output: string): string {
  const seen = [...new Set(inputs.map(typeWord))];
  return seen.length === 0 ? typeWord(output) : `${seen.join(', ')} → ${typeWord(output)}`;
}

/** The Grain-family controls in Adjustments whose binding the remix can change (MRX0 item 3). */
export type RemixGrainControl = 'grain' | 'colorNoise' | 'grainSize';

/**
 * Everything the Remix mount needs for one render, built by `remixModel(session)` in remix-adapter.ts.
 * The adapter is the only place that knows the session's remix API; the container and the panels see only this.
 */
export type RemixModel = {
  readonly status: RemixStatus;
  readonly targets: readonly RemixTarget[];
  readonly target: RemixTarget;
  readonly setTarget: (target: RemixTarget) => void;
  readonly rack: RemixRack;
  readonly detail: (block: string) => RemixBlockDetail | null;
  readonly source: (block: string, node: string) => RemixSource | null;
  readonly actions: RemixActions;
  /** The session gesture value for a block or function parameter (MRX0 S4, G13); one drag is one history action. */
  readonly parameterValue: (owner: Exclude<RemixParamOwner, { readonly kind: 'brush' }>, param: RemixParam, value: number) => GestureValue;
  /** Brush size and opacity are project state, not history (MRX0 S9, G14). */
  readonly setBrushParam: (param: RemixParam, value: number) => void;
  /** Stage 2 only; null while the brush target is unavailable. */
  readonly brush: { readonly view: RemixBrush; readonly pad: RemixPadActions } | null;
  /** The rack instance that holds the photo's Grain, for the Remix Grain shortcut in Adjustments; null when there is none. */
  readonly grainBlock: string | null;
  /** Whether an Adjustments Grain control still has its meaning after a structural remix, or why not. */
  readonly grainControl: (control: RemixGrainControl) => Capability;
  /** Whether Fry still binds both Grain parameters, or why it is off. */
  readonly fry: Capability;
};

