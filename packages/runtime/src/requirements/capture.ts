/**
 * Requirement capture (design 12; mode selection rule in section 10). Pure
 * and deterministic: converts intent input into an Intent / Requirement /
 * Constraint / acceptance-Test proposal. Free text that would need semantic
 * interpretation is never silently completed — a proposal missing required
 * fields or verifiable acceptance criteria comes back as typed clarification
 * questions instead.
 */
export interface AcceptanceCriterionInput {
  readonly description: string;
  /** How the criterion is verified (gate, test or check name); empty is not verifiable. */
  readonly verification: string;
}

export interface RequirementInput {
  readonly statement: string;
  readonly acceptance: readonly AcceptanceCriterionInput[];
}

export interface ConstraintInput {
  readonly statement: string;
  /** How the constraint is verified; constraints without one are not enforceable. */
  readonly verification: string;
}

export interface IntentInput {
  readonly text: string;
  readonly requirements?: readonly RequirementInput[];
  readonly constraints?: readonly ConstraintInput[];
}

/** Identifier kinds minted during capture; all match the schema id pattern. */
export type CaptureIdKind = "intent" | "requirement" | "constraint";

export interface CaptureContext {
  /** Injectable id mint; deterministic tests supply a counter-based mint. */
  readonly newId: (kind: CaptureIdKind) => string;
}

export interface ClarificationQuestion {
  readonly subject: "intent" | "requirement" | "constraint" | "acceptance";
  /** 0-based index into the input list the question refers to, when applicable. */
  readonly index?: number;
  readonly question: string;
}

export interface CapturedAcceptanceCriterion {
  readonly description: string;
  readonly verification: string;
}

export interface CapturedRequirement {
  readonly id: string;
  readonly statement: string;
  readonly acceptance: readonly CapturedAcceptanceCriterion[];
}

export interface CapturedConstraint {
  readonly id: string;
  readonly statement: string;
  readonly verification: string;
}

/** Deterministic, approval-ready requirement set; the baseline digest derives from it. */
export interface RequirementProposal {
  readonly intent: { readonly id: string; readonly text: string };
  readonly requirements: readonly CapturedRequirement[];
  readonly constraints: readonly CapturedConstraint[];
}

export type CaptureOutcome =
  | {
      readonly status: "clarification_required";
      readonly questions: readonly ClarificationQuestion[];
    }
  | { readonly status: "captured"; readonly proposal: RequirementProposal };

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Convert intent input into a proposal, or into the full set of clarification
 * questions blocking it. Every missing required field and every acceptance
 * criterion without a verification surfaces as its own question, in input
 * order, so the caller can resolve them in one round trip.
 */
export function captureRequirements(input: IntentInput, context: CaptureContext): CaptureOutcome {
  const questions: ClarificationQuestion[] = [];
  const requirements = input.requirements ?? [];
  const constraints = input.constraints ?? [];

  if (blank(input.text)) {
    questions.push({ subject: "intent", question: "intent text is required" });
  }
  if (requirements.length === 0) {
    questions.push({
      subject: "requirement",
      question: "at least one requirement is required",
    });
  }
  requirements.forEach((requirement, index) => {
    if (blank(requirement.statement)) {
      questions.push({
        subject: "requirement",
        index,
        question: `requirement ${index + 1} is missing a statement`,
      });
    }
    if (requirement.acceptance.length === 0) {
      questions.push({
        subject: "acceptance",
        index,
        question: `requirement ${index + 1} has no acceptance criteria`,
      });
    }
    requirement.acceptance.forEach((criterion, criterionIndex) => {
      if (blank(criterion.description) || blank(criterion.verification)) {
        questions.push({
          subject: "acceptance",
          index,
          question: `acceptance criterion ${criterionIndex + 1} of requirement ${index + 1} needs a description and a verification`,
        });
      }
    });
  });
  constraints.forEach((constraint, index) => {
    if (blank(constraint.statement) || blank(constraint.verification)) {
      questions.push({
        subject: "constraint",
        index,
        question: `constraint ${index + 1} needs a statement and a verification`,
      });
    }
  });

  if (questions.length > 0) return { status: "clarification_required", questions };

  return {
    status: "captured",
    proposal: {
      intent: { id: context.newId("intent"), text: input.text.trim() },
      requirements: requirements.map((requirement) => ({
        id: context.newId("requirement"),
        statement: requirement.statement.trim(),
        acceptance: requirement.acceptance.map((criterion) => ({
          description: criterion.description.trim(),
          verification: criterion.verification.trim(),
        })),
      })),
      constraints: constraints.map((constraint) => ({
        id: context.newId("constraint"),
        statement: constraint.statement.trim(),
        verification: constraint.verification.trim(),
      })),
    },
  };
}
