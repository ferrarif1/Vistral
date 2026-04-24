import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readText = (...parts: string[]): string => readFileSync(join(rootDir, ...parts), 'utf8');

const assertIncludes = (source: string, expected: string, label: string) => {
  assert.ok(source.includes(expected), `expected ${label}: ${expected}`);
};

const assertMatches = (source: string, pattern: RegExp, label: string) => {
  assert.match(source, pattern, `expected ${label}`);
};

const packageJson = JSON.parse(readText('package.json')) as {
  scripts?: Record<string, string>;
};
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts['smoke:conversation-next-steps-ui-wiring'],
  'tsx scripts/smoke-conversation-next-steps-ui-wiring.ts',
  'smoke:conversation-next-steps-ui-wiring command should point at this guard'
);
assert.equal(
  scripts['smoke:conversation-next-steps'],
  'tsx scripts/smoke-conversation-next-steps.ts',
  'pure next-step smoke should stay available beside UI wiring smoke'
);

const conversationPage = readText('src/pages/ConversationPage.tsx');
const appShell = readText('src/layouts/AppShell.tsx');
const i18n = readText('src/i18n/I18nProvider.tsx');
const styles = readText('src/styles/theme.css');

for (const [label, source] of [
  ['ConversationPage', conversationPage],
  ['AppShell dock', appShell]
] as const) {
  assertIncludes(
    source,
    "from '../features/conversationActionNextSteps';",
    `${label} imports shared conversation action next-step module`
  );
  assertIncludes(
    source,
    'deriveConversationActionNextSteps(actionMetadata, t)',
    `${label} derives suggested next steps from shared helper`
  );
  assertIncludes(
    source,
    'buildConversationActionNextStepInput(step)',
    `${label} builds guarded /ops input from shared helper`
  );
  assertIncludes(source, "t('Suggested next steps')", `${label} renders shared suggested-next-steps label`);
  assertIncludes(source, 'actionNextSteps[0]?.detail', `${label} renders first next-step detail`);
  assertIncludes(source, 'navigate(step.href)', `${label} supports href navigation next steps`);
  assertIncludes(source, 'setInput(nextInput)', `${label} preserves next-step input when auto-send is blocked`);
}

assertMatches(
  conversationPage,
  /const\s+actionNextSteps\s*=\s*actionMetadata\s*\?\s*deriveConversationActionNextSteps\(actionMetadata,\s*t\)\s*:\s*\[\];/,
  'ConversationPage computes actionNextSteps per action card'
);
assertIncludes(conversationPage, 'actionNextSteps.slice(0, 3).map', 'ConversationPage limits visible next steps');
assertIncludes(conversationPage, "step.kind === 'href' && step.href", 'ConversationPage renders href steps as links');
assertIncludes(conversationPage, 'to={step.href}', 'ConversationPage href steps keep router links');
assertIncludes(conversationPage, "step.kind === 'ops'", 'ConversationPage renders ops steps as buttons');
assertIncludes(
  conversationPage,
  'onClick={() => onRunConversationNextStep(step)}',
  'ConversationPage next-step buttons call run handler'
);
assertIncludes(
  conversationPage,
  'void sendWithContent(nextInput).catch',
  'ConversationPage auto-sends executable next-step input when safe'
);
assertIncludes(
  conversationPage,
  "setNotice(t('Suggested next step inserted into composer.'))",
  'ConversationPage explains inserted next-step fallback'
);
assertIncludes(
  conversationPage,
  "setNotice(t('Suggested next step sent. Confirm if prompted.'))",
  'ConversationPage explains sent next-step confirmation flow'
);
assertIncludes(
  conversationPage,
  'composerTextareaRef.current?.focus();',
  'ConversationPage restores composer focus after fallback'
);

assertMatches(
  appShell,
  /const\s+actionNextSteps\s*=\s*actionMetadata\s*\?\s*deriveConversationActionNextSteps\(actionMetadata,\s*t\)\s*:\s*\[\];/,
  'AppShell dock computes actionNextSteps per action card'
);
assertIncludes(appShell, 'actionNextSteps.slice(0, 2).map', 'AppShell dock limits compact next steps');
assertIncludes(appShell, 'className="app-chat-dock-action-next-steps"', 'AppShell dock renders next-step container');
assertIncludes(
  appShell,
  'onClick={() => void runDockNextStep(step)}',
  'AppShell dock next-step buttons call run handler'
);
assertIncludes(appShell, "disabled={step.kind === 'none'}", 'AppShell dock disables informational next steps');
assertIncludes(appShell, 'const shouldAutoSubmit = !sending && !loading && !uploadingAttachment && !authRequired;', 'AppShell dock gates auto-submit');
assertIncludes(appShell, 'const ok = await sendDockContent(nextInput);', 'AppShell dock auto-sends executable next-step input when safe');

for (const key of [
  'Suggested next steps',
  'Suggested next step inserted into composer.',
  'Suggested next step sent. Confirm if prompted.',
  'Retry on control-plane lane',
  'Review runtime environment',
  'Check worker/account permissions',
  'Open training logs'
]) {
  assertIncludes(i18n, `'${key}'`, `i18n key ${key}`);
}

for (const selector of ['.chat-action-btn', '.app-chat-dock-action-next-steps', '.app-chat-dock-inline-action']) {
  assertIncludes(styles, selector, `style selector ${selector}`);
}

console.log('[smoke-conversation-next-steps-ui-wiring] PASS');
