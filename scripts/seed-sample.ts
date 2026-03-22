/**
 * Seed the Lietuvos bankas database with sample provisions for testing.
 *
 * Inserts representative provisions from LB_Nutarimai, LB_Gaires,
 * and LB_Rekomendacijos sourcebooks so MCP tools can be tested
 * without running a full ingest.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["LB_DB_PATH"] ?? "data/lb.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Sourcebooks ---

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "LB_NUTARIMAI",
    name: "LB Nutarimai",
    description:
      "Lietuvos banko nutarimai — fintech licencijavimas, kapitalo reikalavimai, AML, ir mokejimo paslaugu reguliavimas.",
  },
  {
    id: "LB_GAIRES",
    name: "LB Gaires",
    description:
      "Lietuvos banko gaires — priziuro laukimai, IT sauga, rizikos valdymas, ir valdysenos standartai.",
  },
  {
    id: "LB_REKOMENDACIJOS",
    name: "LB Rekomendacijos",
    description:
      "Lietuvos banko rekomendacijos — gerosios prakties standartai ir savanoriski atitikties vadovai.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// --- Sample provisions ---

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // LB Nutarimai — resolutions
  {
    sourcebook_id: "LB_NUTARIMAI",
    reference: "LB nutarimas 03-41",
    title: "Del mokejimo istaigu ir elektroninių pinigu istaigu licencijavimo",
    text: "Mokejimo istaigos ir elektroninių pinigu istaigos privalo gauti Lietuvos banko licencija pries pradedant teikti mokejimo paslaugas. Paraiskie turi pateikti verslo plana, valdysenos struktura, kapitalines bazines diferenciacijos dokumentus ir atitikties valdymo plana.",
    type: "nutarimas",
    status: "in_force",
    effective_date: "2018-01-01",
    chapter: "II",
    section: "2.1",
  },
  {
    sourcebook_id: "LB_NUTARIMAI",
    reference: "LB nutarimas 03-67",
    title: "Del kredito istaigu nuosavo kapitalo reikalavimu",
    text: "Kredito istaigos privalo palaikyti nuosavo kapitalo paka ir atitikti minimaliu kapitalo rodikliu reikalavimus pagal CRR/CRD IV sistema. Bendrasis pirmo lygio kapitalas turi sudaryti ne maziau kaip 4,5% pagal rizika svertu turto. Minimalus nuosavo kapitalo koeficientas sudaro 8%.",
    type: "nutarimas",
    status: "in_force",
    effective_date: "2014-01-01",
    chapter: "III",
    section: "3.2",
  },
  {
    sourcebook_id: "LB_NUTARIMAI",
    reference: "LB nutarimas 03-88",
    title: "Del pinigu plovimo ir terorizmo finansavimo prevencijos",
    text: "Visi Lietuvos banko priziurime esantys subjektai privalo igyvendinti rizika grindziama pinigu plovimo ir terorizmo finansavimo prevencijos (AML/CFT) sistema. Sistema apima kliento pazinimo proceduras (KYC), nuolatiniu stebejima, ir galimu tariu atveju pranesimu prieziorui.",
    type: "nutarimas",
    status: "in_force",
    effective_date: "2019-04-01",
    chapter: "I",
    section: "1.3",
  },
  {
    sourcebook_id: "LB_NUTARIMAI",
    reference: "LB nutarimas 04-12",
    title: "Del kriptovaliutu paslaugu teikejo registracijos",
    text: "Kriptovaliutu paslaugu teikejai privalo registruotis Lietuvos banke pries pradedant veikla. Registracijai reikalingas valdysenos apibrezimas, AML/CFT politika, IT saugos priemones ir kapitalo patvirtinimas. Sios nuostatos taikomos virtualiosios valiutos birzoms, saugykloms ir konvertavimo paslaugoms.",
    type: "nutarimas",
    status: "in_force",
    effective_date: "2022-01-01",
    chapter: "IV",
    section: "4.1",
  },

  // LB Gaires — guidelines
  {
    sourcebook_id: "LB_GAIRES",
    reference: "LB gaires 2021/1",
    title: "IT rizikos valdymo gaires finansu institucijoms",
    text: "Lietuvos bankas tikisi, kad finansu institucijos veiksmingai valdo IT rizika. Gaireses numatytos IT valdysenos, kibernetines saugos, verslo testinumo, trecziosios salies rizikos valdymo ir IT incidentu valdymo reikalavimai. Visi materialus incidentai per 4 val. pranesamai Lietuvos bankui.",
    type: "gaires",
    status: "in_force",
    effective_date: "2021-07-01",
    chapter: "II",
    section: "2.3",
  },
  {
    sourcebook_id: "LB_GAIRES",
    reference: "LB gaires 2022/3",
    title: "ESG rizikos integravimo gaires",
    text: "Finansu institucijos privalo integruoti ESG rizikus i savo rizikos valdymo procesus. Klimate rizika turi buti iverdinta vykdant kreditini vertinima, vidini kapitalo pakankamuma ir likvidumo valdyma. Institucijos turi atskleisti ESG rizikos apimti ir valdymo priemones metinese ataskaitose.",
    type: "gaires",
    status: "in_force",
    effective_date: "2022-09-01",
    chapter: "III",
    section: "3.1",
  },

  // LB Rekomendacijos — recommendations
  {
    sourcebook_id: "LB_REKOMENDACIJOS",
    reference: "LB rekomendacija 2020/2",
    title: "Vartotoju apsaugos rekomendacijos finansu institucijoms",
    text: "Lietuvos bankas rekomenduoja finansu institucijoms uztikrini aisku ir sazininga komunikacija su vartotojais. Rekomenduojama sudaryti nesudatingus finansines produktu apibrezimus, aisku mokesciu sandar atskleidima ir skundo nagrinejimo proceduras. Institucijos raginamos ivesti nepriklausoma vartotojo interesy atstovavima.",
    type: "rekomendacija",
    status: "in_force",
    effective_date: "2020-05-01",
    chapter: "I",
    section: "1.1",
  },
  {
    sourcebook_id: "LB_REKOMENDACIJOS",
    reference: "LB rekomendacija 2023/1",
    title: "Dirbtinio intelekto sistemų naudojimo rekomendacijos",
    text: "Lietuvos bankas rekomenduoja finansu institucijoms, naudojancoms DI sistemas (pvz., kredito vertinimui, sukciavimo aptikimui), uztikrini siu sistemu skaidruma ir atsakinguma. Institucijos skatinamos atlikti DI modeliu validacija, tikrinti musu del diskriminacijos, ir vesti aisku DI valdysenos dokumentavima.",
    type: "rekomendacija",
    status: "in_force",
    effective_date: "2023-04-01",
    chapter: "II",
    section: "2.2",
  },
  {
    sourcebook_id: "LB_REKOMENDACIJOS",
    reference: "LB rekomendacija 2021/4",
    title: "Kibernetinio saugumo gerosios prakties vadovas",
    text: "Rekomendacija skirta ypac mazoms finansu institucijoms, kurioms sudeting ivesti pilna kibernetines saugos programa. Vadovas apima privilegijuotos prieigos kontrole, darbuotoju mokymasi, atsarginio kopijavimo proceduros, ir reagavimo i incidentus plan.",
    type: "rekomendacija",
    status: "in_force",
    effective_date: "2021-11-01",
    chapter: "I",
    section: "1.4",
  },
  {
    sourcebook_id: "LB_NUTARIMAI",
    reference: "LB nutarimas 03-95",
    title: "Del tarpusavio skolinimo platformu licencijavimo",
    text: "Sutelktinio finansavimo ir tarpusavio skolinimo platformos privalo gauti Lietuvos banko licencija pagal ES sutelktinio finansavimo reglamento (2020/1503) nuostatas. Platformos turi laikytis investuotoju apsaugos, skaidrumo atskleidimo ir kapitalui taikomu reikalavimu.",
    type: "nutarimas",
    status: "in_force",
    effective_date: "2021-11-10",
    chapter: "V",
    section: "5.2",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();
console.log(`Inserted ${provisions.length} sample provisions`);

// --- Sample enforcement actions ---

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "UAB Paysera LT",
    reference_number: "LB-ENF-2022-0041",
    action_type: "fine",
    amount: 250_000,
    date: "2022-09-14",
    summary:
      "Lietuvos bankas skyre 250 000 EUR bauda UAB Paysera LT uz nepakankama pinigu plovimo prevencijos priemoniy igyvendinima. Buvo nustatyta, kad imone laiku neidentifikavo ir neprane apie galimai tariasias operacijas keliems didesnes rizikos kategoriju klientams.",
    sourcebook_references: "LB nutarimas 03-88, LB gaires 2021/1",
  },
  {
    firm_name: "UAB Mano Bank",
    reference_number: "LB-ENF-2023-0017",
    action_type: "fine",
    amount: 180_000,
    date: "2023-03-22",
    summary:
      "Lietuvos bankas skyre 180 000 EUR bauda UAB Mano Bank uz IT incidento pavelog pranesimu pazeidima. Bankas nesilaikye 4 valandy pranesimy termino per darbui kritisku IT sistemu sutrikima ir nepateike isamios incidento analizeis.",
    sourcebook_references: "LB gaires 2021/1, LB nutarimas 03-41",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();
console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// --- Summary ---

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
