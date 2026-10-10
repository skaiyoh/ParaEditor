// The phone checklist page, /dev/checklist.html: the index of sittings,
// sitting A's and sitting C's rows with their exact actions and links, the posts each answer
// makes to the results sink with the page's own environment snapshot and CSP
// violations, that snapshot under the no-isolation fault, the CSP violations
// the page saw carried by its posts, the posts sent as the page is left or
// frozen while they wait behind a slow one, what a card says when the sink
// refuses a post or does not answer, "Clear model cache", and the page at
// phone size in light and dark.

import { z } from '../../../src/core/zod.ts';
import type { Scenario, ScenarioContext, SinkLine } from '../scenario.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CHECKLIST = '/dev/checklist.html';

/** The iPhone 16 Pro's portrait viewport in CSS pixels. */
const PHONE = { width: 393, height: 852 } as const;

const IndexView = z.object({
  heading: z.string(),
  unknown: z.string().nullable(),
  links: z.array(z.object({ text: z.string(), href: z.string() })),
});

function readIndex(): unknown {
  const main = document.querySelector('main[data-sitting=none]');
  if (main === null) return null;
  return {
    heading: main.querySelector('h1')?.textContent ?? '',
    unknown: main.querySelector('[data-testid=unknown-sitting]')?.textContent ?? null,
    links: [...main.querySelectorAll<HTMLAnchorElement>('a[data-sitting-link]')].map((a) => ({ text: a.textContent ?? '', href: a.href })),
  };
}

const SittingView = z.object({
  sitting: z.string(),
  heading: z.string(),
  cards: z.array(
    z.object({
      row: z.string(),
      heading: z.string(),
      action: z.string(),
      question: z.string(),
      links: z.array(z.object({ text: z.string(), href: z.string(), target: z.string() })),
    }),
  ),
});

function readSitting(): unknown {
  const main = document.querySelector<HTMLElement>('main[data-sitting]');
  const sitting = main?.dataset['sitting'];
  if (main === null || sitting === undefined || sitting === 'none') return null;
  return {
    sitting,
    heading: main.querySelector('h1')?.textContent ?? '',
    cards: [...main.querySelectorAll<HTMLElement>('section[data-row]')].map((card) => ({
      row: card.dataset['row'] ?? '',
      heading: card.querySelector('h2')?.textContent ?? '',
      action: card.querySelector('[data-testid=action]')?.textContent ?? '',
      question: card.querySelector('[data-testid=question]')?.textContent ?? '',
      links: [...card.querySelectorAll<HTMLAnchorElement>('[data-testid=action] a')].map((a) => ({ text: a.textContent ?? '', href: a.href, target: a.target })),
    })),
  };
}

const Settled = z.object({ post: z.string(), matches: z.string().nullable(), environment: z.string().nullable(), text: z.string() });

// A page function is sent as its source text and cannot close over a helper,
// so each card's wait is its own function.

/** The conditions card's status once its latest post has settled. */
function conditionsSettled(): unknown {
  const status = document.querySelector<HTMLElement>('section[data-row=conditions] [data-testid=status]');
  const post = status?.dataset['post'];
  if (status === null || post === undefined || post === 'idle' || post === 'posting') return null;
  return { post, matches: status.dataset['matches'] ?? null, environment: status.dataset['environment'] ?? null, text: status.textContent ?? '' };
}

/** H1's status once its latest post has settled. */
function h1Settled(): unknown {
  const status = document.querySelector<HTMLElement>('section[data-row=H1] [data-testid=status]');
  const post = status?.dataset['post'];
  if (status === null || post === undefined || post === 'idle' || post === 'posting') return null;
  return { post, matches: status.dataset['matches'] ?? null, environment: status.dataset['environment'] ?? null, text: status.textContent ?? '' };
}

/** H1's status once a "no" answer has settled. */
function h1SettledNo(): unknown {
  const status = document.querySelector<HTMLElement>('section[data-row=H1] [data-testid=status]');
  const post = status?.dataset['post'];
  if (status === null || post === undefined || post === 'idle' || post === 'posting' || !(status.textContent ?? '').includes('Sent: no')) return null;
  return { post, matches: status.dataset['matches'] ?? null, environment: status.dataset['environment'] ?? null, text: status.textContent ?? '' };
}

