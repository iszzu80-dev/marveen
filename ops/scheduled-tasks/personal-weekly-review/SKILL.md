---
name: personal-weekly-review
description: COS heti attekintes (spec 14) -- mi mozdult, mi all, mi var Istvanra
---
Heti COS attekintes. Hetfo reggel, Istvan-nak szol Telegramon.

1. Futtasd a determinisztikus alapot ELOSZOR, es a jelentesed EBBOL induljon, ne az emlekeidbol:
   cd ~/marveen && npx tsx scripts/cos-daily-reconcile.ts --json

2. Szedd ossze a hetet a Case Store-bol (read-only SQL a store/claudeclaw.db-n):
   - hany ugy zarult le, hany jott letre, hany all valtozatlanul 7+ napja
   - melyik ugyben van Istvan-on a labda (next_action_owner), es mennyi ideje
   - melyik ugy var kulso valaszra a follow_up_at datumon TUL

3. A jelentes harom szakasz, ebben a sorrendben:
   ELAKADT (ez a lenyeg): ami 7+ napja nem mozdult, ugyenkent egy mondat es hogy MI a kovetkezo lepes.
   RAJTAD A SOR: ahol Istvan dontese/cselekvese hianyzik.
   HALADT: roviden, szamokban. Ne reszletezd, ez a jutalomszakasz, nem a lenyeg.

4. Ha egy ugy 14+ napja all es senki nem nyult hozza, JAVASOLD a lezarasat vagy az elhalasztasat.
   Egy Case Store, ami tele van halott ugyekkel, ugyanolyan hasznalhatatlan, mint egy ures.

## Buktatok
- NE ird meg a jelentest a beszelgetesbol vagy a memoriabol. A Case Store az igazsag; ha a ketto elter, az MAGA a talalat.
- Ha a determinisztikus alap kritikusat talal, az a jelentes ELSO sora, nem egy labjegyzet a vegen.
