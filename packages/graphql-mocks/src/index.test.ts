import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import type {
  CountFieldsConfig,
  DeriveConfig,
  DeriveContext,
  FieldDeriveFn,
  OverridesConfig,
} from './index.js';

// The public surface has no other guardrail — index.ts is excluded from coverage and nothing
// else imports it — so pin the exported names. Adding one here is the deliberate step that
// makes a new export public; removing one is a breaking change.
const EXPORTS = [
  'DEFAULT_HUGE_LIST_SIZE',
  'QA_PROFILES',
  'QA_PROFILE_NAMES',
  'assertValidMocks',
  'buildMatrix',
  'buildMocks',
  'buildQaSets',
  'composeScenarios',
  'createRequestHandler',
  'defaultScalarMockers',
  'defineScenarios',
  'mockOperation',
  'mockOperationVariants',
  'mockScenarios',
  'paginate',
  'qaScalarMockers',
  'resolveRelation',
  'resolveScalarMocker',
  'searchItems',
  'select',
  'toPlain',
  'validateMocks',
];

/**
 * Type-only exports leave no runtime trace, so the list above cannot pin them. Annotating real
 * values with them does: drop one from `index.ts` and `npm run typecheck:tests` fails here.
 */
const countFields: CountFieldsConfig = { ProductSearchResult: { totalCount: 'results' } };
const derive: DeriveConfig = {
  User: { fullName: (self, ctx: DeriveContext) => `${self.firstName}-${ctx.index}` },
};
const fullName: FieldDeriveFn = (self) => String(self.firstName);
const overrides: OverridesConfig = { User: { firstName: () => 'Ada' } };

describe('index', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual(EXPORTS);
  });

  it('exports every runtime value as a function or object, never undefined', () => {
    for (const name of EXPORTS) {
      expect(api[name as keyof typeof api]).toBeDefined();
    }
  });

  it('exposes the option types the README documents, so a config can be typed by name', () => {
    expect(countFields).toEqual({ ProductSearchResult: { totalCount: 'results' } });
    expect(Object.keys(derive)).toEqual(['User']);
    expect(typeof fullName).toBe('function');
    expect(Object.keys(overrides)).toEqual(['User']);
  });
});