/** H2's status once its latest post has settled. */
function h2Settled(): unknown {
  const status = document.querySelector<HTMLElement>('section[data-row=H2] [data-testid=status]');
  const post = status?.dataset['post'];
  if (status === null || post === undefined || post === 'idle' || post === 'posting') return null;
  return { post, matches: status.dataset['matches'] ?? null, environment: status.dataset['environment'] ?? null, text: status.textContent ?? '' };
}

const EnvironmentRead = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('read'),
    snapshot: z.object({
      build: z.string(),
      userAgent: z.string(),
      deviceClass: z.enum(['phone', 'desktop']),
      crossOriginIsolated: z.boolean(),
      hardwareConcurrency: z.number(),
      standalone: z.boolean(),
      storage: z.object({ quota: z.number().nullable(), persisted: z.boolean() }),
    }),
  }),
  z.object({ kind: z.literal('unavailable'), reason: z.string() }),
]);

const CspViolation = z.object({ directive: z.string(), blocked: z.string(), disposition: z.enum(['enforce', 'report']) });

const Common = { sitting: z.string(), buildId: z.string(), answeredAt: z.iso.datetime(), environment: EnvironmentRead, cspViolations: z.array(CspViolation) };

const AnswerRow = z.object({
  kind: z.literal('checklist-answer'),
  row: z.string(),
  part: z.string(),
  answer: z.object({ kind: z.string(), value: z.union([z.string(), z.number()]) }),
  expected: z.union([z.string(), z.number()]).nullable(),
  matches: z.boolean().nullable(),
  ...Common,
});
const ConditionsRow = z.object({
  kind: z.literal('checklist-conditions'),
  conditions: z.object({ onCharger: z.string(), lowPowerMode: z.string(), otherSafariTabsClosed: z.string() }),
  ...Common,
});
const ChecklistRow = z.discriminatedUnion('kind', [AnswerRow, ConditionsRow]);
type ChecklistRow = z.infer<typeof ChecklistRow>;

/** Every sink line that is a checklist row, parsed, in the sink's order; a line that does not parse fails a check. */
function checklistRows(t: ScenarioContext, lines: readonly SinkLine[]): readonly ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  for (const line of lines) {
    if (!('row' in line)) continue;
    const parsed = ChecklistRow.safeParse(line.row);
    if (parsed.success) rows.push(parsed.data);
    else t.ok('every sink row is a well-formed checklist row', false, { row: line.row, error: parsed.error.message });
  }
  return rows;
}

/**
 * Checks that a row carries the page's environment snapshot, read from this
 * build in this browser, isolated as `isolated` says, and no CSP violation.
 */
function checkEnvironment(t: ScenarioContext, label: string, row: ChecklistRow | undefined, isolated: boolean): void {
  t.equal(`${label}: the row carries the checklist's build id`, row?.buildId, t.build.buildId);
  const environment = row?.environment;
  if (!t.equal(`${label}: the page's environment was read`, environment?.kind, 'read', { environment })) return;
  if (environment?.kind !== 'read') return;
  const { snapshot } = environment;
  t.equal(`${label}: the snapshot's build id is build.json's`, snapshot.build, t.build.buildId);
  t.equal(`${label}: the snapshot's crossOriginIsolated is ${isolated}`, snapshot.crossOriginIsolated, isolated);
  t.equal(`${label}: the snapshot is headless Chrome's, outside the Home Screen`, [snapshot.userAgent.includes('Chrome/'), snapshot.standalone], [true, false], { snapshot });
  t.equal(`${label}: the row lists no CSP violation`, row?.cspViolations, []);
}

/** The sink's checklist rows once it holds `count` of them, polled for up to `ms`; what it holds then otherwise. */
async function sinkRowsOnce(t: ScenarioContext, count: number, ms: number): Promise<readonly ChecklistRow[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const lines = await t.server.sinkLines();
    if (lines.length >= count || Date.now() >= deadline) return checklistRows(t, lines);
    await sleep(100);
  }
}

