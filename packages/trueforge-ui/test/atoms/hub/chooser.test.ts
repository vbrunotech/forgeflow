import { describe, expect, it } from 'vitest';

import { recommendAutomation } from '../../../src/atoms/hub/chooser.js';

describe('recommendAutomation', () => {
  it('waits for every answer', () => {
    expect(recommendAutomation({ stepsKnown: true, inputsStructured: null, mustBeRepeatable: true })).toBeNull();
  });

  it('recommends a workflow when the steps and inputs are known', () => {
    expect(recommendAutomation({ stepsKnown: true, inputsStructured: true, mustBeRepeatable: false })?.kind).toBe(
      'workflow',
    );
  });

  it('recommends an agent only when nothing is predictable', () => {
    expect(recommendAutomation({ stepsKnown: false, inputsStructured: false, mustBeRepeatable: false })?.kind).toBe(
      'agent',
    );
  });

  it('recommends combining them for mixed answers', () => {
    expect(recommendAutomation({ stepsKnown: true, inputsStructured: false, mustBeRepeatable: true })?.kind).toBe(
      'hybrid',
    );
    expect(recommendAutomation({ stepsKnown: false, inputsStructured: true, mustBeRepeatable: false })?.kind).toBe(
      'hybrid',
    );
  });
});
