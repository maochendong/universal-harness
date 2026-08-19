import { contentDigest } from "../identity/digest.js";
import type { ClarificationQuestionDraft } from "../capture/records.js";
import type { CaptureQuestionTargetKind } from "../schema/capture.js";
import type {
  PrdAcceptanceCriterion,
  PrdProposal,
  PrdValidationFinding,
  PrdValidationRuleResult,
} from "../schema/proposal.js";

/**
 * Deterministic PRD hard gates (intent-to-prd design 12). These rules are
 * public and cannot be disabled by any Profile or approval: schema shape is
 * enforced before this runs, and every semantic failure becomes a typed
 * finding plus a precise clarification question draft — never a free-text
 * warning. A non-atomic criterion (multiple independently verdictable
 * outcomes) must be split here; Planner must never paper it over with a
 * 1:N assertion mapping downstream.
 */
export const PRD_VALIDATION_RULE_IDS = [
  "required_sections",
  "requirement_criteria",
  "criterion_test_first",
  "constraint_verification",
  "reference_integrity",
  "structural_conflict",
  "open_question_blocking",
  "test_first_readiness",
  "atomic_criterion",
  "risk_scenario_coverage",
] as const;
export type PrdValidationRuleId = (typeof PRD_VALIDATION_RULE_IDS)[number];

/** Versioned rule set identity; any rule change must bump the version. */
export const PRD_VALIDATION_RULE_SET = {
  version: "1.1.0",
  rules: PRD_VALIDATION_RULE_IDS,
} as const;

export function prdValidationRuleSetDigest(): string {
  return contentDigest(PRD_VALIDATION_RULE_SET);
}

export interface PrdGateOutcome {
  readonly passed: boolean;
  readonly results: readonly PrdValidationRuleResult[];
  readonly questions: readonly ClarificationQuestionDraft[];
}