/** The status text of a card whose latest post settled as `refused` or `no-reply`, or null. */
function h1Refused(): unknown {
  const status = document.querySelector<HTMLElement>('section[data-row=H1] [data-testid=status]');
  return status?.dataset['post'] === 'refused' ? status.textContent : null;
}

function h2NoReply(): unknown {
  const status = document.querySelector<HTMLElement>('section[data-row=H2] [data-testid=status]');
  return status?.dataset['post'] === 'no-reply' ? status.textContent : null;
}

function conditionsNoReply(): unknown {
  const status = document.querySelector<HTMLElement>('section[data-row=conditions] [data-testid=status]');
  return status?.dataset['post'] === 'no-reply' ? status.textContent : null;
}

function h1Posting(): unknown {
  return document.querySelector<HTMLElement>('section[data-row=H1] [data-testid=status]')?.dataset['post'] === 'posting';
}

function h2Posting(): unknown {
  return document.querySelector<HTMLElement>('section[data-row=H2] [data-testid=status]')?.dataset['post'] === 'posting';
}

/** Plants two model caches, one with an entry, and a cache of another name; returns every cache name. */
async function plantModelCaches(): Promise<unknown> {
  await (await caches.open('noisy-models-planted')).put('/models/planted.onnx', new Response('planted'));
  await caches.open('noisy-models-planted-partial');
  await caches.open('not-a-model-cache');
  return (await caches.keys()).sort();
}

async function cacheNames(): Promise<unknown> {
  return (await caches.keys()).sort();
}

function clearStatus(): unknown {
  const status = document.querySelector<HTMLElement>('[data-tool=model-cache] [data-testid=clear-status]');
  const state = status?.dataset['clear'];
  return state === 'cleared' || state === 'failed' ? { state, text: status?.textContent ?? '' } : null;
}

/** Every link, button, and field on the page smaller than 44 x 44 CSS pixels. */
function smallTargets(): unknown {
  return [...document.querySelectorAll<HTMLElement>('main a, main button, main input')]
    .map((el) => {
      const box = el.getBoundingClientRect();
      return { tag: el.tagName, text: (el.textContent ?? '').trim().slice(0, 40), width: Math.round(box.width), height: Math.round(box.height) };
    })
    .filter((target) => target.width < 44 || target.height < 44);
}

const Targets = z.array(z.object({ tag: z.string(), text: z.string(), width: z.number(), height: z.number() }));

async function openSittingA(t: ScenarioContext): Promise<z.infer<typeof SittingView>> {
  await t.page.goto(`${CHECKLIST}?sitting=A`);
  return t.page.waitFor('sitting A to render', SittingView, readSitting);
}

async function answerConditions(t: ScenarioContext): Promise<z.infer<typeof Settled>> {
  await t.page.click('[data-condition=onCharger] [data-answer=yes]');
  await t.page.click('[data-condition=lowPowerMode] [data-answer=no]');
  await t.page.click('[data-condition=otherSafariTabsClosed] [data-answer=yes]');
  await t.page.click('section[data-row=conditions] [data-testid=send]');
  return t.page.waitFor('the conditions post to settle', Settled, conditionsSettled);
}

async function answerH2(t: ScenarioContext, text: string): Promise<z.infer<typeof Settled>> {
  await t.page.type('section[data-row=H2] [data-testid=answer-input]', text);
  await t.page.click('section[data-row=H2] [data-testid=send]');
  return t.page.waitFor('the H2 post to settle', Settled, h2Settled);
}

function hasNoHorizontalScroll(): unknown {
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' };
}

function scrollToH2(): null {
  document.querySelector('section[data-row=H2]')?.scrollIntoView({ block: 'end' });
  return null;
}

