// THE SENTENCE ISTVAN ACTUALLY READS, built deterministically from the action.
//
// WHAT WENT OUT BEFORE THIS FILE EXISTED. On 2026-08-28 the ZST case for the
// NVIDIA Inception application produced a live approval request whose headline
// line was:
//
//     Művelet: Identify required actions and dependencies
//
// That is an internal English plan-step label from `buildRollingPlan`, offered
// to a Hungarian reader as the thing he is being asked to authorise. The
// codebase already refuses to do this ONE LAYER OVER: `isUsableRecommendation`
// rejects exactly this closed set of strings, for exactly this reason, and has
// since 2026-08-16. The approval producer was written afterwards and did not go
// through it. A guard that covers one caller and not the choke point is a guard
// that will be walked around, and it was.
//
// THE OWNER'S FIVE ELEMENTS, and none of them is decoration:
//
//   1. mit fog tenni
//   2. kivel / milyen célponton
//   3. mi változik kint a világban
//   4. miért kell jóváhagyás
//   5. releváns payload rövid, biztonságos összefoglalója
//
// ELEMENT 3 IS THE ONE THAT DISCIPLINES THE REST. A step that changes nothing
// outside cannot answer it, and the honest attempt makes the whole request
// collapse: there is nothing to approve. That is why this module refuses to
// narrate an action that does not reach outside, rather than writing a graceful
// sentence about an act that will not happen. The refusal is the finding.
//
// A MAPPING, NOT A MODEL. Same three rules `case-action-label.ts` obeys: it is
// presentation and never state; it never becomes trusted input; a label this
// file does not know returns a DEFECT rather than a cheerful fallback, because
// an unmapped label rendered generically is indistinguishable from a mapped one
// and the vocabulary would quietly stop being covered.

import type { ActionSideEffectClass } from './action-side-effect.js'
import type { RiskClass } from './decision-confidence.js'

/**
 * Plan-step label -> what the engine will do, said in Hungarian.
 *
 * KEYED ON THE LABEL, not on the kind, because the kind is seven values and the
 * owner asked WHAT it will do. `buildRollingPlan` emits a closed set of about
 * two dozen labels and a test drives the planner to prove every one of them is
 * mapped, so a label added tomorrow fails the suite instead of reaching him as
 * English.
 */
export const STEP_SENTENCE: Record<string, string> = {
  'Verify current state and gathered context':
    'Ellenőrzöm az ügy jelenlegi állapotát és a hozzá összegyűjtött adatokat.',
  'Classify and prioritize the case':
    'Besorolom az ügyet és eldöntöm, mennyire sürgős.',
  'Identify required actions and dependencies':
    'Összeszedem, milyen lépések kellenek az ügyhöz és mi függ mitől.',
  'Gather missing information from relevant sources':
    'Összegyűjtöm a hiányzó információt a releváns forrásokból.',
  'Evaluate gathered information against requirements':
    'Összevetem az összegyűjtött információt azzal, amire az ügynek szüksége van.',
  'Check for external response or escalate if overdue':
    'Megnézem, érkezett-e külső válasz, és ha lejárt a határidő, jelzem.',
  'Process response and decide next step':
    'Feldolgozom a beérkezett választ és eldöntöm a következő lépést.',
  'Follow up on pending approval/selection':
    'Utánamegyek a függőben lévő jóváhagyásnak vagy választásnak.',
  'Act on the received decision':
    'Végrehajtom, ami a megszületett döntésből következik.',
  'Execute the next action in the work plan':
    'Végrehajtom a munkaterv soron következő műveletét.',
  'Document result and plan next cycle':
    'Rögzítem az eredményt és megtervezem a következő kört.',
  'Continue or complete the current execution step':
    'Folytatom vagy befejezem a megkezdett végrehajtási lépést.',
  'Verify execution result against expected outcome':
    'Összevetem a végrehajtás eredményét azzal, aminek történnie kellett volna.',
  'Identify and document the blocker precisely':
    'Pontosan megnevezem és rögzítem, mi akasztotta meg az ügyet.',
  'Escalate or resolve the blocking condition':
    'Feloldom az akadályt, vagy továbbadom annak, aki fel tudja oldani.',
  'Analyze what failed and define recovery path':
    'Megnézem, mi bukott el, és meghatározom a visszaállás útját.',
  'Execute first recovery action':
    'Végrehajtom a visszaállás első lépését.',
  'Perform the scheduled follow-up check':
    'Elvégzem az ütemezett utánkövető ellenőrzést.',
  'Determine whether the case can advance or needs more waiting':
    'Eldöntöm, továbbléphet-e az ügy, vagy még várni kell.',
  'Schedule and prepare for the call':
    'Időpontot keresek a hívásra és előkészítem.',
  'Place the call and document the outcome':
    'Lebonyolítom a hívást és rögzítem, mi lett az eredménye.',
  'Verify all DoD criteria are satisfied':
    'Ellenőrzöm, hogy az ügy minden lezárási feltétele teljesült-e.',
  'Archive evidence and notify stakeholders':
    'Archiválom a bizonyítékokat és értesítem az érintetteket.',
  'Prepare for the scheduled event':
    'Felkészülök az ütemezett eseményre.',
  'Execute at the scheduled time':
    'Végrehajtom a műveletet az ütemezett időpontban.',
  'Assess current situation and determine next move':
    'Felmérem a jelenlegi helyzetet és meghatározom a következő lépést.',
  'Take the appropriate next step':
    'Megteszem a helyzetnek megfelelő következő lépést.',
  // Appended after the status switch, so it belongs to every plan. It was
  // missing from the first version of this table and the enumeration test found
  // it, which is the whole reason that test drives the planner instead of
  // reading a list somebody maintains by hand.
  'Review progress against Definition of Done':
    'Összevetem az eddigi haladást az ügy lezárási feltételeivel.',
}

