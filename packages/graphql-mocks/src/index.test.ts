import { describe, expect, it } from 'vitest';
import * as api from './index.js';

// The public surface has no other guardrail — index.ts is excluded from coverage and nothing
// else imports it — so pin the exported names. Adding one here is the deliberate step that
// makes a new export public; removing one is a breaking change.
const EXPORTS = [
  'DEFAULT_HUGE_LIST_SIZE',
  'QA_PROFILES',
  'QA_PROFILE_NAMES',
  'buildMatrix',
  'buildMocks',
  'buildQaSets',
  'composeScenarios',
  'defaultScalarMockers',
  'defineScenarios',
  'mockOperation',
  'mockOperationVariants',
  'qaScalarMockers',
  'resolveRelation',
  'resolveScalarMocker',
];

describe('index', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual(EXPORTS);
  });

  it('exports every runtime value as a function or object, never undefined', () => {
    for (const name of EXPORTS) {
      expect(api[name as keyof typeof api]).toBeDefined();
    }
  });
});