/** Fires a `securitypolicyviolation` at H1's card, as a browser fires one at an element whose style attribute the CSP blocked. */
function dispatchViolation(directive: string, blocked: string, disposition: 'enforce' | 'report'): null {
  const init = { bubbles: true, composed: true, effectiveDirective: directive, violatedDirective: directive, blockedURI: blocked, disposition, documentURI: location.href, originalPolicy: "style-src 'self'", statusCode: 200 };
  (document.querySelector('section[data-row=H1]') ?? document).dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', init));
  return null;
}

/** The rows in the order the owner answered them, by their `answeredAt`. */
function byAnsweredAt(rows: readonly ChecklistRow[]): readonly ChecklistRow[] {
  return [...rows].sort((a, b) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt));
}

/** Each answer row as `[row, answer value]`, conditions rows as `['conditions']`. */
function answersOf(rows: readonly ChecklistRow[]): readonly (readonly unknown[])[] {
  return rows.map((r) => (r.kind === 'checklist-answer' ? [r.row, r.answer.value] : ['conditions']));
}

/** The count of the page's requests to the sink so far. */
function sinkRequests(t: ScenarioContext): number {
  return t.page.requests().filter((r) => r.url === `${t.baseUrl}api/log`).length;
}

const Width = z.object({ scrollWidth: z.number(), innerWidth: z.number(), scheme: z.string() });