/** Concrete operation type -> what it does out in the world. Unmapped is a
 *  defect, not a shrug: an operation nobody can describe is one nobody should
 *  be asked to approve. */
export const OPERATION_SENTENCE: Record<string, string> = {
  EMAIL_SEND: 'Kimegy egy e-mail. Elküldött levelet nem lehet visszavonni.',
  EMAIL_REPLY: 'Kimegy egy válasz e-mail. Elküldött levelet nem lehet visszavonni.',
  EMAIL_FORWARD: 'Továbbítunk egy levelet. Elküldött levelet nem lehet visszavonni.',
  SMS_SEND: 'Kimegy egy SMS. Elküldött üzenetet nem lehet visszavonni.',
  MESSAGE_SEND: 'Kimegy egy üzenet a csatornán. Elküldött üzenetet nem lehet visszavonni.',
  CALL_PLACE: 'Felhívunk valakit. A hívás megtörténte nem vonható vissza.',
  FILING_SUBMIT: 'Beadványt nyújtunk be egy külső rendszerbe.',
  FORM_SUBMIT: 'Elküldünk egy űrlapot egy külső rendszernek.',
  BOOKING_CONFIRM: 'Megerősítünk egy foglalást a szolgáltatónál.',
}

/** Risk class -> why this needs a person. */
export const RISK_SENTENCE: Record<RiskClass, string> = {
  IRREVERSIBLE_EXTERNAL: 'a művelet kifelé hat és nem vonható vissza',
  FINANCIAL_CONTRACTUAL: 'pénzügyi vagy szerződéses következménye van',
  CREDENTIAL_SECURITY: 'hitelesítő adatot vagy titkot érint',
  DESTRUCTIVE: 'adatot vagy állapotot töröl visszaállíthatatlanul',
  ACCESS_CONTROL: 'hozzáférési jogosultságot változtat',
}

export interface NarrationInput {
  /** The internal plan-step label. Audit only. Never a headline. */
  machineLabel: string
  caseId: string
  caseVersion: number | null
  caseTitle: string
  planStep: number
  /** The resolved outbound target, when a queued row bound one. */
  target: string | null
  /** Concrete operation types this action would perform. */
  operationTypes: readonly string[]
  riskClasses: readonly RiskClass[]
  sideEffectClass: ActionSideEffectClass
  /** Why the classifier said what it said. Shown so the reader can check the
   *  claim rather than take it. */
  sideEffectReasons: readonly string[]
  /** The fingerprint the ticket binds. Twelve characters is enough to compare
   *  two asks and not enough to be mistaken for content. */
  payloadFingerprint: string
}

export interface Narration {
  /** 1. */ whatItDoes: string
  /** 2. */ target: string
  /** 3. */ worldChange: string
  /** 4. */ whyApproval: string
  /** 5. */ payloadSummary: string
  /** Everything that makes this un-askable. Non-empty means DO NOT ASK. */
  defects: string[]
}

/**
 * Build the narration, or say why it cannot be built.
 *
 * DEFECTS ARE RETURNED, NOT THROWN, and they are not warnings. The producer's
 * contract is that a request with defects is never opened: a question that
 * cannot state what changes in the world is not a better question after being
 * rephrased, it is a question that should not be asked at all.
 */
