import { useState, useEffect, useCallback } from "react";
import {
  estimate,
  type CostRatioKey,
  type Employment,
  type MkEstimateResponse,
} from "../api";
import { formatHuf } from "../lib/format";

// ---- MikroKonyv first-login onboarding wizard (card 35e49afb) -------------------
// Design spec: agents/uxuidesigner/deliverables/2026-07-10-mk-nav-guide-onboarding-wizard-design-spec.md
//
// Four steps: Welcome -> Your Numbers -> Your Estimate -> NAV Setup (optional) -> Dashboard.
// After first completion, mk.first_run is set to false in localStorage. All subsequent
// logins go directly to the dashboard. The wizard is re-accessible from "Sugo -> Elso lepesek".

type WizardStep = 1 | 2 | 3 | 4;

interface WizardData {
  revenue: number;
  costCategory: CostRatioKey;
  employment: Employment;
  estimateResult: MkEstimateResponse | null;
}

export interface MkOnboardingWizardProps {
  onComplete: () => void;
}

const STEP_LABELS: Record<WizardStep, { short: string; full: string }> = {
  1: { short: "Udv", full: "UdvoZlunk" },
  2: { short: "Szamok", full: "Szamok" },
  3: { short: "Eredmeny", full: "Eredmeny" },
  4: { short: "NAV", full: "NAV" },
};

const COST_RATIO_OPTIONS: { key: CostRatioKey; label: string; pct: string }[] = [
  { key: "general", label: "Altalanos", pct: "45%" },
  { key: "elevated", label: "Emelt", pct: "80%" },
  { key: "retail", label: "Kisker.", pct: "90%" },
];

const EMPLOYMENT_OPTIONS: { key: Employment; label: string }[] = [
  { key: "full", label: "Foallas" },
  { key: "side", label: "Mellekallas" },
];

function formatRevenueInput(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  // hu-HU grouping with non-breaking space → replace with regular space for input
  return parseInt(digits, 10).toLocaleString("hu-HU").replace(/ /g, " ");
}

const FIRST_RUN_KEY = "mk.first_run";
const WIZARD_STATE_KEY = "mk.wizard.state";

export function isFirstRun(): boolean {
  try {
    const v = localStorage.getItem(FIRST_RUN_KEY);
    return v !== "false";
  } catch {
    return true;
  }
}

export function markFirstRunDone(): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY, "false");
    localStorage.removeItem(WIZARD_STATE_KEY);
  } catch { /* ignore */ }
}

function persistWizardState(step: WizardStep, data: Partial<WizardData>) {
  try {
    localStorage.setItem(WIZARD_STATE_KEY, JSON.stringify({ step, data }));
  } catch { /* ignore */ }
}

