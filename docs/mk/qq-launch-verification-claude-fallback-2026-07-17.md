# QQ launch verification + onboarding analysis (2026-07-17)

**Attribution:** produced by Claude (marveen main), NOT gpt-5.6-sol. The gpt-5.6-sol delegation was attempted TWICE and both runs hung reproducibly (0.0% CPU, 0 bytes output, blocked API socket — endpoint outage or ChatGPT-Plus quota block at the time). Per the analysis-delegate-gpt-sol fallback rule, falling back to Claude and labeling it. This is a stress-test of an already-decided plan (Istvan GO'd QQ; no external check gates go-live), so it is advisory. It converges with business's independent onboarding call.

## VERDICT: SOUND-WITH-ADJUSTMENTS

The narrowed positioning ("Hungarian on-site field assistant: dictation → sendable, trackable quote in minutes", result-first) is **defensible** — the on-site, spoken, minutes-to-sendable quote moment is genuinely unowned in HU:
- Számlázz.hu / Billingo own the invoice moment, quoting is secondary/weak — QQ's wedge is upstream of them.
- Colostok does form-based quoting but no AI-capture — dictation is the differentiator IF voice quality holds.
- Jobber / Housecall Pro aren't HU-localized (ÁFA, trade specifics, Hungarian dictation) — localization is a real moat for a segment the internationals won't chase.

**But the differentiation rests almost entirely on voice-capture quality, which is gated-not-yet-proven.** That's the fragility: if dictation isn't materially better than phone-typing, the wedge collapses to "another quoting form" (Colostok exists; Billingo can bolt one on). Positioning is sound but fragile until the voice proof lands.

### Adjustments
1. **Make the 3 free sent quotes a ONE-TIME onboarding allowance, not monthly.** Monthly-3-free lets low-volume tradespeople stay free forever (never convert); one-time is a taste that drives conversion.
2. **Typing must be a co-equal, one-tap fallback on the capture screen** — not buried. Dictation-primary is correct for the pilot (that's how you gather the ≥100 dictations for the proof), but a bad dictation must never cost the quote.
3. **Hold dictation as the PUBLIC landing headline until the voice gate passes** (≥15 tradespeople, ≥100 dictations, ≤2 edits avg, ≥85% line-items, ≥95% quantities, 0% invented). The pilot can lead with dictation internally; the public claim waits for proof.
4. **Extra uncertainty-tagging rigor on gas/electric**, where a wrong quantity/spec has safety cost, not just money cost.

3-trade choice (villany / víz-gáz-fűtés / klíma): **sound** — high quote-volume, fairly structured line-items suited to extraction, and adjacent (víz-gáz-fűtés ↔ klíma overlap). Keep "general mode" visibly lighter so non-core trades don't churn expecting equal depth.

## (B) Onboarding question-set: YES, but 2 blocking + rest just-in-time

Core tension: a busy tradesperson churns on a long upfront form, but a quote is WRONG without a few facts you can't infer. Resolution — **2 blocking questions at first login (~10s), everything else progressive/JIT:**

- **BLOCKING (2):**
  1. **Trade** (villany / víz-gáz-fűtés / klíma / egyéb) — sets mode + line-item vocab + depth; can't be inferred.
  2. **ÁFA-status** (alanyi adómentes / ÁFA-körös) — changes every quote total and is a legally-required field on the document. Poisons every quote if wrong.
- **PROGRESSIVE / JIT (on the first quote, inline, with editable defaults):** hourly labour rate + default call-out fee — asked at the moment the quote needs them ("Mennyi az óradíjad?" inline when labour appears), answered in context, not upfront.
- **POST-FIRST-QUOTE / optional:** business name/branding/logo for the sent PDF (send the first quote with a plain header, prompt to brand after); price-list import (optional accelerator later, never blocking).

Rationale: the tradesperson hits "I dictated → I have a draft quote" in under a minute (the aha), while the only data that would make the quote WRONG (trade, ÁFA) is captured in 2 taps first, and the merely-convenient data (rates, branding, price-list) is captured where its value is obvious. **This confirms business's call (2 blocking + progressive); the sharpening is WHICH two: trade + ÁFA-status — NOT hourly rate (that is better JIT).**

## (C) Top 5 launch risks (ranked)

1. **Voice quality under-delivers → the wedge collapses.** Field noise, HU trade jargon, material names. If recognition <85% or it invents items, QQ becomes a slower Colostok. Mitigation: the quality gate before public headline; typing co-equal fallback; the pilot exists to measure exactly this. THE make-or-break.
2. **A wrong quote reaches a real customer → trust + liability.** An invented/mis-quantified line-item (esp. gas/electric) damages the tradesperson's reputation and QQ's. Mitigation: hard uncertainty-tagging + mandatory 2-4 clarifying questions + never-auto-add + explicit pre-send review. (The QQ analogue of the MK tax-error discipline.)
3. **Email deliverability breaks the "sendable/trackable" promise.** Spam/silent-bounce makes the tradesperson look unprofessional and voids the core value. Mitigation: keep the SES prod gate hard (SPF/DKIM/DMARC, bounce/complaint webhook, delivery-status visibility, mobile-fast accept link).
4. **Low free→paid conversion.** If 3-free is monthly, low-volume users never pay. Mitigation: one-time not monthly; instrument sents/user + time-to-paywall; pilot must show active users hit the paywall fast and convert.
5. **Wrong-persona churn on "general mode" trades.** A festő/burkoló expecting villany-depth churns and poisons word-of-mouth. Mitigation: landing must not claim equal depth for 13 trades; self-select non-core trades into "lighter" expectations or waitlist them for their depth.
