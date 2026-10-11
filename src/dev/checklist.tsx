// The phone checklist page (/dev/checklist.html, dev builds only). With
// ?sitting=<letter> it lists that sitting's rows from CHECKLIST_ROWS, each
// with its exact action, and posts the owner's answers to the results sink
// with what the page records about its own browser context; otherwise it
// lists the sittings that have rows. It writes nothing but its posts, and
// deletes the model caches when the owner taps "Clear model cache"; it reads
// nothing from the sink.

// First, so its CSP listener is in place before the rest of the page runs.
import './checklist-environment.ts';
import { render, type ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { clearModelCaches } from '../analysis/models.ts';
import type { EnvironmentRead } from './checklist-environment.ts';
import { matchOf, post, type Conditions, type PostResult } from './checklist-post.ts';
import { CHECKLIST_ROWS, SITTINGS, type ActionPart, type Answer, type BatchRow, type ChecklistRow, type ManualRow, type Sitting, type YesNo } from './checklist-rows.ts';
import { adoptStyles } from './checklist-style.ts';

// ------------------------------------------------------------ post state

/** `refused` and `no-reply` are `Posted`'s kinds: the sink answered with an error, or no answer came. */
type PostState =
  | { readonly post: 'idle' }
  | { readonly post: 'posting'; readonly summary: string }
  | { readonly post: 'posted'; readonly summary: string; readonly matches: boolean | null; readonly environment: EnvironmentRead }
  | { readonly post: 'refused'; readonly summary: string; readonly status: number }
  | { readonly post: 'no-reply'; readonly summary: string; readonly reason: string };

function settled(summary: string, matches: boolean | null, { posted, environment }: PostResult): PostState {
  switch (posted.kind) {
    case 'recorded':
      return { post: 'posted', summary, matches, environment };
    case 'refused':
      return { post: 'refused', summary, status: posted.status };
    case 'no-reply':
      return { post: 'no-reply', summary, reason: posted.reason };
    default: {
      const exhaustive: never = posted;
      return exhaustive;
    }
  }
}

/**
 * The state of a card's latest post. A post that settles after a later one
 * started changes nothing on screen, whether or not the sink recorded it.
 */
function usePostState(): [PostState, (summary: string, matches: boolean | null, run: () => Promise<PostResult>) => void] {
  const [state, setState] = useState<PostState>({ post: 'idle' });
  const latest = useRef(0);
  const start = (summary: string, matches: boolean | null, run: () => Promise<PostResult>): void => {
    const attempt = ++latest.current;
    setState({ post: 'posting', summary });
    // `run` never rejects by its contract; a rejection still ends the "Sending" state.
    void run().then(
      (result) => {
        if (attempt === latest.current) setState(settled(summary, matches, result));
      },
      (e: unknown) => {
        if (attempt === latest.current) setState({ post: 'no-reply', summary, reason: e instanceof Error ? e.message : String(e) });
      },
    );
  };
  return [state, start];
}

function environmentLine(environment: EnvironmentRead): string {
  if (environment.kind === 'unavailable') return `Environment not recorded: ${environment.reason}.`;
  const { crossOriginIsolated, build } = environment.snapshot;
  return `Recorded with it: isolated ${crossOriginIsolated ? 'yes' : 'no'}, build ${build}.`;
}

function Status({ state, expected }: { readonly state: PostState; readonly expected: string | null }) {
  const attrs = { 'data-testid': 'status', 'data-post': state.post, class: 'status', role: 'status' } as const;
  switch (state.post) {
    case 'idle':
      return <div {...attrs} />;
    case 'posting':
      return (
        <div {...attrs}>
          <strong>Sending {state.summary}...</strong>
        </div>
      );
    case 'posted': {
      const verdict = state.matches === null ? '' : state.matches ? ', as expected' : `, not the expected ${expected ?? ''}`;
      return (
        <div {...attrs} data-matches={state.matches === null ? 'none' : String(state.matches)} data-environment={state.environment.kind}>
          <strong>
            Sent: {state.summary}
            {verdict}.
          </strong>
          <span class="muted">{environmentLine(state.environment)} Answer again to send a newer answer; the latest one counts.</span>
        </div>
      );
    }
    case 'refused':
      return (
        <div {...attrs}>
          <strong>Not recorded: the sink answered HTTP {state.status}.</strong>
          <span class="muted">Answer again to retry.</span>
        </div>
      );
    case 'no-reply':
      return (
        <div {...attrs}>
          <strong>No reply from the Mac: {state.reason}.</strong>
          <span class="muted">The answer may or may not have arrived. Answer again to be sure; the latest answer counts.</span>
        </div>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

// ------------------------------------------------------------ rows

function Action({ parts }: { readonly parts: readonly ActionPart[] }) {
  return (
    <p class="action" data-testid="action">
      {parts.map((part) => {
        if (typeof part === 'string') return part;
        return (
          <a key={part.href} href={part.href} target="_blank">
            {part.code ? <code>{part.text}</code> : part.text}
          </a>
        );
      })}
    </p>
  );
}

function expectedText(row: ManualRow): string | null {
  const { expected } = row.answer;
  return expected === null ? null : String(expected);
}

function describeAnswer(answer: Answer): string {
  return String(answer.value);
}

function YesNoButtons({ chosen, onChoose, disabled = false }: { readonly chosen: YesNo | null; readonly onChoose: (v: YesNo) => void; readonly disabled?: boolean }) {
  return (
    <div class="choices">
      {(['yes', 'no'] as const).map((v) => (
        <button key={v} type="button" data-answer={v} aria-pressed={chosen === v} disabled={disabled} onClick={() => onChoose(v)}>
          {v === 'yes' ? 'Yes' : 'No'}
        </button>
      ))}
    </div>
  );
}

function TextEntry({ kind, onSend }: { readonly kind: 'number' | 'observation'; readonly onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const valid = kind === 'number' ? text.trim() !== '' && Number.isFinite(Number(text.trim())) : text.trim() !== '';
  return (
    <form
      class="entry"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSend(text.trim());
      }}
    >
      <input
        type="text"
        data-testid="answer-input"
        inputMode={kind === 'number' ? 'decimal' : 'text'}
        autoComplete="off"
        aria-label={kind === 'number' ? 'Your answer, a number' : 'Your answer, in a few words'}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <button type="submit" class="primary" data-testid="send" disabled={!valid}>
        Send
      </button>
    </form>
  );
}

function ManualCard({ row, sitting }: { readonly row: ManualRow; readonly sitting: Sitting }) {
  const [state, start] = usePostState();
  const [chosen, setChosen] = useState<YesNo | null>(null);
  const expected = expectedText(row);

  const send = (answer: Answer): void => {
    const { expected: expectedValue, matches } = matchOf(row, answer);
    const answeredAt = new Date().toISOString();
    start(describeAnswer(answer), matches, () =>
      post({
        kind: 'checklist-answer',
        sitting,
        row: row.id,
        part: row.part,
        answer,
        expected: expectedValue,
        matches,
        buildId: NOISY_BUILD_ID,
        answeredAt,
      }),
    );
  };

  const spec = row.answer;
  let input: ComponentChildren;
  switch (spec.kind) {
    case 'yes-no':
      input = (
        <YesNoButtons
          chosen={chosen}
          onChoose={(value) => {
            setChosen(value);
            send({ kind: 'yes-no', value });
          }}
        />
      );
      break;
    case 'number':
      input = <TextEntry kind="number" onSend={(text) => send({ kind: 'number', value: Number(text) })} />;
      break;
    case 'observation':
      input = <TextEntry kind="observation" onSend={(text) => send({ kind: 'observation', value: text })} />;
      break;
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }

  return (
    <section class="card" data-row={row.id}>
      <RowHeading row={row} />
      <Action parts={row.action} />
      <p class="question" data-testid="question">
        {row.question}
        {expected === null ? null : <span class="muted"> [{expected}]</span>}
      </p>
      {row.recorded === null ? null : <p class="muted">Recorded automatically: {row.recorded}.</p>}
      {row.attach === 'screenshot' ? <p class="muted">Attaching a screenshot is not built into this page yet.</p> : null}
      {input}
      <Status state={state} expected={expected} />
    </section>
  );
}

function BatchCard({ row }: { readonly row: BatchRow }) {
  return (
    <section class="card" data-row={row.id}>
      <RowHeading row={row} />
      <Action parts={row.action} />
      <p class="question">{row.question}</p>
      <p class="muted">This page cannot run batch rows yet.</p>
    </section>
  );
}

function RowHeading({ row }: { readonly row: ChecklistRow }) {
  return (
    <h2>
      {row.id} <span class="muted">{row.part}</span>
    </h2>
  );
}

function RowCard({ row, sitting }: { readonly row: ChecklistRow; readonly sitting: Sitting }) {
  switch (row.kind) {
    case 'manual':
      return <ManualCard row={row} sitting={sitting} />;
    case 'batch':
      return <BatchCard row={row} />;
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

// ------------------------------------------------------------ conditions

const CONDITION_QUESTIONS: readonly { readonly key: keyof Conditions; readonly question: string }[] = [
  { key: 'onCharger', question: 'Is the phone on its charger?' },
  { key: 'lowPowerMode', question: 'Is Low Power Mode on?' },
  { key: 'otherSafariTabsClosed', question: 'Are all other Safari tabs closed?' },
];

function ConditionsCard({ sitting }: { readonly sitting: Sitting }) {
  const [state, start] = usePostState();
  const [chosen, setChosen] = useState<Partial<Record<keyof Conditions, YesNo>>>({});
  const { onCharger, lowPowerMode, otherSafariTabsClosed } = chosen;
  const complete = onCharger !== undefined && lowPowerMode !== undefined && otherSafariTabsClosed !== undefined ? { onCharger, lowPowerMode, otherSafariTabsClosed } : null;

  const send = (conditions: Conditions): void => {
    const answeredAt = new Date().toISOString();
    const summary = `charger ${conditions.onCharger}, Low Power Mode ${conditions.lowPowerMode}, other tabs closed ${conditions.otherSafariTabsClosed}`;
    start(summary, null, () => post({ kind: 'checklist-conditions', sitting, conditions, buildId: NOISY_BUILD_ID, answeredAt }));
  };

  return (
    <section class="card" data-row="conditions">
      <h2>Conditions</h2>
      <p class="muted">Send these first. This page records the browser it runs in and whether it was opened from the Home Screen.</p>
      {CONDITION_QUESTIONS.map(({ key, question }) => (
        <div key={key} class="ask" data-condition={key}>
          <p class="question">{question}</p>
          <YesNoButtons chosen={chosen[key] ?? null} onChoose={(value) => setChosen({ ...chosen, [key]: value })} />
        </div>
      ))}
      <button type="button" class="primary wide" data-testid="send" disabled={complete === null} onClick={() => complete !== null && send(complete)}>
        Send
      </button>
      <Status state={state} expected={null} />
    </section>
  );
}

// ------------------------------------------------------------ controls

type ClearState =
  | { readonly clear: 'idle' }
  | { readonly clear: 'clearing' }
  | { readonly clear: 'cleared'; readonly count: number }
  | { readonly clear: 'failed'; readonly reason: string };

function clearedText(state: ClearState): string {
  switch (state.clear) {
    case 'idle':
      return '';
    case 'clearing':
      return 'Clearing...';
    case 'cleared':
      return state.count === 0 ? 'No model cache was stored.' : `Cleared ${state.count} model ${state.count === 1 ? 'cache' : 'caches'}.`;
    case 'failed':
      return `Not cleared: ${state.reason}.`;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** Deletes every model cache, so the next analysis downloads its models again. */
function ModelCacheCard() {
  const [state, setState] = useState<ClearState>({ clear: 'idle' });
  const clear = (): void => {
    setState({ clear: 'clearing' });
    void clearModelCaches(caches).then(
      (result) => setState(result.ok ? { clear: 'cleared', count: result.value.length } : { clear: 'failed', reason: `Cache Storage refused (${result.error.kind})` }),
      (e: unknown) => setState({ clear: 'failed', reason: e instanceof Error ? e.message : String(e) }),
    );
  };
  return (
    <section class="card" data-tool="model-cache">
      <h2>Model cache</h2>
      <p class="muted">Deletes the downloaded models, so ParaEditor downloads them again the next time it needs them. Do this only when a row asks.</p>
      <button type="button" class="wide" data-testid="clear-model-cache" disabled={state.clear === 'clearing'} onClick={clear}>
        Clear model cache
      </button>
      <div class="status" role="status" data-testid="clear-status" data-clear={state.clear}>
        {clearedText(state)}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ pages

function rowsOf(sitting: Sitting): readonly ChecklistRow[] {
  return CHECKLIST_ROWS.filter((row) => row.sitting === sitting);
}

function SittingPage({ sitting, rows }: { readonly sitting: Sitting; readonly rows: readonly ChecklistRow[] }) {
  return (
    <main data-sitting={sitting}>
      <p class="muted">
        <a class="back" href="?">
          All sittings
        </a>
      </p>
      <h1>Sitting {sitting}</h1>
      <p class="muted" data-testid="build-id">
        Checklist build {NOISY_BUILD_ID}. Each answer goes to the Mac as you give it.
      </p>
      <ConditionsCard sitting={sitting} />
      {rows.map((row) => (
        <RowCard key={row.id} row={row} sitting={sitting} />
      ))}
      <ModelCacheCard />
    </main>
  );
}

function Index({ asked }: { readonly asked: string | null }) {
  const sittings = SITTINGS.filter((s) => rowsOf(s).length > 0);
  return (
    <main data-sitting="none">
      <h1>Phone checklist</h1>
      {asked === null ? null : (
        <p data-testid="unknown-sitting">
          There is no sitting "{asked}" with rows on this page.
        </p>
      )}
      <p class="muted">Choose the sitting the agent named.</p>
      <ul class="sittings">
        {sittings.map((s) => (
          <li key={s}>
            <a href={`?sitting=${s}`} data-sitting-link={s}>
              Sitting {s}: {rowsOf(s).map((r) => r.id).join(', ')}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

function isSitting(value: string): value is Sitting {
  return SITTINGS.some((s) => s === value);
}

function Page() {
  const asked = new URLSearchParams(location.search).get('sitting');
  const sitting = asked?.trim().toUpperCase() ?? '';
  if (isSitting(sitting)) {
    const rows = rowsOf(sitting);
    if (rows.length > 0) return <SittingPage sitting={sitting} rows={rows} />;
  }
  return <Index asked={asked === null || asked === '' ? null : asked} />;
}

adoptStyles(document);
const element = document.getElementById('checklist');
if (element !== null) render(<Page />, element);