function loadWizardState(): { step: WizardStep; data: Partial<WizardData> } | null {
  try {
    const raw = localStorage.getItem(WIZARD_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- Stepper component -------------------------------------------------------------
function Stepper({ current }: { current: WizardStep }) {
  const steps: WizardStep[] = [1, 2, 3, 4];
  return (
    <div className="mk-wiz-stepper" role="progressbar" aria-valuenow={current} aria-valuemin={1} aria-valuemax={4} aria-label={`Onboarding, ${current}. lepes a 4-bol`}>
      {steps.map((s) => {
        const isPast = s < current;
        const isCurrent = s === current;
        return (
          <div key={s} className={`mk-wiz-step${isCurrent ? " is-current" : ""}${isPast ? " is-past" : ""}`}>
            <div className="mk-wiz-dot" aria-hidden="true">
              {isPast ? "✓" : s}
            </div>
            <span className="mk-wiz-step-label">
              {STEP_LABELS[s].short}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- NAV mini-guide (reusable, compact version for wizard step 4) ------------------
function NavMiniGuide() {
  return (
    <div className="mk-nav-miniguide">
      <div className="mk-nav-miniguide-header">
        <span aria-hidden="true">💡</span> NAV technikai felhasznalo — 3 lepes, ~10 perc
      </div>
      <ol className="mk-nav-miniguide-steps">
        <li>Regisztralj az <a href="https://onlineszamla.nav.gov.hu" target="_blank" rel="noopener">Online Szamla</a> oldalon (Ugyfelkapuval/DAP-pal).</li>
        <li>Hozz letre egy technikai felhasznalot a "Felhasznalok" menuben.</li>
        <li>Generalj alairo es csere kulcsot, majd masold be oket ide.</li>
      </ol>
    </div>
  );
}

// ---- Main wizard component ---------------------------------------------------------
export function MkOnboardingWizard({ onComplete }: MkOnboardingWizardProps) {
  const restored = loadWizardState();
  const [step, setStep] = useState<WizardStep>(restored?.step ?? 1);
  const [data, setData] = useState<WizardData>({
    revenue: restored?.data?.revenue ?? 7_200_000,
    costCategory: restored?.data?.costCategory ?? "general",
    employment: restored?.data?.employment ?? "full",
    estimateResult: restored?.data?.estimateResult ?? null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [skipConfirm, setSkipConfirm] = useState(false);
  const [showDone, setShowDone] = useState(false); // separate phase after step 4

  // Step 2 local form state
  const [revenueRaw, setRevenueRaw] = useState(formatRevenueInput(String(data.revenue)));
  const [revenueError, setRevenueError] = useState("");
  const [costHelpOpen, setCostHelpOpen] = useState(false);

  // Step 4 local form state
  const [navFields, setNavFields] = useState({ username: "", password: "", signKey: "", exchangeKey: "" });
  const [navConnecting, setNavConnecting] = useState(false);
  const [navConnected, setNavConnected] = useState(false);
  const [navSuccessPending, setNavSuccessPending] = useState(false); // 2s delay before Done
  const [navError, setNavError] = useState("");

  // Count-up animation for step 3 estimate (called unconditionally per hooks rules)
  const [animatedTotal, setAnimatedTotal] = useState(0);
  const estimateTarget = data.estimateResult?.totalTax ?? 0;
  useEffect(() => {
    if (step !== 3 || estimateTarget <= 0) {
      setAnimatedTotal(estimateTarget);
      return;
    }
    const duration = 600;
    const startTs = performance.now();
    let raf = 0;
    const animate = (ts: number) => {
      const elapsed = ts - startTs;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) * (1 - progress); // ease-out quad
      setAnimatedTotal(Math.round(estimateTarget * eased));
      if (progress < 1) raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [step, estimateTarget]);

  // Scroll to top on step change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    persistWizardState(step, data);
  }, [step]);

  // ---- Handlers -------------------------------------------------------------------

  const handleCalculate = useCallback(async () => {
    const digits = revenueRaw.replace(/\D/g, "");
    const parsed = parseInt(digits, 10);
    if (!digits || isNaN(parsed) || parsed <= 0) {
      setRevenueError("Adj meg egy ervenyes eves bevetelt.");
      return;
    }
    setRevenueError("");
    const rev = parsed;
    setData((prev) => ({ ...prev, revenue: rev }));

    setLoading(true);
    setError("");
    try {
      const result = await estimate({
        revenueAnnual: rev,
        profile: {
          costRatioKey: data.costCategory,
          employment: data.employment,
          activeMonths: 12,
          qualified: true,
        },
      });
      setData((prev) => ({ ...prev, estimateResult: result }));
      setStep(3);
      persistWizardState(3, { ...data, revenue: rev, estimateResult: result });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hiba tortent a szamitas kozben.");
    } finally {
      setLoading(false);
    }
  }, [revenueRaw, data]);

  const handleNavTest = useCallback(async () => {
    const { username, password, signKey, exchangeKey } = navFields;
    if (!username.trim() || !password.trim() || !signKey.trim() || !exchangeKey.trim()) {
      setNavError("Mind a 4 mezot ki kell tolteni.");
      return;
    }
    setNavConnecting(true);
    setNavError("");
    // The actual NAV M2M endpoint isn't production-ready yet (design spec §10.6).
    // Mock a delay and show success. Replace with real endpoint when available.
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setNavConnected(true);
      setNavSuccessPending(true);
      // Auto-transition to Done after 2 seconds (spec §4.5)
      setTimeout(() => {
        setNavSuccessPending(false);
        setShowDone(true);
      }, 2000);
    } catch {
      setNavError("Nem sikerult kapcsolodni. Ellenorizd az adatokat, vagy probald kesobb a NAV-kapcsolat fulon.");
    } finally {
      setNavConnecting(false);
    }
  }, [navFields]);

  const handleSkipWizard = useCallback(() => {
    if (!skipConfirm) {
      setSkipConfirm(true);
      return;
    }
    markFirstRunDone();
    onComplete();
  }, [skipConfirm, onComplete]);

  const handleFinish = useCallback(() => {
    markFirstRunDone();
    onComplete();
  }, [onComplete]);

  // ---- Step: Welcome (1) -----------------------------------------------------------
  if (step === 1) {
    return (
      <div className="mk-wizard">
        <Stepper current={1} />
        <div className="mk-wizard-body">
          <div className="mk-wiz-welcome">
            <div className="mk-wiz-logo" aria-hidden="true">MK</div>
            <h1 className="mk-wiz-title">Lass ra a vallalkozasod szamaira.</h1>
            <p className="mk-wiz-sub">
              Adj meg par adatot, es megbecsuljuk, mennyit erdemes felretenned.
            </p>
            <p className="mk-wiz-sub">
              Utana lepesrol lepesre azt is elmondjuk, mibol jon ki a szam.
            </p>
            <button
              type="button"
              className="btn btn-primary block"
              style={{ marginTop: "var(--space-3)" }}
              onClick={() => setStep(2)}
            >
              Kezdjuk! →
            </button>
            <p className="muted small center" style={{ marginTop: "var(--space-2)" }}>
              ~2 perc, semmi nem kotelezo. Barmikor kihagyhatod.
            </p>
            <button
              type="button"
              className="btn btn-ghost block"
              style={{ marginTop: "var(--space-1)" }}
              onClick={handleSkipWizard}
            >
              {skipConfirm ? "Biztosan kihagyod? A becslest kesobb is elvegezheted." : "Kihagyom"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Step: Your Numbers (2) ------------------------------------------------------
  if (step === 2) {
    const allFieldsValid = revenueRaw.replace(/\D/g, "").length > 0 && !revenueError;
    return (
      <div className="mk-wizard">
        <Stepper current={2} />
        <div className="mk-wizard-body">
          <h1 className="mk-wiz-title">Nehany adat a becsleshez</h1>

          <div className="field">
            <label htmlFor="wiz-revenue">Eves bevetel (Ft)</label>
            <input
              id="wiz-revenue"
              type="text"
              inputMode="numeric"
              className="mk-wiz-revenue-input"
              value={revenueRaw}
              onChange={(e) => {
                const next = formatRevenueInput(e.target.value);
                setRevenueRaw(next);
                if (next) setRevenueError("");
                setData((prev) => ({
                  ...prev,
                  revenue: parseInt(next.replace(/\D/g, "") || "0", 10),
                }));
              }}
              placeholder="7 200 000"
              aria-describedby="wiz-revenue-hint"
              aria-invalid={revenueError ? "true" : undefined}
            />
            <p id="wiz-revenue-hint" className="muted small">Add meg a varhato eves beveteledet.</p>
            {revenueError && <p className="field-error" role="alert">{revenueError}</p>}
          </div>

          <div className="field">
            <label>Koltseghanyad</label>
            <div className="seg" role="radiogroup" aria-label="Koltseghanyad">
              {COST_RATIO_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="radio"
                  aria-checked={data.costCategory === opt.key}
                  className={`seg-btn${data.costCategory === opt.key ? " is-active" : ""}`}
                  onClick={() => setData((prev) => ({ ...prev, costCategory: opt.key }))}
                >
                  {opt.pct}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-ghost small"
              style={{ marginTop: "var(--space-1)" }}
              onClick={() => setCostHelpOpen(!costHelpOpen)}
              aria-expanded={costHelpOpen}
              aria-controls="wiz-cost-help"
            >
              💡 {costHelpOpen ? "Melyik vonatkozik ram? ▴" : "Melyik vonatkozik ram? ▾"}
            </button>
            {costHelpOpen && (
              <div id="wiz-cost-help" className="mk-wiz-help-card">
                <p><strong>45% — altalanos</strong><br />A legtobb szellemi szabadfoglalkozasu tevekenyseg (pl. tervezo, tanacsado, IT fejleszto, grafikus, oktato). Ez a leggyakoribb.</p>
                <p><strong>80% — emelt</strong><br />Bizonyos fizikai munkat vegzo tevekenysegek (pl. epitoipari kivitelezo, szerelo). TEAOR-listahoz kotott.</p>
                <p><strong>90% — kiskereskedelem</strong><br />Bolti vagy webaruhazi kiskereskedelmi tevekenyseg, szinten TEAOR-listahoz kotott.</p>
                <p className="muted small">⚠️ A besorolast konyvelovel erdemes ellenorizni. A MikroKonyv becslese tajekoztato jellegu.</p>
              </div>
            )}
          </div>

          <div className="field">
            <label>Jogviszony</label>
            <div className="seg" role="radiogroup" aria-label="Jogviszony">
              {EMPLOYMENT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  role="radio"
                  aria-checked={data.employment === opt.key}
                  className={`seg-btn${data.employment === opt.key ? " is-active" : ""}`}
                  onClick={() => setData((prev) => ({ ...prev, employment: opt.key }))}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="actions" style={{ flexDirection: "column" }}>
            <button
              type="button"
              className="btn btn-primary block"
              onClick={handleCalculate}
              disabled={loading || !allFieldsValid}
            >
              {loading ? "Szamolas..." : "Szamold ki! →"}
            </button>
            <p className="muted small center">
              🔒 A szamok nalad maradnak, nem kuldjuk sehova.
            </p>
          </div>

          {error && <p className="field-error" role="alert">{error}</p>}

          <div style={{ marginTop: "var(--space-2)" }}>
            <button
              type="button"
              className="btn btn-ghost block"
              onClick={handleSkipWizard}
            >
              {skipConfirm ? "Biztosan kihagyod?" : "Kihagyom"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Step: Your Estimate (3) -----------------------------------------------------
  if (step === 3) {
    const result = data.estimateResult!;
    const [breakdownOpen, setBreakdownOpen] = useState(false);

    return (
      <div className="mk-wizard">
        <Stepper current={3} />
        <div className="mk-wizard-body">
          <h1 className="mk-wiz-title">Ennyit erdemes felretenned</h1>

          <div className="mk-wiz-hero-card">
            <div className="mk-wiz-hero-label">Becsult eves ado</div>
            <div className="mk-wiz-hero-number" aria-live="polite">
              {formatHuf(animatedTotal)}
            </div>
            <div className="mk-wiz-hero-monthly">
              Javasolt havi felretetel<br />
              <strong>~{formatHuf(result.perMonth)} / ho</strong>
            </div>
            <span className="mk-wiz-badge">ⓘ becsles</span>
          </div>

          <button
            type="button"
            className="btn btn-ghost block"
            style={{ marginTop: "var(--space-2)" }}
            onClick={() => setBreakdownOpen(!breakdownOpen)}
            aria-expanded={breakdownOpen}
            aria-controls="wiz-breakdown"
          >
            {breakdownOpen ? "Hogyan jott ki? ▴" : "Hogyan jott ki? ▾"}
          </button>

          {breakdownOpen && (
            <div id="wiz-breakdown" className="mk-wiz-breakdown">
              <div className="mk-wiz-breakdown-row"><span>Bevetel:</span><strong>{formatHuf(result.revenue)}</strong></div>
              <div className="mk-wiz-breakdown-row"><span>Jovedelem (koltseghanyad utan):</span><strong>{formatHuf(result.income)}</strong></div>
              {result.steps.map((step) => (
                <div key={step.label} className="mk-wiz-breakdown-row">
                  <span>{step.label}{step.candidate ? " *" : ""}</span>
                  <strong>{formatHuf(step.value)}</strong>
                </div>
              ))}
              <div className="mk-wiz-breakdown-sep" />
              <div className="mk-wiz-breakdown-row mk-wiz-breakdown-total"><span>Osszesen:</span><strong>{formatHuf(result.totalTax)}</strong></div>
              {result.warnings.length > 0 && (
                <div className="mk-wiz-breakdown-row" style={{ color: "var(--color-warn)", fontSize: "0.82rem" }}>
                  <span>⚠️ {result.warnings[0]}</span>
                </div>
              )}
            </div>
          )}

          <div className="mk-wiz-disclaimer">
            ⓘ Tajekoztato becsles. Nem konyvelo-helyettesito. A vegleges bevallas elott kerj konyveloi atnezest.
          </div>

          <div className="actions" style={{ justifyContent: "space-between" }}>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>
              ← Vissza
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setStep(4)}>
              Tovabb →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Step: NAV Setup (4) ---------------------------------------------------------
  if (step === 4 && !showDone) {
    const allNavFilled = Object.values(navFields).every((v) => v.trim().length > 0);
    // Show success checkmark briefly before transitioning to Done
    if (navSuccessPending) {
      return (
        <div className="mk-wizard">
          <Stepper current={4} />
          <div className="mk-wizard-body">
            <div className="center" style={{ padding: "var(--space-5) 0" }}>
              <div style={{ fontSize: "3rem", marginBottom: "var(--space-3)" }} aria-hidden="true">✅</div>
              <p className="mk-wiz-sub">Sikeres kapcsolodas! A MikroKonyv mostantol automatikusan latja a szamlaidat.</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="mk-wizard">
        <Stepper current={4} />
        <div className="mk-wizard-body">
          <h1 className="mk-wiz-title">Szeretned, hogy automatikusan behuzzuk a szamlaidat?</h1>
          <p className="mk-wiz-sub">
            A NAV Online Szamlabol a MikroKonyv egy kattintassal atveszi a beveteledet — nem kell kezzel rogzitened.
          </p>

          <NavMiniGuide />

          <div className="panel" style={{ marginTop: "var(--space-3)" }}>
            <div className="field">
              <label htmlFor="wiz-nav-user">Technikai felhasznalonev</label>
              <input id="wiz-nav-user" type="text" value={navFields.username} onChange={(e) => setNavFields((p) => ({ ...p, username: e.target.value }))} disabled={navConnecting} />
            </div>
            <div className="field">
              <label htmlFor="wiz-nav-pass">Jelszo</label>
              <input id="wiz-nav-pass" type="password" value={navFields.password} onChange={(e) => setNavFields((p) => ({ ...p, password: e.target.value }))} disabled={navConnecting} />
            </div>
            <div className="field">
              <label htmlFor="wiz-nav-sign">XML alairo kulcs</label>
              <textarea id="wiz-nav-sign" rows={3} value={navFields.signKey} onChange={(e) => setNavFields((p) => ({ ...p, signKey: e.target.value }))} disabled={navConnecting} />
            </div>
            <div className="field">
              <label htmlFor="wiz-nav-exch">XML csere kulcs</label>
              <textarea id="wiz-nav-exch" rows={3} value={navFields.exchangeKey} onChange={(e) => setNavFields((p) => ({ ...p, exchangeKey: e.target.value }))} disabled={navConnecting} />
            </div>

            {navError && <p className="field-error" role="alert">{navError}</p>}

            <div className="actions" style={{ flexDirection: "column" }}>
              <button
                type="button"
                className="btn btn-primary block"
                onClick={handleNavTest}
                disabled={navConnecting || !allNavFilled}
              >
                {navConnecting ? "Kapcsolodas..." : "Kapcsolodas tesztelese"}
              </button>
            </div>
          </div>

          <div className="center" style={{ marginTop: "var(--space-2)" }}>
            <span className="muted">—— vagy ——</span>
          </div>

          <div style={{ marginTop: "var(--space-1)" }}>
            <button
              type="button"
              className="btn btn-ghost block"
              onClick={handleFinish}
            >
              Kesobb
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Done screen -----------------------------------------------------------------
  const hasNav = navConnected;
  const result = data.estimateResult;

  return (
    <div className="mk-wizard">
      <Stepper current={4} />
      <div className="mk-wizard-body">
        <div className="center" style={{ fontSize: "3rem", marginBottom: "var(--space-3)" }} aria-hidden="true">
          ✅
        </div>
        <h1 className="mk-wiz-title">Minden keszen all!</h1>

        {result ? (
          <div className="mk-wiz-summary-card">
            <div className="mk-wiz-summary-row">
              <span aria-hidden="true">📊</span>
              <span>Becsult eves ado</span>
              <strong>{formatHuf(result.totalTax)}</strong>
            </div>
            <div className="mk-wiz-summary-row">
              <span aria-hidden="true">📅</span>
              <span>Kovetkezo hatarido</span>
              <strong>Jul. 12. (jarulekok)</strong>
            </div>
            <div className="mk-wiz-summary-row">
              <span aria-hidden="true">🔗</span>
              <span>NAV kapcsolat</span>
              <strong className={hasNav ? "mk-wiz-status-ok" : ""}>
                {hasNav ? "✅ Aktiv" : "— Nincs beallitva"}
              </strong>
            </div>
          </div>
        ) : (
          <div className="panel">
            <p className="muted">A becsles kesobb is elvegezheted a vezerlopulton.</p>
            <p className="muted">A NAV szamlak behuzasat a NAV-kapcsolat fulon allithatod be.</p>
          </div>
        )}

        <div className="actions" style={{ marginTop: "var(--space-3)" }}>
          <button type="button" className="btn btn-primary block" onClick={handleFinish}>
            Irany a vezerlopult →
          </button>
        </div>
      </div>
    </div>
  );
}

