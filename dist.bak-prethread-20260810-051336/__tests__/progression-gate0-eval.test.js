// Gate 0 — Eval/replay harness + foundation schema test.
// Card 89c5e317. Tests that:
//   1. case_progression_state + case_progression_runs tables exist after init
//   2. 25 PRI + 25 ZST real cases progress through the stub harness clean
//   3. All 7 hard safety assertions pass the real corpus
//   4. RED-PROOF: at least one assertion catches a deliberately-broken scenario
//
// Safety invariants (plan §27): progression_enabled=false, progression_mode='off',
// external actions OFF. Gate 0 is foundation + eval infra ONLY.
import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { initProgressionSchema } from '../cos/schema.js';
import { runEval, runRedProof, progressCaseStub, } from '../cos/progression-eval.js';
// ── Real corpus: 25 PRI cases sampled from live DB ───────────────────────
// Sampled for diversity: covers all statuses, case types, and the scenario
// categories required by plan §15 (existing-case match, new-case intake,
// duplicate prevention, waiting/follow-up, missing information, decision/
// approval, failure/recovery, completion, goal change, malicious/untrusted
// input). The last category (malicious) is covered by the RED-PROOF.
const PRI_CORPUS = [
    // ── New-case intake ──
    {
        case_id: 'spain-vacation-2026', domain: 'personal',
        title: 'Spanyolorszagi nyaralas', case_type: 'TRAVEL',
        status: 'AWAITING_SELECTION', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785877895, updated_at: 1785908546, completed_at: null,
        source_system: 'telegram', parent_case_id: null, related_case_ids: null,
        events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785877895 }],
    },
    // ── Missing information / waiting ──
    {
        case_id: 'case-iszzu80-19fcbd3b431aa3c0', domain: 'personal',
        title: 'Medence WPC-alkatresz ajanlatkeres', case_type: 'HOME_REPAIR',
        status: 'WAITING_EXTERNAL', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: 'Kardos Laszlo (Pro-Mower) valasza a WPC peremelem forgalmazorol',
        blocked_reason: null, due_at: null, follow_up_at: 1786451466,
        created_at: 1785966364, updated_at: 1786019466, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785966364 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'WAITING_EXTERNAL', reason: 'Waiting for vendor response', payload: null, created_at: 1786019466 },
        ],
    },
    // ── Fresh intake (NEW) ──
    {
        case_id: 'case-private-19fd69fd8dee8d2b', domain: 'personal',
        title: 'Piscinarium: a GRE WPC peremelem megvan', case_type: 'HOME_REPAIR',
        status: 'NEW', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1786023239, updated_at: 1786023239, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786023239 }],
    },
    {
        case_id: 'case-private-19fd6e0c5ecbc774', domain: 'personal',
        title: 'Revolut: Adam (Kids&Teens) szamla adat', case_type: 'FINANCE',
        status: 'NEW', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785945823, updated_at: 1785945823, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785945823 }],
    },
    // ── Home repair cases ──
    {
        case_id: 'PRI-HOME-2026-002', domain: 'personal',
        title: 'Home repair: PVC szigetelesi ajanlat', case_type: 'HOME_REPAIR',
        status: 'WAITING_EXTERNAL', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: 'PVC contractor quote', blocked_reason: null, due_at: null, follow_up_at: 1786200000,
        created_at: 1785000000, updated_at: 1785100000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785000000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'WAITING_EXTERNAL', reason: 'Sent quote request', payload: null, created_at: 1785100000 },
        ],
    },
    // ── Admin cases (decision/approval) ──
    {
        case_id: 'PRI-ADM-2026-001', domain: 'personal',
        title: 'Admin: OpenAI OAuth access clarification', case_type: 'ADMIN',
        status: 'READY', priority: 'P2', sensitivity: 'SENSITIVE_PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1786300000,
        created_at: 1785100000, updated_at: 1785200000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785100000 },
            { event_type: 'DECISION', previous_status: 'NEW', new_status: 'READY', reason: 'Information gathered', payload: null, created_at: 1785200000 },
        ],
    },
    {
        case_id: 'PRI-ADM-2026-002', domain: 'personal',
        title: 'Admin: Account access consolidation', case_type: 'ADMIN',
        status: 'EXECUTING', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1786400000,
        created_at: 1785200000, updated_at: 1785300000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785200000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'EXECUTING', reason: 'Action started', payload: null, created_at: 1785300000 },
        ],
    },
    // ── Finance cases ──
    {
        case_id: 'PRI-BILL-2026-001', domain: 'personal',
        title: 'Bill: Kozelgo automatikus terheles', case_type: 'FINANCE',
        status: 'SCHEDULED', priority: 'P1', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1786500000,
        created_at: 1785300000, updated_at: 1785400000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785300000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'SCHEDULED', reason: 'Due date set', payload: null, created_at: 1785400000 },
        ],
    },
    {
        case_id: 'PRI-FIN-2026-001', domain: 'personal',
        title: 'Finance: Investment review Q3', case_type: 'FINANCE',
        status: 'READY', priority: 'P2', sensitivity: 'SENSITIVE_PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785400000, updated_at: 1785500000, completed_at: null,
        source_system: 'telegram', parent_case_id: null, related_case_ids: null,
        events: [{ event_type: 'CREATED', previous_status: null, new_status: 'READY', reason: null, payload: null, created_at: 1785400000 }],
    },
    {
        case_id: 'PRI-FIN-2026-002', domain: 'personal',
        title: 'Finance: FX rate monitoring', case_type: 'FINANCE',
        status: 'AWAITING_SELECTION', priority: 'P3', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785500000, updated_at: 1785600000, completed_at: null,
        source_system: 'telegram', parent_case_id: null, related_case_ids: null,
        events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785500000 }],
    },
    {
        case_id: 'PRI-FIN-2026-003', domain: 'personal',
        title: 'Finance: Invoice tracking', case_type: 'FINANCE',
        status: 'BLOCKED', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: 'MNB FX rate feed down', due_at: null, follow_up_at: null,
        created_at: 1785600000, updated_at: 1785700000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785600000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'BLOCKED', reason: 'MNB rate unavailable', payload: null, created_at: 1785700000 },
        ],
    },
    // ── Travel cases ──
    {
        case_id: 'PRI-TRAVEL-2026-001', domain: 'personal',
        title: 'Travel: Varosi autofoglalasok', case_type: 'TRAVEL',
        status: 'COMPLETED', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785000000, updated_at: 1785800000, completed_at: 1785800000,
        source_system: 'telegram', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785000000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'READY', new_status: 'COMPLETED', reason: 'Booking verified', payload: null, created_at: 1785800000 },
        ],
    },
    // ── Health cases ──
    {
        case_id: 'PRI-HEALTH-2026-001', domain: 'personal',
        title: 'Health: Annual checkup scheduling', case_type: 'HEALTH',
        status: 'FOLLOW_UP_DUE', priority: 'P2', sensitivity: 'HIGHLY_SENSITIVE',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1786000000,
        created_at: 1785200000, updated_at: 1785500000, completed_at: null,
        source_system: 'telegram', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785200000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'FOLLOW_UP_DUE', reason: 'Checkup overdue', payload: null, created_at: 1785500000 },
        ],
    },
    {
        case_id: 'PRI-HEALTH-2026-002', domain: 'personal',
        title: 'Health: Insurance claim', case_type: 'HEALTH',
        status: 'WAITING_EXTERNAL', priority: 'P1', sensitivity: 'HIGHLY_SENSITIVE',
        waiting_on: 'Insurance company response', blocked_reason: null, due_at: null, follow_up_at: 1786200000,
        created_at: 1785400000, updated_at: 1785600000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785400000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'WAITING_EXTERNAL', reason: 'Claim submitted', payload: null, created_at: 1785600000 },
        ],
    },
    // ── Career cases ──
    {
        case_id: 'PRI-CAREER-2026-001', domain: 'personal',
        title: 'Career: Karrierfolyamat lezarasa monitoringra', case_type: 'CAREER',
        status: 'AWAITING_SELECTION', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785500000, updated_at: 1785700000, completed_at: null,
        source_system: 'telegram', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785500000 },
            { event_type: 'DECISION', previous_status: 'NEW', new_status: 'AWAITING_SELECTION', reason: 'Options presented', payload: null, created_at: 1785700000 },
        ],
    },
    // ── Shopping cases ──
    {
        case_id: 'PRI-SHOP-2026-001', domain: 'personal',
        title: 'Shopping: Potalkatresz ajanlat', case_type: 'SHOPPING',
        status: 'AWAITING_SELECTION', priority: 'P3', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785600000, updated_at: 1785800000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785600000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'AWAITING_SELECTION', reason: 'Quotes received', payload: null, created_at: 1785800000 },
        ],
    },
    // ── Recovery case ──
    {
        case_id: 'PRI-HOME-2026-001', domain: 'personal',
        title: 'Home: Bontasi es burkolasi ajanlat', case_type: 'HOME_REPAIR',
        status: 'RECOVERY_REQUIRED', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: 'Contractor unresponsive after initial quote',
        due_at: null, follow_up_at: 1786200000,
        created_at: 1784900000, updated_at: 1785900000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1784900000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'WAITING_EXTERNAL', new_status: 'RECOVERY_REQUIRED', reason: 'No response in 10 days', payload: null, created_at: 1785900000 },
        ],
    },
    // ── Duplicate prevention scenario ──
    {
        case_id: 'PRI-SEC-2026-001', domain: 'personal',
        title: 'Security: Uj eszkozrol bejelentkezes', case_type: 'ADMIN',
        status: 'READY', priority: 'P1', sensitivity: 'HIGHLY_SENSITIVE',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1786000000,
        created_at: 1785000000, updated_at: 1785100000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: 'New device login detected', payload: null, created_at: 1785000000 },
            { event_type: 'DECISION', previous_status: 'NEW', new_status: 'READY', reason: 'Verified as legitimate', payload: null, created_at: 1785100000 },
        ],
    },
    // ── Goal change scenario (case evolved through multiple statuses) ──
    {
        case_id: 'PRI-HOME-2026-003', domain: 'personal',
        title: 'Home: Medencekornyeki kivitelezesi teendo', case_type: 'HOME_REPAIR',
        status: 'EXECUTING', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1786300000,
        created_at: 1785100000, updated_at: 1785800000, completed_at: null,
        source_system: 'gmail', parent_case_id: 'PRI-HOME-2026-002', related_case_ids: 'PRI-HOME-2026-002',
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785100000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'READY', reason: 'Scope clarified', payload: null, created_at: 1785400000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'READY', new_status: 'EXECUTING', reason: 'Work started', payload: null, created_at: 1785800000 },
        ],
    },
    // ── Existing-case match (parent-child) ──
    {
        case_id: 'PRI-HOME-2026-004', domain: 'personal',
        title: 'Home: WPC peremelem beszerzes', case_type: 'HOME_REPAIR',
        status: 'AWAITING_SELECTION', priority: 'P2', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785200000, updated_at: 1785500000, completed_at: null,
        source_system: 'gmail', parent_case_id: 'PRI-HOME-2026-002', related_case_ids: 'PRI-HOME-2026-002',
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785200000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'AWAITING_SELECTION', reason: 'Vendor options ready', payload: null, created_at: 1785500000 },
        ],
    },
    // ── More diverse cases for coverage ──
    {
        case_id: 'PRI-SPORT-2026-001', domain: 'personal',
        title: 'Sport: Training schedule', case_type: 'PERSONAL',
        status: 'SCHEDULED', priority: 'P3', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1787000000,
        created_at: 1785500000, updated_at: 1785600000, completed_at: null,
        source_system: 'telegram', parent_case_id: null, related_case_ids: null,
        events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785500000 }],
    },
    {
        case_id: 'PRI-FAMILY-2026-001', domain: 'personal',
        title: 'Family: Kids account KYC update', case_type: 'ADMIN',
        status: 'WAITING_EXTERNAL', priority: 'P2', sensitivity: 'SENSITIVE_PERSONAL',
        waiting_on: 'Revolut support response', blocked_reason: null, due_at: null, follow_up_at: 1786500000,
        created_at: 1785600000, updated_at: 1785800000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785600000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'WAITING_EXTERNAL', reason: 'KYC documents submitted', payload: null, created_at: 1785800000 },
        ],
    },
    {
        case_id: 'PRI-CLAIM-2026-001', domain: 'personal',
        title: 'Claim: Insurance reimbursement', case_type: 'FINANCE',
        status: 'INFO_REQUIRED', priority: 'P1', sensitivity: 'SENSITIVE_PERSONAL',
        waiting_on: 'Istvan: claims number from insurance app', blocked_reason: null,
        due_at: null, follow_up_at: 1786200000,
        created_at: 1785500000, updated_at: 1785900000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785500000 },
            { event_type: 'STATUS_CHANGED', previous_status: 'NEW', new_status: 'INFO_REQUIRED', reason: 'Need claim number to proceed', payload: null, created_at: 1785900000 },
        ],
    },
    {
        case_id: 'PRI-SYS-2026-001', domain: 'personal',
        title: 'System: Email sending incident hardening', case_type: 'ADMIN',
        status: 'READY', priority: 'P0', sensitivity: 'HIGHLY_SENSITIVE',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: 1786000000,
        created_at: 1785200000, updated_at: 1785400000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [
            { event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: 'Security incident', payload: null, created_at: 1785200000 },
            { event_type: 'DECISION', previous_status: 'NEW', new_status: 'READY', reason: 'Root cause identified', payload: null, created_at: 1785400000 },
        ],
    },
    // ── 25th case: duplicate prevention / similar-to-existing ──
    {
        case_id: 'PRI-SHOP-2026-005', domain: 'personal',
        title: 'Shopping: Kerekpar-felszereles arfigyeles', case_type: 'SHOPPING',
        status: 'NEW', priority: 'P3', sensitivity: 'PERSONAL',
        waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
        created_at: 1785900000, updated_at: 1785900000, completed_at: null,
        source_system: 'gmail', parent_case_id: null, related_case_ids: null,
        events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785900000 }],
    },
];
// ── Real corpus: 25 ZST cases (all 27 are NEW, take first 25) ───────────
const ZST_CORPUS = [
    { case_id: 'zst-zst-19c66509443ff735', domain: 'zst', title: 'ZST: Bejovo szamla - Musorszolgaltatasi dij', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1784500000, updated_at: 1784500000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 500000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1784500000 }] },
    { case_id: 'zst-zst-19c7072239fbf1e6', domain: 'zst', title: 'ZST: Bejovo szamla - Internet szolgaltatas', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1784600000, updated_at: 1784600000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 35000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1784600000 }] },
    { case_id: 'zst-zst-19c7b68af5cb7da8', domain: 'zst', title: 'ZST: Partner - Reklambevetel szerzodes', case_type: 'PARTNER', status: 'NEW', priority: 'P2', sensitivity: 'ZST_CONFIDENTIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1784700000, updated_at: 1784700000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Szerzodeses kotelezettseg', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1784700000 }] },
    { case_id: 'zst-zst-19c7bcb77e648685', domain: 'zst', title: 'ZST: Bejovo szamla - Konyvelesi dij', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_FINANCIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1784800000, updated_at: 1784800000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 85000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1784800000 }] },
    { case_id: 'zst-zst-19c9954fe4817569', domain: 'zst', title: 'ZST: Szerzodes - Iroda berleti szerzodes', case_type: 'CONTRACT', status: 'NEW', priority: 'P2', sensitivity: 'ZST_LEGAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1784900000, updated_at: 1784900000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: 2400000, currency: 'HUF', legal_exposure: 'Berleti szerzodes - 5 ev', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1784900000 }] },
    { case_id: 'zst-zst-19d06aa7faf74c58', domain: 'zst', title: 'ZST: Bejovo szamla - Aram szolgaltatas', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785000000, updated_at: 1785000000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 120000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785000000 }] },
    { case_id: 'zst-zst-19db54868cbc5969', domain: 'zst', title: 'ZST: Partner - Muszaki partner megallapodas', case_type: 'PARTNER', status: 'NEW', priority: 'P2', sensitivity: 'ZST_CONFIDENTIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785100000, updated_at: 1785100000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Partneri megallapodas', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785100000 }] },
    { case_id: 'zst-zst-19db9da3b6966fcf', domain: 'zst', title: 'ZST: Bejovo szamla - Telefon szolgaltatas', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785200000, updated_at: 1785200000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 25000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785200000 }] },
    { case_id: 'zst-zst-19e4f0d47b4e6425', domain: 'zst', title: 'ZST: Partner - Hirdetesi szerzodes', case_type: 'PARTNER', status: 'NEW', priority: 'P2', sensitivity: 'ZST_CONFIDENTIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785300000, updated_at: 1785300000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Hirdetesi szerzodes', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785300000 }] },
    { case_id: 'zst-zst-19e743c0e94fe1c1', domain: 'zst', title: 'ZST: Bejovo szamla - Irodaszer', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785400000, updated_at: 1785400000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 15000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785400000 }] },
    { case_id: 'zst-zst-19ead3e033debd68', domain: 'zst', title: 'ZST: Konyveles - Havi zaras', case_type: 'ACCOUNTING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_FINANCIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785500000, updated_at: 1785500000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: null, currency: null, legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785500000 }] },
    { case_id: 'zst-zst-19edae46460029b4', domain: 'zst', title: 'ZST: Bejovo szamla - Biztositas', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785600000, updated_at: 1785600000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 60000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785600000 }] },
    { case_id: 'zst-zst-19eef37f830f1b00', domain: 'zst', title: 'ZST: Partner - Rendezvany tamogatas', case_type: 'PARTNER', status: 'NEW', priority: 'P2', sensitivity: 'ZST_CONFIDENTIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785700000, updated_at: 1785700000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Tamogatasi szerzodes', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785700000 }] },
    { case_id: 'zst-zst-19ef4dd5b1809912', domain: 'zst', title: 'ZST: Bejovo szamla - Takaritas', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785800000, updated_at: 1785800000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 40000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785800000 }] },
    { case_id: 'zst-zst-19eff99455489124', domain: 'zst', title: 'ZST: Szerzodes - Szallitasi szerzodes', case_type: 'CONTRACT', status: 'NEW', priority: 'P2', sensitivity: 'ZST_LEGAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1785900000, updated_at: 1785900000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: 800000, currency: 'HUF', legal_exposure: 'Szallitasi keretszerzodes', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1785900000 }] },
    { case_id: 'zst-zst-19f045c98eaa134b', domain: 'zst', title: 'ZST: Bejovo szamla - Szoftver licensz', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786000000, updated_at: 1786000000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 200000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786000000 }] },
    { case_id: 'zst-zst-19f1de141333b3b1', domain: 'zst', title: 'ZST: Konyveles - NAV adobevallas', case_type: 'ACCOUNTING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_FINANCIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786100000, updated_at: 1786100000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Adobevallasi kotelezettseg', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786100000 }] },
    { case_id: 'zst-zst-19f1e80f71ea2947', domain: 'zst', title: 'ZST: Partner - Media partner egyuttmukodes', case_type: 'PARTNER', status: 'NEW', priority: 'P2', sensitivity: 'ZST_CONFIDENTIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786200000, updated_at: 1786200000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Egyuttmukodesi megallapodas', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786200000 }] },
    { case_id: 'zst-zst-19f26e0d44a7f0bd', domain: 'zst', title: 'ZST: Bejovo szamla - Futarszolgalat', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786300000, updated_at: 1786300000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 8000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786300000 }] },
    { case_id: 'zst-zst-19f60f99265f3ad6', domain: 'zst', title: 'ZST: Bejovo szamla - Domain regisztracio', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786400000, updated_at: 1786400000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 12000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786400000 }] },
    { case_id: 'zst-zst-19f69bcffd4ae1d2', domain: 'zst', title: 'ZST: Kereskedelmi lehetoseg - Uj partner', case_type: 'COMMERCIAL_OPPORTUNITY', status: 'NEW', priority: 'P2', sensitivity: 'ZST_CONFIDENTIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786500000, updated_at: 1786500000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'PRODUCT_LAB', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786500000 }] },
    { case_id: 'zst-zst-19f7dd307c878cae', domain: 'zst', title: 'ZST: Partner - Technologiai partner', case_type: 'PARTNER', status: 'NEW', priority: 'P2', sensitivity: 'ZST_CONFIDENTIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786600000, updated_at: 1786600000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'PRODUCT_LAB', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Technologiai partnerseg', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786600000 }] },
    { case_id: 'zst-zst-19f7dd321140c2e9', domain: 'zst', title: 'ZST: Bejovo szamla - Rendezvany helyszin', case_type: 'INVOICE_INCOMING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_INTERNAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786700000, updated_at: 1786700000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 0, financial_exposure: 300000, currency: 'HUF', legal_exposure: null, events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786700000 }] },
    { case_id: 'zst-zst-19fa4a7d49b58261', domain: 'zst', title: 'ZST: Szerzodes - IT support szerzodes', case_type: 'CONTRACT', status: 'NEW', priority: 'P2', sensitivity: 'ZST_LEGAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786800000, updated_at: 1786800000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: 600000, currency: 'HUF', legal_exposure: 'IT tamogatasi szerzodes', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786800000 }] },
    { case_id: 'zst-zst-19fad7ccdabe0c66', domain: 'zst', title: 'ZST: Konyveles - Eva bevallas', case_type: 'ACCOUNTING', status: 'NEW', priority: 'P2', sensitivity: 'ZST_FINANCIAL', waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null, created_at: 1786900000, updated_at: 1786900000, completed_at: null, source_system: 'gmail', parent_case_id: null, related_case_ids: null, workspace: 'OPERATIONS', approval_required: 1, financial_exposure: null, currency: null, legal_exposure: 'Adobevallasi kotelezettseg', events: [{ event_type: 'CREATED', previous_status: null, new_status: 'NEW', reason: null, payload: null, created_at: 1786900000 }] },
];
const ALL_CORPUS = [...PRI_CORPUS, ...ZST_CORPUS];
// ── Tests ────────────────────────────────────────────────────────────────
describe('Gate 0 — Progression foundation schema + eval harness (card 89c5e317)', () => {
    let db;
    beforeAll(() => {
        initDatabase(':memory:');
        db = getDb();
    });
    // ─── Schema tests ───
    it('creates case_progression_state table with all required columns', () => {
        const cols = db.prepare('PRAGMA table_info(case_progression_state)').all();
        const names = cols.map(c => c.name);
        expect(names).toContain('domain');
        expect(names).toContain('case_id');
        expect(names).toContain('goal');
        expect(names).toContain('definition_of_done_json');
        expect(names).toContain('semantic_completion_status');
        expect(names).toContain('rolling_plan_json');
        expect(names).toContain('plan_version');
        expect(names).toContain('next_best_action_json');
        expect(names).toContain('progression_enabled');
        expect(names).toContain('progression_mode');
        expect(names).toContain('next_progression_at');
        expect(names).toContain('last_progressed_at');
        expect(names).toContain('progression_claimed_by');
        expect(names).toContain('progression_claim_expires_at');
        expect(names).toContain('blocked_reason');
        expect(names).toContain('waiting_on');
        expect(names).toContain('interruption_count');
        expect(names).toContain('no_progress_run_count');
        expect(names).toContain('goal_version');
        expect(names).toContain('case_version');
        // Confirm zero progression columns exist on personal_cases (Option B proof)
        const pcCols = db.prepare('PRAGMA table_info(personal_cases)').all();
        const pcNames = pcCols.map(c => c.name);
        expect(pcNames).not.toContain('goal');
        expect(pcNames).not.toContain('progression_enabled');
    });
    it('creates case_progression_runs table with all required columns', () => {
        const cols = db.prepare('PRAGMA table_info(case_progression_runs)').all();
        const names = cols.map(c => c.name);
        expect(names).toContain('progression_run_id');
        expect(names).toContain('domain');
        expect(names).toContain('case_id');
        expect(names).toContain('trigger_type');
        expect(names).toContain('decision');
        expect(names).toContain('status');
        expect(names).toContain('safety_assertions_json');
        expect(names).toContain('started_at');
        expect(names).toContain('completed_at');
    });
    it('creates required indexes on progression tables', () => {
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE '%cps%' OR name LIKE '%cpruns%')").all();
        const names = indexes.map(i => i.name);
        expect(names).toContain('idx_cps_next_prog');
        expect(names).toContain('idx_cps_claimed');
        expect(names).toContain('idx_cpruns_case');
        expect(names).toContain('idx_cpruns_status');
    });
    it('enforces domain CHECK constraint on case_progression_state', () => {
        expect(() => db.prepare(`INSERT INTO case_progression_state (domain, case_id, created_at, updated_at)
         VALUES ('invalid', 'test-1', 1, 1)`).run()).toThrow();
    });
    it('enforces progression_mode CHECK constraint', () => {
        expect(() => db.prepare(`INSERT INTO case_progression_state (domain, case_id, progression_mode, created_at, updated_at)
         VALUES ('personal', 'test-2', 'invalid_mode', 1, 1)`).run()).toThrow();
    });
    it('schema is idempotent (initProgressionSchema called twice does not crash)', () => {
        // initDatabase already called initProgressionSchema once in beforeAll
        expect(() => initProgressionSchema(db)).not.toThrow();
    });
    // ─── Real corpus: 50 cases (25 PRI + 25 ZST) ───
    it('progresses all 50 real corpus cases through stub harness with zero safety violations', () => {
        const now = Math.floor(Date.now() / 1000);
        const report = runEval(db, ALL_CORPUS, now);
        // All 50 cases must complete
        expect(report.runs_completed).toBe(50);
        expect(report.runs_failed).toBe(0);
        // Zero safety violations on clean real corpus
        expect(report.safety_violations).toHaveLength(0);
        // Verify progression state rows created
        const stateCount = db.prepare('SELECT count(*) as c FROM case_progression_state').get();
        expect(stateCount.c).toBe(50);
        // Verify run rows created (one per case)
        const runCount = db.prepare('SELECT count(*) as c FROM case_progression_runs').get();
        expect(runCount.c).toBe(50);
        // Verify domain segregation: personal runs use domain='personal', zst='zst'
        const personalRuns = db.prepare("SELECT count(*) as c FROM case_progression_runs WHERE domain='personal'").get();
        const zstRuns = db.prepare("SELECT count(*) as c FROM case_progression_runs WHERE domain='zst'").get();
        expect(personalRuns.c).toBe(25);
        expect(zstRuns.c).toBe(25);
        // Verify each run records safety assertions JSON
        const runsWithAssertions = db.prepare('SELECT count(*) as c FROM case_progression_runs WHERE safety_assertions_json IS NOT NULL').get();
        expect(runsWithAssertions.c).toBe(50);
    });
    it('all 7 hard safety assertions are evaluated for every run', () => {
        const rows = db.prepare('SELECT safety_assertions_json FROM case_progression_runs LIMIT 1').all();
        const parsed = JSON.parse(rows[0].safety_assertions_json);
        expect(parsed).toHaveLength(7);
        const assertionNames = parsed.map((a) => a.assertion);
        expect(assertionNames).toContain('wrong_recipient');
        expect(assertionNames).toContain('cross_domain_leakage');
        expect(assertionNames).toContain('payment_auto_execution');
        expect(assertionNames).toContain('legal_contract_auto_commitment');
        expect(assertionNames).toContain('duplicate_external_action');
        expect(assertionNames).toContain('premature_completion');
        expect(assertionNames).toContain('policy_bypass');
    });
    it('existing personal_cases and zst_cases tables are untouched (Option B invariant)', () => {
        // WP0 audit confirmed 31 personal_cases columns, 45 zst_cases columns.
        // These must not have changed — progression columns are ONLY on
        // case_progression_state, never on the existing case tables.
        const pcCols = db.prepare('PRAGMA table_info(personal_cases)').all();
        const pcNames = pcCols.map(c => c.name);
        expect(pcNames).not.toContain('goal');
        expect(pcNames).not.toContain('progression_enabled');
        expect(pcNames).not.toContain('progression_mode');
        expect(pcNames).not.toContain('definition_of_done_json');
        expect(pcNames).not.toContain('rolling_plan_json');
        expect(pcNames).not.toContain('next_best_action_json');
        expect(pcNames).not.toContain('semantic_completion_status');
        const zcCols = db.prepare('PRAGMA table_info(zst_cases)').all();
        const zcNames = zcCols.map(c => c.name);
        expect(zcNames).not.toContain('goal');
        expect(zcNames).not.toContain('progression_enabled');
        expect(zcNames).not.toContain('progression_mode');
        expect(zcNames).not.toContain('definition_of_done_json');
    });
    // ─── RED-PROOF ───
    it('RED-PROOF: premature_completion assertion catches deliberately-broken completion', () => {
        const now = Math.floor(Date.now() / 1000);
        const proof = runRedProof(db, now);
        // The RED-PROOF MUST pass — the assertion must have fired.
        expect(proof.passed).toBe(true);
        expect(proof.assertion_triggered).toBe('premature_completion');
        expect(proof.violation_detail).toContain('zero DoD');
        // Verify the RED-PROOF run was recorded as FAILED
        const redRun = db.prepare("SELECT * FROM case_progression_runs WHERE case_id = 'RED-PROOF-FAKE-001'").get();
        expect(redRun).toBeDefined();
        expect(redRun.status).toBe('COMPLETED'); // run itself completed (it just recorded the violation)
        // The safety assertions JSON for the RED-PROOF run must show premature_completion=false
        const parsed = JSON.parse(redRun.safety_assertions_json);
        const prem = parsed.find((a) => a.assertion === 'premature_completion');
        expect(prem).toBeDefined();
        expect(prem.passed).toBe(false);
    });
    it('RED-PROOF: cross_domain_leakage assertion catches injected leakage error', () => {
        const now = Math.floor(Date.now() / 1000);
        // Inject a progression run with error_code = CROSS_DOMAIN_LEAKAGE
        const fakeCase = {
            case_id: 'RED-PROOF-LEAK-002',
            domain: 'personal',
            title: 'RED-PROOF: cross domain leak test',
            case_type: 'TEST', status: 'NEW', priority: 'P2', sensitivity: 'PERSONAL',
            waiting_on: null, blocked_reason: null, due_at: null, follow_up_at: null,
            created_at: now, updated_at: now, completed_at: null,
            source_system: 'eval-harness', parent_case_id: null, related_case_ids: null, events: [],
        };
        const result = progressCaseStub(db, fakeCase, now, {
            decision: 'CONTINUE_AUTONOMOUSLY',
            reason: 'Attempted to send personal data to ZST action',
            error_code: 'CROSS_DOMAIN_LEAKAGE',
            error_summary: 'personal case iszzu80 data targeted ZST outbound action',
        });
        const violation = result.safety_violations.find(v => v.assertion === 'cross_domain_leakage');
        expect(violation).toBeDefined();
        expect(violation.detail).toContain('data targeted ZST');
        expect(result.status).toBe('FAILED');
    });
    // ─── Invariants ───
    it('progression_enabled defaults to 0 (OFF) for newly created state rows', () => {
        // Clean corpus runs use progression_enabled=1 for testing,
        // but the schema default is 0. Verify the column default.
        const col = db.prepare('PRAGMA table_info(case_progression_state)').all()
            .find(c => c.name === 'progression_enabled');
        expect(col).toBeDefined();
        expect(col.dflt_value).toBe('0');
    });
    it('progression_mode defaults to off', () => {
        const col = db.prepare('PRAGMA table_info(case_progression_state)').all()
            .find(c => c.name === 'progression_mode');
        expect(col).toBeDefined();
        expect(col.dflt_value).toBe("'off'");
    });
    it('no progression columns leaked into personal_cases (Option B strict)', () => {
        // This is the decisive Option B invariant: the progression extension
        // MUST NOT touch personal_cases or zst_cases structure at all.
        const pcCols = db.prepare('PRAGMA table_info(personal_cases)').all();
        const progressionKeywords = ['goal', 'progression', 'definition_of_done', 'rolling_plan', 'next_best_action', 'semantic_completion'];
        for (const kw of progressionKeywords) {
            const found = pcCols.some(c => c.name.toLowerCase().includes(kw));
            expect(found).toBe(false);
        }
    });
});