function norm(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function normKey(value: string): string {
  return norm(value).toLowerCase();
}

/**
 * Conservative vocabulary for the test-first readiness rule (design 12.2).
 * A vague claim only flags when the same text carries no measurable cue.
 */
const VAGUE_TERMS = [
  "faster",
  "better",
  "easier",
  "optimize",
  "optimized",
  "user-friendly",
  "more friendly",
  "更快",
  "更友好",
  "优化",
  "更流畅",
] as const;
const MEASURABLE_CUE = /[0-9０-９%％]|ms\b|秒|次/iu;
const TEST_PASS_ONLY = new Set([
  "tests pass",
  "test passes",
  "all tests pass",
  "pass the tests",
  "passes the tests",
  "测试通过",
  "通过测试",
  "gate passes",
  "gates pass",
  "mandatory gate suite passes",
]);

/** Deterministic risk cues (design 12.2: 高风险需求缺少失败/边界/安全场景). */
const RISK_CUE =
  /security|auth|password|credential|payment|delete|permission|privacy|token|安全|权限|密码|支付|删除|隐私|合规|密钥/iu;

/** Clause separators for the atomicity rule; a bare " and " is too noisy. */
const CLAUSE_SEPARATOR = /[;；\n]|并且|以及|\band then\b/iu;

interface FindingSeed {
  readonly rule_id: PrdValidationRuleId;
  readonly target_kind: CaptureQuestionTargetKind;
  readonly target_id?: string;
  readonly missing_dimension: string;
  readonly message: string;
}

function toFinding(seed: FindingSeed): PrdValidationFinding {
  return {
    severity: "critical",
    target_kind: seed.target_kind,
    ...(seed.target_id === undefined ? {} : { target_id: seed.target_id }),
    message: seed.message,
  };
}

function toQuestion(seed: FindingSeed): ClarificationQuestionDraft {
  return {
    source: "deterministic_gate",
    target_kind: seed.target_kind,
    ...(seed.target_id === undefined ? {} : { target_id: seed.target_id }),
    missing_dimension: seed.missing_dimension,
    question: seed.message,
    required: true,
  };
}

function collectRule(
  ruleId: PrdValidationRuleId,
  seeds: readonly FindingSeed[],
): { result: PrdValidationRuleResult; questions: ClarificationQuestionDraft[] } {
  const findings = seeds
    .map(toFinding)
    .sort((left, right) =>
      `${left.target_kind}${left.target_id ?? ""}${left.message}` <
      `${right.target_kind}${right.target_id ?? ""}${right.message}`
        ? -1
        : 1,
    );
  return {
    result: {
      rule_id: ruleId,
      passed: findings.length === 0,
      findings,
    },
    questions: seeds.map(toQuestion),
  };
}

function isVague(text: string): boolean {
  const lowered = normKey(text);
  return VAGUE_TERMS.some((term) => lowered.includes(term)) && !MEASURABLE_CUE.test(lowered);
}

/**
 * Run every hard gate against the canonical proposal. Results are ordered by
 * rule id and questions are deduplicated by (target, dimension, question), so
 * the same proposal always produces the same outcome.
 */
export function runPrdHardGates(proposal: PrdProposal): PrdGateOutcome {
  const rules: { result: PrdValidationRuleResult; questions: ClarificationQuestionDraft[] }[] = [];

  // 1. required_sections ------------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    if (norm(proposal.problem_statement).length === 0) {
      seeds.push({
        rule_id: "required_sections",
        target_kind: "prd_section",
        missing_dimension: "problem_statement",
        message: "the problem statement is missing; what problem does this change solve?",
      });
    }
    if (proposal.goals.length === 0) {
      seeds.push({
        rule_id: "required_sections",
        target_kind: "prd_section",
        missing_dimension: "goals",
        message: "at least one goal is required; what should be true after this change?",
      });
    }
    if (proposal.requirements.length === 0) {
      seeds.push({
        rule_id: "required_sections",
        target_kind: "prd_section",
        missing_dimension: "requirements",
        message: "at least one requirement is required",
      });
    }
    for (const entity of [
      ...proposal.goals.map((goal) => ({ kind: "goal", id: goal.id, text: goal.statement })),
      ...proposal.requirements.map((requirement) => ({
        kind: "requirement",
        id: requirement.id,
        text: requirement.statement,
      })),
    ]) {
      if (norm(entity.text).length === 0) {
        seeds.push({
          rule_id: "required_sections",
          target_kind: entity.kind === "goal" ? "prd_section" : "requirement",
          target_id: entity.id,
          missing_dimension: "statement",
          message: `${entity.kind} ${entity.id} has no statement`,
        });
      }
    }
    rules.push(collectRule("required_sections", seeds));
  }

  // 2. requirement_criteria ---------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    const criteriaByRequirement = new Map<string, PrdAcceptanceCriterion[]>();
    for (const criterion of proposal.acceptance_criteria) {
      const list = criteriaByRequirement.get(criterion.requirement_id) ?? [];
      list.push(criterion);
      criteriaByRequirement.set(criterion.requirement_id, list);
    }
    for (const requirement of proposal.requirements) {
      const criteria = criteriaByRequirement.get(requirement.id) ?? [];
      if (requirement.acceptance_criterion_ids.length === 0 || criteria.length === 0) {
        seeds.push({
          rule_id: "requirement_criteria",
          target_kind: "requirement",
          target_id: requirement.id,
          missing_dimension: "acceptance_criteria",
          message: `requirement ${requirement.id} has no acceptance criterion; which observable behavior proves it?`,
        });
      }
    }
    rules.push(collectRule("requirement_criteria", seeds));
  }

  // 3. criterion_test_first ---------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    for (const requirement of proposal.requirements) {
      if (requirement.change_kind !== "must_change") continue;
      const criteria = proposal.acceptance_criteria.filter(
        (criterion) => criterion.requirement_id === requirement.id,
      );
      if (criteria.length === 0) continue; // rule 2 already flags it
      const hasExample = criteria.some(
        (criterion) => norm(criterion.test_first_example ?? "").length > 0,
      );
      if (!hasExample) {
        seeds.push({
          rule_id: "criterion_test_first",
          target_kind: "requirement",
          target_id: requirement.id,
          missing_dimension: "test_first_example",
          message: `must-change requirement ${requirement.id} has no test-first example; which behavior should fail before implementation?`,
        });
      }
    }
    rules.push(collectRule("criterion_test_first", seeds));
  }

  // 4. constraint_verification -------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    for (const constraint of proposal.constraints) {
      if (norm(constraint.verification_intent).length === 0) {
        seeds.push({
          rule_id: "constraint_verification",
          target_kind: "constraint",
          target_id: constraint.id,
          missing_dimension: "verification_intent",
          message: `constraint ${constraint.id} has no verification intent; how is it checked?`,
        });
      }
    }
    rules.push(collectRule("constraint_verification", seeds));
  }

  // 5. reference_integrity -----------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    const requirementIds = new Set(proposal.requirements.map((requirement) => requirement.id));
    const scenarioIds = new Set(proposal.scenarios.map((scenario) => scenario.id));
    const actorIds = new Set(proposal.actors.map((actor) => actor.id));
    for (const requirement of proposal.requirements) {
      for (const scenarioId of requirement.scenario_ids) {
        if (!scenarioIds.has(scenarioId)) {
          seeds.push({
            rule_id: "reference_integrity",
            target_kind: "requirement",
            target_id: requirement.id,
            missing_dimension: "scenario_reference",
            message: `requirement ${requirement.id} references unknown scenario ${scenarioId}`,
          });
        }
      }
    }
    for (const criterion of proposal.acceptance_criteria) {
      if (!requirementIds.has(criterion.requirement_id)) {
        seeds.push({
          rule_id: "reference_integrity",
          target_kind: "acceptance_criterion",
          target_id: criterion.criterion_id,
          missing_dimension: "requirement_reference",
          message: `criterion ${criterion.criterion_id} references unknown requirement ${criterion.requirement_id}`,
        });
      }
    }
    for (const scenario of proposal.scenarios) {
      if (!actorIds.has(scenario.actor_id)) {
        seeds.push({
          rule_id: "reference_integrity",
          target_kind: "prd_section",
          target_id: scenario.id,
          missing_dimension: "actor_reference",
          message: `scenario ${scenario.id} references unknown actor ${scenario.actor_id}`,
        });
      }
    }
    for (const dependency of proposal.dependencies) {
      for (const requiredBy of dependency.required_by_ids) {
        if (!requirementIds.has(requiredBy)) {
          seeds.push({
            rule_id: "reference_integrity",
            target_kind: "prd_section",
            target_id: dependency.id,
            missing_dimension: "dependency_reference",
            message: `dependency ${dependency.id} references unknown requirement ${requiredBy}`,
          });
        }
      }
    }
    rules.push(collectRule("reference_integrity", seeds));
  }

  // 6. structural_conflict -----------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    const nonGoalStatements = new Map(
      proposal.non_goals.map((nonGoal) => [normKey(nonGoal.statement), nonGoal.id]),
    );
    for (const requirement of proposal.requirements) {
      const conflict = nonGoalStatements.get(normKey(requirement.statement));
      if (conflict !== undefined) {
        seeds.push({
          rule_id: "structural_conflict",
          target_kind: "requirement",
          target_id: requirement.id,
          missing_dimension: "requirement_conflict",
          message: `requirement ${requirement.id} conflicts with non-goal ${conflict}; is the behavior in scope or not?`,
        });
      }
    }
    const termDefinitions = new Map<string, { definition: string; id: string }>();
    for (const term of proposal.glossary) {
      const key = normKey(term.term);
      const existing = termDefinitions.get(key);
      if (existing !== undefined && existing.definition !== norm(term.definition)) {
        seeds.push({
          rule_id: "structural_conflict",
          target_kind: "glossary",
          target_id: term.id,
          missing_dimension: "term_conflict",
          message: `glossary term "${norm(term.term)}" has conflicting definitions (${existing.id} and ${term.id}); which meaning is authoritative?`,
        });
      } else if (existing === undefined) {
        termDefinitions.set(key, { definition: norm(term.definition), id: term.id });
      }
    }
    const criteriaByRequirement = new Map<string, PrdAcceptanceCriterion[]>();
    for (const criterion of proposal.acceptance_criteria) {
      const list = criteriaByRequirement.get(criterion.requirement_id) ?? [];
      list.push(criterion);
      criteriaByRequirement.set(criterion.requirement_id, list);
    }
    for (const [requirementId, criteria] of criteriaByRequirement) {
      const seen = new Map<string, string>();
      for (const criterion of criteria) {
        const key = [
          normKey(criterion.precondition),
          normKey(criterion.action),
          normKey(criterion.observable_outcome),
          criterion.scenario_kind,
        ].join("\u001f");
        const duplicate = seen.get(key);
        if (duplicate !== undefined) {
          seeds.push({
            rule_id: "structural_conflict",
            target_kind: "acceptance_criterion",
            target_id: criterion.criterion_id,
            missing_dimension: "duplicate_criteria",
            message: `criteria ${duplicate} and ${criterion.criterion_id} of requirement ${requirementId} are indistinguishable; merge or differentiate them`,
          });
        } else {
          seen.set(key, criterion.criterion_id);
        }
      }
    }
    rules.push(collectRule("structural_conflict", seeds));
  }

  // 7. open_question_blocking ---------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    for (const openQuestion of proposal.open_questions) {
      if (openQuestion.blocking) {
        seeds.push({
          rule_id: "open_question_blocking",
          target_kind: "prd_section",
          target_id: openQuestion.id,
          missing_dimension: "blocking_open_question",
          message: `blocking open question ${openQuestion.id} must be resolved before acceptance: ${norm(openQuestion.question)}`,
        });
      }
    }
    rules.push(collectRule("open_question_blocking", seeds));
  }

  // 8. test_first_readiness ------------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    for (const requirement of proposal.requirements) {
      if (isVague(requirement.statement)) {
        seeds.push({
          rule_id: "test_first_readiness",
          target_kind: "requirement",
          target_id: requirement.id,
          missing_dimension: "observable_outcome",
          message: `requirement ${requirement.id} is vague ("faster/better/optimized"-style wording without a measure); what observable result defines success?`,
        });
      }
    }
    for (const criterion of proposal.acceptance_criteria) {
      if (
        isVague(criterion.observable_outcome) ||
        norm(criterion.observable_outcome).length === 0
      ) {
        seeds.push({
          rule_id: "test_first_readiness",
          target_kind: "acceptance_criterion",
          target_id: criterion.criterion_id,
          missing_dimension: "observable_outcome",
          message: `criterion ${criterion.criterion_id} has no observable outcome; what can be observed after the action?`,
        });
      }
      if (TEST_PASS_ONLY.has(normKey(criterion.verification_intent))) {
        seeds.push({
          rule_id: "test_first_readiness",
          target_kind: "acceptance_criterion",
          target_id: criterion.criterion_id,
          missing_dimension: "verification_intent",
          message: `criterion ${criterion.criterion_id} only says "tests pass"; which object and result are verified?`,
        });
      }
    }
    rules.push(collectRule("test_first_readiness", seeds));
  }

  // 9. atomic_criterion ----------------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    for (const criterion of proposal.acceptance_criteria) {
      const clauses = norm(criterion.observable_outcome)
        .split(CLAUSE_SEPARATOR)
        .map((clause) => clause.trim())
        .filter((clause) => clause.length > 0);
      if (clauses.length >= 2) {
        seeds.push({
          rule_id: "atomic_criterion",
          target_kind: "acceptance_criterion",
          target_id: criterion.criterion_id,
          missing_dimension: "atomicity",
          message: `criterion ${criterion.criterion_id} has ${String(clauses.length)} independently verdictable outcomes; split it into one criterion per outcome (Planner must not map one criterion to several assertions)`,
        });
      }
    }
    rules.push(collectRule("atomic_criterion", seeds));
  }

  // 10. risk_scenario_coverage -----------------------------------------------------
  {
    const seeds: FindingSeed[] = [];
    for (const requirement of proposal.requirements) {
      if (requirement.change_kind !== "must_change" && requirement.priority !== "must") continue;
      if (!RISK_CUE.test(requirement.statement)) continue;
      const criteria = proposal.acceptance_criteria.filter(
        (criterion) => criterion.requirement_id === requirement.id,
      );
      if (criteria.length === 0) continue;
      const hasNonPrimary = criteria.some((criterion) => criterion.scenario_kind !== "primary");
      if (!hasNonPrimary) {
        seeds.push({
          rule_id: "risk_scenario_coverage",
          target_kind: "requirement",
          target_id: requirement.id,
          missing_dimension: "failure_scenario",
          message: `high-risk requirement ${requirement.id} has only primary scenarios; what failure, boundary, rejection, security or compatibility scenario applies?`,
        });
      }
    }
    rules.push(collectRule("risk_scenario_coverage", seeds));
  }

  const results = rules
    .map((rule) => rule.result)
    .sort((left, right) => (left.rule_id < right.rule_id ? -1 : 1));
  const questionMap = new Map<string, ClarificationQuestionDraft>();
  for (const rule of rules) {
    for (const question of rule.questions) {
      const key = `${question.target_kind}\u001f${question.target_id ?? ""}\u001f${question.missing_dimension}\u001f${norm(question.question)}`;
      if (!questionMap.has(key)) questionMap.set(key, question);
    }
  }
  const questions = [...questionMap.values()].sort((left, right) => {
    const leftKey = `${left.target_kind}${left.target_id ?? ""}${left.missing_dimension}`;
    const rightKey = `${right.target_kind}${right.target_id ?? ""}${right.missing_dimension}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const passed = results.every((result) => result.passed);
  return { passed, results, questions };
}