export function buildNarration(i: NarrationInput): Narration {
  const defects: string[] = []

  const sentence = STEP_SENTENCE[i.machineLabel]
  if (!sentence) {
    defects.push(
      `a "${i.machineLabel}" terv-lépéshez nincs magyar mondat a STEP_SENTENCE táblában`,
    )
  }

  // ELEMENT 3 FIRST, because it decides whether the other four are worth having.
  let worldChange: string
  if (i.sideEffectClass === 'IRREVERSIBLE_EXTERNAL' || i.sideEffectClass === 'REVERSIBLE_EXTERNAL'
      || i.sideEffectClass === 'READ_ONLY_EXTERNAL') {
    const named = i.operationTypes.map(t => OPERATION_SENTENCE[t]).filter((x): x is string => !!x)
    const unnamed = i.operationTypes.filter(t => !OPERATION_SENTENCE[t])
    if (unnamed.length) {
      defects.push(`nincs leírás ezekhez a művelet-típusokhoz: ${unnamed.join(', ')}`)
    }
    if (i.sideEffectClass === 'READ_ONLY_EXTERNAL') {
      worldChange = named.length
        ? named.join(' ')
        : 'Kint semmi nem változik: a lépés külső rendszerből olvas, nem ír bele.'
    } else if (named.length) {
      worldChange = named.join(' ')
    } else {
      defects.push('a lépés kifelé hat, de egyetlen forrás sem nevezi meg, hogy mi történik odakint')
      worldChange = ''
    }
  } else {
    // INTERNAL, CONTRADICTORY, UNKNOWN. None of these may become a question.
    defects.push(
      `a lépés külső hatása "${i.sideEffectClass}", tehát nincs bizonyított külső változás, `
      + 'amit jóvá lehetne hagyni: itt nem jóváhagyás kell, hanem a besorolás javítása',
    )
    worldChange = ''
  }

  const target = i.target
    ?? (i.operationTypes.length ? i.operationTypes.join(', ') : '')
  if (!target) defects.push('nincs megnevezett célpont vagy csatorna')

  const why = i.riskClasses.map(c => RISK_SENTENCE[c]).filter((x): x is string => !!x)
  const unmappedRisk = i.riskClasses.filter(c => !RISK_SENTENCE[c])
  if (unmappedRisk.length) defects.push(`nincs indoklás ezekhez a kockázati osztályokhoz: ${unmappedRisk.join(', ')}`)
  if (!why.length) defects.push('nincs megnevezett kockázati osztály, ami indokolná a jóváhagyást')

  return {
    whatItDoes: sentence ?? '',
    target,
    worldChange,
    whyApproval: why.length
      ? `Azért kérem, mert ${why.join(', és ')}.`
      : '',
    payloadSummary: [
      `Ügy: ${i.caseTitle} (${i.caseId}${i.caseVersion !== null ? `, v${i.caseVersion}` : ''})`,
      `Terv-lépés: #${i.planStep}`,
      i.operationTypes.length ? `Művelet-típus: ${i.operationTypes.join(', ')}` : null,
      `Payload-ujjlenyomat: ${i.payloadFingerprint.slice(0, 12)}`,
    ].filter((x): x is string => x !== null).join('\n'),
    defects,
  }
}

/**
 * Render the question.
 *
 * REFUSES A DEFECTIVE NARRATION by throwing. The producer catches it and records
 * `APPROVAL_REQUEST_NOT_CREATED`, which is loud, durable and already wired --
 * whereas printing the question anyway would put the defect in front of Istvan,
 * which is the outcome this whole file exists to prevent. Silence here is not
 * silence in the system: the assertion says the door did not open and why.
 */
export function renderApprovalQuestion(n: Narration, i: NarrationInput): string {
  if (n.defects.length) {
    throw new Error(`a jóváhagyás-kérdés nem állítható elő: ${n.defects.join('; ')}`)
  }
  return [
    `JÓVÁHAGYÁS KÉRÉSE: ${i.caseTitle}`,
    '',
    'MIT FOGOK TENNI',
    n.whatItDoes,
    '',
    'MILYEN CÉLPONTON',
    n.target,
    '',
    'MI VÁLTOZIK KINT A VILÁGBAN',
    n.worldChange,
    '',
    'MIÉRT KÉREM A JÓVÁHAGYÁSODAT',
    n.whyApproval,
    '',
    'MIT TARTALMAZ',
    n.payloadSummary,
    '',
    '"igen" = EZT a konkrét műveletet hagyod jóvá, egyszer.',
    '"nem" = nem hajtjuk végre.',
    'Bármi más szöveg információ marad, és nem jóváhagyás.',
    '',
    'Ha a leírás, az ügy verziója vagy a lépés időközben változik,',
    'a jóváhagyás magától érvénytelen lesz.',
    '',
    // AUDIT, AND ONLY HERE. The machine label is real and traceable and belongs
    // in the record; what it may not be is the thing he is asked to approve.
    `Audit: gépi címke "${i.machineLabel}", külső hatás ${i.sideEffectClass}`
    + `${i.sideEffectReasons.length ? ` (${i.sideEffectReasons.join('; ')})` : ''}.`,
  ].join('\n')
}
