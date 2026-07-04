// PURE DATA -- no DB calls, no side effects.
import type { InterviewQuestion } from './interview-types.js';

// --- ELIGIBILITY ---
// Determines: is the org in scope for DORA/NIS2 + security class

export const ELIGIBILITY_QUESTIONS: Record<string, InterviewQuestion> = {

  'EQ-01': {
    id: 'EQ-01',
    text: 'A szervezet pénzügyi szektorbeli szervezet (bank, biztosító, befektetési vállalkozás, fizetési intézmény)?',
    type: 'yes_no',
    options: [
      { value: 'yes', label: 'Igen', nextId: 'EQ-02' },
      { value: 'no',  label: 'Nem',  nextId: 'EQ-10' },
    ],
  },

  'EQ-02': {
    id: 'EQ-02',
    text: 'A szervezet felügyelt pénzügyi intézmény (DORA 2. cikk hatálya)?',
    hint: 'Pl. MNB, EBA, ESMA felügyeli.',
    type: 'yes_no',
    options: [
      { value: 'yes', label: 'Igen -- DORA hatályban', nextId: 'EQ-03' },
      {
        value: 'no', label: 'Nem',
        terminatesWith: {
          inScope: false,
          reasoning: 'A szervezet pénzügyi szektorbeli, de nem MNB/EBA/ESMA felügyelete alá tartozó intézmény -- DORA közvetlen hatálya valószínűleg nem áll fenn. Javasolt: jogász megerősítés.',
        },
      },
    ],
  },

  'EQ-03': {
    id: 'EQ-03',
    text: 'Mekkora a szervezet mérete?',
    type: 'single_choice',
    options: [
      { value: 'micro',        label: 'Mikrovállalkozás (< 10 fő, < 2M EUR forgalom)', nextId: 'EQ-04' },
      { value: 'small',        label: 'Kisvállalkozás (< 50 fő)',                       nextId: 'EQ-05' },
      { value: 'medium_large', label: 'Közepes vagy nagyvállalat (≥ 50 fő)',            nextId: 'EQ-06' },
    ],
  },

  'EQ-04': {
    id: 'EQ-04',
    text: 'Mikrovállalkozásokra a DORA egyszerűsített rezsimet alkalmaz. Él-e a szervezet az egyszerűsített megfelelési lehetőséggel?',
    hint: 'DORA 16. cikk: arányossági elv.',
    type: 'yes_no',
    options: [
      {
        value: 'yes', label: 'Igen -- egyszerűsített rezsim',
        terminatesWith: {
          inScope: true,
          securityClass: 'Alap',
          reasoning: 'Mikrovállalkozás, egyszerűsített DORA rezsim. Biztonsági osztály: Alap. Kötelező: alapvető ICT kockázatkezelési keret, incidensjelentés.',
          nextMode: 'system_scope',
        },
      },
      { value: 'no', label: 'Nem -- teljes rezsim', nextId: 'EQ-06' },
    ],
  },

  'EQ-05': {
    id: 'EQ-05',
    text: 'A kisvállalkozásként kezelt intézmény esetén: kritikus vagy fontos intézménynek minősíti-e a felügyelő hatóság?',
    type: 'yes_no',
    options: [
      { value: 'yes', label: 'Igen', nextId: 'EQ-06' },
      {
        value: 'no', label: 'Nem',
        terminatesWith: {
          inScope: true,
          securityClass: 'Alap',
          reasoning: 'Kisintézmény, nem kritikus/fontos besorolású. Biztonsági osztály: Alap.',
          nextMode: 'system_scope',
        },
      },
    ],
  },

  'EQ-06': {
    id: 'EQ-06',
    text: 'Kritikus infrastruktúrát üzemeltet a szervezet (energia, közlekedés, vízügy, egészségügy, digitális infrastruktúra)?',
    type: 'yes_no',
    options: [
      { value: 'yes', label: 'Igen', nextId: 'EQ-07' },
      { value: 'no',  label: 'Nem',  nextId: 'EQ-08' },
    ],
  },

  'EQ-07': {
    id: 'EQ-07',
    text: 'A NIS2 irányelv értelmében "lényeges" (essential) vagy "fontos" (important) szervezetnek minősül?',
    type: 'single_choice',
    options: [
      {
        value: 'essential', label: 'Lényeges szervezet',
        terminatesWith: {
          inScope: true,
          securityClass: 'Magas',
          reasoning: 'Lényeges szervezet NIS2 értelmében. Biztonsági osztály: Magas. Fokozott követelmények (DORA + NIS2 kombinált).',
          nextMode: 'system_scope',
        },
      },
      {
        value: 'important', label: 'Fontos szervezet',
        terminatesWith: {
          inScope: true,
          securityClass: 'Jelentős',
          reasoning: 'Fontos szervezet NIS2 értelmében. Biztonsági osztály: Jelentős.',
          nextMode: 'system_scope',
        },
      },
      { value: 'unknown', label: 'Nem tudom / Folyamatban', nextId: 'EQ-08' },
    ],
  },

  'EQ-08': {
    id: 'EQ-08',
    text: 'Mekkora az éves IT költségvetés hozzávetőleg?',
    type: 'single_choice',
    options: [
      { value: 'under_1m',  label: '< 1M EUR',   nextId: 'EQ-09' },
      { value: '1m_10m',   label: '1-10M EUR',  nextId: 'EQ-09' },
      { value: 'over_10m', label: '> 10M EUR',  nextId: 'EQ-09' },
    ],
  },

  'EQ-09': {
    id: 'EQ-09',
    text: 'Harmadik fél ICT-szolgáltatóktól függ a szervezet kritikus üzleti folyamatainak végrehajtásában?',
    type: 'yes_no',
    terminal: true,
    options: [
      {
        value: 'yes', label: 'Igen',
        terminatesWith: {
          inScope: true,
          securityClass: 'Jelentős',
          reasoning: 'Közepes/nagy szervezet, harmadik fél ICT-függőséggel. Biztonsági osztály: Jelentős. DORA harmadik fél kockázatkezelés fokozottan releváns.',
          nextMode: 'system_scope',
        },
      },
      {
        value: 'no', label: 'Nem',
        terminatesWith: {
          inScope: true,
          securityClass: 'Alap',
          reasoning: 'Közepes/nagy szervezet, alacsony harmadik fél ICT-függőség. Biztonsági osztály: Alap.',
          nextMode: 'system_scope',
        },
      },
    ],
  },

  'EQ-10': {
    id: 'EQ-10',
    text: 'Állami vagy közigazgatási szervről van szó (nemzeti biztonsági, közrendi, honvédelmi feladatkör)?',
    type: 'yes_no',
    options: [
      {
        value: 'yes', label: 'Igen',
        terminatesWith: {
          inScope: false,
          reasoning: 'Állami/közigazgatási szerv -- DORA hatálya nem terjed ki (DORA 2. cikk (3) bekezdés). NIS2 más módon alkalmazandó. Javasolt: jogász konzultáció.',
        },
      },
      { value: 'no', label: 'Nem', nextId: 'EQ-11' },
    ],
  },

  'EQ-11': {
    id: 'EQ-11',
    text: 'A szervezet ICT-szolgáltatóként (pl. cloud, managed service) szállít pénzügyi intézményeknek?',
    type: 'yes_no',
    options: [
      {
        value: 'yes', label: 'Igen -- kritikus ICT-szolgáltató vagyok',
        terminatesWith: {
          inScope: true,
          securityClass: 'Jelentős',
          reasoning: 'Kritikus ICT harmadik fél szolgáltató (DORA 31. cikk). Felügyeleti keretben (oversight framework). Biztonsági osztály: Jelentős.',
          nextMode: 'system_scope',
        },
      },
      {
        value: 'no', label: 'Nem',
        terminatesWith: {
          inScope: false,
          reasoning: 'A szervezet nem pénzügyi szektorbeli és nem kritikus ICT-szolgáltató -- valószínűleg nem esik DORA hatálya alá. Javasolt: jogász megerősítés.',
        },
      },
    ],
  },
};

