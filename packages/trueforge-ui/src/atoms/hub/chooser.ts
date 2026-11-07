export type ChooserAnswers = {
  /** Can every step be written down before it runs? */
  stepsKnown: boolean | null;
  /** Do the inputs arrive in a predictable shape? */
  inputsStructured: boolean | null;
  /** Must the same input always produce the same actions? */
  mustBeRepeatable: boolean | null;
};

export type ChooserRecommendation = {
  kind: 'workflow' | 'agent' | 'hybrid';
  title: string;
  reason: string;
};

/**
 * Bias towards a workflow: it is cheaper, faster, and easier to audit, so an agent has to
 * be earned by the work actually needing judgment. A mixed answer means the judgment is
 * probably confined to one part, which is what an agent step inside a workflow is for.
 */
export function recommendAutomation(answers: ChooserAnswers): ChooserRecommendation | null {
  const { stepsKnown, inputsStructured, mustBeRepeatable } = answers;
  if (stepsKnown === null || inputsStructured === null || mustBeRepeatable === null) {
    return null;
  }
  if (!stepsKnown && !inputsStructured && !mustBeRepeatable) {
    return {
      kind: 'agent',
      title: 'Use an agent',
      reason: 'The path depends on what it finds, so a model should decide each next step.',
    };
  }
  if (stepsKnown && inputsStructured) {
    return {
      kind: 'workflow',
      title: 'Use a workflow',
      reason: 'You already know the steps. A workflow runs them the same way every time, with no model cost.',
    };
  }
  return {
    kind: 'hybrid',
    title: 'Use a workflow with an agent step',
    reason: 'Most of this is predictable. Keep the process fixed and call an agent only for the part needing judgment.',
  };
}