export const scenarios: readonly Scenario[] = [
  {
    id: 'checklist.index',
    title: 'with no or an unknown sitting the checklist lists the sittings that have rows, A and C',
    target: 'dev',
    covers: [],
    async run(t) {
      for (const [path, asked] of [[CHECKLIST, null], [`${CHECKLIST}?sitting=Z`, 'Z']] as const) {
        await t.page.goto(path);
        const view = await t.page.waitFor('the index to render', IndexView, readIndex);
        t.equal(`${path}: the index is the checklist's`, view.heading, 'Phone checklist');
        t.equal(`${path}: it lists sittings A and C and links to each`, view.links, [
          { text: 'Sitting A: H1, H2', href: `${t.baseUrl}dev/checklist.html?sitting=A` },
          { text: 'Sitting C: H8', href: `${t.baseUrl}dev/checklist.html?sitting=C` },
        ]);
        t.equal(`${path}: it names the unknown sitting asked for`, view.unknown, asked === null ? null : `There is no sitting "${asked}" with rows on this page.`);
      }
    },
  },
  {
    id: 'checklist.sitting-a',
    title: 'sitting A lists H1 and H2 in order with their exact actions, questions, and same-origin links',
    target: 'dev',
    covers: [],
    async run(t) {
      const view = await openSittingA(t);
      t.equal('the page is sitting A', [view.sitting, view.heading], ['A', 'Sitting A']);
      t.equal('the conditions come first, then H1 and H2', view.cards.map((c) => c.row), ['conditions', 'H1', 'H2']);
      const [, h1, h2] = view.cards;
      t.equal('H1 names its part', h1?.heading, 'H1 P0.1');
      t.equal('H1\'s action is the registry\'s, word for word', h1?.action, 'In Safari open the noisy address the agent sends.');
      t.equal('H1 asks the registry\'s question with its expected answer', h1?.question, 'Does the page say "isolated: yes"? [yes]');
      t.equal('H1 links the noisy address on this origin', h1?.links, [{ text: 'the noisy address', href: t.baseUrl, target: '_blank' }]);
      t.equal('H2 names its part', h2?.heading, 'H2 P0.2');
      t.equal('H2\'s action is the registry\'s, word for word', h2?.action, 'Open /dev/threads.html and tap Run.');
      t.equal('H2 asks the registry\'s question with its expected answer', h2?.question, 'What thread count does it show? [2]');
      t.equal('H2 links the thread probe on this origin', h2?.links, [{ text: '/dev/threads.html', href: `${t.baseUrl}dev/threads.html`, target: '_blank' }]);
    },
  },
  {
    id: 'checklist.sitting-c',
    title: 'sitting C lists H8 with its exact action, question, and a same-origin link to the store page',
    target: 'dev',
    covers: [],
    async run(t) {
      await t.page.goto(`${CHECKLIST}?sitting=c`);
      const view = await t.page.waitFor('sitting C to render', SittingView, readSitting);
      t.equal('the page is sitting C', [view.sitting, view.heading], ['C', 'Sitting C']);
      t.equal('the conditions come first, then H8', view.cards.map((c) => c.row), ['conditions', 'H8']);
      const h8 = view.cards[1];
      t.equal('H8 names its part', h8?.heading, 'H8 P2b.1');
      t.equal('H8\'s action is the registry\'s, word for word', h8?.action, 'Open /dev/store.html, tap Write, switch to another app for ten minutes, come back, tap Write.');
      t.equal('H8 asks the registry\'s question with its expected answer', h8?.question, 'Does it say "second write saved"? [yes]');
      t.equal('H8 links the store page on this origin', h8?.links, [{ text: '/dev/store.html', href: `${t.baseUrl}dev/store.html`, target: '_blank' }]);
    },
  },
  {
    id: 'checklist.posts',
    title: 'the conditions and an answer to H1 and to H2 each post one row with the page\'s environment snapshot and no CSP violation; a mismatch is marked',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await openSittingA(t);
      const conditions = await answerConditions(t);
      t.equal('the conditions show as posted, with the environment read', [conditions.post, conditions.environment], ['posted', 'read']);

      await t.page.click('section[data-row=H1] [data-answer=yes]');
      const h1 = await t.page.waitFor('the H1 post to settle', Settled, h1Settled);
      t.equal('H1 shows as posted and matching, with the environment read', [h1.post, h1.matches, h1.environment], ['posted', 'true', 'read'], { text: h1.text });
      t.ok('H1 says what the page recorded', h1.text.includes(`Recorded with it: isolated yes, build ${t.build.buildId}.`), { text: h1.text });

      const h2 = await answerH2(t, '3');
      t.equal('H2 shows as posted and not matching, with the environment read', [h2.post, h2.matches, h2.environment], ['posted', 'false', 'read'], { text: h2.text });
      t.ok('H2 says the answer is not the expected one', h2.text.includes('Sent: 3, not the expected 2.'), { text: h2.text });
      await t.page.screenshot('checklist-posted');

      const rows = checklistRows(t, await t.server.sinkLines());
      t.equal('the sink holds three checklist rows, in the order answered', rows.map((r) => (r.kind === 'checklist-answer' ? r.row : 'conditions')), ['conditions', 'H1', 'H2']);
      const [c, a1, a2] = rows;
      t.equal('the conditions row names the sitting and the answers', c?.kind === 'checklist-conditions' ? [c.sitting, c.conditions] : null, [
        'A',
        { onCharger: 'yes', lowPowerMode: 'no', otherSafariTabsClosed: 'yes' },
      ]);
      checkEnvironment(t, 'conditions', c, true);
      t.equal('the H1 row: sitting, row, part, answer, expected, match', a1?.kind === 'checklist-answer' ? [a1.sitting, a1.row, a1.part, a1.answer, a1.expected, a1.matches] : null, [
        'A',
        'H1',
        'P0.1',
        { kind: 'yes-no', value: 'yes' },
        'yes',
        true,
      ]);
      checkEnvironment(t, 'H1', a1, true);
      t.equal('the H2 row: sitting, row, part, answer, expected, match', a2?.kind === 'checklist-answer' ? [a2.sitting, a2.row, a2.part, a2.answer, a2.expected, a2.matches] : null, [
        'A',
        'H2',
        'P0.2',
        { kind: 'number', value: 3 },
        2,
        false,
      ]);
      checkEnvironment(t, 'H2', a2, true);

      // Answering again posts a new row and the card shows the latest answer.
      await t.page.click('section[data-row=H1] [data-answer=no]');
      const again = await t.page.waitFor('the second H1 post to settle', Settled, h1SettledNo);
      t.equal('the second H1 answer shows as posted and not matching', [again.post, again.matches], ['posted', 'false']);
      t.ok('the second H1 answer shows as posted and not matching', again.text.includes('Sent: no, not the expected yes.'), { text: again.text });
      const after = checklistRows(t, await t.server.sinkLines());
      const last = after.at(-1);
      t.equal('answering again appends a fourth row, the latest for H1', [after.length, last?.kind === 'checklist-answer' ? [last.row, last.answer, last.matches] : null], [
        4,
        ['H1', { kind: 'yes-no', value: 'no' }, false],
      ]);
    },
  },
  {
    id: 'checklist.no-isolation',
    title: 'under the no-isolation fault the page posts a snapshot with crossOriginIsolated false, so the snapshot is read, not assumed',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await t.server.setFaults(['no-isolation']);
      await openSittingA(t);
      await t.page.click('section[data-row=H1] [data-answer=no]');
      const h1 = await t.page.waitFor('the H1 post to settle', Settled, h1Settled);
      t.equal('H1 shows as posted and not matching, with the environment read', [h1.post, h1.matches, h1.environment], ['posted', 'false', 'read'], { text: h1.text });
      t.ok('H1 says the page recorded itself as not isolated', h1.text.includes(`Recorded with it: isolated no, build ${t.build.buildId}.`), { text: h1.text });
      const rows = checklistRows(t, await t.server.sinkLines());
      t.equal('the sink holds H1\'s one answer', rows.map((r) => (r.kind === 'checklist-answer' ? [r.row, r.answer] : null)), [['H1', { kind: 'yes-no', value: 'no' }]]);
      checkEnvironment(t, 'H1', rows[0], false);
    },
  },
  {
    id: 'checklist.csp-violations',
    title: 'each post carries every CSP violation the page has seen by then, oldest first',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await openSittingA(t);
      // Dispatched events, not real violations: a real one would fail the driver's I6 checks, which every scenario gets.
      await t.page.evaluate(z.null(), dispatchViolation, 'style-src-attr', 'inline', 'enforce');
      await answerConditions(t);
      await t.page.evaluate(z.null(), dispatchViolation, 'img-src', 'data', 'report');
      await t.page.click('section[data-row=H1] [data-answer=yes]');
      await t.page.waitFor('the H1 post to settle', Settled, h1Settled);
      const rows = checklistRows(t, await t.server.sinkLines());
      const first = { directive: 'style-src-attr', blocked: 'inline', disposition: 'enforce' };
      const second = { directive: 'img-src', blocked: 'data', disposition: 'report' };
      t.equal('the conditions row lists the one violation seen before it', rows[0]?.kind === 'checklist-conditions' ? rows[0].cspViolations : null, [first]);
      t.equal('the H1 row lists both violations, oldest first', rows[1]?.kind === 'checklist-answer' ? rows[1].cspViolations : null, [first, second]);
    },
  },
  {
    id: 'checklist.left-mid-post',
    title: 'answers waiting behind a post that has no reply yet are sent, with the page\'s snapshot, when the owner leaves the page; answeredAt, not the sink\'s order, gives the latest answer',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await openSittingA(t);
      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'hold' } }]);
      await t.page.click('section[data-row=H1] [data-answer=yes]');
      await t.page.waitFor('the H1 post to start', z.literal(true), h1Posting);
      await t.page.click('section[data-row=H1] [data-answer=no]');
      await t.page.type('section[data-row=H2] [data-testid=answer-input]', '2');
      await t.page.click('section[data-row=H2] [data-testid=send]');
      await t.page.waitFor('the H2 post to wait its turn', z.literal(true), h2Posting);
      t.equal('only H1\'s first post has been sent; the other two wait behind it', sinkRequests(t), 1);
      await t.page.click('a.back');
      await t.page.waitFor('the index to render', IndexView, readIndex);
      // Releases the held posts: H1's first, sent with keepalive, and the two sent as the page was left.
      await t.page.intercept([]);
      const rows = await sinkRowsOnce(t, 3, 5000);
      t.equal('the sink holds the three answers, in some order', answersOf(rows).map((r) => r.join(' ')).sort(), ['H1 no', 'H1 yes', 'H2 2']);
      const ordered = byAnsweredAt(rows);
      t.equal('by answeredAt they are in the order answered, so H1\'s latest is no', answersOf(ordered), [['H1', 'yes'], ['H1', 'no'], ['H2', 2]], { sinkOrder: answersOf(rows) });
      checkEnvironment(t, 'H1 no, sent as the page was left', ordered[1], true);
      checkEnvironment(t, 'H2, sent as the page was left', ordered[2], true);
    },
  },
  {
    id: 'checklist.frozen-mid-post',
    title: 'an answer waiting behind a post that has no reply yet is sent as the page is hidden and frozen, as a background tab is, and the card shows it recorded once the page resumes',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await openSittingA(t);
      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'hold' } }]);
      await t.page.click('section[data-row=H1] [data-answer=yes]');
      await t.page.waitFor('the H1 post to start', z.literal(true), h1Posting);
      await t.page.type('section[data-row=H2] [data-testid=answer-input]', '2');
      await t.page.click('section[data-row=H2] [data-testid=send]');
      await t.page.waitFor('the H2 post to wait its turn', z.literal(true), h2Posting);
      t.equal('only H1\'s post has been sent; H2\'s waits behind it', sinkRequests(t), 1);
      await t.page.lifecycle('frozen');
      const deadline = Date.now() + 5000;
      while (sinkRequests(t) < 2 && Date.now() < deadline) await sleep(100);
      t.equal('H2\'s post is sent while the page is frozen', sinkRequests(t), 2);
      await t.page.lifecycle('active');
      await t.page.intercept([]);
      const h2 = await t.page.waitFor('the H2 post to settle', Settled, h2Settled);
      t.equal('once resumed, H2 shows as posted and matching', [h2.post, h2.matches, h2.environment], ['posted', 'true', 'read'], { text: h2.text });
      const rows = await sinkRowsOnce(t, 2, 5000);
      const ordered = byAnsweredAt(rows);
      t.equal('the sink holds both answers; by answeredAt, H1 first', answersOf(ordered), [['H1', 'yes'], ['H2', 2]], { sinkOrder: answersOf(rows) });
      checkEnvironment(t, 'H2, sent as the page was hidden', ordered[1], true);
    },
  },
  {
    id: 'checklist.sink-answers',
    title: 'a card says when the sink refuses a post, when the request fails, and when no reply comes within 10 seconds; only the answer the sink took is in it',
    target: 'dev',
    covers: [],
    readsSinkFiles: true,
    async run(t) {
      await openSittingA(t);
      t.expectMessage({ because: 'the intercepted sink answers 500', channel: 'log', source: 'network', level: 'error', url: /\/api\/log$/ });

      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'respond', status: 500, body: 'refused' } }]);
      await t.page.click('section[data-row=H1] [data-answer=yes]');
      const refused = await t.page.waitFor('H1 to show the refusal', z.string(), h1Refused);
      t.ok('a refused post says it was not recorded and why', refused.includes('Not recorded: the sink answered HTTP 500.') && refused.includes('Answer again to retry.'), { text: refused });

      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'fail' } }]);
      await answerH2(t, '2').catch(() => undefined);
      const failed = await t.page.waitFor('H2 to show no reply', z.string(), h2NoReply);
      t.ok('a failed request says no reply came and that it may have arrived', failed.includes('No reply from the Mac: Failed to fetch.') && failed.includes('may or may not have arrived'), { text: failed });

      await t.page.intercept([{ method: 'POST', path: '/api/log', action: { kind: 'hold' } }]);
      const started = Date.now();
      await answerConditions(t).catch(() => undefined);
      const stalled = await t.page.waitFor('the conditions to show no reply', z.string(), conditionsNoReply, { timeoutMs: 20_000 });
      const waited = Date.now() - started;
      t.ok('a post with no answer says no reply came, after 10 seconds', stalled.includes('No reply from the Mac:') && stalled.includes('timed out') && waited >= 10_000, { text: stalled, waited });

      await t.page.intercept([]);
      await t.page.click('section[data-row=H1] [data-answer=no]');
      const posted = await t.page.waitFor('the second H1 post to settle', Settled, h1SettledNo);
      t.equal('with the sink answering again, the answer posts', posted.post, 'posted', { text: posted.text });
      const rows = (await sinkRowsOnce(t, 2, 1000)).map((r) => (r.kind === 'checklist-answer' ? [r.row, r.answer] : ['conditions']));
      // The refused and the failed posts never reached the server. The held
      // one was released when the rules changed, after the page had given up
      // on it, and Chrome 154 still delivers it: a post with no reply may
      // have been recorded, as the card says.
      t.equal('the refused and the failed posts are not in the sink; the post with no reply may be, before the last answer', rows.filter((r) => r[0] !== 'conditions'), [['H1', { kind: 'yes-no', value: 'no' }]], { rows });
      t.equal('the last row is the answer posted once the sink answered', rows.at(-1), ['H1', { kind: 'yes-no', value: 'no' }], { rows });
    },
  },
  {
    id: 'checklist.clear-model-cache',
    title: '"Clear model cache" on a sitting deletes every model cache and no other cache, and says how many it cleared',
    target: 'dev',
    covers: [],
    async run(t) {
      await openSittingA(t);
      t.equal('the planted caches exist', await t.page.evaluate(z.array(z.string()), plantModelCaches), ['noisy-models-planted', 'noisy-models-planted-partial', 'not-a-model-cache']);
      await t.page.click('[data-testid=clear-model-cache]');
      const ClearStatus = z.object({ state: z.string(), text: z.string() });
      t.equal('the card says it cleared both model caches', await t.page.waitFor('the clear to settle', ClearStatus, clearStatus), { state: 'cleared', text: 'Cleared 2 model caches.' });
      t.equal('only the other cache is left', await t.page.evaluate(z.array(z.string()), cacheNames), ['not-a-model-cache']);
      await t.page.click('[data-testid=clear-model-cache]');
      await sleep(200);
      t.equal('a second clear finds nothing to clear', await t.page.waitFor('the second clear to settle', ClearStatus, clearStatus), { state: 'cleared', text: 'No model cache was stored.' });
      await t.page.screenshot('checklist-model-cache');
    },
  },
  {
    id: 'checklist.phone',
    title: 'sitting A at the iPhone 16 Pro\'s 393 x 852 portrait viewport has no horizontal scroll and no tap target under 44 x 44, in light and in dark',
    target: 'dev',
    covers: [],
    // It posts an answer, so it reads the sink back, which keeps a run attached with --base-url from writing it into a sitting's sink.
    readsSinkFiles: true,
    async run(t) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await t.page.emulate({ ...PHONE, deviceScaleFactor: 3, mobile: true, colorScheme });
        await openSittingA(t);
        const width = await t.page.evaluate(Width, hasNoHorizontalScroll);
        t.equal(`${colorScheme}: the page renders in the ${colorScheme} scheme`, width.scheme, colorScheme);
        t.equal(`${colorScheme}: the viewport is ${PHONE.width} CSS pixels wide`, width.innerWidth, PHONE.width);
        t.ok(`${colorScheme}: nothing is wider than the viewport`, width.scrollWidth <= PHONE.width, width);
        t.equal(`${colorScheme}: every link, button, and field is at least 44 x 44`, await t.page.evaluate(Targets, smallTargets), []);
        await t.page.screenshot(`checklist-phone-${colorScheme}`);
        await t.page.click('section[data-row=H1] [data-answer=yes]');
        await t.page.waitFor('the H1 post to settle', Settled, h1Settled);
        await t.page.evaluate(z.null(), scrollToH2);
        const scrolled = await t.page.evaluate(Width, hasNoHorizontalScroll);
        t.ok(`${colorScheme}: nothing is wider than the viewport once H1 is answered`, scrolled.scrollWidth <= PHONE.width, scrolled);
        await t.page.screenshot(`checklist-phone-${colorScheme}-rows`);
      }
      const rows = checklistRows(t, await t.server.sinkLines());
      t.equal('the sink holds the two answers given at phone size', rows.map((r) => (r.kind === 'checklist-answer' ? [r.row, r.answer] : null)), [
        ['H1', { kind: 'yes-no', value: 'yes' }],
        ['H1', { kind: 'yes-no', value: 'yes' }],
      ]);
    },
  },
];