export const ELIGIBILITY_START_ID = 'EQ-01';

// --- SYSTEM SCOPE ---
// Determines: which ICT systems the org operates (EIR seed)

export const SYSTEM_SCOPE_QUESTIONS: Record<string, InterviewQuestion> = {

  'SS-01': {
    id: 'SS-01',
    text: 'Milyen típusú ICT rendszereket üzemeltet a szervezet? (Több választható)',
    type: 'multi_choice',
    options: [
      { value: 'core_banking',   label: 'Core banking / tranzakció-feldolgozó rendszer' },
      { value: 'payment',        label: 'Fizetési rendszer / POS' },
      { value: 'risk_mgmt',      label: 'Kockázatkezelési rendszer' },
      { value: 'reporting',      label: 'Regulatorikus riportáló rendszer' },
      { value: 'crm',            label: 'CRM / ügyfélkezelő' },
      { value: 'erp',            label: 'ERP / vállalatirányítási rendszer' },
      { value: 'cloud_infra',    label: 'Cloud infrastruktúra (IaaS/PaaS)' },
      { value: 'network',        label: 'Hálózati infrastruktúra' },
      { value: 'security_ops',   label: 'Biztonsági műveleti rendszer (SIEM, SOC)' },
      { value: 'data_analytics', label: 'Adat-analitika / BI' },
      { value: 'comm',           label: 'Kommunikációs rendszer (email, collab)' },
      { value: 'other',          label: 'Egyéb' },
    ],
    defaultNextId: 'SS-02',
  },

  'SS-02': {
    id: 'SS-02',
    text: 'Hány kritikus ICT rendszert üzemeltet (becslés)?',
    type: 'single_choice',
    options: [
      { value: '1_5',     label: '1-5 rendszer' },
      { value: '6_20',    label: '6-20 rendszer' },
      { value: '21_50',   label: '21-50 rendszer' },
      { value: '50_plus', label: '50+ rendszer' },
    ],
    defaultNextId: 'SS-03',
  },

  'SS-03': {
    id: 'SS-03',
    text: 'Hogyan üzemeltetik a kritikus rendszereket?',
    type: 'single_choice',
    options: [
      { value: 'on_prem',    label: 'Kizárólag saját infrastruktúrán (on-premise)' },
      { value: 'cloud',      label: 'Kizárólag publikus felhőben (AWS/Azure/GCP)' },
      { value: 'hybrid',     label: 'Vegyes (on-premise + felhő)' },
      { value: 'outsourced', label: 'Harmadik fél által üzemeltetett (outsourcing)' },
    ],
    defaultNextId: 'SS-04',
  },

  'SS-04': {
    id: 'SS-04',
    text: 'Van-e kritikus funkciót ellátó harmadik fél ICT-szolgáltató? (pl. felhő, BPO)',
    type: 'yes_no',
    terminal: true,
    options: [
      {
        value: 'yes', label: 'Igen',
        terminatesWith: {
          inScope: true,
          reasoning: 'Rendszerhatókör rögzítve. Harmadik fél ICT-függőség azonosítva -- RoI regiszter kitöltése szükséges.',
          suggestedEirTypes: ['core_banking', 'payment', 'cloud_infra', 'security_ops'],
        },
      },
      {
        value: 'no', label: 'Nem -- csak belső rendszerek',
        terminatesWith: {
          inScope: true,
          reasoning: 'Rendszerhatókör rögzítve. Belső üzemeltetés, harmadik fél ICT-kockázat alacsony.',
          suggestedEirTypes: ['core_banking', 'payment', 'erp', 'network'],
        },
      },
    ],
  },
};

export const SYSTEM_SCOPE_START_ID = 'SS-01';

export function getQuestionsForMode(mode: 'eligibility' | 'system_scope'): Record<string, InterviewQuestion> {
  return mode === 'eligibility' ? ELIGIBILITY_QUESTIONS : SYSTEM_SCOPE_QUESTIONS;
}

export function getStartId(mode: 'eligibility' | 'system_scope'): string {
  return mode === 'eligibility' ? ELIGIBILITY_START_ID : SYSTEM_SCOPE_START_ID;
}
